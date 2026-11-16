"""
Automação 1 — Padronização de dimensões: o cadastro do Tiny é a fonte das medidas.

Coleta (diária ou sob demanda):
1. Mercado Livre (todas as contas): anúncios (menos carrinhos), SKUs, ficha técnica e embalagem.
2. Tiny da MESMA empresa de cada conta do ML (TINY_CONTA_POR_FILIAL), só dos SKUs anunciados:
   altura, largura, comprimento e peso bruto. O cadastro completo só é relido quando
   `dataAlteracao` muda (cache em dimensoes.json).
3. Cada anúncio é comparado com o Tiny: ficha técnica (só os atributos de medida que o anúncio
   já usa) e embalagem (as medidas do Tiny, com o peso bruto). Diferente → o SKU
   fica "a enviar"; sem o SKU ou sem medida/peso bruto no Tiny → "sem medida no Tiny" (corrigir
   no Tiny).

Envio (tela, confirmado em lote, sem editar medidas): só ao ML, nos anúncios que estão diferentes
do Tiny. A automação não grava no Tiny.
"""
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from app.config import FILIAIS, settings
from app.dimensoes import (
    Dimensoes,
    e_carrinho,
    embalagem_no_ml,
    embalagem_para,
    ficha_ml,
    medidas_tiny,
    mesmo_peso,
    mesmo_tamanho,
    peso_liquido_tiny,
    valores_ficha,
)
from app.estado import Estado, agora
from app.ml_client import ClienteML, ContaNaoConectada, MLAPIError
from app.rotina import skus_do_anuncio
from app.tiny_client import ClienteTiny

logger = logging.getLogger("marketplace.padronizacao")

STATUS_ANUNCIO_OK = ("active", "paused", "under_review")
# Atributos da ficha técnica do ML que recebem a medida do Tiny (só os que o anúncio já usa:
# atributo que não existe na categoria é recusado pelo ML). NET_WEIGHT recebe o peso líquido.
ATRIBUTO_ML_POR_CAMPO = {
    "HEIGHT": "altura", "THICKNESS": "altura", "WIDTH": "largura", "LENGTH": "comprimento",
    "WEIGHT": "peso", "NET_WEIGHT": "peso_liquido",
}

# Situação de cada anúncio diante do Tiny.
IGUAL, DIFERENTE, SEM_TINY, SEM_MEDIDA = "igual", "diferente", "sem_tiny", "sem_medida"
# Diferente do Tiny, mas o ML não aceita alteração agora (anúncio em revisão, ou o ML já recusou
# com `item.attributes.not_modifiable`, ex.: anúncio de catálogo). Não conta como "a enviar".
BLOQUEADO_ML = "bloqueado_ml"
MSG_EM_REVISAO = (
    "Anúncio em revisão no Mercado Livre: o ML não aceita alterar as medidas até a revisão terminar. "
    "Ele volta para a lista na primeira coleta depois de liberado."
)
MSG_NAO_MODIFICAVEL = (
    "O Mercado Livre não deixa alterar as medidas deste anúncio (ex.: anúncio de catálogo ou em revisão). "
    "Nova tentativa em {dias} dias; até lá ele fica fora da lista a enviar."
)
MSG_PESO_PEQUENO = (
    "O Mercado Livre recusa o peso de {peso} g para uma embalagem de {medidas}: acha leve demais para "
    "o tamanho. Confira o peso bruto no Tiny (com a embalagem); com o peso corrigido, ele volta para a "
    "lista na próxima coleta."
)
# Quanto tempo um anúncio recusado com "not_modifiable" fica fora da lista antes de tentar de novo.
DIAS_REJEITADO_ML = 7


def recusa_nao_modificavel(erro: Exception) -> bool:
    """O ML recusou porque o anúncio não aceita alteração (não é erro de dado nosso)."""
    texto = str(erro)
    return "not_modifiable" in texto or "status:under_review" in texto


def recusa_peso_pequeno(erro: Exception) -> bool:
    """O ML acha o peso da embalagem pequeno demais para as medidas: reenviar o mesmo dado não adianta."""
    texto = str(erro)
    return "seller_package_weight" in texto and "too small" in texto


def aplicar_bloqueio_ml(anuncio: Dict[str, Any], comp: Dict[str, Any], rejeitados: Dict[str, Any]) -> Dict[str, Any]:
    """Anúncio diferente do Tiny que o ML não deixa alterar vira BLOQUEADO_ML (fora de "a enviar")."""
    if comp.get("situacao") != DIFERENTE:
        return comp
    if anuncio.get("status_ml") == "under_review":
        return {**comp, "situacao": BLOQUEADO_ML, "mensagem": MSG_EM_REVISAO}
    rejeitado = rejeitados.get(anuncio.get("mlb"))
    # Recusa presa a uma embalagem (peso pequeno): vale enquanto o Tiny mandar a mesma embalagem.
    if rejeitado and rejeitado.get("embalagem") not in (None, comp.get("embalagem_alvo")):
        return comp
    if rejeitado:
        return {**comp, "situacao": BLOQUEADO_ML, "mensagem": rejeitados[anuncio["mlb"]].get("mensagem") or MSG_NAO_MODIFICAVEL.format(dias=DIAS_REJEITADO_ML)}
    return comp


def descartar_skus_fora_do_tiny(ml: Dict[str, Dict[str, List[Dict[str, Any]]]], tiny, contas_com_erro: set) -> None:
    """
    Anúncio com mais de um SKU candidato: os que não existem no Tiny da empresa são descartados
    quando outro candidato do mesmo anúncio existe lá (código legado não vira produto fantasma).
    Conta do Tiny que falhou na coleta não descarta nada.
    """
    for filial, por_sku in ml.items():
        conta = settings.tiny_por_filial().get(filial)
        if not conta or conta in contas_com_erro:
            continue
        cadastrados = tiny.get(conta) or {}
        mlbs_no_tiny = {a["mlb"] for sku, anuncios in por_sku.items() if sku in cadastrados for a in anuncios}
        for sku in [s for s in por_sku if s not in cadastrados]:
            restantes = [a for a in por_sku[sku] if a["mlb"] not in mlbs_no_tiny]
            if restantes:
                por_sku[sku] = restantes
            else:
                del por_sku[sku]


