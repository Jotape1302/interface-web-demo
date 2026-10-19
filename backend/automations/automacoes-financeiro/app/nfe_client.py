import atexit
import base64
import gzip
import logging
import os
import re
import shutil
import tempfile
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import defusedxml.ElementTree as ET
from xml.etree.ElementTree import Element
import requests

from app.config import Settings, settings
from app.nfe_items import NFeItem, extract_items_from_xml

logger = logging.getLogger(__name__)

# Configurações padronizadas de timeout para requisições de rede (connect_timeout, read_timeout)
DEFAULT_SEFAZ_TIMEOUT: Tuple[float, float] = (10.0, 30.0)
DEFAULT_HTTP_TIMEOUT: Tuple[float, float] = (5.0, 20.0)
DEFAULT_HTTP_EXTENDED_TIMEOUT: Tuple[float, float] = (5.0, 25.0)

UF_TO_IBGE = {
    "RO": "11", "AC": "12", "AM": "13", "RR": "14", "PA": "15", "AP": "16", "TO": "17",
    "MA": "21", "PI": "22", "CE": "23", "RN": "24", "PB": "25", "PE": "26", "AL": "27",
    "SE": "28", "BA": "29", "MG": "31", "ES": "32", "RJ": "33", "SP": "35", "PR": "41",
    "SC": "42", "RS": "43", "MS": "50", "MT": "51", "GO": "52", "DF": "53"
}

# Nomes canônicos oficiais de exibição para as empresas do grupo Norvia monitoradas
COMPANY_DISPLAY_NAME_BY_CNPJ: Dict[str, str] = {
    "36592814000100": "REVESTA DECORACOES LTDA",
    "43820617000166": "FABRILUX ACABAMENTOS LTDA",
    "27184930000107": "NORVIA ACABAMENTOS LTDA (CAMPINAS)",
    "27184930000280": "NORVIA ACABAMENTOS LTDA (CURITIBA)",
}

# Siglas de UF das empresas para autorização e webservice distDFeInt da SEFAZ
COMPANY_UF_BY_CNPJ: Dict[str, str] = {
    "36592814000100": "SP",
    "43820617000166": "SP",
    "27184930000107": "SP",
    "27184930000280": "PR",
}


class NFeProviderError(Exception):
    """Exceção levantada quando ocorre falha na obtenção dos dados fiscais da NF-e."""
    pass


@dataclass
class NFeDuplicate:
    """Representação de uma duplicata/parcela de pagamento da NF-e."""
    numero: str
    vencimento: date
    valor: Decimal


@dataclass
class NFeData:
    """Dados consolidados extraídos da NF-e para lançamento financeiro."""
    chave: str
    numero_nota: str
    data_emissao: date
    emitente_nome: str
    emitente_cnpj: str
    valor_total: Decimal
    duplicatas: List[NFeDuplicate] = field(default_factory=list)
    destinatario_cnpj: Optional[str] = None
    destinatario_nome: Optional[str] = None
    meio_pagamento_nfe: Optional[str] = None
    numero_documento_custom: Optional[str] = None
    marcador_empresa: Optional[str] = None
    marcador_caixa: Optional[str] = None
    marcadores: List[str] = field(default_factory=list)
    itens: List[NFeItem] = field(default_factory=list)

    def get_effective_duplicatas(self) -> List[NFeDuplicate]:
        """
        Padronização de negócio: toda nota é lançada como uma única parcela no Tiny,
        usando sempre o valor total da nota (nunca a soma/lista de duplicatas extraídas).

        Motivo: a extração de duplicatas por OCR/regex (`extract_fiscal_data_from_text`)
        confunde linhas de itens do cupom (quantidade + data + preço) com parcelas de
        pagamento, gerando lançamentos como "4 parcelas" quando na verdade eram 4 itens
        de uma compra à vista. Em vez de tornar aquele parsing mais robusto, a regra de
        negócio decidida é nunca fatiar o lançamento — sempre 1 parcela.
        """
        vencimento = min((d.vencimento for d in self.duplicatas), default=self.data_emissao)
        return [
            NFeDuplicate(
                numero="001",
                vencimento=vencimento,
                valor=self.valor_total
            )
        ]


@dataclass
class SefazDocEntry:
    """Um documento (`docZip`) dentro de um lote de distribuição por NSU já descompactado."""
    nsu: str
    schema: str
    xml_content: str


@dataclass
class DistNsuResult:
    """Resultado de uma chamada de distribuição por NSU (distNSUInt) à SEFAZ."""
    c_stat: str
    x_motivo: str
    ult_nsu: str
    max_nsu: str
    docs: List[SefazDocEntry] = field(default_factory=list)


@dataclass
class ResNFeSummary:
    """Dados extraídos de um resumo `resNFe` (distribuição por NSU sem XML completo — caso comum de NFC-e)."""
    chave: str
    cnpj_emit: str
    nome_emit: str
    dh_emi: Optional[str]
    v_nf: Decimal
    c_sit_nfe: str
    tp_nf: Optional[str]


def parse_res_nfe(xml_text: str) -> ResNFeSummary:
    """
    Interpreta um resumo `resNFe` retornado pela distribuição por NSU. Diferente do XML
    completo (`procNFe`), o resumo não traz itens/duplicatas — só o essencial para
    identificar a nota (chave, emitente, valor, data e situação).
    """
    root = ET.fromstring(xml_text)

    def find_first(element: Element, tag_name: str) -> Optional[Element]:
        for el in element.iter():
            if el.tag.split("}")[-1] == tag_name:
                return el
        return None

    ch_nfe_el = find_first(root, "chNFe")
    chave = ch_nfe_el.text.strip() if ch_nfe_el is not None and ch_nfe_el.text else ""

    cnpj_el = find_first(root, "CNPJ")
    cnpj_emit = cnpj_el.text.strip() if cnpj_el is not None and cnpj_el.text else ""

    x_nome_el = find_first(root, "xNome")
    nome_emit = x_nome_el.text.strip() if x_nome_el is not None and x_nome_el.text else "Emitente SEFAZ"

    v_nf_el = find_first(root, "vNF")
    v_nf = Decimal(v_nf_el.text.strip()) if v_nf_el is not None and v_nf_el.text else Decimal("0.00")

    dh_emi_el = find_first(root, "dhEmi")
    dh_emi = dh_emi_el.text.strip() if dh_emi_el is not None and dh_emi_el.text else None

    c_sit_el = find_first(root, "cSitNFe")
    c_sit_nfe = c_sit_el.text.strip() if c_sit_el is not None and c_sit_el.text else "1"

    tp_nf_el = find_first(root, "tpNF")
    tp_nf = tp_nf_el.text.strip() if tp_nf_el is not None and tp_nf_el.text else None

    return ResNFeSummary(
        chave=chave,
        cnpj_emit=cnpj_emit,
        nome_emit=nome_emit,
        dh_emi=dh_emi,
        v_nf=v_nf,
        c_sit_nfe=c_sit_nfe,
        tp_nf=tp_nf,
    )


def res_nfe_summary_to_nfe_data(summary: ResNFeSummary, dest_cnpj: Optional[str] = None) -> NFeData:
    """Converte um resumo `resNFe` em `NFeData` (sem itens/duplicatas discriminados)."""
    data_emissao = date.today()
    if summary.dh_emi:
        try:
            data_emissao = datetime.fromisoformat(summary.dh_emi.split("T")[0]).date()
        except Exception:
            pass

    numero_nota = (
        str(int(summary.chave[25:34]))
        if len(summary.chave) == 44 and summary.chave[25:34].isdigit()
        else "0"
    )

    return NFeData(
        chave=summary.chave,
        numero_nota=numero_nota,
        data_emissao=data_emissao,
        emitente_nome=summary.nome_emit,
        emitente_cnpj=summary.cnpj_emit,
        valor_total=summary.v_nf,
        duplicatas=[],
        destinatario_cnpj=dest_cnpj,
    )


def dados_fiscais_do_arquivo(file_path: Path, chave: str, metodo: str, provider: "BaseNFeProvider") -> "NFeData":
    """
    Dados fiscais de um arquivo recebido (upload manual ou pasta). Se for o XML completo da
    NF-e, lê dele mesmo; senão (PDF/imagem, ou XML só de resumo/evento) consulta pela chave.
    Consultar a SEFAZ com o XML em mãos falhava para notas com mais de 90 dias (cStat 632,
    "Solicitacao fora de prazo") — justamente o caso de quem baixou o XML para importar.
    """
    if metodo == "xml":
        conteudo = Path(file_path).read_text(encoding="utf-8", errors="ignore")
        if re.search(r"<(?:\w+:)?infNFe\b", conteudo) and re.search(r"<(?:\w+:)?det\b", conteudo):
            logger.info(f"[{Path(file_path).name}] NF-e completa no XML: dados lidos do arquivo, sem consultar a SEFAZ.")
            return NFeXmlParser.parse(conteudo, chave)
    return provider.get_nfe_data(chave)


