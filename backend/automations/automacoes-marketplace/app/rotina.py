"""
Automação 2 — Tipo de frete.

Rotina diária (por conta do Mercado Livre):
1. Sincroniza o catálogo de anúncios (menos carrinhos): tipo de envio, tags, SKUs.
2. Cada anúncio pega as medidas e o peso bruto do seu SKU no Tiny da mesma empresa (lidos pela
   coleta da automação 1). Elas são a embalagem (como no Tiny) e dão o envio indicado:
   maior lado até 2 m → ME2; maior → ME1 (só nas contas com ME1).
3. Anúncio "a combinar" com envio indicado: envia as medidas da embalagem (com o peso bruto) e
   troca para o envio indicado. A varredura (botão "Corrigir tipo de frete", `varredura=True`)
   também troca os anúncios já em ME1/ME2 cujo tipo não bate com a embalagem (ex.: 2 m em ME1);
   a rotina diária não.
4. Toda alteração é conferida FRETES_MINUTOS_CONFERENCIA minutos depois: o ML aceita o PUT e às
   vezes volta o anúncio para "a combinar" ou desfaz as medidas. Isso vira "ML desfez" na tela
   (com nova tentativa em lote) e notificação.

Sem medidas e peso bruto no Tiny o anúncio não é alterado.
"""
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

from app.config import FILIAIS, FUSO_SP, settings
from app.dimensoes import Dimensoes, e_carrinho, embalagem_no_ml, embalagem_para, envio_indicado, mesmo_tamanho
from app.estado import Estado, agora, chave_anuncio, ler_data
from app.ml_client import ClienteML, ContaNaoConectada

logger = logging.getLogger("marketplace.rotina")

A_COMBINAR = "not_specified"
STATUS_IGNORADOS = {"closed", "inactive"}

FabricaCliente = Callable[[str], ClienteML]

BLOQUEIO_TEXTO = {
    "sem_padrao": "Produto sem medidas ou peso bruto no Tiny da empresa: corrija o cadastro no Tiny.",
    "sem_sku": "Anúncio sem SKU no Mercado Livre: não dá para achar as medidas no Tiny.",
    "sem_embalagem": "Produto sem as três medidas no Tiny da empresa: corrija o cadastro no Tiny.",
    "sem_peso": "Produto sem peso bruto no Tiny: o ML exige o peso junto com as medidas.",
    "sem_me1": "Pelo tamanho só cabe no ME1, que não está ativo nesta conta.",
}


