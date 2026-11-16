"""
Chamadas à API do Mercado Livre, uma instância por conta (filial).

Portado do ClienteMercadoLivre.java do sincronizador-anuncios-meli, com o que a rotina diária
precisa a mais: listagem de todos os anúncios da conta. A renovação do token NÃO é feita aqui:
um fluxo externo (a definir) renova e grava o access token (ver ClienteML._token).
"""
import logging
from typing import Any, Dict, Iterator, List, Optional, Tuple

import requests

from app import retry
from app.config import settings
from app.retry import TENTATIVAS, deve_repetir, espera
from app.dimensoes import Dimensoes
from app.estado import Estado

logger = logging.getLogger("marketplace.ml")

CAMPO_BLOQUEADO = "field_not_updatable"
LOTE_MULTIGET = 20  # máximo de ids por GET /items/bulk?ids=
ATRIBUTOS_DO_ITEM = "id,title,status,permalink,thumbnail,shipping,attributes,seller_custom_field,variations,last_updated"
# /items/bulk filtra os campos com o prefixo "body." (o /items?ids= antigo usava o nome puro).
ATRIBUTOS_DO_BULK = ",".join(f"body.{a}" for a in ATRIBUTOS_DO_ITEM.split(","))


class MLAPIError(RuntimeError):
    def __init__(self, mensagem: str, status: Optional[int] = None, corpo: str = "") -> None:
        super().__init__(mensagem)
        self.status = status
        self.corpo = corpo


class ContaNaoConectada(MLAPIError):
    """Sem access token válido da conta: a rotina pula a filial e avisa."""