def enviados_ml(dados: Dict[str, Any]) -> Dict[str, str]:
    """
    {sku: data do 1º envio com sucesso} — base do ROI. O registro em "enviados_ml" não é apagado
    pela coleta (que refaz a lista de produtos e perderia o envio de SKU que mudou ou sumiu) nem
    por um reenvio; produto com envio ok ainda não registrado (antes deste registro) também conta.
    """
    enviados = {sku: r["em"] for sku, r in (dados.get("enviados_ml") or {}).items() if r.get("em")}
    for sku, p in (dados.get("produtos") or {}).items():
        envio = p.get("envio") or {}
        algum_ok = envio.get("status") == "ok" or any(d.get("status") == "ok" for d in (envio.get("destinos") or {}).values())
        if sku not in enviados and algum_ok and envio.get("em"):
            enviados[sku] = envio["em"]
    return enviados


def _registrar_enviado(dados: Dict[str, Any], sku: str, em: str) -> None:
    dados.setdefault("enviados_ml", {}).setdefault(sku, {"em": em})


def rejeitados_validos(dados: Dict[str, Any], agora_dt: Optional[datetime] = None) -> Dict[str, Any]:
    """Recusas `not_modifiable` dos últimos DIAS_REJEITADO_ML dias (as mais velhas são tentadas de novo)."""
    agora_dt = agora_dt or datetime.fromisoformat(agora())
    limite = agora_dt - timedelta(days=DIAS_REJEITADO_ML)
    validos = {}
    for mlb, info in (dados.get("rejeitados_ml") or {}).items():
        try:
            if datetime.fromisoformat(info["em"]) >= limite:
                validos[mlb] = info
        except (KeyError, TypeError, ValueError):
            continue
    return validos


class ColetaSemAnuncios(RuntimeError):
    pass


# Esperas (s) antes de reler o ml_tokens.json quando o ML recusa o token na coleta agendada. O
# token vem do TMS pelo cron scripts/sync_ml_tokens.py (a cada 30 min): em 08/11/2026 às 06h as
# duas contas deram 401 e às 06h do dia seguinte já estavam válidas. 2 × 20 min cobre um ciclo
# do cron com folga. A coleta manual não espera: quem clicou vê o erro na hora.
ESPERAS_TOKEN_ML: Tuple[float, ...] = (1200.0, 1200.0)


def vazio_dimensoes() -> Dict[str, Any]:
    return {
        "produtos": {}, "cache_tiny": {}, "anuncios_sem_sku": [], "rejeitados_ml": {}, "ficha_mantida_ml": {}, "embalagem_mantida_ml": {}, "enviados_ml": {},
        "execucoes": [], "em_execucao": None, "progresso": None,
    }