class Rotina:
    def __init__(
        self,
        estado: Estado,
        fonte_padroes: Optional[Callable[[], Dict[str, Dict[str, Dict[str, Any]]]]] = None,
        fabrica_cliente: Optional[FabricaCliente] = None,
        pausa: Optional[float] = None,
    ) -> None:
        self.estado = estado
        # {filial: {sku: medidas do Tiny}} — Padronizacao.padroes_por_filial
        self.fonte_padroes = fonte_padroes
        self.fabrica_cliente = fabrica_cliente or (lambda filial: ClienteML(filial, estado))
        self.pausa = settings.ML_PAUSA_ENTRE_ALTERACOES_S if pausa is None else pausa
        self._executando = threading.Lock()
        self.em_execucao: Optional[str] = None
        self._aviso_padroes_em = -1e9

    def padroes(self) -> Dict[str, Dict[str, Dict[str, Any]]]:
        if self.fonte_padroes is None:
            return {}
        try:
            return self.fonte_padroes()
        except Exception as e:
            logger.error(f"[FRETES] Não consegui ler as medidas do Tiny: {e}")
            # Sem as medidas todo anúncio fica bloqueado: o erro vai para o aviso, não só para o log.
            # No máximo um aviso por hora (a conferência chama isto a cada minuto).
            if time.monotonic() - self._aviso_padroes_em > 3600:
                self._aviso_padroes_em = time.monotonic()
                try:
                    with self.estado.alterar() as dados:
                        self.estado.registrar_aviso(
                            dados, "fretes_erro", "Medidas do Tiny indisponíveis", f"Não consegui ler as medidas do Tiny: {e}"[:500]
                        )
                except Exception:
                    logger.error("[FRETES] Não consegui registrar o aviso das medidas do Tiny.", exc_info=True)
            return {}

    # ------------------------------------------------------------------------------------------
    # Registro de anúncio
    # ------------------------------------------------------------------------------------------

    @staticmethod
    def _aplicar_dados_do_ml(reg: Dict[str, Any], item: Dict[str, Any]) -> None:
        envio = item.get("shipping") or {}
        skus = skus_do_anuncio(item)
        reg.update(
            titulo=item.get("title") or reg.get("titulo") or "",
            skus=skus,
            sku=", ".join(skus) or None,
            status=item.get("status") or reg.get("status"),
            permalink=item.get("permalink") or reg.get("permalink"),
            thumbnail=item.get("thumbnail") or reg.get("thumbnail"),
            modo_envio=envio.get("mode"),
            logistic_type=envio.get("logistic_type"),
            tags_envio=list(envio.get("tags") or []),
            free_shipping=bool(envio.get("free_shipping", False)),
            local_pick_up=bool(envio.get("local_pick_up", False)),
            embalagem_ml=embalagem_no_ml(item).para_dict(),
            sincronizado_em=agora(),
        )

    @staticmethod
    def avaliar(reg: Dict[str, Any], padroes: Dict[str, Dict[str, Dict[str, Any]]]) -> None:
        """Medidas do Tiny, embalagem, envio indicado e o que impede a troca (sem rede)."""
        por_sku = padroes.get(reg.get("filial") or "") or {}
        encontrados = [por_sku[s] for s in reg.get("skus") or [] if s in por_sku]
        reg["padrao"] = None
        reg["embalagem"] = None
        reg["envio_indicado"] = None
        if not reg.get("skus"):
            reg["bloqueio"] = "sem_sku"
            return
        if not encontrados:
            reg["bloqueio"] = "sem_padrao"
            return
        # Anúncio com variações de SKUs diferentes: vale a maior embalagem (cabe todas).
        melhor = None
        for p in encontrados:
            dims = Dimensoes(p["altura_cm"], p["largura_cm"], p["comprimento_cm"], p.get("peso_g"))
            emb = embalagem_para(dims)
            if melhor is None or (emb and (melhor[1] is None or emb.comprimento > melhor[1].comprimento)):
                melhor = (p, emb, dims)
        p, emb, dims = melhor  # type: ignore[misc]
        reg["padrao"] = {"sku": p["sku"], **dims.para_dict()}
        reg["embalagem"] = emb.para_dict() if emb else None
        indicado = envio_indicado(emb)
        reg["envio_indicado"] = indicado
        if emb is None:
            reg["bloqueio"] = "sem_embalagem"
        elif not dims.peso:
            reg["bloqueio"] = "sem_peso"
        elif indicado == "me1" and reg["filial"] not in settings.contas_com_me1():
            reg["bloqueio"] = "sem_me1"
        else:
            reg["bloqueio"] = None

    # ------------------------------------------------------------------------------------------
    # Rotina diária
    # ------------------------------------------------------------------------------------------

    def executar(self, origem: str = "agendada", varredura: bool = False) -> Dict[str, Any]:
        """
        Rotina diária: troca os anúncios "a combinar". Com `varredura`, também corrige os já em
        ME1/ME2 cujo tipo não bate com a embalagem (precisa_corrigir).
        """
        if not self._executando.acquire(blocking=False):
            return {"status": "ignorada", "mensagem": "Já existe uma verificação em andamento."}
        inicio = agora()
        self.em_execucao = inicio
        # Marca no disco: um restart no meio deixa rastro (lifespan registra a execução interrompida).
        with self.estado.alterar() as dados:
            dados["execucao_em_andamento"] = inicio
        resumo: Dict[str, Any] = {"contas": {}, "novos": 0, "trocas": 0, "corrigidos": 0, "erros": []}
        try:
            padroes = self.padroes()
            for filial in FILIAIS:
                try:
                    self._executar_conta(filial, resumo, padroes, varredura)
                except ContaNaoConectada as e:
                    resumo["contas"][filial] = {"status": "nao_conectada", "mensagem": str(e)}
                except Exception as e:  # uma conta com problema não impede a outra
                    logger.error(f"[FRETES] Falha na conta {filial}: {e}", exc_info=True)
                    resumo["contas"][filial] = {"status": "erro", "mensagem": str(e)}
                    resumo["erros"].append(f"{settings.rotulos()[filial]}: {e}")
            status = "erro" if resumo["erros"] and not any(
                c.get("status") == "ok" for c in resumo["contas"].values()
            ) else ("parcial" if resumo["erros"] else "ok")
        finally:
            self.em_execucao = None
            self._executando.release()

        with self.estado.alterar() as dados:
            dados["execucao_em_andamento"] = None
            self.estado.registrar_execucao(
                dados, {"iniciada_em": inicio, "concluida_em": agora(), "origem": origem, "status": status, "resumo": resumo}
            )
            if resumo["erros"]:
                self.estado.registrar_aviso(
                    dados, "fretes_erro", "Falha na verificação diária de fretes", "; ".join(resumo["erros"])[:500]
                )
        return {"status": status, "iniciada_em": inicio, "resumo": resumo}

    def _executar_conta(
        self, filial: str, resumo: Dict[str, Any], padroes: Dict[str, Dict[str, Dict[str, Any]]], varredura: bool = False
    ) -> None:
        cliente = self.fabrica_cliente(filial)
        itens = list(cliente.anuncios(cliente.ids_dos_anuncios()))

        novos = 0
        with self.estado.alterar() as dados:
            for chave in [k for k, r in dados["anuncios"].items() if r["filial"] == filial and e_carrinho(r.get("titulo"))]:
                del dados["anuncios"][chave]
            for item in itens:
                if item.get("status") in STATUS_IGNORADOS or e_carrinho(item.get("title")):
                    continue
                chave = chave_anuncio(filial, item["id"])
                reg = dados["anuncios"].get(chave)
                if reg is None:
                    reg = {"filial": filial, "mlb": item["id"], "criado_em": agora(), "falha_envio": None}
                    dados["anuncios"][chave] = reg
                    novos += 1
                # Campos do modelo antigo (medidas por anúncio) saem: a medida agora é por SKU.
                for antigo in ("dims", "dims_ml", "origem_dims", "pendencia", "peso_ml"):
                    reg.pop(antigo, None)
                self._aplicar_dados_do_ml(reg, item)
                self.avaliar(reg, padroes)
            aguardando = _aguardando(dados)
            candidatos = [
                dict(r)
                for k, r in dados["anuncios"].items()
                if r["filial"] == filial
                and r.get("status") == "active"
                and (r.get("modo_envio") == A_COMBINAR or (varredura and precisa_corrigir(r)))
                and r.get("envio_indicado")
                and not r.get("bloqueio")
                and k not in aguardando
            ]

        trocas = corrigidos = 0
        erros_troca: List[str] = []
        for reg in candidatos:
            try:
                self._trocar_envio(cliente, reg, reg["envio_indicado"], origem="varredura" if varredura else "rotina")
                if reg.get("modo_envio") == A_COMBINAR:
                    trocas += 1
                else:
                    corrigidos += 1
            except Exception as e:
                erros_troca.append(f"{reg['mlb']}: {e}")
                self._registrar_falha(reg, str(e))
            time.sleep(self.pausa)

        resumo["contas"][filial] = {
            "status": "ok",
            "anuncios": len(itens),
            "novos": novos,
            "a_combinar_trocados": trocas,
            "tipo_corrigido": corrigidos,
            "falhas_de_troca": len(erros_troca),
        }
        resumo["novos"] += novos
        resumo["trocas"] += trocas
        resumo["corrigidos"] += corrigidos
        if erros_troca:
            resumo["erros"].append(f"{settings.rotulos()[filial]}: {len(erros_troca)} troca(s) de frete falharam")

    # ------------------------------------------------------------------------------------------
    # Alterações no ML
    # ------------------------------------------------------------------------------------------

    def _trocar_envio(self, cliente: ClienteML, reg: Dict[str, Any], modo: str, origem: str, usuario: Optional[str] = None) -> Dict[str, Any]:
        embalagem = Dimensoes.de_dict(reg.get("embalagem"))
        envio_atual = {"free_shipping": reg.get("free_shipping"), "local_pick_up": reg.get("local_pick_up")}
        cliente.enviar_medidas(reg["mlb"], embalagem)
        cliente.trocar_envio(reg["mlb"], embalagem, modo, envio_atual)
        return self._agendar_conferencia(reg, de=reg.get("modo_envio"), para=modo, origem=origem, usuario=usuario)

    def _agendar_conferencia(
        self, reg: Dict[str, Any], de: Optional[str], para: Optional[str], origem: str, usuario: Optional[str]
    ) -> Dict[str, Any]:
        verificar_em = datetime.now(FUSO_SP) + timedelta(minutes=settings.FRETES_MINUTOS_CONFERENCIA)
        with self.estado.alterar() as dados:
            return self.estado.registrar_troca(
                dados,
                {
                    "filial": reg["filial"],
                    "mlb": reg["mlb"],
                    "titulo": reg.get("titulo"),
                    "de": de,
                    "para": para,
                    "dims": reg.get("embalagem"),
                    "origem": origem,
                    "usuario": usuario,
                    "feita_em": agora(),
                    "verificar_em": verificar_em.isoformat(timespec="seconds"),
                    "status": "aguardando",
                    "mensagem": None,
                },
            )

    def _registrar_falha(self, reg: Dict[str, Any], mensagem: str) -> None:
        with self.estado.alterar() as dados:
            atual = dados["anuncios"].get(chave_anuncio(reg["filial"], reg["mlb"]))
            if atual is not None:
                atual["falha_envio"] = {"mensagem": mensagem, "em": agora()}
            self.estado.registrar_troca(
                dados,
                {
                    "filial": reg["filial"],
                    "mlb": reg["mlb"],
                    "titulo": reg.get("titulo"),
                    "de": reg.get("modo_envio"),
                    "para": reg.get("envio_indicado"),
                    "dims": reg.get("embalagem"),
                    "origem": "rotina",
                    "usuario": None,
                    "feita_em": agora(),
                    "verificar_em": None,
                    "status": "erro",
                    "mensagem": mensagem,
                },
            )

    # ------------------------------------------------------------------------------------------
    # Ações da tela
    # ------------------------------------------------------------------------------------------

    def retentar(self, anuncios: List[Dict[str, str]], usuario: Optional[str] = None) -> Dict[str, Any]:
        """
        Nova tentativa nos anúncios que o ML desfez (aba "ML desfez"), com as medidas atuais do
        Tiny: a combinar ou tipo inconsistente → embalagem + troca para o envio indicado; senão só a
        embalagem. Cada um ganha nova conferência; se o ML desfizer de novo, volta à lista.
        """
        resultado: Dict[str, Any] = {"enviados": 0, "ignorados": [], "erros": []}
        padroes = self.padroes()
        dados = self.estado.ler()
        aguardando = _aguardando(dados)
        for alvo in anuncios:
            filial, mlb = alvo.get("filial") or "", alvo.get("mlb") or ""
            chave = chave_anuncio(filial, mlb)
            reg = dict(dados["anuncios"].get(chave) or {})
            if not reg:
                resultado["ignorados"].append(f"{mlb}: não está no catálogo")
                continue
            if chave in aguardando:
                resultado["ignorados"].append(f"{mlb}: já aguardando conferência")
                continue
            self.avaliar(reg, padroes)
            if reg.get("bloqueio"):
                resultado["ignorados"].append(f"{mlb}: {BLOQUEIO_TEXTO[reg['bloqueio']]}")
                continue
            try:
                cliente = self.fabrica_cliente(filial)
                if reg.get("envio_indicado") and (reg.get("modo_envio") == A_COMBINAR or precisa_corrigir(reg)):
                    self._trocar_envio(cliente, reg, reg["envio_indicado"], origem="manual", usuario=usuario)
                else:
                    cliente.enviar_medidas(mlb, Dimensoes.de_dict(reg.get("embalagem")))
                    self._agendar_conferencia(reg, de=reg.get("modo_envio"), para=None, origem="manual", usuario=usuario)
                with self.estado.alterar() as dados_w:
                    atual = dados_w["anuncios"].get(chave)
                    if atual is not None:
                        atual["falha_envio"] = None
                resultado["enviados"] += 1
            except Exception as e:
                logger.warning(f"[FRETES] Nova tentativa de {mlb} falhou: {e}")
                self._registrar_falha(reg, str(e))
                resultado["erros"].append(f"{mlb}: {e}")
            time.sleep(self.pausa)
        return resultado

    # ------------------------------------------------------------------------------------------
    # Conferência depois da espera
    # ------------------------------------------------------------------------------------------

    def conferir_vencidas(self) -> int:
        """Confere as alterações cujo prazo de espera já passou. Devolve quantas conferiu."""
        agora_dt = datetime.now(FUSO_SP)
        dados = self.estado.ler()
        vencidas = [
            dict(t)
            for t in dados["trocas"]
            if t.get("status") == "aguardando" and t.get("verificar_em") and ler_data(t["verificar_em"]) <= agora_dt
        ]
        revertidas: List[str] = []
        padroes = self.padroes() if vencidas else {}
        for troca in vencidas:
            try:
                item = self.fabrica_cliente(troca["filial"]).anuncio(troca["mlb"])
            except Exception as e:
                logger.warning(f"[FRETES] Conferência de {troca['mlb']} adiada: {e}")
                # Fica no histórico (a troca continua "aguardando" e será tentada de novo).
                try:
                    with self.estado.alterar() as dados_w:
                        for t in dados_w["trocas"]:
                            if t.get("id") == troca.get("id"):
                                t["erro_conferencia"] = {"mensagem": str(e)[:300], "em": agora()}
                except Exception:
                    logger.error("[FRETES] Não consegui gravar o erro da conferência.", exc_info=True)
                continue
            modo = (item.get("shipping") or {}).get("mode")
            tags = (item.get("shipping") or {}).get("tags") or []
            problemas: List[str] = []
            if troca.get("para") and modo != troca["para"]:
                problemas.append(
                    f"o Mercado Livre deixou o frete em '{_rotulo_modo(modo)}' em vez de '{_rotulo_modo(troca['para'])}'"
                    f" (tags do envio: {', '.join(tags) or 'nenhuma'})"
                )
            enviada = Dimensoes.de_dict(troca.get("dims"))
            if enviada.completas() and not mesmo_tamanho(Dimensoes(*enviada.para_ml().lados), embalagem_no_ml(item)):
                problemas.append("o Mercado Livre desfez as medidas da embalagem")
            with self.estado.alterar() as dados_w:
                for t in dados_w["trocas"]:
                    if t["id"] == troca["id"]:
                        t["status"] = "revertido" if problemas else "ok"
                        t["mensagem"] = ("Após a espera, " + "; ".join(problemas) + ".") if problemas else None
                        t["verificado_em"] = agora()
                reg = dados_w["anuncios"].get(chave_anuncio(troca["filial"], troca["mlb"]))
                if reg is not None:
                    self._aplicar_dados_do_ml(reg, item)
                    self.avaliar(reg, padroes)
                    reg["falha_envio"] = {"mensagem": "; ".join(problemas), "em": agora()} if problemas else None
            if problemas:
                revertidas.append(troca["mlb"])
        if revertidas:
            with self.estado.alterar() as dados_w:
                self.estado.registrar_aviso(
                    dados_w,
                    "fretes_revertido",
                    f"Mercado Livre desfez {len(revertidas)} alteração(ões) de frete",
                    f"Anúncios: {', '.join(revertidas[:10])}{'…' if len(revertidas) > 10 else ''}. "
                    "Veja o card ML desfez em Tipo de frete.",
                )
        return len(vencidas)


