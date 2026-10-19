"""
Automação 1 — Padronização de dimensões (por SKU).

Coleta (diária ou sob demanda):
1. Tiny (contas de TINY_CONTAS): todos os produtos ativos com SKU; o cadastro completo só é
   relido quando `dataAlteracao` muda (cache em dimensoes.json).
2. Mercado Livre (todas as contas): anúncios (menos carrinhos) e descrição; a descrição só é
   relida quando o anúncio muda (`last_updated`).
3. Para cada SKU, as medidas de cada fonte — título, descrição e ficha técnica, no ML e no
   Tiny — são comparadas (dimensoes.comparar_fontes): valor sugerido + confiabilidade.
4. SKU ainda não padronizado → pendência de revisão. SKU padronizado cuja ficha (ML ou Tiny)
   mudou depois → pendência "divergente do padrão".

Validação (tela, sempre humana, em lote): grava em dimensoes_produtos (MariaDB) e envia às
plataformas — Tiny (todas as contas onde o SKU existe) e ML (todos os anúncios do SKU: ficha
técnica do produto + medidas da embalagem padrão, que o frete usa).
"""
import logging
import re
import threading
import time
from html import unescape
from typing import Any, Callable, Dict, List, Optional

from app.config import FILIAIS, settings
from app.dimensoes import (
    Dimensoes,
    comparar_fontes,
    dimensoes_de_texto,
    dimensoes_do_titulo,
    e_carrinho,
    embalagem_para,
    ficha_ml,
    ficha_tiny,
    mesmo_peso,
    mesmo_tamanho,
    normalizada,
)
from app.estado import Estado, agora
from app.ml_client import ClienteML, ContaNaoConectada, MLAPIError
from app.rotina import skus_do_anuncio
from app.tiny_client import ClienteTiny

logger = logging.getLogger("marketplace.padronizacao")

STATUS_ANUNCIO_OK = ("active", "paused", "under_review")
ROTULO_FONTE = {
    "ml_titulo": "Título ML",
    "ml_descricao": "Descrição ML",
    "ml_ficha": "Ficha técnica ML",
    "tiny_titulo": "Nome Tiny",
    "tiny_descricao": "Descrição Tiny",
    "tiny_ficha": "Dimensões Tiny",
}
# Atributos da ficha técnica do ML que recebem a medida padronizada (só os que o anúncio já usa:
# atributo que não existe na categoria é recusado pelo ML).
ATRIBUTO_ML_POR_CAMPO = {
    "HEIGHT": "altura", "THICKNESS": "altura", "WIDTH": "largura", "LENGTH": "comprimento",
    "WEIGHT": "peso", "NET_WEIGHT": "peso",
}


class ColetaSemAnuncios(RuntimeError):
    pass


def vazio_dimensoes() -> Dict[str, Any]:
    return {
        "produtos": {}, "cache_ml": {}, "cache_tiny": {}, "anuncios_sem_sku": [],
        "execucoes": [], "em_execucao": None, "progresso": None,
    }


def _limpar_html(texto: Optional[str]) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", texto or ""))).strip()


def _fonte(fonte: str, local: str, dims: Dimensoes, texto: Optional[str] = None) -> Dict[str, Any]:
    return {
        "fonte": fonte,
        "rotulo": ROTULO_FONTE[fonte],
        "local": local,
        "dims": dims.para_dict(),
        "texto": (texto or "")[:300] or None,
    }


