"""
Cliente de integração com a API Banking v2 do Banco Inter (PJ).
Utiliza mTLS (certificado .crt e chave privada .key) e OAuth2 client_credentials.

Suporta:
- As 4 filiais: fabrilux, revesta, norvia_campinas, norvia_curitiba.
- Divisão automática de períodos longos em janelas de até 89 dias (limite da API Inter).
- Extração de pagamentos (Boletos com código de barras, PIX, TEDs).
- Cache em memória de tokens OAuth2 mTLS.
- Fallback para dados de demonstração quando certificados não estiverem disponíveis em ambiente local.
"""
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
import hashlib
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import requests

from app.http_errors import sufixo_erro

from app.boleto import parse_boleto
from app.config import settings

logger = logging.getLogger("automacao_nfe.inter_client")

# Base URL oficial da API do Banco Inter PJ
INTER_BASE_URL = "https://cdpj.partners.bancointer.com.br"
INTER_TOKEN_PATH = "/oauth/v2/token"
INTER_EXTRATO_PATH = "/banking/v2/extrato/completo"

# Timeout padronizado para chamadas mTLS / HTTP ao Banco Inter (connect_timeout, read_timeout)
DEFAULT_INTER_TIMEOUT: Tuple[float, float] = (5.0, 25.0)

# Filiais com conta PJ no Inter. client_id/client_secret são segredos e vêm do ambiente
# (INTER_<EMPRESA>_CLIENT_ID / INTER_<EMPRESA>_CLIENT_SECRET, ver .env.example).
INTER_EMPRESAS: Dict[str, Dict[str, str]] = {
    "revesta": {"cnpj": "36592814000100", "nome": "Revesta"},
    "fabrilux": {"cnpj": "43820617000166", "nome": "Fabrilux"},
    "norvia_curitiba": {"cnpj": "27184930000280", "nome": "Norvia Curitiba"},
    "norvia_campinas": {"cnpj": "27184930000107", "nome": "Norvia Campinas"},
}


def get_inter_oauth_credentials(empresa: str) -> Optional[Tuple[str, str]]:
    """Retorna (client_id, client_secret) da empresa configurados no ambiente, ou None."""
    prefix = f"INTER_{empresa.upper()}"
    client_id = getattr(settings, f"{prefix}_CLIENT_ID", None)
    client_secret = getattr(settings, f"{prefix}_CLIENT_SECRET", None)
    if not client_id or not client_secret:
        return None
    return (client_id, client_secret)


@dataclass
class InterTransacao:
    """Transação de débito/pagamento normalizada do extrato do Banco Inter."""
    empresa: str
    transacao_id: str
    data_pagamento: date
    valor_pago: Decimal
    tipo_transacao: str  # PAGAMENTO, PIX, TRANSFERENCIA, BOLETO...
    titulo: str
    descricao: str
    codigo_barras: Optional[str] = None  # 44 dígitos
    cpf_cnpj_favorecido: Optional[str] = None
    nome_favorecido: Optional[str] = None
    valor_original: Optional[Decimal] = None
    data_vencimento: Optional[date] = None
    juros: Decimal = Decimal("0.00")
    multa: Decimal = Decimal("0.00")
    desconto: Decimal = Decimal("0.00")
    raw: Dict[str, Any] = field(default_factory=dict)


def _clean_digits(val: Optional[str]) -> Optional[str]:
    if not val:
        return None
    digits = re.sub(r"\D", "", str(val))
    return digits if digits else None


def _to_decimal(val: Any) -> Decimal:
    if val is None or val == "":
        return Decimal("0.00")
    try:
        clean = str(val).strip().replace(",", ".")
        return Decimal(clean)
    except Exception:
        return Decimal("0.00")


def _parse_date(val: Any) -> Optional[date]:
    if not val:
        return None
    val_str = str(val).split("T")[0].strip()
    try:
        if "/" in val_str:
            d, m, y = val_str.split("/")
            return date(int(y), int(m), int(d))
        return date.fromisoformat(val_str)
    except Exception:
        return None


# Esperas entre novas tentativas do extrato quando o Inter responde 5xx.
EXTRATO_RETRY_DELAYS_SECONDS: Tuple[int, ...] = (2, 5)