def precisa_corrigir(reg: Dict[str, Any]) -> bool:
    """Já em ME1/ME2 (fora do Full) com o tipo diferente do indicado pela embalagem (ex.: 2 m em ME1)."""
    return (
        reg.get("modo_envio") in ("me1", "me2")
        and reg.get("logistic_type") != "fulfillment"
        and bool(reg.get("envio_indicado"))
        and reg.get("modo_envio") != reg.get("envio_indicado")
    )


def _aguardando(dados: Dict[str, Any]) -> set:
    return {chave_anuncio(t["filial"], t["mlb"]) for t in dados["trocas"] if t.get("status") == "aguardando"}


def skus_do_anuncio(item: Dict[str, Any]) -> List[str]:
    """
    SKUs do anúncio. O atributo SELLER_SKU (do item e das variações; as variações só vêm com
    include_attributes=all) é o SKU de verdade. O seller_custom_field só entra quando nenhum nível
    tem SELLER_SKU, porque em anúncios antigos ele guarda o código legado (ex.: "4203" num anúncio
    cujo SKU é "LHD1111BD20").
    """
    niveis = [item, *(item.get("variations") or [])]
    skus = [
        str(a["value_name"]).strip()
        for nivel in niveis
        for a in nivel.get("attributes") or []
        if a.get("id") == "SELLER_SKU" and a.get("value_name")
    ]
    if not any(skus):
        skus = [str(n["seller_custom_field"]).strip() for n in niveis if n.get("seller_custom_field")]
    return [s for s in dict.fromkeys(skus) if s]


def _rotulo_modo(modo: Optional[str]) -> str:
    return {"me1": "ME1", "me2": "ME2", A_COMBINAR: "a combinar", "custom": "personalizado"}.get(modo or "", modo or "—")