class NFeXmlParser:
    """
    Parser robusto para XML de NF-e (layout padrão SEFAZ - infNFe v4.00).
    Lida com namespaces SEFAZ e extrai dados do emitente, valores e parcelas.
    """

    @staticmethod
    def parse(xml_content: str, chave: str) -> NFeData:
        try:
            root = ET.fromstring(xml_content)
        except Exception as e:
            raise NFeProviderError(f"Falha ao interpretar conteúdo XML da NF-e: {e}") from e

        # Namespace padrão SEFAZ: http://www.portalfiscal.inf.br/nfe
        # Usamos busca com curinga ou remoção de namespace para maior resiliência
        def find_first(element: Element, tag_name: str) -> Optional[Element]:
            for el in element.iter():
                if el.tag.split("}")[-1] == tag_name:
                    return el
            return None

        def find_all(element: Element, tag_name: str) -> List[Element]:
            return [el for el in element.iter() if el.tag.split("}")[-1] == tag_name]

        # 1. Identificação da Nota (ide)
        ide_el = find_first(root, "ide")
        if ide_el is None:
            raise NFeProviderError("Tag <ide> não encontrada no XML da NF-e.")

        n_nf_el = find_first(ide_el, "nNF")
        numero_nota = n_nf_el.text.strip() if (n_nf_el is not None and n_nf_el.text) else "0"

        # Data de emissão: pode estar em dhEmi (ISO 8601) ou dEmi (YYYY-MM-DD)
        dh_emi_el = find_first(ide_el, "dhEmi")
        d_emi_el = find_first(ide_el, "dEmi")
        data_emissao_str = (dh_emi_el.text if dh_emi_el is not None else None) or (d_emi_el.text if d_emi_el is not None else None)

        if data_emissao_str:
            try:
                # Trata formato ISO com timezone (ex: 2024-03-15T14:30:00-03:00)
                data_emissao = datetime.fromisoformat(data_emissao_str.split("T")[0]).date()
            except ValueError:
                data_emissao = date.today()
        else:
            data_emissao = date.today()

        # 2. Emitente (emit)
        emit_el = find_first(root, "emit")
        if emit_el is None:
            raise NFeProviderError("Tag <emit> não encontrada no XML da NF-e.")

        x_nome_el = find_first(emit_el, "xNome")
        emitente_nome = x_nome_el.text.strip() if (x_nome_el is not None and x_nome_el.text) else "Fornecedor Não Identificado"

        cnpj_el = find_first(emit_el, "CNPJ")
        if cnpj_el is None:
            cnpj_el = find_first(emit_el, "CPF")
        emitente_cnpj = cnpj_el.text.strip() if (cnpj_el is not None and cnpj_el.text) else ""

        # 2.1 Destinatário (dest)
        dest_el = find_first(root, "dest")
        destinatario_nome = None
        destinatario_cnpj = None
        if dest_el is not None:
            dest_nome_el = find_first(dest_el, "xNome")
            if dest_nome_el is not None and dest_nome_el.text:
                destinatario_nome = dest_nome_el.text.strip()
            dest_cnpj_el = find_first(dest_el, "CNPJ")
            if dest_cnpj_el is None:
                dest_cnpj_el = find_first(dest_el, "CPF")
            if dest_cnpj_el is not None and dest_cnpj_el.text:
                destinatario_cnpj = dest_cnpj_el.text.strip()
            if destinatario_cnpj and destinatario_cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
                destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ[destinatario_cnpj]

        # 2.2 Meio de pagamento declarado na nota (pag -> detPag -> tPag), código padrão
        # SEFAZ (01=Dinheiro, 15=Boleto, 17=Pix etc. — ver PAYMENT_METHOD_NFE_LABELS).
        # Quando a nota tem mais de uma forma (pagamento misto), usamos a primeira.
        det_pag_el = find_first(root, "detPag")
        t_pag_el = find_first(det_pag_el, "tPag") if det_pag_el is not None else None
        meio_pagamento_nfe = t_pag_el.text.strip() if (t_pag_el is not None and t_pag_el.text) else None

        # 3. Totais (total -> ICMSTot -> vNF)
        icms_tot_el = find_first(root, "ICMSTot")
        v_nf_el = find_first(icms_tot_el, "vNF") if icms_tot_el is not None else None
        if v_nf_el is not None and v_nf_el.text:
            valor_total = Decimal(v_nf_el.text.strip())
        else:
            valor_total = Decimal("0.00")

        # 4. Cobrança e Duplicatas (cobr -> dup)
        duplicatas: List[NFeDuplicate] = []
        dup_elements = find_all(root, "dup")
        for dup in dup_elements:
            n_dup_el = find_first(dup, "nDup")
            d_venc_el = find_first(dup, "dVenc")
            v_dup_el = find_first(dup, "vDup")

            n_dup = n_dup_el.text.strip() if (n_dup_el is not None and n_dup_el.text) else f"{len(duplicatas)+1:03d}"
            
            if d_venc_el is not None and d_venc_el.text:
                try:
                    d_venc = datetime.strptime(d_venc_el.text.strip(), "%Y-%m-%d").date()
                except ValueError:
                    d_venc = data_emissao
            else:
                d_venc = data_emissao

            if v_dup_el is not None and v_dup_el.text:
                v_dup = Decimal(v_dup_el.text.strip())
            else:
                v_dup = valor_total

            duplicatas.append(NFeDuplicate(numero=n_dup, vencimento=d_venc, valor=v_dup))

        # 5. Itens/produtos (det -> prod), usados na tela de revisão e categorização
        itens = extract_items_from_xml(xml_content)

        return NFeData(
            chave=chave,
            numero_nota=numero_nota,
            data_emissao=data_emissao,
            emitente_nome=emitente_nome,
            emitente_cnpj=emitente_cnpj,
            valor_total=valor_total,
            duplicatas=duplicatas,
            destinatario_cnpj=destinatario_cnpj,
            destinatario_nome=destinatario_nome,
            meio_pagamento_nfe=meio_pagamento_nfe,
            itens=itens
        )



class BaseNFeProvider(ABC):
    """Interface abstrata para consulta de dados fiscais de NF-e por chave de acesso."""

    @abstractmethod
    def get_nfe_data(self, chave: str) -> NFeData:
        """Consulta e retorna os dados estruturados da NF-e para a chave especificada."""
        pass


class NuvemFiscalProvider(BaseNFeProvider):
    """
    Integração com a API da Nuvem Fiscal (OAuth2 Client Credentials).
    Endpoint: https://api.nuvemfiscal.com.br/v2/nfe/{chave}
    """

    def __init__(self, client_id: str, client_secret: str, api_url: str, auth_url: str) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.api_url = api_url.rstrip("/")
        self.auth_url = auth_url
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0.0

    def _get_access_token(self) -> str:
        if self._access_token and time.time() < (self._token_expires_at - 60):
            return self._access_token

        logger.debug("Solicitando novo token de acesso OAuth2 na Nuvem Fiscal...")
        try:
            resp = requests.post(
                self.auth_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": "nfe"
                },
                timeout=DEFAULT_HTTP_TIMEOUT
            )
            resp.raise_for_status()
            data = resp.json()
            self._access_token = data["access_token"]
            expires_in = data.get("expires_in", 3600)
            self._token_expires_at = time.time() + expires_in
            return self._access_token
        except Exception as e:
            raise NFeProviderError(f"Falha de autenticação na Nuvem Fiscal: {e}") from e

    def get_nfe_data(self, chave: str) -> NFeData:
        token = self._get_access_token()
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/xml, application/json"}

        # Tentativa 1: Obter o XML completo da NF-e
        xml_endpoint = f"{self.api_url}/nfe/{chave}/xml"
        try:
            logger.info(f"Consultando XML da NF-e {chave} na Nuvem Fiscal...")
            resp = requests.get(xml_endpoint, headers=headers, timeout=DEFAULT_HTTP_TIMEOUT)
            if resp.status_code == 200 and resp.text.startswith("<?xml") or "<nfeProc" in resp.text or "<NFe" in resp.text:
                return NFeXmlParser.parse(resp.text, chave)
        except Exception as e:
            logger.debug(f"Endpoint de XML direto falhou ou retornou não-200: {e}")

        # Tentativa 2: Consulta de metadados / JSON
        json_endpoint = f"{self.api_url}/nfe/{chave}"
        try:
            logger.info(f"Consultando metadados JSON da NF-e {chave} na Nuvem Fiscal...")
            resp = requests.get(json_endpoint, headers=headers, timeout=DEFAULT_HTTP_TIMEOUT)
            resp.raise_for_status()
            payload = resp.json()

            # Extração de campos do JSON da Nuvem Fiscal
            emitente = payload.get("emitente", {})
            valores = payload.get("valores", {})
            return NFeData(
                chave=chave,
                numero_nota=str(payload.get("numero", "")),
                data_emissao=datetime.fromisoformat(payload.get("data_emissao", "").split("T")[0]).date() if payload.get("data_emissao") else date.today(),
                emitente_nome=emitente.get("nome", "Fornecedor Nuvem Fiscal"),
                emitente_cnpj=emitente.get("cnpj", ""),
                valor_total=Decimal(str(valores.get("valor_total", 0.0))),
                duplicatas=[]
            )
        except Exception as e:
            raise NFeProviderError(f"Erro ao consultar chave {chave} na Nuvem Fiscal: {e}") from e


class PlugNotasProvider(BaseNFeProvider):
    """
    Integração com a API do PlugNotas (TecnoSpeed).
    Endpoint: https://api.plugnotas.com.br/nfe/{chave}
    """

    def __init__(self, api_key: str, api_url: str) -> None:
        self.api_key = api_key
        self.api_url = api_url.rstrip("/")

    def get_nfe_data(self, chave: str) -> NFeData:
        headers = {"x-api-key": self.api_key, "Accept": "application/json"}
        url = f"{self.api_url}/nfe/{chave}"

        try:
            logger.info(f"Consultando NF-e {chave} no PlugNotas...")
            resp = requests.get(url, headers=headers, timeout=DEFAULT_HTTP_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()

            # Se contiver XML bruto no retorno:
            if "xml" in data and data["xml"]:
                return NFeXmlParser.parse(data["xml"], chave)

            # Caso retorne JSON estruturado:
            emitente = data.get("emitente", {})
            cobranca = data.get("cobranca", {})
            dups: List[NFeDuplicate] = []
            for d in cobranca.get("duplicatas", []):
                dups.append(NFeDuplicate(
                    numero=str(d.get("numero", "")),
                    vencimento=datetime.strptime(d.get("vencimento"), "%Y-%m-%d").date() if d.get("vencimento") else date.today(),
                    valor=Decimal(str(d.get("valor", 0)))
                ))

            return NFeData(
                chave=chave,
                numero_nota=str(data.get("numero", "")),
                data_emissao=datetime.fromisoformat(data.get("emissao", "").split("T")[0]).date() if data.get("emissao") else date.today(),
                emitente_nome=emitente.get("razaoSocial", ""),
                emitente_cnpj=emitente.get("cpfCnpj", ""),
                valor_total=Decimal(str(data.get("valor", 0.0))),
                duplicatas=dups
            )
        except Exception as e:
            raise NFeProviderError(f"Erro ao consultar chave {chave} no PlugNotas: {e}") from e


class ReceitaFederalProvider(BaseNFeProvider):
    """
    Integração com a API Oficial da Receita Federal (SERPRO / Gateway gov.br).
    Endpoint padrão: https://gateway.apiserpro.serpro.gov.br/consulta-nfe-df/v1/nfe/{chave}
    Suporta autenticação via Consumer Key / Secret (OAuth2 Serpro) ou Bearer Token direto.
    """

    def __init__(
        self,
        consumer_key: Optional[str] = None,
        consumer_secret: Optional[str] = None,
        token: Optional[str] = None,
        api_url: Optional[str] = None,
        auth_url: Optional[str] = None
    ) -> None:
        self.consumer_key = consumer_key or settings.RECEITA_CONSUMER_KEY
        self.consumer_secret = consumer_secret or settings.RECEITA_CONSUMER_SECRET
        self.token = token or settings.RECEITA_API_TOKEN
        self.api_url = (api_url or settings.RECEITA_API_URL).rstrip("/")
        self.auth_url = auth_url or settings.RECEITA_AUTH_URL
        self._cached_token: Optional[str] = None
        self._token_expires_at: float = 0.0

    def _get_bearer_token(self) -> str:
        if self.token and "COLOQUE" not in self.token:
            return self.token

        if self._cached_token and time.time() < (self._token_expires_at - 60):
            return self._cached_token

        if not (self.consumer_key and self.consumer_secret and "COLOQUE" not in self.consumer_key):
            raise NFeProviderError(
                "Credenciais da API Oficial da Receita Federal (Consumer Key e Secret ou Token) não configuradas no .env."
            )

        logger.debug("Obtendo novo token de autenticação Serpro / Receita Federal...")
        try:
            resp = requests.post(
                self.auth_url,
                data={"grant_type": "client_credentials"},
                auth=(self.consumer_key, self.consumer_secret),
                timeout=DEFAULT_HTTP_TIMEOUT
            )
            resp.raise_for_status()
            data = resp.json()
            self._cached_token = data["access_token"]
            expires_in = data.get("expires_in", 3600)
            self._token_expires_at = time.time() + float(expires_in)
            return self._cached_token
        except Exception as e:
            raise NFeProviderError(f"Falha de autenticação na API Serpro / Receita Federal: {e}") from e

    def get_nfe_data(self, chave: str) -> NFeData:
        token = self._get_bearer_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, application/xml"
        }
        url = f"{self.api_url}/nfe/{chave}"

        try:
            logger.info(f"Consultando chave {chave} na API Oficial da Receita Federal (Serpro)...")
            resp = requests.get(url, headers=headers, timeout=DEFAULT_HTTP_EXTENDED_TIMEOUT)
            resp.raise_for_status()

            # Se retornar XML diretamente
            content_type = resp.headers.get("Content-Type", "").lower()
            text = resp.text if isinstance(resp.text, str) else ""
            if "xml" in content_type or text.startswith("<?xml") or "<nfeProc" in text:
                return NFeXmlParser.parse(text, chave)

            # Se retornar JSON estruturado Serpro
            data = resp.json()
            if "xml" in data and data["xml"]:
                return NFeXmlParser.parse(data["xml"], chave)

            nfe = data.get("nfe", data)
            emitente = nfe.get("emitente", {})
            valores = nfe.get("valores", nfe.get("total", {}))
            cobranca = nfe.get("cobranca", {})

            dups: List[NFeDuplicate] = []
            for d in cobranca.get("duplicatas", []):
                dups.append(NFeDuplicate(
                    numero=str(d.get("numero", "")),
                    vencimento=datetime.strptime(d.get("vencimento"), "%Y-%m-%d").date() if d.get("vencimento") else date.today(),
                    valor=Decimal(str(d.get("valor", 0)))
                ))

            data_emi_str = nfe.get("dataEmissao") or nfe.get("dhEmi")
            data_emissao = datetime.fromisoformat(data_emi_str.split("T")[0]).date() if data_emi_str else date.today()

            return NFeData(
                chave=chave,
                numero_nota=str(nfe.get("numero", "")),
                data_emissao=data_emissao,
                emitente_nome=emitente.get("razaoSocial", emitente.get("xNome", "")),
                emitente_cnpj=emitente.get("cnpj", emitente.get("cpfCnpj", "")),
                valor_total=Decimal(str(valores.get("valorTotal", valores.get("vNF", 0.0)))),
                duplicatas=dups
            )
        except Exception as e:
            raise NFeProviderError(f"Erro ao consultar chave {chave} na API Oficial da Receita Federal: {e}") from e