class ClienteML:
    def __init__(self, filial: str, estado: Estado, http: Any = None, base_url: Optional[str] = None) -> None:
        self.filial = filial
        self.estado = estado
        self.http = http or requests.Session()
        self.base_url = (base_url or settings.ML_API_URL).rstrip("/")
        self._user_id: Optional[int] = None
        self._relidos = [0, 0]
        self._um_a_um = False

    # --- autenticação -----------------------------------------------------------------------

    def _token(self) -> str:
        """
        Access token da conta: o gravado em DATA_DIR/ml_tokens.json pelo fluxo externo de
        renovação, senão ML_<CONTA>_ACCESS_TOKEN. Esta automação não renova tokens.
        """
        token = self.estado.token(self.filial).get("access_token") or settings.access_token_env(self.filial)
        if not token:
            raise ContaNaoConectada(
                f"Conta {self.filial} sem access token do Mercado Livre (ml_tokens.json ou "
                f"ML_{self.filial.upper()}_ACCESS_TOKEN). A renovação é feita fora desta automação."
            )
        return token

    def user_id(self) -> int:
        if self._user_id is None:
            uid = self.estado.token(self.filial).get("user_id")
            self._user_id = int(uid) if uid else int(self._chamar("GET", "/users/me", "identificar a conta")["id"])
        return self._user_id

    # --- HTTP -------------------------------------------------------------------------------

    def _chamar(self, metodo: str, caminho: str, descricao: str, **kwargs: Any) -> Any:
        for tentativa in range(1, TENTATIVAS + 1):
            headers = {"Authorization": f"Bearer {self._token()}", "Accept": "application/json"}
            try:
                resp = self.http.request(metodo, f"{self.base_url}{caminho}", headers=headers, timeout=30, **kwargs)
            except requests.RequestException as e:
                if tentativa == TENTATIVAS or not deve_repetir(metodo, None):
                    raise MLAPIError(f"Falha de rede ao {descricao}: {e}") from e
                retry.dormir(espera(tentativa))
                continue
            if resp.status_code == 401:
                raise ContaNaoConectada(
                    f"Access token da conta {self.filial} expirado ou inválido (HTTP 401). "
                    "A renovação é feita fora desta automação.",
                    resp.status_code,
                    resp.text,
                )
            if (resp.status_code == 429 or resp.status_code >= 500) and deve_repetir(metodo, resp.status_code):
                if tentativa < TENTATIVAS:
                    retry.dormir(espera(tentativa, resp))
                    continue
            if not 200 <= resp.status_code < 300:
                raise MLAPIError(
                    f"Falha ao {descricao}: HTTP {resp.status_code} - {resp.text[:500]}", resp.status_code, resp.text
                )
            return resp.json() if resp.content else {}
        raise MLAPIError(f"Falha ao {descricao}: sem resposta válida do Mercado Livre")

    # --- leitura ----------------------------------------------------------------------------

    def ids_dos_anuncios(self) -> List[str]:
        """Todos os anúncios da conta (search_type=scan pagina por scroll_id, sem o teto de 1000)."""
        uid = self.user_id()
        ids: List[str] = []
        params: Dict[str, Any] = {"search_type": "scan", "limit": 100}
        while True:
            pagina = self._chamar("GET", f"/users/{uid}/items/search", "listar os anúncios", params=params)
            resultados = pagina.get("results") or []
            ids.extend(resultados)
            scroll = pagina.get("scroll_id")
            if not resultados or not scroll:
                break
            params = {"search_type": "scan", "limit": 100, "scroll_id": scroll}
        return list(dict.fromkeys(ids))

    def anuncios(self, ids: List[str]) -> Iterator[Dict[str, Any]]:
        """
        Lê os anúncios em lotes de 20 por GET /items/bulk?ids=. O /items?ids= antigo foi
        desativado pelo ML (prazo de migração 25/10/2026): em 06/11 a Campinas recebeu 403
        "ResourceDeprecated". Se o bulk também for recusado, lê um a um por GET /items/{id}.
        """
        self._relidos = [0, 0]  # [relidos sozinhos, com a embalagem na releitura]
        self._um_a_um = False
        for i in range(0, len(ids), LOTE_MULTIGET):
            lote = ids[i : i + LOTE_MULTIGET]
            for item, sozinho in self._lote(lote):
                yield item if sozinho else self._com_embalagem(item)
        if self._relidos[0]:
            logger.info(f"[ML] {self.filial}: {self._relidos[0]} anúncio(s) sem embalagem no lote relidos; "
                        f"{self._relidos[1]} tinham a embalagem na releitura")

    def _lote(self, lote: List[str]) -> List[Tuple[Dict[str, Any], bool]]:
        """(anúncio, lido sozinho): o lido por GET /items/{id} já vem completo, sem releitura."""
        lidos: Dict[str, Dict[str, Any]] = {}
        if not self._um_a_um:
            try:
                respostas = self._chamar(
                    "GET", "/items/bulk", "buscar os anúncios",
                    params={"ids": ",".join(lote), "attributes": ATRIBUTOS_DO_BULK, "include_attributes": "all"},
                )
            except ContaNaoConectada:
                raise
            except MLAPIError as e:
                if e.status is None or e.status >= 500 or e.status == 429:
                    raise
                logger.warning(f"[ML] {self.filial}: leitura em lote recusada ({e}); lendo os anúncios um a um")
                self._um_a_um = True
                respostas = []
            for r in respostas or []:
                # Aceita {code, body} (formato do multiget) e o item direto.
                corpo = r.get("body") if isinstance(r, dict) and "body" in r else r
                codigo = r.get("code", 200) if isinstance(r, dict) else None
                if codigo == 200 and isinstance(corpo, dict) and corpo.get("id"):
                    lidos[str(corpo["id"])] = corpo
                else:
                    logger.warning(f"[ML] {self.filial}: anúncio não lido no lote: {str(r)[:200]}")
        itens: List[Tuple[Dict[str, Any], bool]] = []
        for mlb in lote:
            if mlb in lidos:
                itens.append((lidos[mlb], False))
                continue
            # Fora da resposta do lote (ou lote recusado): lê sozinho.
            try:
                item = self.anuncio(mlb)
            except ContaNaoConectada:
                raise
            except MLAPIError as e:
                # Só o anúncio que não existe mais é pulado. Outra recusa (403...) derruba a
                # verificação: pular todos daria "ok" com zero anúncios.
                if e.status == 404:
                    logger.warning(f"[ML] {self.filial}: anúncio {mlb} não encontrado: {e}")
                    continue
                raise
            if isinstance(item, dict) and item.get("id"):
                itens.append((item, True))
        return itens

    def _com_embalagem(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """
        Anúncio sem SELLER_PACKAGE_* no GET em lote é relido sozinho (com include_attributes=all):
        em 28/10 1.230 embalagens enviadas e conferidas às 09h "voltaram" na coleta das 13h para o
        shipping.dimensions antigo, a leitura de reserva. Se a releitura falhar, fica o do lote.
        """
        if any(str(a.get("id", "")).startswith("SELLER_PACKAGE_") for a in item.get("attributes") or []):
            return item
        self._relidos[0] += 1
        try:
            completo = self.anuncio(item["id"])
        except ContaNaoConectada:
            raise
        except MLAPIError as e:
            logger.warning(f"[ML] {self.filial}: {item.get('id')} sem a embalagem no lote e sem releitura: {e}")
            return item
        if not (isinstance(completo, dict) and completo.get("id")):
            return item
        if any(str(a.get("id", "")).startswith("SELLER_PACKAGE_") for a in completo.get("attributes") or []):
            self._relidos[1] += 1
        return completo

    def descricao(self, mlb: str) -> str:
        """Descrição do anúncio (texto puro). Anúncio sem descrição: vazio."""
        try:
            corpo = self._chamar("GET", f"/items/{mlb}/description", f"ler a descrição de {mlb}")
        except MLAPIError as e:
            if e.status == 404:
                return ""
            raise
        return str((corpo or {}).get("plain_text") or "")

    def atualizar_atributos(self, mlb: str, atributos: List[Dict[str, str]], descricao: str) -> None:
        self._chamar("PUT", f"/items/{mlb}", descricao, json={"attributes": atributos})

    def anuncio(self, mlb: str) -> Dict[str, Any]:
        return self._chamar("GET", f"/items/{mlb}", f"buscar o anúncio {mlb}", params={"include_attributes": "all"})

    # --- escrita ----------------------------------------------------------------------------

    def enviar_medidas(self, mlb: str, dims: Dimensoes) -> None:
        """
        Medidas da EMBALAGEM como atributos SELLER_PACKAGE_*: nos anúncios "user product" o ML
        calcula o frete por eles e ignora shipping.dimensions. O ML exige o peso junto
        (SELLER_PACKAGE_WEIGHT): vai o peso padronizado do produto (`dims.peso`).
        """
        if not dims.peso:
            raise MLAPIError(
                f"{mlb}: o Mercado Livre exige o peso junto com as medidas da embalagem; "
                "padronize o peso do produto em Padronização de dimensões."
            )
        ml = dims.para_ml()  # o ML só aceita inteiros
        atributos = [
            {"id": "SELLER_PACKAGE_HEIGHT", "value_name": f"{ml.altura} cm"},
            {"id": "SELLER_PACKAGE_WIDTH", "value_name": f"{ml.largura} cm"},
            {"id": "SELLER_PACKAGE_LENGTH", "value_name": f"{ml.comprimento} cm"},
            {"id": "SELLER_PACKAGE_WEIGHT", "value_name": f"{ml.peso} g"},
        ]
        self._chamar("PUT", f"/items/{mlb}", f"atualizar as medidas de {mlb}", json={"attributes": atributos})

    def enviar_dimensoes_envio(self, mlb: str, dims: Dimensoes, envio_atual: Dict[str, Any]) -> bool:
        """
        shipping.dimensions de anúncio ME1: é por ele que o ML calcula o frete, e em 28/10 ~980
        anúncios ME1 voltaram ao valor antigo horas depois de receber só os SELLER_PACKAGE_*.
        Vai com o modo, frete grátis e retirada que o anúncio já tem. False se o ML trava o campo.
        """
        texto = dims.texto_ml()
        if not texto:
            return False
        envio = {
            "mode": envio_atual.get("mode"),
            "dimensions": texto,
            "local_pick_up": bool(envio_atual.get("local_pick_up", False)),
            "free_shipping": bool(envio_atual.get("free_shipping", False)),
        }
        try:
            self._chamar("PUT", f"/items/{mlb}", f"atualizar as medidas de envio de {mlb}", json={"shipping": envio})
        except MLAPIError as e:
            if CAMPO_BLOQUEADO not in (e.corpo or str(e)):
                raise
            return False
        return True

    def trocar_envio(self, mlb: str, dims: Dimensoes, modo: str, envio_atual: Dict[str, Any]) -> None:
        """
        Troca o modo de envio. O PUT devolve 200 mesmo quando o ML vai recusar e voltar o
        anúncio para "a combinar" (not_specified) — por isso a conferência depois de 10 min.
        Frete grátis e retirada no local são mantidos como estão no anúncio (o Java forçava
        frete grátis desligado, o que tiraria o frete grátis de quem tinha). shipping.dimensions
        só vai quando `dims` traz o peso que o anúncio já tem (o campo exige peso).
        """
        def corpo(com_dimensoes: bool) -> Dict[str, Any]:
            envio: Dict[str, Any] = {
                "mode": modo,
                "methods": [],
                "local_pick_up": bool(envio_atual.get("local_pick_up", True)),
                "free_shipping": bool(envio_atual.get("free_shipping", False)),
            }
            if com_dimensoes and dims.texto_ml():
                envio["dimensions"] = dims.texto_ml()
            if modo == "me1":
                envio["logistic_type"] = "default"  # logística do ME1; no ME2 o ML escolhe
            return {"shipping": envio}

        descricao = f"trocar o envio de {mlb} para {modo}"
        try:
            self._chamar("PUT", f"/items/{mlb}", descricao, json=corpo(True))
        except MLAPIError as e:
            # Em parte dos anúncios o ML trava shipping.dimensions; as medidas já foram como
            # atributos, então basta trocar o modo sem esse campo.
            if CAMPO_BLOQUEADO not in (e.corpo or str(e)):
                raise
            self._chamar("PUT", f"/items/{mlb}", descricao + " (sem shipping.dimensions)", json=corpo(False))