def _num_ml(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _texto_medidas(d: Dimensoes) -> str:
    lados = " x ".join(_num_ml(v) if v else "?" for v in d.lados)
    return f"{lados} cm, {d.peso or '?'} g"


def alvo_dos_atributos(atributos: List[str], medidas: Dimensoes, peso_liquido: Optional[int]) -> Dict[str, float]:
    """Valor que cada atributo de medida da ficha deve ter, pelo Tiny (sem valor: fica de fora)."""
    valores = {
        "altura": medidas.altura, "largura": medidas.largura, "comprimento": medidas.comprimento,
        "peso": medidas.peso, "peso_liquido": peso_liquido,
    }
    alvo: Dict[str, float] = {}
    for attr_id in atributos:
        v = valores.get(ATRIBUTO_ML_POR_CAMPO.get(attr_id, ""))
        if v:
            alvo[attr_id] = float(v)
    return alvo


def mesmo_valor_ficha(attr_id: str, tem: Optional[float], valor: Optional[float]) -> bool:
    if "WEIGHT" in attr_id:
        return mesmo_peso(int(round(tem)) if tem else None, int(round(valor)) if valor else None)
    return bool(tem and valor) and abs(tem - valor) <= 0.5  # type: ignore[operator]


def comparar_anuncio(anuncio: Dict[str, Any], tiny: Optional[Dict[str, Any]], rotulo_tiny: str) -> Dict[str, Any]:
    """
    Situação do anúncio diante do cadastro do Tiny da empresa (sem rede): o que deve ir para a
    ficha e para a embalagem, e as diferenças. `tiny` = {id, sku, descricao, dimensoes} ou None.
    """
    if tiny is None:
        return {"situacao": SEM_TINY, "conta_tiny": rotulo_tiny, "alvo": None, "ficha_alvo": {}, "embalagem_alvo": None,
                "ficha_diferente": [], "embalagem_diferente": False,
                "diferencas": [], "mensagem": f"SKU não encontrado no {rotulo_tiny}."}
    medidas = medidas_tiny(tiny)
    falta = medidas.faltando() + ([] if medidas.peso else ["peso bruto"])
    if falta:
        return {"situacao": SEM_MEDIDA, "conta_tiny": rotulo_tiny, "alvo": medidas.para_dict(), "ficha_alvo": {},
                "embalagem_alvo": None, "ficha_diferente": [], "embalagem_diferente": False, "diferencas": [],
                "mensagem": f"Cadastro no {rotulo_tiny} sem {', '.join(falta)}."}
    ficha_alvo = alvo_dos_atributos(anuncio.get("atributos") or [], medidas, peso_liquido_tiny(tiny))
    embalagem = embalagem_para(medidas)
    diferencas: List[str] = []
    ficha_diferente: List[str] = []
    embalagem_diferente = False
    atual = anuncio.get("ficha_atual") or {}
    for attr_id, valor in ficha_alvo.items():
        tem = atual.get(attr_id)
        unidade = "g" if "WEIGHT" in attr_id else "cm"
        if not mesmo_valor_ficha(attr_id, tem, valor):
            ficha_diferente.append(attr_id)
            diferencas.append(f"Ficha {attr_id}: {_num_ml(tem) + ' ' + unidade if tem else 'vazio'} → {_num_ml(valor)} {unidade}")
    if embalagem is not None:
        no_ml = Dimensoes.de_dict(anuncio.get("embalagem_ml"))
        alvo_ml = embalagem.para_ml()
        if not (mesmo_tamanho(no_ml, alvo_ml) and mesmo_peso(no_ml.peso, alvo_ml.peso)):
            embalagem_diferente = True
            texto_ml = _texto_medidas(no_ml) if no_ml.completas() else "vazia"
            diferencas.append(f"Embalagem: {texto_ml} → {_texto_medidas(alvo_ml)}")
    return {
        "situacao": DIFERENTE if diferencas else IGUAL,
        "conta_tiny": rotulo_tiny,
        "alvo": medidas.para_dict(),
        "ficha_alvo": ficha_alvo,
        "embalagem_alvo": embalagem.para_dict() if embalagem else None,
        # O que vai no envio: só os atributos e a embalagem que estão diferentes do Tiny.
        "ficha_diferente": ficha_diferente,
        "embalagem_diferente": embalagem_diferente,
        "diferencas": diferencas,
        "mensagem": None,
    }


def nao_ficou_no_ml(item: Dict[str, Any], anuncio: Dict[str, Any], conferir_ficha: bool) -> Tuple[Dict[str, Optional[float]], Optional[str]]:
    """
    Releitura do anúncio logo depois do envio: o que o ML respondeu OK mas não guardou.
    ({atributo da ficha: valor que o ML manteve}, texto da embalagem que não ficou ou None).
    Na embalagem, diz de onde veio a leitura (SELLER_PACKAGE_* ou shipping.dimensions).
    """
    mantida: Dict[str, Optional[float]] = {}
    alvo = anuncio.get("ficha_alvo") or {}
    ids = [i for i in anuncio.get("ficha_diferente") or [] if i in alvo] if conferir_ficha else []
    for attr_id, tem in valores_ficha(item, ids).items():
        if not mesmo_valor_ficha(attr_id, tem, alvo[attr_id]):
            mantida[attr_id] = tem
    embalagem = None
    if anuncio.get("embalagem_diferente") and anuncio.get("embalagem_alvo"):
        no_ml = embalagem_no_ml(item)
        alvo_ml = Dimensoes.de_dict(anuncio["embalagem_alvo"]).para_ml()
        if not (mesmo_tamanho(no_ml, alvo_ml) and mesmo_peso(no_ml.peso, alvo_ml.peso)):
            pacote = any(str(a.get("id", "")).startswith("SELLER_PACKAGE_") for a in item.get("attributes") or [])
            origem = "SELLER_PACKAGE_*" if pacote else f"sem SELLER_PACKAGE_*, shipping.dimensions {(item.get('shipping') or {}).get('dimensions')}"
            embalagem = f"embalagem {_texto_medidas(no_ml)} ({origem}; enviado {_texto_medidas(alvo_ml)})"
    return mantida, embalagem


def _texto_ficha(mantida: Dict[str, Optional[float]], alvo: Dict[str, float]) -> str:
    return "; ".join(f"ficha {k} {_num_ml(v) if v else 'vazio'} (enviado {_num_ml(alvo[k])})" for k, v in mantida.items())


def aplicar_ficha_mantida(anuncio: Dict[str, Any], comp: Dict[str, Any], mantidas: Dict[str, Any]) -> Dict[str, Any]:
    """
    Atributo da ficha que o ML aceitou no PUT mas manteve (ex.: ficha vinda do catálogo) sai do
    "a enviar" enquanto o ML continuar com o mesmo valor; se o valor no ML mudar, volta a comparar.
    """
    mantida = mantidas.get(anuncio.get("mlb")) or {}
    if comp.get("situacao") != DIFERENTE or not mantida:
        return comp
    atual = anuncio.get("ficha_atual") or {}
    fora = [i for i in comp["ficha_diferente"] if i in mantida and mesmo_valor_ficha(i, atual.get(i), mantida[i])]
    if not fora:
        return comp
    ficha_diferente = [i for i in comp["ficha_diferente"] if i not in fora]
    diferencas = [d for d in comp["diferencas"] if not any(d.startswith(f"Ficha {i}:") for i in fora)]
    aviso = f"O ML não aceita alterar {', '.join(fora)} da ficha deste anúncio (mantém o valor atual)."
    return {
        **comp,
        "situacao": DIFERENTE if diferencas else IGUAL,
        "ficha_diferente": ficha_diferente,
        "diferencas": diferencas,
        "mensagem": " ".join(filter(None, [comp.get("mensagem"), aviso])),
    }


def e_me1(anuncio: Dict[str, Any]) -> bool:
    return (anuncio.get("envio_ml") or {}).get("mode") == "me1"


def embalagem_voltou(enviado: Dict[str, Any], anuncio: Dict[str, Any]) -> bool:
    """
    A embalagem foi enviada e conferida (OK) e a coleta lê outra no ML: o ML pôs a dele de volta
    (anúncio de produto de catálogo ou com medidas aferidas pelo ML, sem opção de alterar).
    Envio sem a embalagem registrada (antes de 28/10 14h) mandava a padrão 5 x 7.
    """
    if enviado.get("status") != "ok":
        return False
    # ME1 que só recebeu os SELLER_PACKAGE_* (antes de 28/10 ~15h): ainda falta o shipping.dimensions.
    if e_me1(anuncio) and not enviado.get("dimensoes_envio"):
        return False
    no_ml = Dimensoes.de_dict(anuncio.get("embalagem_ml"))
    if not no_ml.completas():
        return False
    if "embalagem" in enviado:
        if not enviado["embalagem"]:
            return False
        mandada = Dimensoes.de_dict(enviado["embalagem"]).para_ml()
        return not (mesmo_tamanho(no_ml, mandada) and mesmo_peso(no_ml.peso, mandada.peso))
    menor, meio, _ = sorted(no_ml.lados)  # type: ignore[type-var]
    return not (abs(menor - 5) <= 0.5 and abs(meio - 7) <= 0.5)


def aplicar_embalagem_mantida(anuncio: Dict[str, Any], comp: Dict[str, Any], mantidas: Dict[str, Any]) -> Dict[str, Any]:
    """
    Embalagem que o ML pôs de volta depois do envio sai do "a enviar" enquanto o ML mantiver a
    mesma; se o valor no ML mudar, volta a comparar. Sem mais nada diferente: BLOQUEADO_ML.
    """
    mantida = mantidas.get(anuncio.get("mlb"))
    if comp.get("situacao") != DIFERENTE or not comp.get("embalagem_diferente") or not mantida:
        return comp
    if e_me1(anuncio) and not mantida.get("dimensoes_envio"):
        return comp  # guardada antes de o ME1 receber o shipping.dimensions: vale tentar
    no_ml, guardada = Dimensoes.de_dict(anuncio.get("embalagem_ml")), Dimensoes.de_dict(mantida.get("embalagem"))
    if not (mesmo_tamanho(no_ml, guardada) and mesmo_peso(no_ml.peso, guardada.peso)):
        return comp
    diferencas = [d for d in comp["diferencas"] if not d.startswith("Embalagem:")]
    aviso = (f"O ML pôs de volta a embalagem {_texto_medidas(no_ml.para_ml())} depois do envio de "
             f"{mantida.get('enviado_em', '')[:16].replace('T', ' ')} (produto de catálogo ou medidas do próprio ML, "
             "sem opção de alterar). Não é reenviada enquanto o ML mantiver esse valor.")
    return {
        **comp,
        "situacao": DIFERENTE if diferencas else BLOQUEADO_ML,
        "embalagem_diferente": False,
        "diferencas": diferencas,
        "mensagem": " ".join(filter(None, [comp.get("mensagem"), aviso])),
    }


def status_do_produto(anuncios: List[Dict[str, Any]]) -> str:
    """
    'pendente' (algum anúncio a enviar), 'bloqueado' (o ML não aceita a alteração: pendência a
    resolver no Tiny ou no ML, reenviar não adianta), 'sem_medida' (falta no Tiny) ou 'padronizado'.
    """
    situacoes = {a.get("situacao") for a in anuncios}
    if DIFERENTE in situacoes:
        return "pendente"
    if BLOQUEADO_ML in situacoes:
        return "bloqueado"
    if situacoes & {SEM_TINY, SEM_MEDIDA}:
        return "sem_medida"
    return "padronizado"


class Padronizacao:
    def __init__(
        self,
        estado: Estado,
        repositorio: Any,
        fabrica_ml: Optional[Callable[[str], ClienteML]] = None,
        fabrica_tiny: Optional[Callable[[str], ClienteTiny]] = None,
        pausa: float = 0.3,
        estado_fretes: Optional[Estado] = None,
        espera_conferencia: float = 2.0,
        esperas_token: Sequence[float] = ESPERAS_TOKEN_ML,
    ) -> None:
        self.estado = estado
        self.repo = repositorio  # só os tokens do Tiny (financeiro.api_tokens)
        self.fabrica_ml = fabrica_ml or (lambda filial: ClienteML(filial, estado_fretes or estado))
        self.fabrica_tiny = fabrica_tiny or (lambda conta: ClienteTiny(conta, lambda: self.repo.token_tiny(conta)))
        self.pausa = pausa
        self.espera_conferencia = espera_conferencia  # entre o envio e a releitura do anúncio
        self.estado_fretes = estado_fretes  # avisos para o gateway notificar
        self.esperas_token = tuple(esperas_token)
        self.parar = threading.Event()  # desligamento do serviço: interrompe a espera pelo token
        self._executando = threading.Lock()
        self._enviando = threading.Lock()

    # ------------------------------------------------------------------------------------------
    # Coleta
    # ------------------------------------------------------------------------------------------

    def coletar(self, origem: str = "agendada") -> Dict[str, Any]:
        """
        ML primeiro (anúncios e SKUs), depois o Tiny de cada empresa, só dos SKUs anunciados nela.
        Progresso na tela e no log; o cache do Tiny é gravado aos poucos, para um restart no meio
        não perder o que já foi lido.
        """
        if not self._executando.acquire(blocking=False):
            return {"status": "ignorada", "mensagem": "Já existe uma coleta em andamento."}
        inicio = agora()
        with self.estado.alterar() as dados:
            dados["em_execucao"] = inicio
            dados["progresso"] = None
        erros: List[str] = []
        try:
            ml, sem_sku, desconectadas = self._coletar_ml(erros, origem)
            if desconectadas and (any(ml.values()) or sem_sku):
                # Uma conta só: a coleta segue com a outra, mas a recusa do token precisa de aviso.
                logger.error(f"[DIMENSOES] Token do ML recusado após as novas tentativas: {'; '.join(desconectadas)}")
            if not any(ml.values()) and not sem_sku:
                # Sem nenhum anúncio (token do ML expirado, conta desconectada): não há o que
                # padronizar, e ler o Tiny seria tempo perdido. Os produtos da coleta anterior ficam.
                raise ColetaSemAnuncios(
                    "Nenhum anúncio lido do Mercado Livre (access token expirado ou conta sem conexão?). "
                    "Coleta interrompida antes do Tiny."
                )
            tiny, contas_com_erro = self._coletar_tiny(erros, ml)
            descartar_skus_fora_do_tiny(ml, tiny, contas_com_erro)
            self._progresso("Comparando com o Tiny", 0, 0)
            resumo = self._montar_produtos(tiny, ml, sem_sku, contas_com_erro)
            resumo["erros"] = erros
            status = "parcial" if erros else "ok"
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
                    f"{resumo['pendencias_novas']} produto(s) com anúncios diferentes do Tiny",
                    "A coleta encontrou anúncios com medidas ou peso diferentes do cadastro do Tiny. "
                    "Confira e envie em Marketplace → Padronização de dimensões.",
                )
        return execucao

    def _progresso(self, etapa: str, feitos: int, total: int) -> None:
        """Etapa atual da coleta (tela), com log de 100 em 100."""
        with self.estado.alterar() as dados:
            dados["progresso"] = {"etapa": etapa, "feitos": feitos, "total": total, "em": agora()}
        if feitos % 100 == 0 or feitos == total:
            logger.info(f"[DIMENSOES] {etapa}: {feitos}/{total}")

    def _coletar_ml(self, erros: List[str], origem: str = "agendada"):
        """
        ({filial: {sku: [anúncio]}}, [anúncios sem SKU], [contas com o token recusado]).
        Na coleta agendada, a conta com o token recusado (401) é relida depois de cada espera de
        `esperas_token`: o cron do TMS pode regravar o ml_tokens.json nesse meio-tempo.
        """
        por_filial: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
        sem_sku: List[Dict[str, Any]] = []
        desconectadas: List[str] = []
        esperas = self.esperas_token if origem == "agendada" else ()
        for filial in FILIAIS:
            rotulo = f"ML {settings.rotulos()[filial]}"
            for tentativa in range(len(esperas) + 1):
                por_sku = por_filial[filial] = {}
                sem_sku[:] = [a for a in sem_sku if a["filial"] != filial]  # releitura do zero
                try:
                    self._ler_filial_ml(filial, rotulo, por_sku, sem_sku)
                    break
                except ContaNaoConectada as e:
                    if tentativa < len(esperas) and not self.parar.is_set():
                        minutos = max(1, round(esperas[tentativa] / 60))
                        logger.warning(
                            f"[DIMENSOES] {rotulo}: {e} Nova tentativa em {minutos} min "
                            f"({tentativa + 1}/{len(esperas)}), relendo o token gravado pelo TMS."
                        )
                        self._progresso(f"{rotulo}: token recusado, nova tentativa em {minutos} min", 0, 0)
                        if not self.parar.wait(esperas[tentativa]):
                            continue
                    # Aviso único fica com coletar() (ERROR): aqui só WARNING, para não abrir um
                    # incidente por conta mais outro do resumo, como em 08/11/2026.
                    logger.warning(f"[DIMENSOES] {rotulo}: {e}")
                    erros.append(f"{rotulo}: {e}")
                    desconectadas.append(f"{rotulo}: {e}")
                    break
                except Exception as e:
                    logger.error(f"[DIMENSOES] {rotulo}: {e}", exc_info=True)
                    erros.append(f"{rotulo}: {e}")
                    break
        return por_filial, sem_sku, desconectadas

    def _ler_filial_ml(
        self, filial: str, rotulo: str, por_sku: Dict[str, List[Dict[str, Any]]], sem_sku: List[Dict[str, Any]]
    ) -> None:
        """Lê os anúncios ativos de uma conta do ML (ContaNaoConectada sobe para a nova tentativa)."""
        cliente = self.fabrica_ml(filial)
        self._progresso(f"{rotulo}: listando anúncios", 0, 0)
        ids = cliente.ids_dos_anuncios()
        for i, item in enumerate(cliente.anuncios(ids), start=1):
            if i % 25 == 0 or i == len(ids):
                self._progresso(f"{rotulo}: anúncios", i, len(ids))
            if item.get("status") not in STATUS_ANUNCIO_OK or e_carrinho(item.get("title")):
                continue
            atributos = sorted(
                {a["id"] for a in item.get("attributes") or [] if a.get("id") in ATRIBUTO_ML_POR_CAMPO}
            )
            anuncio = {
                "filial": filial,
                "mlb": item["id"],
                "titulo": item.get("title") or "",
                "permalink": item.get("permalink"),
                "status_ml": item.get("status"),
                "catalogo": bool(item.get("catalog_listing")),
                "atributos": atributos,
                "ficha_atual": valores_ficha(item, atributos),
                "ficha_ml": ficha_ml(item).para_dict(),
                "embalagem_ml": embalagem_no_ml(item).para_dict(),
                "envio_ml": {k: (item.get("shipping") or {}).get(k) for k in ("mode", "local_pick_up", "free_shipping")},
            }
            skus = skus_do_anuncio(item)
            if not skus:
                sem_sku.append({k: anuncio[k] for k in ("filial", "mlb", "titulo", "permalink")})
            for sku in skus:
                por_sku.setdefault(sku, []).append(anuncio)

    def _coletar_tiny(self, erros: List[str], ml: Dict[str, Dict[str, List[Dict[str, Any]]]]):
        """
        ({conta: {sku: cadastro}}, contas que falharam). A listagem (100 por página) é barata; o
        cadastro completo (1 chamada por produto) só dos SKUs anunciados nas contas do ML dessa
        empresa.
        """
        alvos_por_conta: Dict[str, set] = {}
        for filial, por_sku in ml.items():
            conta = settings.tiny_por_filial().get(filial)
            if conta:
                alvos_por_conta.setdefault(conta, set()).update(por_sku)
        por_conta: Dict[str, Dict[str, Dict[str, Any]]] = {}
        com_erro: set = set()
        cache = dict(self.estado.ler()["cache_tiny"])
        for conta, skus_alvo in alvos_por_conta.items():
            rotulo = settings.rotulo_tiny(conta)
            por_sku = por_conta.setdefault(conta, {})
            try:
                cliente = self.fabrica_tiny(conta)
                self._progresso(f"{rotulo}: listando produtos", 0, 0)
                alvos = [
                    (str(r.get("sku") or "").strip(), r)
                    for r in cliente.produtos()
                    if str(r.get("sku") or "").strip() in skus_alvo
                ]
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
                            "dimensoes": det.get("dimensoes") or {},
                        }
                        cache[chave] = anterior
                        lidos += 1
                        if lidos % 50 == 0:
                            self._salvar_cache(cache)
                    por_sku.setdefault(sku, anterior)
                    if i % 25 == 0 or i == len(alvos):
                        self._progresso(f"{rotulo}: cadastros dos produtos anunciados", i, len(alvos))
            except Exception as e:
                logger.error(f"[DIMENSOES] Tiny {conta}: {e}", exc_info=True)
                erros.append(f"{rotulo}: {e}")
                com_erro.add(conta)
            self._salvar_cache(cache)
        return por_conta, com_erro

    def _salvar_cache(self, cache: Dict[str, Any]) -> None:
        with self.estado.alterar() as dados:
            dados["cache_tiny"] = cache

    def _montar_produtos(self, tiny, ml, sem_sku, contas_com_erro: set) -> Dict[str, Any]:
        pendencias_novas = 0
        por_sku: Dict[str, List[Dict[str, Any]]] = {}
        for por_sku_filial in ml.values():
            for sku, anuncios in por_sku_filial.items():
                por_sku.setdefault(sku, []).extend(anuncios)
        with self.estado.alterar() as dados:
            anteriores = dados["produtos"]
            rejeitados = rejeitados_validos(dados)
            dados["rejeitados_ml"] = rejeitados
            mantidas = dados.get("ficha_mantida_ml") or {}
            embalagens_mantidas = dados.setdefault("embalagem_mantida_ml", {})
            produtos: Dict[str, Dict[str, Any]] = {}
            for sku in sorted(por_sku):
                antes = anteriores.get(sku) or {}
                destinos_antes = (antes.get("envio") or {}).get("destinos") or {}
                anuncios = []
                contas: Dict[str, Dict[str, Any]] = {}
                for a in por_sku[sku]:
                    conta = settings.tiny_por_filial().get(a["filial"], "")
                    rotulo = settings.rotulo_tiny(conta) if conta else "Tiny (conta não configurada)"
                    cadastro = (tiny.get(conta) or {}).get(sku)
                    if conta in contas_com_erro and cadastro is None:
                        comp = {"situacao": SEM_TINY, "conta_tiny": rotulo, "alvo": None, "ficha_alvo": {},
                                "embalagem_alvo": None, "ficha_diferente": [], "embalagem_diferente": False,
                                "diferencas": [], "mensagem": f"{rotulo} não respondeu na coleta."}
                    else:
                        comp = comparar_anuncio(a, cadastro, rotulo)
                        enviado = destinos_antes.get(f"ml:{a['filial']}:{a['mlb']}") or {}
                        if comp.get("embalagem_diferente") and embalagem_voltou(enviado, a):
                            embalagens_mantidas[a["mlb"]] = {"embalagem": a["embalagem_ml"], "enviado_em": enviado.get("em", ""),
                                                             "dimensoes_envio": bool(enviado.get("dimensoes_envio"))}
                        comp = aplicar_embalagem_mantida(a, aplicar_ficha_mantida(a, comp, mantidas), embalagens_mantidas)
                        comp = aplicar_bloqueio_ml(a, comp, rejeitados)
                    enviado = destinos_antes.get(f"ml:{a['filial']}:{a['mlb']}") or {}
                    if comp["situacao"] == DIFERENTE and enviado.get("status") == "ok":
                        # O envio anterior teve OK do ML e a coleta leu de novo o valor antigo.
                        voltou = f"Enviado em {enviado.get('em', '')[:16].replace('T', ' ')}, mas o ML voltou ao valor anterior."
                        comp = {**comp, "mensagem": " ".join(filter(None, [voltou, comp.get("mensagem")]))}
                    campos = ("filial", "mlb", "titulo", "permalink", "status_ml", "catalogo", "atributos", "ficha_atual", "ficha_ml", "embalagem_ml", "envio_ml")
                    anuncios.append({**{k: a.get(k) for k in campos}, **comp})
                    if cadastro is not None:
                        contas[conta] = {"conta": conta, "rotulo": rotulo, "id": cadastro["id"],
                                         "medidas": medidas_tiny(cadastro).para_dict(),
                                         "peso_liquido": peso_liquido_tiny(cadastro)}
                descricao = next((c["descricao"] for c in (tiny.get(x, {}).get(sku) for x in contas) if c), None)
                reg: Dict[str, Any] = {
                    "sku": sku,
                    "descricao": descricao or anuncios[0]["titulo"],
                    "tiny": list(contas.values()),
                    "anuncios": anuncios,
                    "status": status_do_produto(anuncios),
                    "motivos": [a["mensagem"] for a in anuncios if a.get("mensagem") and a["situacao"] in (SEM_TINY, SEM_MEDIDA)],
                    "coletado_em": agora(),
                }
                if reg["status"] == "pendente" and antes.get("status") != "pendente":
                    pendencias_novas += 1
                envio_antes = antes.get("envio")
                # Erro de envio de produto que não tem mais nada a enviar (os anúncios ficaram iguais
                # ao Tiny, ex.: atualizados por outro produto que divide o anúncio, ou só sobrou
                # anúncio bloqueado no ML) não fica preso em "Erro no envio".
                if envio_antes and not (envio_antes.get("status") == "erro" and reg["status"] != "pendente"):
                    reg["envio"] = envio_antes
                produtos[sku] = reg
            for sku, em in enviados_ml(dados).items():
                _registrar_enviado(dados, sku, em)
            dados["produtos"] = produtos
            dados["anuncios_sem_sku"] = sem_sku
        return {
            "produtos": len(produtos),
            "pendentes": sum(1 for p in produtos.values() if p["status"] == "pendente"),
            "sem_medida": sum(1 for p in produtos.values() if p["status"] == "sem_medida"),
            "bloqueados": sum(1 for p in produtos.values() if p["status"] == "bloqueado"),
            "pendencias_novas": pendencias_novas,
            "anuncios_sem_sku": len(sem_sku),
        }

    # ------------------------------------------------------------------------------------------
    # Medidas do Tiny para o Tipo de frete
    # ------------------------------------------------------------------------------------------

    def padroes_por_filial(self) -> Dict[str, Dict[str, Dict[str, Any]]]:
        """
        {filial: {sku: {sku, altura_cm, largura_cm, comprimento_cm, peso_g}}} com as medidas do
        Tiny da empresa de cada conta do ML (última coleta). SKU sem medida/peso bruto fica de fora.
        """
        por_conta: Dict[str, Dict[str, Dict[str, Any]]] = {}
        for p in self.estado.ler()["produtos"].values():
            for t in p.get("tiny") or []:
                d = Dimensoes.de_dict(t.get("medidas"))
                if d.completas() and d.peso:
                    por_conta.setdefault(t["conta"], {})[p["sku"]] = {
                        "sku": p["sku"], "altura_cm": d.altura, "largura_cm": d.largura,
                        "comprimento_cm": d.comprimento, "peso_g": d.peso,
                    }
        return {filial: por_conta.get(conta, {}) for filial, conta in settings.tiny_por_filial().items()}

    # ------------------------------------------------------------------------------------------
    # Envio ao ML (confirmado na tela)
    # ------------------------------------------------------------------------------------------

    def confirmar(self, skus: List[str], usuario: Optional[str]) -> Dict[str, Any]:
        """
        Marca para envio os SKUs com anúncio diferente do Tiny (ou com erro no envio anterior).
        Devolve os aceitos; o envio ao ML segue depois (enviar), em segundo plano.
        """
        aceitos: List[str] = []
        recusados: List[str] = []
        with self.estado.alterar() as dados:
            for sku in dict.fromkeys(skus):
                reg = dados["produtos"].get(sku)
                if reg is None:
                    recusados.append(f"{sku}: não está na última coleta")
                    continue
                if not any(a.get("situacao") == DIFERENTE for a in reg["anuncios"]):
                    recusados.append(f"{sku}: nenhum anúncio diferente do Tiny")
                    continue
                if (reg.get("envio") or {}).get("status") == "enviando":
                    recusados.append(f"{sku}: envio já em andamento")
                    continue
                reg["envio"] = {"status": "enviando", "em": agora(), "por": usuario, "destinos": {}}
                aceitos.append(sku)
        return {"aceitos": aceitos, "recusados": recusados}

    def enviar(self, skus: List[str]) -> Dict[str, Any]:
        """Envia ao ML a ficha e a embalagem dos anúncios diferentes do Tiny; resultado por anúncio."""
        with self._enviando:
            resultado = {"ok": 0, "com_erro": 0}
            for sku in skus:
                reg = self.estado.ler()["produtos"].get(sku)
                if not reg:
                    continue
                destinos: Dict[str, Dict[str, Any]] = {}
                enviados: Dict[str, Dict[str, Any]] = {}  # mlb -> atributos da ficha que ficaram no ML
                mantidas: Dict[str, Dict[str, Optional[float]]] = {}  # mlb -> ficha que o ML manteve
                bloqueados: Dict[str, str] = {}  # mlb -> mensagem (o ML não deixa alterar)
                embalagens_recusadas: Dict[str, Dict[str, Any]] = {}  # mlb -> embalagem com peso recusado
                for a in reg["anuncios"]:
                    if a.get("situacao") != DIFERENTE:
                        continue
                    chave = f"ml:{a['filial']}:{a['mlb']}"
                    local = f"ML {settings.rotulos().get(a['filial'], a['filial'])} · {a['mlb']}"
                    try:
                        cliente = self.fabrica_ml(a["filial"])
                        aviso = self._enviar_ml(cliente, a)
                        ficha_aceita = not (aviso or "").startswith("Ficha técnica não aceita")
                        mantida, embalagem = self._conferir_no_ml(cliente, a, ficha_aceita)
                        alvo = a.get("ficha_alvo") or {}
                        ficha_txt = _texto_ficha(mantida, alvo)
                        if embalagem:
                            # O PUT voltou 2xx mas a embalagem não mudou: não conta como enviado.
                            msg = f"O ML respondeu OK, mas o anúncio continua diferente: {'; '.join(filter(None, [ficha_txt, embalagem]))}."
                            logger.warning(f"[DIMENSOES] {local}: {msg}")
                            destinos[chave] = {"status": "erro", "local": local, "mensagem": msg, "em": agora()}
                        else:
                            if mantida:
                                # Reenviar não muda: o ML mantém esses atributos (ex.: ficha do catálogo).
                                logger.info(f"[DIMENSOES] {local}: ML manteve a ficha ({ficha_txt})")
                                aviso = " ".join(filter(None, [aviso, f"O ML não aceita alterar a ficha: {ficha_txt}."]))
                                mantidas[a["mlb"]] = mantida
                            # A embalagem mandada fica no destino: a coleta compara para ver se o ML a pôs de volta.
                            mandada = a["embalagem_alvo"] if a.get("embalagem_diferente") else None
                            destinos[chave] = {"status": "ok", "local": local, "em": agora(), "embalagem": mandada,
                                               "dimensoes_envio": e_me1(a),
                                               **({"mensagem": aviso} if aviso else {})}
                            enviados[a["mlb"]] = {k: v for k, v in alvo.items() if ficha_aceita and k not in mantida}
                    except Exception as e:
                        if recusa_nao_modificavel(e):
                            em_revisao = "under_review" in str(e)
                            msg = MSG_EM_REVISAO if em_revisao else MSG_NAO_MODIFICAVEL.format(dias=DIAS_REJEITADO_ML)
                            logger.info(f"[DIMENSOES] {local}: ML não aceita alteração ({e})")
                            destinos[chave] = {"status": "bloqueado", "local": local, "mensagem": msg, "em": agora()}
                            bloqueados[a["mlb"]] = msg
                        elif recusa_peso_pequeno(e) and a.get("embalagem_alvo"):
                            emb = Dimensoes.de_dict(a["embalagem_alvo"]).para_ml()
                            msg = MSG_PESO_PEQUENO.format(
                                peso=emb.peso, medidas=f"{emb.altura} × {emb.largura} × {emb.comprimento} cm")
                            logger.info(f"[DIMENSOES] {local}: ML recusou o peso da embalagem ({e})")
                            destinos[chave] = {"status": "bloqueado", "local": local, "mensagem": msg, "em": agora()}
                            bloqueados[a["mlb"]] = msg
                            embalagens_recusadas[a["mlb"]] = a["embalagem_alvo"]
                        else:
                            destinos[chave] = {"status": "erro", "local": local, "mensagem": str(e), "em": agora()}
                    time.sleep(self.pausa)
                erro = any(d["status"] == "erro" for d in destinos.values())
                so_bloqueados = bool(destinos) and all(d["status"] == "bloqueado" for d in destinos.values())
                resultado["com_erro" if erro else "ok"] += 1
                with self.estado.alterar() as dados:
                    if any(d["status"] == "ok" for d in destinos.values()):
                        _registrar_enviado(dados, sku, agora())
                    for mlb, mantida in mantidas.items():
                        dados.setdefault("ficha_mantida_ml", {}).setdefault(mlb, {}).update(mantida)
                    for mlb, msg in bloqueados.items():
                        dados.setdefault("rejeitados_ml", {})[mlb] = {
                            "em": agora(), "mensagem": msg,
                            **({"embalagem": embalagens_recusadas[mlb]} if mlb in embalagens_recusadas else {}),
                        }
                    atual = dados["produtos"].get(sku)
                    if atual is None:
                        continue
                    for a in atual["anuncios"]:
                        if a["mlb"] in enviados:
                            # A tela passa a mostrar no ML o que foi enviado (até a próxima coleta).
                            a["ficha_atual"] = {**(a.get("ficha_atual") or {}), **enviados[a["mlb"]], **mantidas.get(a["mlb"], {})}
                            if a.get("embalagem_diferente") and a.get("embalagem_alvo"):
                                a["embalagem_ml"] = a["embalagem_alvo"]
                            a["situacao"], a["diferencas"] = IGUAL, []
                            a["ficha_diferente"], a["embalagem_diferente"] = [], False
                        elif a["mlb"] in bloqueados:
                            a["situacao"], a["mensagem"] = BLOQUEADO_ML, bloqueados[a["mlb"]]
                    atual["status"] = status_do_produto(atual["anuncios"])
                    status_envio = "erro" if erro else ("bloqueado" if so_bloqueados else "ok")
                    atual["envio"] = {**(atual.get("envio") or {}), "status": status_envio, "em": agora(), "destinos": destinos}
            return resultado

    def _conferir_no_ml(
        self, cliente: ClienteML, anuncio: Dict[str, Any], conferir_ficha: bool
    ) -> Tuple[Dict[str, Optional[float]], Optional[str]]:
        """Relê o anúncio depois do envio; falha na releitura não derruba o envio (fica sem conferir)."""
        time.sleep(self.espera_conferencia)
        try:
            item = cliente.anuncio(anuncio["mlb"])
        except Exception as e:
            logger.warning(f"[DIMENSOES] {anuncio['mlb']}: envio sem conferência ({e})")
            return {}, None
        return nao_ficou_no_ml(item, anuncio, conferir_ficha)

    @staticmethod
    def _enviar_ml(cliente: ClienteML, anuncio: Dict[str, Any]) -> Optional[str]:
        """
        Só o que está diferente do Tiny: atributos de medida da ficha e embalagem (medidas do Tiny,
        com o peso bruto). Se o ML recusar a ficha, a embalagem vai sozinha e o aviso fica no resultado.
        """
        alvo = anuncio.get("ficha_alvo") or {}
        ficha = [
            {"id": attr_id, "value_name": f"{_num_ml(alvo[attr_id])} {'g' if 'WEIGHT' in attr_id else 'cm'}"}
            for attr_id in anuncio.get("ficha_diferente") or []
            if attr_id in alvo
        ]
        embalagem = (
            Dimensoes.de_dict(anuncio["embalagem_alvo"])
            if anuncio.get("embalagem_alvo") and anuncio.get("embalagem_diferente")
            else None
        )
        aviso = None
        if ficha:
            try:
                cliente.atualizar_atributos(anuncio["mlb"], ficha, f"atualizar a ficha técnica de {anuncio['mlb']}")
            except MLAPIError as e:
                if embalagem is None:
                    raise
                aviso = f"Ficha técnica não aceita pelo ML ({e}); embalagem enviada."
        if embalagem is not None:
            cliente.enviar_medidas(anuncio["mlb"], embalagem)
            envio = anuncio.get("envio_ml") or {}
            if envio.get("mode") == "me1" and not cliente.enviar_dimensoes_envio(anuncio["mlb"], embalagem, envio):
                aviso = " ".join(filter(None, [aviso, "O ML não deixa alterar as medidas de envio (shipping.dimensions) deste anúncio ME1."]))
        elif ficha and not anuncio.get("embalagem_alvo"):
            aviso = "Produto sem as três medidas no Tiny: embalagem não enviada."
        return aviso