NSU_RE = re.compile(r"^\d{1,15}$")


def validar_nsu(nsu: Any) -> str:
    """NSU da distribuição DF-e: 1 a 15 dígitos. Levanta ValueError para qualquer outra coisa."""
    valor = str(nsu if nsu is not None else "").strip()
    if not NSU_RE.match(valor):
        raise ValueError(f"NSU inválido: deve ter de 1 a 15 dígitos (recebido {valor[:20]!r}).")
    return valor


_PASTAS_PEM_ATIVAS: "set[str]" = set()


def _base_pasta_pem() -> Optional[str]:
    """tmpfs (/dev/shm) quando existe e é gravável: a chave privada não toca o disco."""
    shm = Path("/dev/shm")
    if shm.is_dir() and os.access(shm, os.W_OK | os.X_OK):
        return str(shm)
    return None


def _criar_pasta_privada_pem() -> str:
    pasta = tempfile.mkdtemp(prefix="sefaz-a1-", dir=_base_pasta_pem())
    os.chmod(pasta, 0o700)
    _PASTAS_PEM_ATIVAS.add(pasta)
    return pasta


def _gravar_privado(caminho: Path, conteudo: bytes) -> str:
    fd = os.open(str(caminho), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(conteudo)
    return str(caminho)


def _remover_pasta_privada(pasta: str) -> None:
    shutil.rmtree(pasta, ignore_errors=True)
    _PASTAS_PEM_ATIVAS.discard(pasta)


@atexit.register
def _limpar_pastas_pem() -> None:
    for pasta in list(_PASTAS_PEM_ATIVAS):
        _remover_pasta_privada(pasta)


class SefazA1Provider(BaseNFeProvider):
    """
    Integração direta com o WebService Nacional da SEFAZ (NFeDistribuicaoDFe).
    Utiliza Certificado Digital A1 (.pfx, .p12 ou .pem) para autenticação mTLS.
    Endpoint: https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx
    """
    SEFAZ_DIST_URL_PROD = "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx"
    SEFAZ_DIST_URL_HOM = "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx"

    def __init__(
        self,
        cert_path: Optional[Path] = None,
        cert_password: Optional[str] = None,
        cnpj: Optional[str] = None,
        uf: str = "SP",
        ambiente: str = "1",
        endpoint_url: Optional[str] = None,
        cert_uf: Optional[str] = None,
        timeout: Optional[Tuple[float, float]] = None,
    ) -> None:
        self.cert_path = cert_path or settings.SEFAZ_CERT_PATH
        self.cert_password = cert_password or settings.SEFAZ_CERT_PASSWORD
        raw_cnpj = str(cnpj or settings.SEFAZ_CNPJ or "")
        self.cnpj = "".join(c for c in raw_cnpj if c.isdigit())
        self.uf = (uf or settings.SEFAZ_UF or "SP").upper().strip()
        self.cert_uf = (cert_uf or self.uf or "SP").upper().strip()
        self.ambiente = ambiente or getattr(settings, "SEFAZ_AMBIENTE", "1")
        self.endpoint_url = endpoint_url or (self.SEFAZ_DIST_URL_PROD if self.ambiente == "1" else self.SEFAZ_DIST_URL_HOM)
        self.timeout = timeout or DEFAULT_SEFAZ_TIMEOUT
        self._temp_cert_file: Optional[str] = None
        self._temp_key_file: Optional[str] = None
        self._temp_dir: Optional[str] = None

    def _prepare_certificates(self) -> tuple[str, str]:
        """Extrai par de chaves PEM do certificado .pfx/.p12 para uso no requests (mTLS)."""
        if not self.cert_path or not Path(self.cert_path).exists():
            raise NFeProviderError(f"Arquivo de certificado digital A1 não encontrado: {self.cert_path}")

        path_obj = Path(self.cert_path)
        ext = path_obj.suffix.lower()

        if ext in [".pem", ".crt"]:
            return (str(path_obj), str(path_obj))

        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.serialization import pkcs12
        except ImportError:
            raise NFeProviderError("Biblioteca 'cryptography' é necessária para ler certificados .pfx/.p12. Instale com 'pip install cryptography'.")

        try:
            with open(path_obj, "rb") as f:
                pfx_bytes = f.read()

            pwd_bytes = self.cert_password.encode("utf-8") if self.cert_password else None
            private_key, certificate, additional_certs = pkcs12.load_key_and_certificates(pfx_bytes, pwd_bytes)

            if not private_key or not certificate:
                raise NFeProviderError("Chave privada ou certificado não encontrados no arquivo .pfx/.p12 fornecido.")

            cert_pem = certificate.public_bytes(serialization.Encoding.PEM)
            if additional_certs:
                for ac in additional_certs:
                    cert_pem += ac.public_bytes(serialization.Encoding.PEM)

            key_pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption()
            )

            # O requests/OpenSSL só carrega o par mTLS de arquivo. A chave privada vai para uma
            # pasta privada (0700) em memória (/dev/shm, tmpfs) quando existe, com arquivos 0600,
            # e é apagada ao fim de cada consulta (_cleanup_temp_certs) e no encerramento (atexit).
            self._cleanup_temp_certs()
            self._temp_dir = _criar_pasta_privada_pem()
            self._temp_cert_file = _gravar_privado(Path(self._temp_dir) / "cert.pem", cert_pem)
            self._temp_key_file = _gravar_privado(Path(self._temp_dir) / "key.pem", key_pem)
            return (self._temp_cert_file, self._temp_key_file)
        except Exception as e:
            self._cleanup_temp_certs()
            raise NFeProviderError(f"Erro ao processar certificado A1 ({self.cert_path}): {e}") from e

    def _build_soap_envelope(self, chave: str) -> str:
        c_uf = UF_TO_IBGE.get(self.cert_uf, UF_TO_IBGE.get(self.uf, "35"))
        return f"""<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>{self.ambiente}</tpAmb>
          <cUFAutor>{c_uf}</cUFAutor>
          <CNPJ>{self.cnpj}</CNPJ>
          <consChNFe>
            <chNFe>{chave}</chNFe>
          </consChNFe>
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>"""

    def _build_dist_nsu_envelope(self, ult_nsu: str) -> str:
        """
        Envelope de consulta por NSU (distNSUInt): em vez de pedir uma chave específica
        já conhecida (consChNFe), pede "tudo que é novo para este CNPJ desde este NSU" —
        é o que permite descobrir compras automaticamente sem já saber a chave de antemão.
        """
        c_uf = UF_TO_IBGE.get(self.cert_uf, UF_TO_IBGE.get(self.uf, "35"))
        # Vai interpolado no XML: só dígitos (até 15), nunca texto vindo de fora.
        nsu_padded = validar_nsu(ult_nsu or "0").zfill(15)
        return f"""<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>{self.ambiente}</tpAmb>
          <cUFAutor>{c_uf}</cUFAutor>
          <CNPJ>{self.cnpj}</CNPJ>
          <distNSU>
            <ultNSU>{nsu_padded}</ultNSU>
          </distNSU>
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>"""

    def consultar_distribuicao_nsu(self, ult_nsu: str = "0") -> "DistNsuResult":
        """
        Consulta o lote de documentos novos disponíveis para este CNPJ a partir do NSU
        informado (distNSUInt). Ao contrário de get_nfe_data (que exige já saber a chave),
        este método é o que alimenta a varredura automática: "o que apareceu desde a
        última vez que perguntei".
        """
        if not self.cnpj:
            raise NFeProviderError("CNPJ consultante (SEFAZ_CNPJ) não configurado no .env.")

        soap_body = self._build_dist_nsu_envelope(ult_nsu)
        headers = {
            "Content-Type": "application/soap+xml; charset=utf-8; action=\"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse\"",
            "Accept": "application/soap+xml, text/xml"
        }

        try:
            cert_files = self._prepare_certificates()
            logger.info(f"Consultando distribuição NSU={ult_nsu} para CNPJ {self.cnpj} no WebService Nacional SEFAZ...")
            resp = requests.post(
                self.endpoint_url,
                data=soap_body.encode("utf-8"),
                headers=headers,
                cert=cert_files,
                timeout=self.timeout,
                verify=True
            )
            resp.raise_for_status()
            return self._parse_dist_nsu_response(resp.text, ult_nsu)
        except requests.exceptions.RequestException as e:
            raise NFeProviderError(f"Falha de comunicação com WebService SEFAZ (distNSU): {e}") from e
        finally:
            self._cleanup_temp_certs()

    def _parse_dist_nsu_response(self, response_xml: str, requested_nsu: str) -> "DistNsuResult":
        try:
            root = ET.fromstring(response_xml)
        except Exception as e:
            raise NFeProviderError(f"Resposta SEFAZ inválida (XML malformado) para distNSU: {e}")

        def find_first(element: Element, tag_name: str) -> Optional[Element]:
            for el in element.iter():
                if el.tag.split("}")[-1] == tag_name:
                    return el
            return None

        ret_dist = find_first(root, "retDistDFeInt")
        if ret_dist is None:
            raise NFeProviderError("Tag <retDistDFeInt> não encontrada na resposta da SEFAZ (distNSU).")

        c_stat_el = find_first(ret_dist, "cStat")
        x_motivo_el = find_first(ret_dist, "xMotivo")
        c_stat = c_stat_el.text.strip() if c_stat_el is not None and c_stat_el.text else ""
        x_motivo = x_motivo_el.text.strip() if x_motivo_el is not None and x_motivo_el.text else "Sem motivo retornado"

        ult_nsu_el = find_first(ret_dist, "ultNSU")
        max_nsu_el = find_first(ret_dist, "maxNSU")
        ult_nsu = ult_nsu_el.text.strip() if ult_nsu_el is not None and ult_nsu_el.text else requested_nsu
        max_nsu = max_nsu_el.text.strip() if max_nsu_el is not None and max_nsu_el.text else ult_nsu

        if c_stat == "656":
            logger.warning(
                f"[SEFAZ_SCAN] SEFAZ retornou cStat 656 (Consumo Indevido) para CNPJ {self.cnpj}. "
                f"requested_nsu='{requested_nsu}', ret_ultNSU='{ult_nsu}', ret_maxNSU='{max_nsu}', xMotivo='{x_motivo}'"
            )

        docs: List[SefazDocEntry] = []
        for el in ret_dist.iter():
            if el.tag.split("}")[-1] != "docZip":
                continue
            nsu_attr = el.attrib.get("NSU", "")
            schema_attr = el.attrib.get("schema", "")
            raw_b64 = el.text.strip() if el.text else ""
            if not raw_b64:
                continue
            try:
                decompressed = gzip.decompress(base64.b64decode(raw_b64)).decode("utf-8", errors="replace")
            except Exception as e:
                logger.warning(f"Erro ao descompactar docZip NSU={nsu_attr} da distribuição SEFAZ: {e}")
                continue
            docs.append(SefazDocEntry(nsu=nsu_attr, schema=schema_attr, xml_content=decompressed))

        return DistNsuResult(c_stat=c_stat, x_motivo=x_motivo, ult_nsu=ult_nsu, max_nsu=max_nsu, docs=docs)

    def get_nfe_data(self, chave: str) -> NFeData:
        if chave.startswith("REC-"):
            return build_receipt_from_key(chave, fallback_dest_cnpj=self.cnpj)

        if len(chave) == 44 and chave[20:22] == "65":
            logger.info(f"[NFC-e] Chave {chave} é Modelo 65. Extraindo dados estruturados da chave...")
            return build_nfce_from_key(chave, fallback_dest_cnpj=self.cnpj)

        if not self.cnpj:
            raise NFeProviderError("CNPJ consultante (SEFAZ_CNPJ) não configurado no .env.")

        soap_body = self._build_soap_envelope(chave)
        headers = {
            "Content-Type": "application/soap+xml; charset=utf-8; action=\"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse\"",
            "Accept": "application/soap+xml, text/xml"
        }

        try:
            cert_files = self._prepare_certificates()
            logger.info(f"Consultando chave {chave} no WebService Nacional SEFAZ (NFeDistribuicaoDFe)...")
            resp = requests.post(
                self.endpoint_url,
                data=soap_body.encode("utf-8"),
                headers=headers,
                cert=cert_files,
                timeout=self.timeout,
                verify=True
            )
            resp.raise_for_status()
            return self._parse_sefaz_response(resp.text, chave)
        except requests.exceptions.RequestException as e:
            raise NFeProviderError(f"Falha de comunicação com WebService SEFAZ: {e}") from e
        finally:
            self._cleanup_temp_certs()

    def _cleanup_temp_certs(self) -> None:
        for path in (self._temp_cert_file, self._temp_key_file):
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except Exception:
                    pass
        if self._temp_dir:
            _remover_pasta_privada(self._temp_dir)
        self._temp_cert_file = None
        self._temp_key_file = None
        self._temp_dir = None

    def _parse_sefaz_response(self, response_xml: str, chave: str) -> NFeData:
        try:
            root = ET.fromstring(response_xml)
        except Exception as e:
            raise NFeProviderError(f"Resposta SEFAZ inválida (XML malformado): {e}")

        def find_first(element: Element, tag_name: str) -> Optional[Element]:
            for el in element.iter():
                if el.tag.split("}")[-1] == tag_name:
                    return el
            return None

        ret_dist = find_first(root, "retDistDFeInt")
        if ret_dist is None:
            raise NFeProviderError("Tag <retDistDFeInt> não encontrada na resposta da SEFAZ.")

        c_stat_el = find_first(ret_dist, "cStat")
        x_motivo_el = find_first(ret_dist, "xMotivo")
        c_stat = c_stat_el.text.strip() if c_stat_el is not None and c_stat_el.text else ""
        x_motivo = x_motivo_el.text.strip() if x_motivo_el is not None and x_motivo_el.text else "Sem motivo retornado"

        if c_stat == "618" or "modelo diferente de 55" in x_motivo.lower():
            logger.info(f"SEFAZ cStat {c_stat} ({x_motivo}) para {chave}. Utilizando dados da chave...")
            return build_nfce_from_key(chave, fallback_dest_cnpj=self.cnpj)

        if c_stat not in ("138", "137"):
            raise NFeProviderError(f"SEFAZ retornou rejeição: cStat {c_stat} - {x_motivo}")

        for el in ret_dist.iter():
            if el.tag.split("}")[-1] == "docZip":
                raw_b64 = el.text.strip() if el.text else ""
                if not raw_b64:
                    continue
                try:
                    decompressed = gzip.decompress(base64.b64decode(raw_b64)).decode("utf-8", errors="replace")
                except Exception as e:
                    logger.warning(f"Erro ao descompactar docZip da SEFAZ: {e}")
                    continue

                if "<nfeProc" in decompressed or "<NFe" in decompressed:
                    data = NFeXmlParser.parse(decompressed, chave)
                    if not data.destinatario_cnpj and self.cnpj:
                        data.destinatario_cnpj = self.cnpj
                    return data

                if "<resNFe" in decompressed:
                    data = self._parse_res_nfe(decompressed, chave)
                    if not data.destinatario_cnpj and self.cnpj:
                        data.destinatario_cnpj = self.cnpj
                    return data

        raise NFeProviderError(f"Nenhum documento retornado pela SEFAZ para a chave {chave} (cStat {c_stat} - {x_motivo}).")


    def _parse_res_nfe(self, xml_text: str, chave: str) -> NFeData:
        root = ET.fromstring(xml_text)
        def find_first(element: Element, tag_name: str) -> Optional[Element]:
            for el in element.iter():
                if el.tag.split("}")[-1] == tag_name:
                    return el
            return None

        cnpj_el = find_first(root, "CNPJ")
        x_nome_el = find_first(root, "xNome")
        v_nf_el = find_first(root, "vNF")
        dh_emi_el = find_first(root, "dhEmi")

        cnpj = cnpj_el.text.strip() if cnpj_el is not None and cnpj_el.text else ""
        nome = x_nome_el.text.strip() if x_nome_el is not None and x_nome_el.text else "Emitente SEFAZ"
        v_nf = Decimal(v_nf_el.text.strip()) if v_nf_el is not None and v_nf_el.text else Decimal("0.00")
        
        data_emi = date.today()
        if dh_emi_el is not None and dh_emi_el.text:
            try:
                data_emi = datetime.fromisoformat(dh_emi_el.text.split("T")[0]).date()
            except Exception:
                pass

        n_nf = str(int(chave[25:34])) if len(chave) == 44 else "0"

        return NFeData(
            chave=chave,
            numero_nota=n_nf,
            data_emissao=data_emi,
            emitente_nome=nome,
            emitente_cnpj=cnpj,
            valor_total=v_nf,
            duplicatas=[]
        )