class Padronizacao:
    def __init__(
        self,
        estado: Estado,
        repositorio: Any,
        fabrica_ml: Optional[Callable[[str], ClienteML]] = None,
        fabrica_tiny: Optional[Callable[[str], ClienteTiny]] = None,
        pausa: float = 0.3,
        estado_fretes: Optional[Estado] = None,
    ) -> None:
        self.estado = estado
        self.repo = repositorio
        self.fabrica_ml = fabrica_ml or (lambda filial: ClienteML(filial, estado_fretes or estado))
        self.fabrica_tiny = fabrica_tiny or (lambda conta: ClienteTiny(conta, lambda: self.repo.token_tiny(conta)))
        self.pausa = pausa
        self.estado_fretes = estado_fretes  # avisos para o gateway notificar
        self._executando = threading.Lock()
        self._enviando = threading.Lock()

    # ------------------------------------------------------------------------------------------
    # Coleta
    # ------------------------------------------------------------------------------------------

    def coletar(self, origem: str = "agendada") -> Dict[str, Any]:
        """
        ML primeiro (anúncios e SKUs), depois o Tiny: o cadastro completo só é lido para SKUs
        anunciados (DIMENSOES_SO_ANUNCIADOS) — ler um a um todos os produtos do Tiny, com o
        limite de requisições da API, levava horas. Progresso na tela e no log; os caches são
        gravados aos poucos, para um restart no meio não perder o que já foi lido.
        """
        if not self._executando.acquire(blocking=False):
            return {"status": "ignorada", "mensagem": "Já existe uma coleta em andamento."}
        inicio = agora()
        with self.estado.alterar() as dados:
            dados["em_execucao"] = inicio
            dados["progresso"] = None
        erros: List[str] = []
        try:
            ml, sem_sku = self._coletar_ml(erros)
            if not ml and not sem_sku and settings.DIMENSOES_SO_ANUNCIADOS:
                # Sem nenhum anúncio (token do ML expirado, conta desconectada): não há o que
                # padronizar, e ler o Tiny seria tempo perdido. Os produtos da coleta anterior ficam.
                raise ColetaSemAnuncios(
                    "Nenhum anúncio lido do Mercado Livre (access token expirado ou conta sem conexão?). "
                    "Coleta interrompida antes do Tiny."
                )
            tiny = self._coletar_tiny(erros, set(ml) if settings.DIMENSOES_SO_ANUNCIADOS else None)
            self._progresso("Comparando as medidas", 0, 0)
            resumo = self._montar_produtos(tiny, ml, sem_sku)
            resumo["erros"] = erros
            status = "erro" if erros and not (tiny or ml) else ("parcial" if erros else "ok")
        except ColetaSemAnuncios as e:
            logger.error(f"[DIMENSOES] {e} {'; '.join(erros)}")
            resumo, status = {"erros": erros + [str(e)]}, "erro"
        except Exception as e:
            logger.error(f"[DIMENSOES] Falha na coleta: {e}", exc_info=True)
            resumo, status = {"erros": erros + [str(e)]}, "erro"
        finally:
            self._executando.release()
        execucao = {"iniciada_em": inicio, "concluida_em": agora(), "origem": origem, "status": status, "resumo": resumo}
        logger.info(f"[DIMENSOES] Coleta concluída ({status}): {resumo}")
        with self.estado.alterar() as dados:
            dados["em_execucao"] = None
            dados["progresso"] = None
            dados["execucoes"] = (dados["execucoes"] + [execucao])[-30:]
        if self.estado_fretes is not None and resumo.get("pendencias_novas"):
            with self.estado_fretes.alterar() as dados_f:
                self.estado_fretes.registrar_aviso(
                    dados_f,
                    "dimensoes_pendencias",
                    f"{resumo['pendencias_novas']} produto(s) com dimensões para revisar",
                    "A coleta de dimensões encontrou produtos a padronizar. Revise em Marketplace → Padronização de dimensões.",
                )
        return execucao

    def _progresso(self, etapa: str, feitos: int, total: int) -> None:
        """Etapa atual da coleta (tela) — gravada de 25 em 25, com log de 100 em 100."""
        with self.estado.alterar() as dados:
            dados["progresso"] = {"etapa": etapa, "feitos": feitos, "total": total, "em": agora()}
        if feitos % 100 == 0 or feitos == total:
            logger.info(f"[DIMENSOES] {etapa}: {feitos}/{total}")

    def _salvar_cache(self, nome: str, cache: Dict[str, Any]) -> None:
        with self.estado.alterar() as dados:
            dados[nome] = cache

    def _coletar_tiny(self, erros: List[str], skus_alvo: Optional[set] = None) -> Dict[str, List[Dict[str, Any]]]:
        """
        {sku: [{conta, id, descricao, descricaoComplementar, dimensoes}]}. A listagem (100 por
        página) é barata; o cadastro completo (1 chamada por produto) só para `skus_alvo`.
        """
        por_sku: Dict[str, List[Dict[str, Any]]] = {}
        cache = dict(self.estado.ler()["cache_tiny"])
        for conta in settings.contas_tiny():
            rotulo = settings.rotulo_tiny(conta)
            try:
                cliente = self.fabrica_tiny(conta)
                self._progresso(f"{rotulo}: listando produtos", 0, 0)
                alvos = []
                for resumo in cliente.produtos():
                    sku = str(resumo.get("sku") or "").strip()
                    if not sku or e_carrinho(resumo.get("descricao")):
                        continue
                    if skus_alvo is not None and sku not in skus_alvo:
                        continue
                    alvos.append((sku, resumo))
                lidos = 0
                for i, (sku, resumo) in enumerate(alvos, start=1):
                    chave = f"{conta}:{resumo['id']}"
                    anterior = cache.get(chave)
                    if not anterior or anterior.get("dataAlteracao") != resumo.get("dataAlteracao"):
                        det = cliente.produto(int(resumo["id"]))
                        anterior = {
                            "dataAlteracao": resumo.get("dataAlteracao"),
                            "id": det.get("id") or resumo["id"],
                            "sku": det.get("sku") or sku,
                            "descricao": det.get("descricao") or resumo.get("descricao") or "",
                            "descricaoComplementar": det.get("descricaoComplementar") or "",
                            "dimensoes": det.get("dimensoes") or {},
                        }
                        cache[chave] = anterior
                        lidos += 1
                        if lidos % 50 == 0:
                            self._salvar_cache("cache_tiny", cache)
                    por_sku.setdefault(sku, []).append({"conta": conta, **anterior})
                    if i % 25 == 0 or i == len(alvos):
                        self._progresso(f"{rotulo}: cadastros dos produtos anunciados", i, len(alvos))
            except Exception as e:
                logger.error(f"[DIMENSOES] Tiny {conta}: {e}", exc_info=True)
                erros.append(f"{rotulo}: {e}")
            self._salvar_cache("cache_tiny", cache)
        return por_sku

    def _coletar_ml(self, erros: List[str]):
        """({sku: [anúncio]}, [anúncios sem SKU])"""
        por_sku: Dict[str, List[Dict[str, Any]]] = {}
        sem_sku: List[Dict[str, Any]] = []
        cache = dict(self.estado.ler()["cache_ml"])
        for filial in FILIAIS:
            rotulo = f"ML {settings.rotulos()[filial]}"
            try:
                cliente = self.fabrica_ml(filial)
                self._progresso(f"{rotulo}: listando anúncios", 0, 0)
                ids = cliente.ids_dos_anuncios()
                lidos = 0
                for i, item in enumerate(cliente.anuncios(ids), start=1):
                    if i % 25 == 0 or i == len(ids):
                        self._progresso(f"{rotulo}: anúncios e descrições", i, len(ids))
                    if item.get("status") not in STATUS_ANUNCIO_OK or e_carrinho(item.get("title")):
                        continue
                    chave = f"{filial}:{item['id']}"
                    anterior = cache.get(chave) or {}
                    if anterior.get("last_updated") != item.get("last_updated") or "descricao" not in anterior:
                        try:
                            descricao = cliente.descricao(item["id"])
                        except MLAPIError as e:
                            logger.warning(f"[DIMENSOES] Descrição de {item['id']}: {e}")
                            descricao = anterior.get("descricao", "")
                        anterior = {"last_updated": item.get("last_updated"), "descricao": descricao}
                        cache[chave] = anterior
                        lidos += 1
                        if lidos % 50 == 0:
                            self._salvar_cache("cache_ml", cache)
                        time.sleep(self.pausa)
                    anuncio = {
                        "filial": filial,
                        "mlb": item["id"],
                        "titulo": item.get("title") or "",
                        "permalink": item.get("permalink"),
                        "descricao": anterior.get("descricao", ""),
                        "ficha": ficha_ml(item).para_dict(),
                        "atributos": sorted(
                            a["id"] for a in item.get("attributes") or [] if a.get("id") in ATRIBUTO_ML_POR_CAMPO
                        ),
                    }
                    skus = skus_do_anuncio(item)
                    if not skus:
                        sem_sku.append({k: anuncio[k] for k in ("filial", "mlb", "titulo", "permalink")})
                    for sku in skus:
                        por_sku.setdefault(sku, []).append(anuncio)
            except ContaNaoConectada as e:
                logger.error(f"[DIMENSOES] {rotulo}: {e}")
                erros.append(f"{rotulo}: {e}")
            except Exception as e:
                logger.error(f"[DIMENSOES] {rotulo}: {e}", exc_info=True)
                erros.append(f"{rotulo}: {e}")
            self._salvar_cache("cache_ml", cache)
        return por_sku, sem_sku

    @staticmethod
    def fontes_do_sku(tiny: List[Dict[str, Any]], ml: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        fontes: List[Dict[str, Any]] = []
        for t in tiny:
            local = settings.rotulo_tiny(t["conta"])
            complementar = _limpar_html(t.get("descricaoComplementar"))
            fontes += [
                _fonte("tiny_titulo", local, dimensoes_do_titulo(t.get("descricao") or ""), t.get("descricao")),
                _fonte("tiny_descricao", local, dimensoes_de_texto(complementar), complementar),
                _fonte("tiny_ficha", local, ficha_tiny(t)),
            ]
        for a in ml:
            local = f"ML {settings.rotulos().get(a['filial'], a['filial'])} · {a['mlb']}"
            fontes += [
                _fonte("ml_titulo", local, dimensoes_do_titulo(a["titulo"]), a["titulo"]),
                _fonte("ml_descricao", local, dimensoes_de_texto(a.get("descricao") or ""), a.get("descricao")),
                _fonte("ml_ficha", local, Dimensoes.de_dict(a.get("ficha"))),
            ]
        return fontes

    def _montar_produtos(self, tiny: Dict[str, List[Dict[str, Any]]], ml: Dict[str, List[Dict[str, Any]]], sem_sku) -> Dict[str, Any]:
        padroes = self.repo.listar()
        pendencias_novas = 0
        with self.estado.alterar() as dados:
            anteriores = dados["produtos"]
            produtos: Dict[str, Dict[str, Any]] = {}
            for sku in sorted(set(tiny) | set(ml)):
                t, m = tiny.get(sku, []), ml.get(sku, [])
                fontes = self.fontes_do_sku(t, m)
                comparacao = comparar_fontes(fontes)
                descricao = (t[0]["descricao"] if t else (m[0]["titulo"] if m else sku))
                reg: Dict[str, Any] = {
                    "sku": sku,
                    "descricao": descricao,
                    "fontes": fontes,
                    **comparacao,
                    "anuncios": [{k: a[k] for k in ("filial", "mlb", "titulo", "permalink", "atributos")} for a in m],
                    "tiny": [{"conta": x["conta"], "id": x["id"]} for x in t],
                    "coletado_em": agora(),
                }
                padrao = padroes.get(sku)
                if padrao:
                    reg["padrao"] = _padrao_publico(padrao)
                    motivos = divergencias_do_padrao(padrao, fontes)
                    reg["status"] = "divergente" if motivos else "padronizado"
                    reg["motivos"] = motivos
                else:
                    reg["status"] = "pendente"
                    reg["motivos"] = []
                antes = anteriores.get(sku) or {}
                if reg["status"] in ("pendente", "divergente") and antes.get("status") not in ("pendente", "divergente"):
                    pendencias_novas += 1
                if antes.get("envio"):
                    reg["envio"] = antes["envio"]
                produtos[sku] = reg
            dados["produtos"] = produtos
            dados["anuncios_sem_sku"] = sem_sku
        return {
            "produtos": len(produtos),
            "pendentes": sum(1 for p in produtos.values() if p["status"] != "padronizado"),
            "pendencias_novas": pendencias_novas,
            "anuncios_sem_sku": len(sem_sku),
        }

    # ------------------------------------------------------------------------------------------
    # Validação e envio às plataformas
    # ------------------------------------------------------------------------------------------

    def validar(self, itens: List[Dict[str, Any]], usuario: Optional[str]) -> Dict[str, Any]:
        """
        Grava as medidas revisadas em dimensoes_produtos. Devolve os SKUs gravados; o envio às
        plataformas é feito depois (enviar), em segundo plano.
        """
        gravados: List[str] = []
        recusados: List[str] = []
        produtos = self.estado.ler()["produtos"]
        for it in itens:
            sku = str(it.get("sku") or "")
            dims = normalizada(Dimensoes.de_dict(it))
            if sku not in produtos:
                recusados.append(f"{sku}: não está na última coleta")
                continue
            if not dims.completas() or not dims.peso:
                falta = dims.faltando() + ([] if dims.peso else ["peso"])
                recusados.append(f"{sku}: falta {', '.join(falta)}")
                continue
            reg = produtos[sku]
            embalagem = embalagem_para(dims)
            self.repo.salvar({
                "sku": sku,
                "descricao": (reg.get("descricao") or "")[:255],
                "altura_cm": dims.altura,
                "largura_cm": dims.largura,
                "comprimento_cm": dims.comprimento,
                "peso_g": dims.peso,
                "embalagem_comprimento_cm": int(embalagem.comprimento) if embalagem else None,
                "confiabilidade": reg.get("confiabilidade") or "baixa",
                "fontes": reg.get("fontes"),
                "envios": None,
                "validado_por": usuario,
                "validado_em": agora(),
                "atualizado_em": agora(),
            })
            gravados.append(sku)
        if gravados:
            padroes = {s: self.repo.obter(s) for s in gravados}
            with self.estado.alterar() as dados:
                for sku in gravados:
                    reg = dados["produtos"][sku]
                    reg["padrao"] = _padrao_publico(padroes[sku])
                    reg["status"] = "padronizado"
                    reg["motivos"] = []
                    reg["envio"] = {"status": "enviando", "em": agora(), "destinos": {}}
        return {"gravados": gravados, "recusados": recusados}

    def enviar(self, skus: List[str]) -> Dict[str, Any]:
        """Envia o padrão de cada SKU ao Tiny e ao ML e registra o resultado por destino."""
        with self._enviando:
            resultado = {"ok": 0, "com_erro": 0}
            for sku in skus:
                padrao = self.repo.obter(sku)
                reg = self.estado.ler()["produtos"].get(sku)
                if not padrao or not reg:
                    continue
                destinos = self._enviar_sku(padrao, reg)
                erro = any(d["status"] == "erro" for d in destinos.values())
                resultado["com_erro" if erro else "ok"] += 1
                self.repo.atualizar_envios(sku, destinos)
                with self.estado.alterar() as dados:
                    if sku in dados["produtos"]:
                        dados["produtos"][sku]["envio"] = {
                            "status": "erro" if erro else "ok", "em": agora(), "destinos": destinos,
                        }
            return resultado

    def _enviar_sku(self, padrao: Dict[str, Any], reg: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        dims = Dimensoes(padrao["altura_cm"], padrao["largura_cm"], padrao["comprimento_cm"], padrao.get("peso_g"))
        destinos: Dict[str, Dict[str, Any]] = {}
        for t in reg.get("tiny") or []:
            chave = f"tiny:{t['conta']}"
            try:
                cliente = self.fabrica_tiny(t["conta"])
                produto = cliente.produto(int(t["id"]))
                cliente.gravar_dimensoes(produto, dims)
                destinos[chave] = {"status": "ok", "local": settings.rotulo_tiny(t["conta"]), "em": agora()}
            except Exception as e:
                destinos[chave] = {"status": "erro", "local": settings.rotulo_tiny(t["conta"]), "mensagem": str(e), "em": agora()}
        embalagem = embalagem_para(dims)
        for a in reg.get("anuncios") or []:
            chave = f"ml:{a['filial']}:{a['mlb']}"
            local = f"ML {settings.rotulos().get(a['filial'], a['filial'])} · {a['mlb']}"
            try:
                cliente = self.fabrica_ml(a["filial"])
                aviso = self._enviar_ml(cliente, a, dims, embalagem)
                destinos[chave] = {"status": "ok", "local": local, "em": agora(), **({"mensagem": aviso} if aviso else {})}
            except Exception as e:
                destinos[chave] = {"status": "erro", "local": local, "mensagem": str(e), "em": agora()}
            time.sleep(self.pausa)
        return destinos

    @staticmethod
    def _enviar_ml(cliente: ClienteML, anuncio: Dict[str, Any], dims: Dimensoes, embalagem: Optional[Dimensoes]) -> Optional[str]:
        """
        Ficha técnica (só os atributos de medida que o anúncio já usa) + embalagem padrão.
        Se o ML recusar a ficha, a embalagem vai sozinha e o aviso fica no resultado.
        """
        valores = {"altura": dims.altura, "largura": dims.largura, "comprimento": dims.comprimento, "peso": dims.peso}
        ficha = []
        for attr_id in anuncio.get("atributos") or []:
            campo = ATRIBUTO_ML_POR_CAMPO.get(attr_id)
            if campo and valores.get(campo):
                unidade = "g" if campo == "peso" else "cm"
                valor = valores[campo]
                ficha.append({"id": attr_id, "value_name": f"{_num_ml(valor)} {unidade}"})
        aviso = None
        if ficha:
            try:
                cliente.atualizar_atributos(anuncio["mlb"], ficha, f"atualizar a ficha técnica de {anuncio['mlb']}")
            except MLAPIError as e:
                aviso = f"Ficha técnica não aceita pelo ML ({e}); embalagem enviada."
        if embalagem is not None:
            cliente.enviar_medidas(anuncio["mlb"], embalagem)
        elif not ficha:
            return "Produto não cabe na embalagem padrão e o anúncio não tem atributos de medida: nada enviado ao ML."
        else:
            aviso = (aviso + " " if aviso else "") + "Produto não cabe na embalagem padrão: embalagem não enviada."
        return aviso


def _num_ml(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _padrao_publico(p: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "altura": p["altura_cm"], "largura": p["largura_cm"], "comprimento": p["comprimento_cm"], "peso": p.get("peso_g"),
        "embalagem_comprimento": p.get("embalagem_comprimento_cm"),
        "confiabilidade": p.get("confiabilidade"), "validado_por": p.get("validado_por"), "validado_em": p.get("validado_em"),
    }


def divergencias_do_padrao(padrao: Dict[str, Any], fontes: List[Dict[str, Any]]) -> List[str]:
    """Fichas técnicas (ML/Tiny) que mudaram depois da padronização. Título e descrição não contam."""
    alvo = Dimensoes(padrao["altura_cm"], padrao["largura_cm"], padrao["comprimento_cm"], padrao.get("peso_g"))
    motivos: List[str] = []
    for f in fontes:
        if f["fonte"] not in ("ml_ficha", "tiny_ficha"):
            continue
        d = Dimensoes.de_dict(f["dims"])
        if d.completas() and not mesmo_tamanho(d, alvo):
            motivos.append(f"{f['rotulo']} ({f['local']}) diferente do padrão")
        elif d.peso and alvo.peso and not mesmo_peso(d.peso, alvo.peso):
            motivos.append(f"Peso em {f['rotulo']} ({f['local']}) diferente do padrão")
    return motivos