# empresa -> (access_token, expira_em_ts); ver InterClient.__init__
_TOKEN_CACHE: Dict[str, Tuple[str, float]] = {}
_TOKEN_LOCK = threading.Lock()


class InterClient:
    """Cliente para a API Banking v2 do Banco Inter."""

    def __init__(
        self,
        base_url: str = INTER_BASE_URL,
        certs_dir: Optional[Path] = None,
        timeout: Union[int, float, Tuple[float, float]] = DEFAULT_INTER_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.certs_dir = Path(certs_dir) if certs_dir else Path("./data/certs/inter")
        self.timeout = timeout
        # Compartilhados entre instâncias: a API cria um InterClient por requisição, e sem isso
        # cada consulta de status/prévia pedia um token OAuth novo por filial (o Inter limita
        # a emissão de tokens; o token vale ~1h).
        self._token_cache = _TOKEN_CACHE
        self._lock = _TOKEN_LOCK

    def get_cert_pair(self, empresa: str) -> Optional[Tuple[str, str]]:
        """
        Localiza o par de certificado (.crt) e chave privada (.key) para a empresa.
        Procura recursivamente em múltiplos diretórios candidatos de infraestrutura/Docker.
        """
        candidate_dirs = [
            self.certs_dir,
            Path("/app/data/certs/inter"),
            Path("./data/certs/inter"),
            Path("./backend/automations/automacoes-financeiro/data/certs/inter"),
            Path("/app/secrets/inter"),
            Path("./secrets/inter"),
            Path("/app/secrets"),
            Path("./secrets"),
        ]

        for cdir in candidate_dirs:
            if not cdir.exists():
                continue

            crt = cdir / f"{empresa}.crt"
            key = cdir / f"{empresa}.key"
            if crt.is_file() and key.is_file():
                return (str(crt), str(key))

            pem = cdir / f"{empresa}.pem"
            if pem.is_file() and key.is_file():
                return (str(pem), str(key))

            # Certificado compartilhado único
            shared_crt = cdir / "inter.crt"
            shared_key = cdir / "inter.key"
            if shared_crt.is_file() and shared_key.is_file():
                return (str(shared_crt), str(shared_key))

        return None

    def has_credentials(self, empresa: str) -> bool:
        """Verifica se existem credenciais (client_id, secret e certificados) configurados."""
        if empresa not in INTER_EMPRESAS or not get_inter_oauth_credentials(empresa):
            return False
        return self.get_cert_pair(empresa) is not None

    def check_credentials_status(self, empresa: str) -> Dict[str, Any]:
        """
        Verifica a saúde da integração mTLS e OAuth2 com o Banco Inter.
        Retorna: { 'status': 'conectado'|'certificados_ausentes'|'certificados_sem_permissao'|'certificado_expirado'|'erro_autenticacao', 'mensagem': str }
        """
        if empresa not in INTER_EMPRESAS:
            return {"status": "nao_configurado", "mensagem": f"Empresa '{empresa}' não cadastrada."}
        if not get_inter_oauth_credentials(empresa):
            prefix = f"INTER_{empresa.upper()}"
            return {
                "status": "nao_configurado",
                "mensagem": f"Credenciais OAuth2 ausentes: defina {prefix}_CLIENT_ID e {prefix}_CLIENT_SECRET no .env.",
            }

        cert_pair = self.get_cert_pair(empresa)
        if not cert_pair:
            return {
                "status": "certificados_ausentes",
                "mensagem": f"Certificados mTLS (.crt e .key) ausentes para '{empresa}'.",
            }

        # is_file() passa mesmo sem permissão de leitura; sem esta checagem o erro só aparece
        # dentro do requests como ('Connection aborted.', PermissionError(13, ...)).
        ilegiveis = [p for p in cert_pair if not os.access(p, os.R_OK)]
        if ilegiveis:
            return {
                "status": "certificados_sem_permissao",
                "mensagem": (
                    "Certificados mTLS encontrados, mas sem permissão de leitura pelo container "
                    f"(uid {os.getuid()}): {', '.join(ilegiveis)}."
                ),
            }

        try:
            self.get_token(empresa)
            return {"status": "conectado", "mensagem": "Conexão mTLS e token OAuth2 operacionais."}
        except Exception as e:
            err_str = str(e)
            if "CERTIFICATE_EXPIRED" in err_str or "certificate expired" in err_str.lower():
                return {
                    "status": "certificado_expirado",
                    "mensagem": "Certificado digital expirado no Banco Inter. Necessário renovar no Internet Banking.",
                }
            return {
                "status": "erro_autenticacao",
                "mensagem": f"Falha na autenticação do Banco Inter: {err_str}",
            }

    def get_token(self, empresa: str) -> str:
        """Obtém ou renova o access_token OAuth2 mTLS para a empresa."""
        with self._lock:
            cached = self._token_cache.get(empresa)
            if cached:
                token, exp_ts = cached
                if time.time() < exp_ts - 60:  # Margem de 60 segundos
                    return token

            cert_pair = self.get_cert_pair(empresa)
            if not cert_pair:
                raise RuntimeError(
                    f"Certificados mTLS (.crt e .key) não encontrados para a empresa '{empresa}' em {self.certs_dir}."
                )

            if empresa not in INTER_EMPRESAS:
                raise ValueError(f"Empresa '{empresa}' não reconhecida.")
            oauth = get_inter_oauth_credentials(empresa)
            if not oauth:
                raise RuntimeError(f"Credenciais OAuth2 do Banco Inter não configuradas para a empresa '{empresa}'.")
            client_id, client_secret = oauth

            url = f"{self.base_url}{INTER_TOKEN_PATH}"
            payload = {
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "client_credentials",
                "scope": "extrato.read",
            }
            headers = {"Content-Type": "application/x-www-form-urlencoded"}

            logger.info(f"[INTER] Solicitando token OAuth2 mTLS para '{empresa}'...")
            resp = requests.post(url, data=payload, headers=headers, cert=cert_pair, timeout=self.timeout)

            if not resp.ok:
                # Corpo cru só no log: pode ecoar dados da requisição de autenticação.
                logger.error(f"[INTER] Autenticação de '{empresa}' recusada (HTTP {resp.status_code}): {resp.text[:500]}")
                raise RuntimeError(f"Falha na autenticação Banco Inter (HTTP {resp.status_code}){sufixo_erro(resp)}")

            data = resp.json()
            access_token = data.get("access_token")
            expires_in = int(data.get("expires_in", 3600))
            if not access_token:
                raise RuntimeError("Resposta de autenticação do Banco Inter sem 'access_token'.")

            self._token_cache[empresa] = (access_token, time.time() + expires_in)
            return access_token

    def _split_date_range(self, start: date, end: date, max_days: int = 89) -> List[Tuple[date, date]]:
        """Divide períodos longos em janelas de até max_days dias (exigência da API Inter)."""
        windows = []
        cur_start = start
        while cur_start <= end:
            cur_end = min(cur_start + timedelta(days=max_days), end)
            windows.append((cur_start, cur_end))
            cur_start = cur_end + timedelta(days=1)
        return windows

    def get_extrato(
        self,
        empresa: str,
        data_inicio: date,
        data_fim: date,
        allow_demo: bool = False,
    ) -> List[InterTransacao]:
        """
        Consulta o extrato completo de débito/pagamento do Banco Inter no período especificado.
        Se os certificados mTLS não estiverem disponíveis e allow_demo=True, retorna dados de demonstração.
        Caso contrário, retorna lista vazia e loga aviso.
        """
        if not self.has_credentials(empresa):
            if allow_demo:
                logger.warning(f"[INTER] Certificados mTLS ausentes para '{empresa}'. Retornando dados demonstrativos.")
                return self.get_demo_extrato(empresa, data_inicio, data_fim)
            logger.warning(f"[INTER] Certificados mTLS ausentes para '{empresa}'. Retornando lista vazia.")
            return []

        windows = self._split_date_range(data_inicio, data_fim, max_days=89)
        all_transacoes: List[InterTransacao] = []
        seen_ids = set()

        cert_pair = self.get_cert_pair(empresa)

        for w_start, w_end in windows:
            token = self.get_token(empresa)
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            }
            pagina = 0
            while True:
                params: Dict[str, Any] = {
                    "dataInicio": w_start.isoformat(),
                    "dataFim": w_end.isoformat(),
                    "pagina": pagina,
                    "tamanhoPagina": 100,
                }
                url = f"{self.base_url}{INTER_EXTRATO_PATH}"
                logger.info(f"[INTER] Consultando extrato {empresa} de {w_start} até {w_end} (pág {pagina})...")

                # 5xx do Inter (ex.: 503 "no healthy upstream", visto em 2026-09-28) costuma ser
                # instabilidade passageira do lado deles: tenta mais algumas vezes antes de desistir.
                for tentativa, espera in enumerate(EXTRATO_RETRY_DELAYS_SECONDS + (None,), start=1):
                    resp = requests.get(url, headers=headers, params=params, cert=cert_pair, timeout=self.timeout)
                    if resp.status_code < 500 or espera is None:
                        break
                    logger.warning(
                        f"[INTER] Extrato {empresa} HTTP {resp.status_code} (tentativa {tentativa}); "
                        f"nova tentativa em {espera}s."
                    )
                    time.sleep(espera)
                if resp.status_code == 401:
                    with self._lock:
                        self._token_cache.pop(empresa, None)
                if not resp.ok:
                    # Antes só logava e seguia: um erro do Inter virava "nenhum débito no período"
                    # e a conciliação mostrava tudo zerado sem explicar o motivo.
                    logger.error(f"[INTER] Erro ao consultar extrato ({resp.status_code}): {resp.text}")
                    raise RuntimeError(
                        f"API do Inter respondeu HTTP {resp.status_code} ao extrato de "
                        f"{w_start:%d/%m/%Y} a {w_end:%d/%m/%Y} (pág. {pagina}){sufixo_erro(resp)}"
                    )

                data = resp.json()
                itens = data.get("transacoes", [])
                if not itens:
                    break

                for raw_item in itens:
                    t = self._normalize_transacao(empresa, raw_item)
                    if t and t.transacao_id not in seen_ids:
                        seen_ids.add(t.transacao_id)
                        all_transacoes.append(t)

                total_paginas = data.get("totalPaginas", 1)
                pagina += 1
                if pagina >= total_paginas:
                    break

        return all_transacoes

    def _normalize_transacao(self, empresa: str, item: Dict[str, Any]) -> Optional[InterTransacao]:
        """Normaliza um registro de débito da API Inter em InterTransacao."""
        tipo_op = str(item.get("tipoOperacao") or "D").upper()
        if tipo_op != "D":
            return None  # Apenas saídas / pagamentos

        detalhes = item.get("detalhes") or {}
        tipo_tx = str(item.get("tipoTransacao") or "PAGAMENTO").upper()

        data_pgto = _parse_date(item.get("dataEntrada") or item.get("dataTransacao"))
        if not data_pgto:
            return None

        valor_pago = abs(_to_decimal(item.get("valor")))
        if valor_pago <= 0:
            return None

        titulo = str(item.get("titulo") or tipo_tx).strip()
        descricao = str(item.get("descricao") or "").strip()
        descricao_pix = str(detalhes.get("descricaoPix") or "").strip()

        # Se houver descrição adicional do Pix, agrega à descrição para busca textual
        desc_completa = descricao
        if descricao_pix and descricao_pix not in desc_completa:
            desc_completa = f"{descricao} - {descricao_pix}" if descricao else descricao_pix

        # Identificador único da transação
        tx_id = (
            str(detalhes.get("autenticacao") or "")
            or str(detalhes.get("endToEndId") or "")
            or str(item.get("idTransacao") or "")
            or str(item.get("codigoTransacao") or "")
            # hash estável (o hash() do Python muda a cada processo): o id identifica o débito no
            # registro de baixas da conciliação mesmo depois de um restart.
            or f"{empresa}-{data_pgto}-{valor_pago}-{hashlib.sha1(desc_completa.encode('utf-8')).hexdigest()[:12]}"
        )

        # Extração de código de barras para boletos
        cod_barras = None
        raw_barras = detalhes.get("codBarras") or detalhes.get("linhaDigitavel")
        if raw_barras:
            parsed = parse_boleto(str(raw_barras), referencia=data_pgto)
            cod_barras = parsed.codigo_barras if parsed else _clean_digits(raw_barras)

        # Favorecido / Destinatário
        # CUIDADO: em débitos/boletos, 'detalhes.cpfCnpj' é o CNPJ do pagador (a filial).
        # Não confundi-lo com o CNPJ do fornecedor beneficiário.
        payer_cnpj = _clean_digits(INTER_EMPRESAS.get(empresa, {}).get("cnpj"))
        cpf_cnpj = None
        cand_cnpj = _clean_digits(
            detalhes.get("cpfCnpjRecebedor")
            or detalhes.get("cpfCnpjBeneficiario")
            or detalhes.get("chavePixRecebedor")
        )
        if cand_cnpj and len(cand_cnpj) in (11, 14):
            cpf_cnpj = cand_cnpj
        elif detalhes.get("cpfCnpj"):
            cand_generic = _clean_digits(detalhes.get("cpfCnpj"))
            if cand_generic and cand_generic != payer_cnpj:
                cpf_cnpj = cand_generic

        # Nome do fornecedor favorecido
        nome_fav = (
            detalhes.get("nomeDestinatario")
            or detalhes.get("nomeRecebedor")
            or detalhes.get("nomeBeneficiario")
            or detalhes.get("detalheDescricao")
            or (descricao if descricao and descricao.lower() != titulo.lower() else None)
        )
        if nome_fav:
            nome_fav = str(nome_fav).strip()

        valor_orig = _to_decimal(detalhes.get("valorOriginal")) if detalhes.get("valorOriginal") else None
        vencimento = _parse_date(detalhes.get("dataVencimento"))

        juros = _to_decimal(detalhes.get("juros"))
        multa = _to_decimal(detalhes.get("multa") or detalhes.get("adicionado"))
        desconto = _to_decimal(detalhes.get("desconto"))

        return InterTransacao(
            empresa=empresa,
            transacao_id=tx_id,
            data_pagamento=data_pgto,
            valor_pago=valor_pago,
            tipo_transacao=tipo_tx,
            titulo=titulo,
            descricao=desc_completa,
            codigo_barras=cod_barras,
            cpf_cnpj_favorecido=cpf_cnpj,
            nome_favorecido=nome_fav,
            valor_original=valor_orig,
            data_vencimento=vencimento,
            juros=juros,
            multa=multa,
            desconto=desconto,
            raw=item,
        )

    def get_demo_extrato(self, empresa: str, data_inicio: date, data_fim: date) -> List[InterTransacao]:
        """Gera pagamentos de demonstração coerentes com o Tiny ERP para simulação e testes."""
        hoje = date.today()
        ref_date = min(hoje, data_fim)

        demo_dataset: Dict[str, List[Dict[str, Any]]] = {
            "fabrilux": [
                {
                    "transacao_id": "INTER-HLX-001",
                    "data_pagamento": ref_date - timedelta(days=2),
                    "valor_pago": Decimal("4820.00"),
                    "tipo_transacao": "BOLETO",
                    "titulo": "Pagamento de Boleto",
                    "descricao": "COMPRAS FORNECEDOR ABC LTDA",
                    "codigo_barras": "34191978900000482000109000000000100000000010",
                    "cpf_cnpj_favorecido": "12345678000195",
                    "nome_favorecido": "FORNECEDOR ABC LTDA",
                    "valor_original": Decimal("4820.00"),
                    "data_vencimento": ref_date - timedelta(days=2),
                },
                {
                    "transacao_id": "INTER-HLX-002",
                    "data_pagamento": ref_date - timedelta(days=5),
                    "valor_pago": Decimal("1250.50"),
                    "tipo_transacao": "PIX",
                    "titulo": "Pix Enviado",
                    "descricao": "SERVICOS DE TRANSPORTE EXPRESSO",
                    "codigo_barras": None,
                    "cpf_cnpj_favorecido": "98765432000188",
                    "nome_favorecido": "TRANSPORTE EXPRESSO S/A",
                    "valor_original": Decimal("1250.50"),
                    "data_vencimento": ref_date - timedelta(days=5),
                },
                {
                    "transacao_id": "INTER-HLX-003",
                    "data_pagamento": ref_date - timedelta(days=1),
                    "valor_pago": Decimal("758.30"),
                    "tipo_transacao": "BOLETO",
                    "titulo": "Pagamento de Boleto com Juros",
                    "descricao": "DISTRIBUIDORA DE EMBALAGENS",
                    "codigo_barras": "23793380000000750001100000012345600000012345",
                    "cpf_cnpj_favorecido": "45678912000133",
                    "nome_favorecido": "DISTRIBUIDORA DE EMBALAGENS",
                    "valor_original": Decimal("750.00"),
                    "juros": Decimal("8.30"),
                    "data_vencimento": ref_date - timedelta(days=8),
                },
            ],
            "revesta": [
                {
                    "transacao_id": "INTER-PST-001",
                    "data_pagamento": ref_date - timedelta(days=3),
                    "valor_pago": Decimal("12800.00"),
                    "tipo_transacao": "BOLETO",
                    "titulo": "Pagamento de Boleto",
                    "descricao": "FABRICANTE DE PISOS CERAMICOS",
                    "codigo_barras": "00191978900001280000000012345678901234567890",
                    "cpf_cnpj_favorecido": "11223344000155",
                    "nome_favorecido": "FABRICANTE DE PISOS CERAMICOS",
                    "valor_original": Decimal("12800.00"),
                    "data_vencimento": ref_date - timedelta(days=3),
                },
                {
                    "transacao_id": "INTER-PST-002",
                    "data_pagamento": ref_date - timedelta(days=6),
                    "valor_pago": Decimal("3200.00"),
                    "tipo_transacao": "PIX",
                    "titulo": "Pix Enviado",
                    "descricao": "LOCACAO DE GALPAO COMERCIAL",
                    "codigo_barras": None,
                    "cpf_cnpj_favorecido": "22334455000166",
                    "nome_favorecido": "IMOBILIARIA CENTRAL LTDA",
                    "valor_original": Decimal("3200.00"),
                    "data_vencimento": ref_date - timedelta(days=6),
                },
            ],
            "norvia_campinas": [
                {
                    "transacao_id": "INTER-GRU-001",
                    "data_pagamento": ref_date - timedelta(days=1),
                    "valor_pago": Decimal("5430.00"),
                    "tipo_transacao": "BOLETO",
                    "titulo": "Pagamento de Boleto",
                    "descricao": "MATERIAL DE CONSTRUCAO CAMPINAS",
                    "codigo_barras": "03399978900000543001234567890123456789012345",
                    "cpf_cnpj_favorecido": "33445566000177",
                    "nome_favorecido": "MATERIAL DE CONSTRUCAO CAMPINAS",
                    "valor_original": Decimal("5430.00"),
                    "data_vencimento": ref_date - timedelta(days=1),
                }
            ],
            "norvia_curitiba": [
                {
                    "transacao_id": "INTER-LDA-001",
                    "data_pagamento": ref_date - timedelta(days=4),
                    "valor_pago": Decimal("2150.00"),
                    "tipo_transacao": "BOLETO",
                    "titulo": "Pagamento de Boleto",
                    "descricao": "FERRAGENS CURITIBA LTDA",
                    "codigo_barras": "10491978900000215001234567890123456789012345",
                    "cpf_cnpj_favorecido": "44556677000188",
                    "nome_favorecido": "FERRAGENS CURITIBA LTDA",
                    "valor_original": Decimal("2150.00"),
                    "data_vencimento": ref_date - timedelta(days=4),
                }
            ],
        }

        itens = demo_dataset.get(empresa, [])
        resultado = []
        for item in itens:
            if data_inicio <= item["data_pagamento"] <= data_fim:
                resultado.append(
                    InterTransacao(
                        empresa=empresa,
                        transacao_id=item["transacao_id"],
                        data_pagamento=item["data_pagamento"],
                        valor_pago=item["valor_pago"],
                        tipo_transacao=item["tipo_transacao"],
                        titulo=item["titulo"],
                        descricao=item["descricao"],
                        codigo_barras=item.get("codigo_barras"),
                        cpf_cnpj_favorecido=item.get("cpf_cnpj_favorecido"),
                        nome_favorecido=item.get("nome_favorecido"),
                        valor_original=item.get("valor_original"),
                        data_vencimento=item.get("data_vencimento"),
                        juros=item.get("juros", Decimal("0.00")),
                        multa=item.get("multa", Decimal("0.00")),
                        desconto=item.get("desconto", Decimal("0.00")),
                        raw=item,
                    )
                )
        return resultado