STATE_NAME_TO_UF = {
    "ACRE": "AC", "ALAGOAS": "AL", "AMAPA": "AP", "AMAZONAS": "AM",
    "BAHIA": "BA", "CEARA": "CE", "DISTRITO FEDERAL": "DF", "ESPIRITO SANTO": "ES",
    "GOIAS": "GO", "MARANHAO": "MA", "MATO GROSSO": "MT", "MATO GROSSO DO SUL": "MS",
    "MINAS GERAIS": "MG", "PARA": "PA", "PARAIBA": "PB", "PARANA": "PR",
    "PERNAMBUCO": "PE", "PIAUI": "PI", "RIO DE JANEIRO": "RJ", "RIO GRANDE DO NORTE": "RN",
    "RIO GRANDE DO SUL": "RS", "RONDONIA": "RO", "RORAIMA": "RR", "SANTA CATARINA": "SC",
    "SAO PAULO": "SP", "SERGIPE": "SE", "TOCANTINS": "TO"
}


def normalize_uf(value: Optional[str]) -> Optional[str]:
    """Converte nome de estado ou sigla para a sigla oficial de 2 letras da UF."""
    if not value:
        return None
    cleaned = value.strip().upper()
    if cleaned in UF_TO_IBGE:
        return cleaned
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", cleaned)
    ascii_clean = "".join([c for c in nfkd if not unicodedata.combining(c)])
    return STATE_NAME_TO_UF.get(ascii_clean)


def collect_candidate_passwords(cert_file: Path, cfg: Settings) -> List[str]:
    """Coleta senhas candidatas para um certificado específico a partir de arquivos .pass, env vars e config."""
    candidates: List[str] = []
    if not cert_file or not cert_file.name or str(cert_file) in ("", "."):
        return candidates

    # 1. Arquivo companheiro ao lado do .pfx (ex: secrets/matriz.pass ou secrets/matriz.txt)
    for ext in (".pass", ".txt"):
        companion = cert_file.with_suffix(ext)
        if companion.exists():
            try:
                content = companion.read_text("utf-8").strip()
                if content:
                    candidates.append(content)
            except Exception:
                pass

    # 2. Variáveis de ambiente dedicadas: SEFAZ_PASSWORD_<NOME> ou SEFAZ_PASSWORD_<CNPJ>
    stem_clean = "".join(c for c in cert_file.stem.upper() if c.isalnum() or c == "_")
    for key, val in os.environ.items():
        if key.upper().startswith("SEFAZ_PASSWORD_") and val:
            suffix = key[len("SEFAZ_PASSWORD_"):].upper()
            if suffix in stem_clean or stem_clean in suffix:
                candidates.append(val.strip())

    # 3. SEFAZ_PASSWORDS (pode ser JSON '{"CNPJ": "senha"}', lista 'matriz:senha1, filial:senha2' ou 'senha1, senha2')
    if cfg.SEFAZ_PASSWORDS:
        raw = cfg.SEFAZ_PASSWORDS.strip()
        if raw.startswith("{"):
            try:
                import json
                m = json.loads(raw)
                for k, v in m.items():
                    digits_k = "".join(c for c in k if c.isdigit())
                    digits_f = "".join(c for c in cert_file.stem if c.isdigit())
                    if k.lower() in cert_file.name.lower() or (digits_k and digits_k == digits_f):
                        candidates.insert(0, str(v).strip())
                    else:
                        candidates.append(str(v).strip())
            except Exception:
                pass
        else:
            entries = [e.strip() for e in raw.replace("\n", ",").split(",") if e.strip()]
            for e in entries:
                if ":" in e:
                    ident, pwd = e.split(":", 1)
                    ident = ident.strip().lower()
                    pwd = pwd.strip()
                    digits_ident = "".join(c for c in ident if c.isdigit())
                    digits_f = "".join(c for c in cert_file.stem if c.isdigit())
                    if ident in cert_file.name.lower() or (digits_ident and digits_ident == digits_f):
                        candidates.insert(0, pwd)
                    else:
                        candidates.append(pwd)
                else:
                    candidates.append(e)

    # 4. Senha padrão de fallback
    if cfg.SEFAZ_CERT_PASSWORD:
        candidates.append(cfg.SEFAZ_CERT_PASSWORD.strip())

    # Deduplica preservando a ordem
    unique_candidates: List[str] = []
    for c in candidates:
        if c and c not in unique_candidates:
            unique_candidates.append(c)

    return unique_candidates


def extract_cert_metadata(
    cert_path: Path,
    candidate_passwords: Optional[Union[List[str], str]] = None
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Tenta abrir o certificado digital A1 testando senhas candidatas.
    Retorna (cnpj, uf, senha_utilizada_com_sucesso).
    """
    if candidate_passwords is None:
        pwds = [None]
    elif isinstance(candidate_passwords, str):
        pwds = [candidate_passwords]
    else:
        pwds = list(candidate_passwords) if candidate_passwords else [None]

    try:
        from cryptography.hazmat.primitives.serialization import pkcs12
        from cryptography.x509.oid import NameOID
        with open(cert_path, "rb") as f:
            pfx_bytes = f.read()

        for pwd in pwds:
            pwd_bytes = pwd.encode("utf-8") if pwd else None
            try:
                _, cert, _ = pkcs12.load_key_and_certificates(pfx_bytes, pwd_bytes)
            except ValueError:
                # Senha incorreta para este certificado, continua tentando a próxima
                continue
            except Exception as e:
                logger.debug(f"Erro ao tentar ler certificado {cert_path.name}: {e}")
                continue

            if cert:
                cnpj = None
                uf = None
                for attr in cert.subject:
                    if attr.oid == NameOID.COMMON_NAME:
                        parts = str(attr.value).split(":")
                        candidate = "".join(c for c in parts[-1] if c.isdigit())
                        if len(candidate) == 14:
                            cnpj = candidate
                    elif attr.oid == NameOID.STATE_OR_PROVINCE_NAME:
                        uf = normalize_uf(str(attr.value))
                return cnpj, uf, pwd

    except Exception as e:
        logger.debug(f"Não foi possível extrair metadados automaticamente de {cert_path.name}: {e}")
    return None, None, None


def extract_cnpj_from_cert_file(cert_path: Path, password: Optional[str] = None) -> Optional[str]:
    """Tenta extrair o CNPJ do Subject (Common Name) ou extensões de um certificado ICP-Brasil."""
    cnpj, _, _ = extract_cert_metadata(cert_path, password)
    return cnpj


def build_nfce_from_key(chave: str, fallback_dest_cnpj: Optional[str] = None) -> NFeData:
    """
    Decompõe chave de acesso de NFC-e (modelo 65) em dados fiscais estruturados.
    A SEFAZ Nacional não distribui XML de NFC-e via NFeDistribuicaoDFe (rejeição cStat 618),
    portanto os metadados estruturais são extraídos da chave oficial de 44 dígitos:
    - [00:02]: UF (código IBGE)
    - [02:04]: Ano de emissão
    - [04:06]: Mês de emissão
    - [06:20]: CNPJ do emitente (14 dígitos)
    - [20:22]: Modelo (65)
    - [22:25]: Série (3 dígitos)
    - [25:34]: Número da nota fiscal (9 dígitos)
    - [34:35]: Tipo de emissão
    - [35:43]: Código numérico aleatório
    - [43:44]: Dígito verificador
    """
    try:
        ano = int("20" + chave[2:4])
        mes = int(chave[4:6])
        data_emissao = date(ano, mes, 1)
    except Exception:
        data_emissao = date.today()

    cnpj_emit = chave[6:20] if len(chave) == 44 else ""
    n_nf = str(int(chave[25:34])) if len(chave) == 44 and chave[25:34].isdigit() else "0"

    return NFeData(
        chave=chave,
        numero_nota=n_nf,
        data_emissao=data_emissao,
        emitente_nome=f"Emitente NFC-e ({cnpj_emit})",
        emitente_cnpj=cnpj_emit,
        valor_total=Decimal("0.00"),
        duplicatas=[],
        destinatario_cnpj=fallback_dest_cnpj
    )


def build_receipt_from_key(chave: str, fallback_dest_cnpj: Optional[str] = None) -> NFeData:
    """Gera NFeData a partir de chave sintética de comprovante/orçamento (REC-...)."""
    parts = chave.split("-")
    emitente_nome = parts[2] if len(parts) > 2 else "Fornecedor / Emitente"
    val_total = Decimal("0.00")
    if len(parts) > 3:
        try:
            val_total = Decimal(parts[3]) / Decimal("100")
        except Exception:
            pass

    return NFeData(
        chave=chave,
        numero_nota="1",
        data_emissao=date.today(),
        emitente_nome=emitente_nome,
        emitente_cnpj="00000000000000",
        valor_total=val_total,
        duplicatas=[],
        destinatario_cnpj=fallback_dest_cnpj
    )


# Whitelist estrita de marcadores pré-existentes autorizados de caixa/pagamento
AUTHORIZED_PAYMENT_MARCADORES: Dict[str, str] = {
    # Norvia
    "caixa visa norvia": "Caixa Visa Norvia",
    # Nome do marcador no Tiny é "Cartão Clara" (2026-10-07); "Clara" no nome do arquivo continua aceito.
    "clara": "Cartão Clara",
    "cartão clara": "Cartão Clara",
    "cartao clara": "Cartão Clara",
    # Revesta
    "caixa visa": "Caixa Visa",
    "caixa elo": "Caixa Elo",
}


def calculate_marker_vencimento(data_emissao: date, marcador_caixa: Optional[str], offset_months: int = 0) -> Optional[date]:
    """
    Regra de vencimento de cartões e caixas:

    1. Marcador Clara ('Cartão Clara'):
       Ciclo de fatura: do dia 03 do mês M até o dia 02 do mês M+1.
       Vencimento: dia 09 do mês M+1 (+ offset_months).
       Exemplos:
       - 03 Jul 26 à 02 Ago 26 -> vencimento em 09/08/2026
       - 03 Ago 26 à 02 Set 26 -> vencimento em 09/09/2026
       - 03 Dez 26 à 02 Jan 27 -> vencimento em 09/01/2027

    2. Marcador Visa e Elo ('Caixa Visa', 'Caixa Elo', 'Caixa Visa Norvia'):
       Ciclo mensal fechado: do dia 01 ao dia 31 do mês M.
       Vencimento: sempre no dia 15 do próximo mês (M+1 + offset_months).
       Exemplos:
       - 01 Jul a 31 Jul -> vencimento em 15/08
       - 01 Ago a 31 Ago -> vencimento em 15/09
       - 01 Dez a 31 Dez -> vencimento em 15/01 (ano seguinte)
    """
    if not marcador_caixa:
        return None

    m_lower = marcador_caixa.strip().lower()

    if "clara" in m_lower:
        # Dias 03 a 31 pertencem ao ciclo que vence no dia 9 do próximo mês
        if data_emissao.day >= 3:
            total_m = (data_emissao.year * 12 + data_emissao.month) + offset_months
        else:
            # Dias 01 e 02 pertencem ao ciclo que vence no dia 9 deste mês atual
            total_m = (data_emissao.year * 12 + data_emissao.month - 1) + offset_months

        target_year = total_m // 12
        target_month = (total_m % 12) + 1
        return date(target_year, target_month, 9)

    if "visa" in m_lower or "elo" in m_lower:
        total_m = (data_emissao.year * 12 + data_emissao.month) + offset_months
        target_year = total_m // 12
        target_month = (total_m % 12) + 1
        return date(target_year, target_month, 15)

    return None


def _cnpj_formatado_regex(cnpj: str) -> str:
    """Regex que casa o CNPJ com ou sem máscara (11.222.333/0001-44 ou 11222333000144)."""
    d = re.sub(r"\D", "", cnpj or "")
    if len(d) != 14:
        return r"(?!)"
    return rf"{d[:2]}\.?{d[2:5]}\.?{d[5:8]}/?{d[8:12]}-?{d[12:]}"


_ROTULOS_NAO_NOME = re.compile(
    r"^(?:CNPJ|CPF|IE|INSCRI|ENDERE|DANFE|NFC-?E|DOCUMENTO|CHAVE|PROTOCOLO|CONSULTA|CONSUMIDOR|"
    r"DESTINAT|EMITENTE\s*$|DATA|HORA|\d{2}/\d{2}/\d{4})",
    re.IGNORECASE,
)


def nome_antes_do_cnpj(raw_text: str, cnpj: str) -> Optional[str]:
    """
    Nome do estabelecimento na linha logo acima do CNPJ dele (layout de DANFE/NFC-e: razão
    social e, embaixo, "CNPJ: ..."). Usado com o CNPJ do emitente tirado da chave — não depende
    de rótulo "Razão Social", que na NFC-e só existe na seção do CONSUMIDOR.
    """
    if not raw_text or not cnpj:
        return None
    linhas = [l.strip() for l in raw_text.splitlines()]
    padrao = re.compile(_cnpj_formatado_regex(cnpj))
    for i, linha in enumerate(linhas):
        if not padrao.search(linha):
            continue
        # Mesmo linha: "JC MATERIAL LTDA CNPJ: 15.077..." -> o que vem antes do rótulo.
        antes = re.split(r"CNPJ", linha, flags=re.IGNORECASE)[0].strip(" :-")
        if len(antes) >= 4 and not _ROTULOS_NAO_NOME.match(antes):
            return antes
        for j in range(i - 1, max(-1, i - 4), -1):
            cand = linhas[j].strip(" :-")
            if len(cand) >= 4 and not _ROTULOS_NAO_NOME.match(cand) and not re.fullmatch(r"[\d\W]+", cand):
                return cand
    return None


# Forma de pagamento escrita no cupom -> código tPag da NF-e (mesma tabela da tela de revisão).
_MEIOS_PAGAMENTO_TEXTO = (
    (r"cart[ãa]o\s+de\s+cr[ée]dito", "03"),
    (r"cart[ãa]o\s+de\s+d[ée]bito", "04"),
    (r"\bpix\b", "17"),
    (r"boleto", "15"),
    (r"vale\s+alimenta", "10"),
    (r"vale\s+refei", "11"),
    (r"vale\s+presente", "12"),
    (r"vale\s+combust", "13"),
    (r"transfer[êe]ncia", "18"),
    (r"\bdinheiro\b", "01"),
    (r"\bcheque\b", "02"),
)


def meio_pagamento_do_texto(raw_text: str) -> Optional[str]:
    """Código tPag pela forma de pagamento escrita depois de "Forma de pagamento" (cupom NFC-e)."""
    if not raw_text:
        return None
    m = re.search(r"forma\s+de\s+pagamento", raw_text, re.IGNORECASE)
    if not m:
        return None
    trecho = raw_text[m.end(): m.end() + 300]
    achados = []
    for padrao, codigo in _MEIOS_PAGAMENTO_TEXTO:
        pos = re.search(padrao, trecho, re.IGNORECASE)
        if pos:
            achados.append((pos.start(), codigo))
    return min(achados)[1] if achados else None


def extract_fiscal_data_from_text(raw_text: str) -> Dict[str, Any]:
    """
    Extrai dados fiscais (emitente, CNPJ, valor total, data de emissão, duplicatas/parcelas)
    a partir do texto bruto escaneado de DANFE, NFC-e ou comprovante.
    """
    data: Dict[str, Any] = {}
    if not raw_text:
        return data

    # 1. CNPJ do Emitente
    cnpj_match = re.search(r"CNPJ[^\d]*(\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2})", raw_text, re.IGNORECASE)
    if cnpj_match:
        data["emitente_cnpj"] = re.sub(r"\D", "", cnpj_match.group(1))

    # 2. Valor Total
    val_match = re.search(
        r"(?:VALOR\s+A\s+PAGAR|VALOR\s+TOTAL|V\.?\s*TOTAL|TOTAL\s+R\$|TOTAL)[^\d\n\r]*R?\$?\s*([\d\.,]+)",
        raw_text,
        re.IGNORECASE
    )
    if val_match:
        try:
            clean_v = val_match.group(1).replace(".", "").replace(",", ".").strip()
            data["valor_total"] = Decimal(clean_v)
        except Exception:
            pass

    # 3. Data de emissão (DD/MM/YYYY). "Emissão" primeiro; "Data/Hora" é a data em que a
    # consulta da SEFAZ foi impressa, não a da nota.
    date_match = re.search(r"EMISS[ÃA]O[^\d\n\r]*(\d{2}/\d{2}/\d{4})", raw_text, re.IGNORECASE) or re.search(
        r"\bDATA\b(?!\s*/\s*HORA)[^\d\n\r]*(\d{2}/\d{2}/\d{4})", raw_text, re.IGNORECASE
    )
    if date_match:
        try:
            data["data_emissao"] = datetime.strptime(date_match.group(1), "%d/%m/%Y").date()
        except Exception:
            pass

    # 4. Razão Social / Nome do Emitente
    emit_explicit = None
    for m in re.finditer(
        r"(?:RAZ[ÃA]O\s+SOCIAL|NOME\s*[/]?\s*RAZ[ÃA]O\s+SOCIAL|EMITENTE)[: \t]*([A-Z0-9 \t\.\-&]{4,60})",
        raw_text,
        re.IGNORECASE,
    ):
        # Na NFC-e a única "Razão Social" é a do CONSUMIDOR (ex.: "CLIENTE NAO IDENTIFICADO").
        contexto = raw_text[max(0, m.start() - 120): m.start()].upper()
        if "CONSUMIDOR" in contexto or "DESTINAT" in contexto:
            continue
        emit_explicit = m
        break
    if emit_explicit:
        cand_name = emit_explicit.group(1).strip()
        if not any(term in cand_name.upper() for term in ["DANFE", "NFC-E", "DOCUMENTO", "CHAVE"]):
            data["emitente_nome"] = cand_name

    if "emitente_nome" not in data:
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
        for line in lines[:10]:
            up = line.upper()
            if any(term in up for term in ["DANFE", "NFC-E", "DOCUMENTO AUXILIAR", "CHAVE DE ACESSO", "PROTOCOLO", "RECEITA FEDERAL", "CONSULTA VIA QR"]):
                continue
            cleaned = re.sub(r"CNPJ[:\s]*\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}", "", line, flags=re.IGNORECASE).strip()
            cleaned = re.sub(r"^[:\s\-\.]+", "", cleaned).strip()
            if len(cleaned) >= 4 and not re.match(r"^[\d\W]+$", cleaned):
                data["emitente_nome"] = cleaned
                break

    # 5. Duplicatas / Parcelas extraídas do corpo da nota
    duplicatas: List[NFeDuplicate] = []
    dup_matches = re.finditer(
        r"(?:(?:DUP|PARC|FATURA)[^\d\n]*)?(?P<num>\d{1,4})\s+(?P<venc>\d{2}/\d{2}/\d{4})\s+R?\$?\s*(?P<val>\d{1,3}(?:\.\d{3})*,\d{2})",
        raw_text,
        re.IGNORECASE
    )
    for m in dup_matches:
        try:
            d_num = f"{int(m.group('num')):03d}"
            d_venc = datetime.strptime(m.group("venc"), "%d/%m/%Y").date()
            d_val = Decimal(m.group("val").replace(".", "").replace(",", ".").strip())
            duplicatas.append(NFeDuplicate(numero=d_num, vencimento=d_venc, valor=d_val))
        except Exception:
            pass

    if not duplicatas:
        parc_mult = re.search(r"(\d+)\s*x\s*(?:de\s*)?R?\$?\s*([\d\.,]+)", raw_text, re.IGNORECASE)
        if parc_mult:
            try:
                qtd = int(parc_mult.group(1))
                val_parc = Decimal(parc_mult.group(2).replace(".", "").replace(",", ".").strip())
                if 1 < qtd <= 24:
                    emissao = data.get("data_emissao", date.today())
                    for i in range(qtd):
                        duplicatas.append(NFeDuplicate(
                            numero=f"{i+1:03d}",
                            vencimento=emissao,
                            valor=val_parc
                        ))
            except Exception:
                pass

    if duplicatas:
        data["duplicatas"] = duplicatas

    return data


_PREFIXO_DOCUMENTO_DRIVE = re.compile(r"^(?:NFC-?e|NF-?e|NF|DANFE|Recibo|REC|Cupom|Nota\s+fiscal)\b", re.IGNORECASE)


def _marcador_na_parte(parte: str) -> Optional[str]:
    """
    Marcador de caixa/cartão numa parte do nome do arquivo: "Clara", "Caixa Visa"... ou com
    "Cartão" na frente ("Cartão Clara" — antes só o nome exato valia e a forma de pagamento,
    que define o vencimento, se perdia).
    """
    p = re.sub(r"\s+", " ", parte.strip().lower())
    if p in AUTHORIZED_PAYMENT_MARCADORES:
        return AUTHORIZED_PAYMENT_MARCADORES[p]
    sem_prefixo = re.sub(r"^cart[ãa]o\s+(?:de\s+cr[ée]dito\s+)?", "", p)
    return AUTHORIZED_PAYMENT_MARCADORES.get(sem_prefixo)


def _cnpj_do_grupo_no_texto(raw_text: str, excluir: Optional[str] = None) -> Optional[str]:
    """
    CNPJ de empresa do grupo citado no texto (fora o do emitente). Na NFC-e, o da seção
    "Consumidor"/"Destinatário" tem prioridade.
    """
    if not raw_text:
        return None
    candidatos = []
    for cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
        if cnpj == excluir:
            continue
        for m in re.finditer(_cnpj_formatado_regex(cnpj), raw_text):
            contexto = raw_text[max(0, m.start() - 80): m.start()].upper()
            prioridade = 0 if ("CONSUMIDOR" in contexto or "DESTINAT" in contexto) else 1
            candidatos.append((prioridade, m.start(), cnpj))
    return min(candidatos)[2] if candidatos else None


def _eh_prefixo_documento_drive(prefixo: str, total_partes: int) -> bool:
    """'NFC-e Revesta', 'Recibo' etc. (padrão do Drive); nunca uma chave, número ou nome de download."""
    if re.fullmatch(r"[\d\s]+", prefixo):
        return False
    return bool(_PREFIXO_DOCUMENTO_DRIVE.match(prefixo)) and (total_partes >= 2 or " " in prefixo)


def enrich_nfe_data_from_file_context(
    nfe_data: NFeData,
    file_path: Union[str, Path],
    raw_ocr_text: Optional[str] = None
) -> NFeData:
    """
    Enriquece ou complementa dados de NF-e/NFC-e usando o nome do arquivo e o conteúdo interno (OCR/texto).
    Padrão oficial do Drive: 'NFC-e {empresa} - {marcador_caixa}.pdf'
    Exemplos:
      - 'NFC-e Norvia - Clara.pdf'
      - 'NFC-e Revesta - Caixa Visa.pdf'
      - 'NFC-e Revesta - Caixa Elo.pdf'
      - 'NFC-e Norvia - Caixa Visa Norvia.pdf'
      - 'NFC-e Norvia - Clara - AUTO POSTO EXEMPLO - R$43,15.pdf' (compatibilidade legado)
    """
    path_obj = Path(file_path)
    filename = path_obj.name
    stem = path_obj.stem.strip()

    # Separação pelos delimitadores ' - ' (com suporte a traço comum, en-dash e em-dash)
    parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", stem) if p.strip()]

    doc_prefix = ""
    marcador_caixa: Optional[str] = None
    emitente_str = ""
    valor_file: Optional[Decimal] = None

    # Só nomes no padrão do Drive viram N° documento. Antes QUALQUER nome virava: um XML
    # salvo com a chave ("4126...1412.xml") ou baixado como "invoice-2000017019020870.xml"
    # ia para o Tiny com N° documento "41260562875462000100" / "invoice-200001701902",
    # em vez de "NF-e {Empresa}" (incidente 2026-09-28, NF 24 Café e Prosa).
    if parts and _eh_prefixo_documento_drive(parts[0], len(parts)):
        doc_prefix = parts[0]
        nfe_data.numero_documento_custom = doc_prefix

    for p in parts[1:]:
        p_clean = p.strip()
        p_lower = p_clean.lower()
        marcador_parte = _marcador_na_parte(p_clean)
        if marcador_parte:
            if not marcador_caixa:
                marcador_caixa = marcador_parte
        elif re.search(r"R\$\s*[\d\.,]+", p_clean, re.IGNORECASE):
            v_match = re.search(r"[\d\.,]+", p_clean)
            if v_match:
                try:
                    val_cleaned = v_match.group(0).replace(".", "").replace(",", ".").strip()
                    valor_file = Decimal(val_cleaned)
                except Exception:
                    pass
        elif not emitente_str and p_lower not in AUTHORIZED_PAYMENT_MARCADORES:
            # Se for apenas número/moeda sem R$ explícito
            v_direct = re.match(r"^R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})$", p_clean)
            if v_direct and not valor_file:
                try:
                    val_cleaned = v_direct.group(1).replace(".", "").replace(",", ".").strip()
                    valor_file = Decimal(val_cleaned)
                except Exception:
                    pass
            else:
                emitente_str = p_clean

    # Fallback regex para casos em que o separador não é ' - ' com espaços
    if not emitente_str or not valor_file:
        match = re.search(
            r"(?:NFC-e|NFE|NF|DANFE)?\s*(?P<empresa>[^-–—]+?)\s*[-–—]\s*(?:(?P<marcador>caixa\s+visa\s+norvia|caixa\s+visa|caixa\s+elo|clara)\s*[-–—]\s*)?(?:(?P<emitente>[^-–—]+?)\s*[-–—]\s*)?R\$\s*(?P<valor>[\d\.,]+)",
            filename,
            re.IGNORECASE
        )
        if match:
            if not doc_prefix:
                doc_prefix = match.group("empresa").strip()
                nfe_data.numero_documento_custom = doc_prefix
            if match.group("marcador") and not marcador_caixa:
                m_low = match.group("marcador").strip().lower()
                if m_low in AUTHORIZED_PAYMENT_MARCADORES:
                    marcador_caixa = AUTHORIZED_PAYMENT_MARCADORES[m_low]
            if match.group("emitente") and not emitente_str:
                cand = match.group("emitente").strip()
                if cand.lower() not in AUTHORIZED_PAYMENT_MARCADORES:
                    emitente_str = cand
            if not valor_file:
                val_cleaned = match.group("valor").replace(".", "").replace(",", ".").strip()
                try:
                    valor_file = Decimal(val_cleaned)
                except Exception:
                    pass

    # Garante que marcador nunca seja atribuído a emitente_str
    if emitente_str and emitente_str.strip().lower() in AUTHORIZED_PAYMENT_MARCADORES:
        if not marcador_caixa:
            marcador_caixa = AUTHORIZED_PAYMENT_MARCADORES[emitente_str.strip().lower()]
        emitente_str = ""

    # Extração prévia de dados internos do arquivo via OCR / pdftotext se aplicável
    if raw_ocr_text is None and path_obj.is_file() and path_obj.suffix.lower() == ".pdf":
        try:
            import subprocess
            proc = subprocess.run(["pdftotext", str(path_obj), "-"], capture_output=True, text=True, timeout=5)
            if proc.returncode == 0 and proc.stdout.strip():
                raw_ocr_text = proc.stdout
        except Exception:
            pass

    # Resolve empresa / destinatário e marcador pré-existente no Tiny
    emp_detect = (nfe_data.numero_documento_custom or "").lower()

    # NFC-e (modelo 65) e comprovantes não têm XML: empresa, data e emitente saem do texto.
    chave_doc = nfe_data.chave or ""
    sem_xml = (len(chave_doc) == 44 and chave_doc[20:22] == "65") or chave_doc.startswith("REC-")

    # 1. Empresa (consumidor) pelo CNPJ do grupo citado no texto. Na NFC-e vale mesmo se já
    #    havia um CNPJ: ele era só um palpite (não há XML com o destinatário).
    if raw_ocr_text and (not nfe_data.destinatario_cnpj or sem_xml):
        cnpj_texto = _cnpj_do_grupo_no_texto(raw_ocr_text, excluir=nfe_data.emitente_cnpj)
        if cnpj_texto:
            nfe_data.destinatario_cnpj = cnpj_texto

    # 2. Fallback por nome do documento / arquivo
    if "revesta" in emp_detect:
        nfe_data.destinatario_cnpj = "36592814000100"
        nfe_data.destinatario_nome = "Revesta"
        nfe_data.marcador_empresa = "Revesta"
    elif "fabrilux" in emp_detect:
        nfe_data.destinatario_cnpj = "43820617000166"
        nfe_data.destinatario_nome = "Fabrilux"
        nfe_data.marcador_empresa = "Fabrilux"
    elif "campinas" in emp_detect:
        nfe_data.destinatario_cnpj = "27184930000107"
        nfe_data.destinatario_nome = "Norvia Campinas"
        nfe_data.marcador_empresa = "Norvia"
    elif "curitiba" in emp_detect:
        nfe_data.destinatario_cnpj = "27184930000280"
        nfe_data.destinatario_nome = "Norvia Curitiba"
        nfe_data.marcador_empresa = "NorviaLDA"
    elif "norvia" in emp_detect:
        # "Norvia" sozinho não diz a filial: se o texto trouxe o CNPJ, o passo 3 resolve.
        if nfe_data.destinatario_cnpj not in ("27184930000107", "27184930000280"):
            nfe_data.destinatario_nome = nfe_data.destinatario_nome or "Norvia"
            nfe_data.marcador_empresa = nfe_data.marcador_empresa or "Norvia"

    # 3. Resolução determinística por CNPJ quando presente e nome ainda não definido
    if not nfe_data.destinatario_nome:
        if nfe_data.destinatario_cnpj == "27184930000280":
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ["27184930000280"]
            nfe_data.marcador_empresa = "NorviaLDA"
        elif nfe_data.destinatario_cnpj == "27184930000107":
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ["27184930000107"]
            nfe_data.marcador_empresa = "Norvia"
        elif nfe_data.destinatario_cnpj == "43820617000166":
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ["43820617000166"]
            nfe_data.marcador_empresa = "Fabrilux"
        elif nfe_data.destinatario_cnpj == "36592814000100":
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ["36592814000100"]
            nfe_data.marcador_empresa = "Revesta"

    nfe_data.marcador_caixa = marcador_caixa
    marcadores_list = []
    if marcador_caixa and marcador_caixa not in marcadores_list:
        marcadores_list.append(marcador_caixa)
    if nfe_data.marcador_empresa and nfe_data.marcador_empresa not in marcadores_list:
        marcadores_list.append(nfe_data.marcador_empresa)
    nfe_data.marcadores = marcadores_list

    if raw_ocr_text:
        internal = extract_fiscal_data_from_text(raw_ocr_text)
        emitente_provisorio = not nfe_data.emitente_nome or nfe_data.emitente_nome.startswith("Emitente NFC-e")
        # O nome na linha acima do CNPJ do emitente (da chave) é o mais confiável.
        nome_pelo_cnpj = nome_antes_do_cnpj(raw_ocr_text, nfe_data.emitente_cnpj) if emitente_provisorio else None
        if nome_pelo_cnpj:
            nfe_data.emitente_nome = nome_pelo_cnpj
        elif internal.get("emitente_nome") and emitente_provisorio:
            nfe_data.emitente_nome = internal["emitente_nome"]
        if not nfe_data.meio_pagamento_nfe:
            nfe_data.meio_pagamento_nfe = meio_pagamento_do_texto(raw_ocr_text)
        if internal.get("emitente_cnpj") and (not nfe_data.emitente_cnpj or len(nfe_data.emitente_cnpj) < 14):
            nfe_data.emitente_cnpj = internal["emitente_cnpj"]
        if internal.get("valor_total") and (nfe_data.valor_total is None or nfe_data.valor_total <= 0):
            nfe_data.valor_total = internal["valor_total"]
        data_texto = internal.get("data_emissao")
        if data_texto and nfe_data.data_emissao == date.today():
            nfe_data.data_emissao = data_texto
        elif data_texto and sem_xml and len(chave_doc) == 44 and (data_texto.year % 100, data_texto.month) == (
            int(chave_doc[2:4]), int(chave_doc[4:6])
        ):
            # A chave da NFC-e só tem ano/mês (o dia vinha como 01): vale a "Emissão" do cupom
            # quando bate com o ano/mês da chave.
            nfe_data.data_emissao = data_texto
        if internal.get("duplicatas") and (not nfe_data.duplicatas or len(nfe_data.duplicatas) <= 1):
            nfe_data.duplicatas = internal["duplicatas"]

    # Se informado no nome do arquivo
    if emitente_str and (not nfe_data.emitente_nome or nfe_data.emitente_nome.startswith("Emitente NFC-e") or nfe_data.emitente_nome.lower() in AUTHORIZED_PAYMENT_MARCADORES):
        nfe_data.emitente_nome = emitente_str

    if valor_file:
        nfe_data.valor_total = valor_file

    # Garante duplicatas com valor e vencimento calculado segundo as regras de cartões/caixa
    calculated_venc = calculate_marker_vencimento(nfe_data.data_emissao, marcador_caixa)
    if calculated_venc:
        # Se a nota tem múltiplas duplicatas legítimas (extraídas da SEFAZ ou do OCR do documento)
        is_mock = bool(nfe_data.emitente_nome and nfe_data.emitente_nome.startswith("FORNECEDOR EXEMPLO"))
        if nfe_data.duplicatas and len(nfe_data.duplicatas) > 1 and not is_mock:
            # Preserva exatamente a quantidade de parcelas da nota, aplicando o ciclo de vencimento para cada parcela
            for idx, dup in enumerate(nfe_data.duplicatas):
                dup.vencimento = calculate_marker_vencimento(nfe_data.data_emissao, marcador_caixa, offset_months=idx)
        else:
            val_dup = nfe_data.valor_total if (nfe_data.valor_total and nfe_data.valor_total > 0) else (valor_file or Decimal("0.00"))
            nfe_data.duplicatas = [
                NFeDuplicate(
                    numero="001",
                    vencimento=calculated_venc,
                    valor=val_dup
                )
            ]
    else:
        # Sem marcador de cartão/caixa: mantém as duplicatas com seus vencimentos originais da SEFAZ/nota
        if not nfe_data.duplicatas or nfe_data.duplicatas[0].valor <= 0:
            val_dup = nfe_data.valor_total if (nfe_data.valor_total and nfe_data.valor_total > 0) else (valor_file or Decimal("0.00"))
            nfe_data.duplicatas = [
                NFeDuplicate(
                    numero="001",
                    vencimento=nfe_data.data_emissao,
                    valor=val_dup
                )
            ]

    return nfe_data


class MultiSefazA1Provider(BaseNFeProvider):
    """
    Provedor Multi-Certificado e Multi-CNPJ para o WebService Nacional da SEFAZ.
    Gerencia um pool de certificados A1 de diferentes filiais/empresas do grupo.
    Ao consultar uma NF-e, itera em cascata sobre os certificados disponíveis até
    localizar a nota (cStat 138) ou confirmar que não pertence a nenhum dos CNPJs.
    """
    def __init__(self, providers: List[SefazA1Provider]) -> None:
        if not providers:
            raise NFeProviderError("Nenhum provedor SEFAZ A1 válido fornecido para MultiSefazA1Provider.")
        self.providers = providers

    def get_nfe_data(self, chave: str) -> NFeData:
        if chave.startswith("REC-"):
            dest_cnpj = self.providers[0].cnpj if self.providers else None
            return build_receipt_from_key(chave, fallback_dest_cnpj=dest_cnpj)

        if len(chave) == 44 and chave[20:22] == "65":
            # A empresa (consumidor) sai do texto do cupom ou do nome do arquivo, em
            # enrich_nfe_data_from_file_context. Antes vinha o CNPJ do 1º certificado do pool,
            # e toda NFC-e caía na mesma empresa (incidente 2026-10-07: NFC-e da Norvia
            # Campinas lançada como Revesta).
            logger.info(
                f"[NFC-e] Chave {chave} é Modelo 65 (NFC-e). "
                f"Decompondo metadados da chave (SEFAZ Nacional NFeDistribuicaoDFe distribui apenas modelo 55)."
            )
            return build_nfce_from_key(chave, fallback_dest_cnpj=None)

        logger.info(f"Consultando NF-e {chave} no pool de {len(self.providers)} CNPJs da empresa...")
        last_error = None
        for prov in self.providers:
            try:
                data = prov.get_nfe_data(chave)
                if not data.destinatario_cnpj and prov.cnpj:
                    data.destinatario_cnpj = prov.cnpj
                logger.info(f"NF-e {chave} localizada com sucesso no CNPJ {prov.cnpj}!")
                return data

            except NFeProviderError as e:
                err_msg = str(e)
                if "618" in err_msg or "modelo diferente de 55" in err_msg.lower():
                    logger.info(f"SEFAZ indicou modelo não-55. Gerando dados estruturados a partir da chave {chave}...")
                    return build_nfce_from_key(chave, fallback_dest_cnpj=prov.cnpj)
                if "137" in err_msg or "não encontrado" in err_msg.lower() or "não localizada" in err_msg.lower():
                    logger.debug(f"Chave {chave} não pertence ao CNPJ {prov.cnpj}. Tentando próximo CNPJ...")
                    last_error = e
                    continue
                last_error = e
                logger.warning(f"Erro ao consultar CNPJ {prov.cnpj}: {e}")

        if last_error and ("618" in str(last_error) or "modelo diferente de 55" in str(last_error).lower()):
            dest_cnpj = self.providers[0].cnpj if self.providers else None
            return build_nfce_from_key(chave, fallback_dest_cnpj=dest_cnpj)

        raise NFeProviderError(
            f"A nota fiscal {chave} não foi localizada em nenhum dos {len(self.providers)} CNPJs configurados da empresa. Detalhe: {last_error}"
        )


def load_sefaz_providers(cfg: Settings) -> BaseNFeProvider:
    """Carrega certificados únicos ou múltiplos do diretório secrets/ e inicializa o provedor SEFAZ com senhas distintas."""
    providers: List[SefazA1Provider] = []
    seen_cnpjs = set()

    # 1. Varre diretório de certificados (SEFAZ_CERTS_DIR ou ./secrets quando não houver cert individual especificado)
    certs_dir = cfg.SEFAZ_CERTS_DIR
    if not certs_dir and not cfg.SEFAZ_CERT_PATH and Path("./secrets").exists():
        certs_dir = Path("./secrets")
    if certs_dir and Path(certs_dir).is_dir():
        cert_files = []
        for ext in ("*.pfx", "*.p12", "*.pem"):
            cert_files.extend(list(Path(certs_dir).glob(ext)))

        for cert_file in cert_files:
            candidates = collect_candidate_passwords(cert_file, cfg)
            cnpj, detected_uf, working_pwd = extract_cert_metadata(cert_file, candidates)

            if not cnpj:
                digits_in_name = "".join(c for c in cert_file.stem if c.isdigit())
                if len(digits_in_name) == 14:
                    cnpj = digits_in_name

            pwd_to_use = working_pwd or (candidates[0] if candidates else cfg.SEFAZ_CERT_PASSWORD)

            if cnpj and cnpj not in seen_cnpjs:
                seen_cnpjs.add(cnpj)
                uf_to_use = detected_uf or cfg.SEFAZ_UF or "SP"
                logger.info(f"Certificado SEFAZ registrado: {cert_file.name} (CNPJ {cnpj}, UF {uf_to_use})")
                providers.append(SefazA1Provider(
                    cert_path=cert_file,
                    cert_password=pwd_to_use,
                    cnpj=cnpj,
                    uf=uf_to_use,
                    ambiente=cfg.SEFAZ_AMBIENTE
                ))

    # 2. Se houver certificado individual explicitado em SEFAZ_CERT_PATH
    if cfg.SEFAZ_CERT_PATH and str(cfg.SEFAZ_CERT_PATH).strip() not in ("", "."):
        cert_path_obj = Path(cfg.SEFAZ_CERT_PATH)
        candidates = collect_candidate_passwords(cert_path_obj, cfg)
        cnpj_val = cfg.SEFAZ_CNPJ
        uf_val = cfg.SEFAZ_UF
        working_pwd = None

        if cert_path_obj.exists():
            c_meta, u_meta, w_pwd = extract_cert_metadata(cert_path_obj, candidates)
            if not cnpj_val:
                digits = "".join(c for c in cert_path_obj.stem if c.isdigit())
                cnpj_val = digits if len(digits) == 14 else c_meta
            if u_meta:
                uf_val = u_meta
            if w_pwd:
                working_pwd = w_pwd

        pwd_to_use = working_pwd or cfg.SEFAZ_CERT_PASSWORD or (candidates[0] if candidates else None)

        if cnpj_val and cnpj_val not in seen_cnpjs:
            seen_cnpjs.add(cnpj_val)
            providers.append(SefazA1Provider(
                cert_path=cfg.SEFAZ_CERT_PATH,
                cert_password=pwd_to_use,
                cnpj=cnpj_val,
                uf=uf_val or "SP",
                ambiente=cfg.SEFAZ_AMBIENTE
            ))

    # 3. Filiais compartilhando certificado da Matriz (mesma raiz de CNPJ de 8 dígitos)
    # Na legislação fiscal brasileira (SEFAZ NT 2014.002), o certificado A1 da Matriz (ex: 27.184.930/0001-07)
    # possui autorização jurídica e técnica para consultar DFe via NFeDistribuicaoDFe de qualquer filial (ex: 27.184.930/0002-80).
    company_map = cfg.get_cnpj_company_map()
    for target_cnpj, company_id in company_map.items():
        if target_cnpj not in seen_cnpjs and len(target_cnpj) == 14:
            root_cnpj = target_cnpj[:8]
            matching_matriz = next((p for p in providers if p.cnpj[:8] == root_cnpj and p.cert_path), None)
            if matching_matriz:
                target_uf = COMPANY_UF_BY_CNPJ.get(target_cnpj) or ("PR" if "curitiba" in str(company_id).lower() else (cfg.SEFAZ_UF or "SP"))
                
                env_pwd_key = f"SEFAZ_PASSWORD_{target_cnpj}"
                pwd_filial = os.environ.get(env_pwd_key, "").strip() or matching_matriz.cert_password

                seen_cnpjs.add(target_cnpj)
                logger.info(
                    f"Certificado SEFAZ registrado para filial: CNPJ {target_cnpj} (UF {target_uf}) "
                    f"utilizando certificado da Matriz {matching_matriz.cnpj} ({Path(matching_matriz.cert_path).name})"
                )
                providers.append(SefazA1Provider(
                    cert_path=matching_matriz.cert_path,
                    cert_password=pwd_filial,
                    cnpj=target_cnpj,
                    uf=target_uf,
                    cert_uf=matching_matriz.uf,
                    ambiente=cfg.SEFAZ_AMBIENTE,
                ))

    if not providers:
        logger.warning("Nenhum certificado digital A1 válido encontrado para SEFAZ. Alternando para MockNFeProvider.")
        return MockNFeProvider()

    if len(providers) == 1:
        return providers[0]

    return MultiSefazA1Provider(providers)


class MockNFeProvider(BaseNFeProvider):
    """
    Provedor Mock para desenvolvimento, testes e homologação offline.
    Decodifica informações estruturais da chave de 44 dígitos (CNPJ, Número da Nota, Mês/Ano)
    e gera dados consistentes sem necessidade de credenciais de APIs pagas.
    """

    def get_nfe_data(self, chave: str) -> NFeData:
        logger.info(f"[MOCK] Gerando dados simulados para a chave NF-e: {chave}")
        if len(chave) == 44 and chave[20:22] == "65":
            logger.info(f"[MOCK] Chave {chave} é NFC-e (modelo 65). Delegando para build_nfce_from_key.")
            return build_nfce_from_key(chave)

        if len(chave) == 44:
            cnpj = chave[6:20]
            n_nf = str(int(chave[25:34]))
            try:
                ano = 2000 + int(chave[2:4])
                mes = int(chave[4:6])
                data_emissao = date(ano, mes, 15)
            except Exception:
                data_emissao = date.today()
        else:
            cnpj = "12345678000195"
            n_nf = "12345"
            data_emissao = date.today()

        v_total = Decimal("1500.00")
        duplicatas = [
            NFeDuplicate(numero="001", vencimento=data_emissao, valor=Decimal("750.00")),
            NFeDuplicate(numero="002", vencimento=date.fromordinal(data_emissao.toordinal() + 30), valor=Decimal("750.00")),
        ]

        return NFeData(
            chave=chave,
            numero_nota=n_nf,
            data_emissao=data_emissao,
            emitente_nome=f"FORNECEDOR EXEMPLO LTDA (CNPJ {cnpj})",
            emitente_cnpj=cnpj,
            valor_total=v_total,
            duplicatas=duplicatas
        )


def get_nfe_provider(cfg: Settings) -> BaseNFeProvider:
    """Fábrica para instanciar o provedor configurado."""
    provider_name = cfg.NFE_PROVIDER.lower()

    if provider_name == "receita_oficial":
        return ReceitaFederalProvider(
            consumer_key=cfg.RECEITA_CONSUMER_KEY,
            consumer_secret=cfg.RECEITA_CONSUMER_SECRET,
            token=cfg.RECEITA_API_TOKEN,
            api_url=cfg.RECEITA_API_URL,
            auth_url=cfg.RECEITA_AUTH_URL
        )

    elif provider_name == "sefaz_a1":
        return load_sefaz_providers(cfg)

    elif provider_name == "nuvem_fiscal":
        if not (cfg.NUVEM_FISCAL_CLIENT_ID and cfg.NUVEM_FISCAL_CLIENT_SECRET):
            logger.warning("Credenciais da Nuvem Fiscal não preenchidas. Alternando para MockNFeProvider.")
            return MockNFeProvider()
        return NuvemFiscalProvider(
            client_id=cfg.NUVEM_FISCAL_CLIENT_ID,
            client_secret=cfg.NUVEM_FISCAL_CLIENT_SECRET,
            api_url=cfg.NUVEM_FISCAL_API_URL,
            auth_url=cfg.NUVEM_FISCAL_AUTH_URL
        )

    elif provider_name == "plugnotas":
        if not cfg.PLUGNOTAS_API_KEY:
            logger.warning("Chave de API do PlugNotas não preenchida. Alternando para MockNFeProvider.")
            return MockNFeProvider()
        return PlugNotasProvider(
            api_key=cfg.PLUGNOTAS_API_KEY,
            api_url=cfg.PLUGNOTAS_API_URL
        )

    elif provider_name == "mock":
        return MockNFeProvider()

    else:
        logger.warning(f"Provedor '{provider_name}' desconhecido. Utilizando MockNFeProvider.")
        return MockNFeProvider()
