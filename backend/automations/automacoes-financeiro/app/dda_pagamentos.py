"""
Boletos do DDA → conta a pagar do Tiny → pagamento agendado no Banco Inter → baixa no Tiny.

Substitui os 4 workflows "CONTAS A PAGAR" do n8n (recebimento DDA, match, agendamento, baixa).

Etapas de cada rodada (rotina a cada DDA_INTERVALO_MINUTOS e botão "Executar agora"):

1. **Sincronizar** — lê na Polp (Super DDA) os cadastros dos CNPJs e os boletos criados ou
   atualizados desde a última leitura. A empresa sai do CNPJ do pagador (INTER_EMPRESAS).
2. **Casar** — cada boleto novo procura, nas contas a pagar EM ABERTO do Tiny da empresa, a de
   mesmo fornecedor (CNPJ do beneficiário ou do sacador/avalista), mesmo vencimento e mesmo valor,
   tudo exato (sem tolerância). Uma conta → CASADO (aguarda validação humana no painel); nenhuma → SEM CONTA (o painel cria a conta ou
   descarta); mais de uma → AMBÍGUO (o painel escolhe). A automação nunca cria conta sozinha: a
   revisão de NF-e também lança contas com forma boleto e duplicaria.
3. **Agendar** (só com DDA_AGENDAR_NO_INTER) — boleto casado, VALIDADO no painel e ainda não vencido
   vai para o Inter
   da empresa com pagamento na data do vencimento, pelo valor original. O gerente aprova ou recusa
   no Internet Banking. Antes de incluir, procura o mesmo código de barras no Inter: um pagamento
   já incluído (rodada anterior que caiu no meio) é adotado, nunca duplicado.
4. **Acompanhar** — consulta no Inter os agendados. Pago → baixa a conta no Tiny (conta de origem
   "Banco Inter" da empresa, valor e data do Inter). Cancelado/recusado → aviso e o boleto fica
   para decidir no painel (reagendar ou descartar).

Estado em DATA_DIR/dda/estado.json (boletos, cursores da Polp, execuções e avisos).
"""
from __future__ import annotations

import copy
import json
import logging
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from app.boleto import parse_boleto
from app.config import Settings, settings
from app.fuso import agora_sp, hoje_sp
from app.inter_client import INTER_EMPRESAS, InterClient, PagamentoInterIncerto
from app.json_store import save_json_state
from app.polp_client import BOLETO_BAIXADO, BOLETO_CANCELADO, BOLETO_PAGO, PolpClient
from app.tiny_client import SITUACOES_CONTA_PAGAR_BAIXAVEIS, LancamentoCaixaIncerto, TinyClient

logger = logging.getLogger("automacao_nfe.dda")

# Situações do boleto na automação
SIT_NOVO = "NOVO"
SIT_SEM_CONTA = "SEM_CONTA"
SIT_AMBIGUO = "AMBIGUO"
SIT_CASADO = "CASADO"
SIT_VENCIDO = "VENCIDO_SEM_AGENDAR"
SIT_AGENDADO = "AGENDADO"
SIT_PAGO = "PAGO"  # pago no Inter, baixa no Tiny pendente (falhou: tenta de novo)
SIT_BAIXADO = "BAIXADO"
SIT_RECUSADO = "RECUSADO"
SIT_ENCERRADO = "ENCERRADO"  # pago/cancelado fora da automação (Polp ou Tiny)
SIT_DESCARTADO = "DESCARTADO"
SIT_ERRO = "ERRO"

FINAIS = {SIT_BAIXADO, SIT_ENCERRADO, SIT_DESCARTADO}
A_CASAR = {SIT_NOVO, SIT_SEM_CONTA, SIT_AMBIGUO}
A_ACOMPANHAR = {SIT_AGENDADO, SIT_PAGO}

# statusPagamento do Inter (a documentação só mostra EMPROCESSAMENTO; o resto segue o n8n e o
# Internet Banking). Status fora das duas listas = ainda em andamento (aguardando aprovação etc.).
INTER_PAGOS = {"PAGO", "REALIZADO", "EFETIVADO", "LIQUIDADO"}
INTER_RECUSADOS = {
    "CANCELADO", "REJEITADO", "RECUSADO", "EXPIRADO", "FALHA", "ERRO", "NAO_REALIZADO", "DEVOLVIDO", "ESTORNADO",
}

MAX_EVENTOS = 30
MAX_EXECUCOES = 60
MAX_AVISOS = 300
# Boletos finalizados saem do estado depois disso (o histórico fica no log e na auditoria).
DIAS_GUARDAR_FINAIS = 120
JANELA_TINY_ANTES = 30  # dias antes do menor vencimento pendente
JANELA_TINY_DEPOIS = 5
# A janela da Polp (fromCreatedAt/fromUpdatedAt) não diz o fuso: a próxima leitura volta 4 h
# (cobre UTC × Brasília). Repetir boleto não faz mal (atualiza o mesmo registro).
MARGEM_CURSOR = timedelta(hours=4)
DDA_STATUS_SUCESSO = 1

TokenTiny = Callable[[str], Optional[str]]


def agora() -> str:
    return agora_sp().isoformat(timespec="seconds")


def _digitos(valor: Any) -> str:
    return "".join(c for c in str(valor or "") if c.isdigit())


def _centavos(valor: Any) -> Optional[Decimal]:
    try:
        return (Decimal(int(valor)) / 100).quantize(Decimal("0.01")) if valor is not None else None
    except (TypeError, ValueError, InvalidOperation):
        return None


def _decimal(valor: Any) -> Optional[Decimal]:
    """Número do Tiny/Inter (float, int ou texto com ponto) em reais com 2 casas."""
    if valor in (None, ""):
        return None
    try:
        return Decimal(str(valor)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None


def _data(valor: Any) -> Optional[date]:
    texto = str(valor or "").strip()[:10]
    for formato in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto, formato).date()
        except ValueError:
            continue
    return None


def _cnpj_contato(conta: Dict[str, Any]) -> str:
    contato = conta.get("cliente") or conta.get("contato") or conta.get("fornecedor") or {}
    if isinstance(contato, dict):
        doc = contato.get("cpfCnpj") or contato.get("cnpj") or contato.get("cpf")
        if doc:
            return _digitos(doc)
    return _digitos(conta.get("cpfCnpj") or "")


def _nome_contato(conta: Dict[str, Any]) -> str:
    contato = conta.get("cliente") or conta.get("contato") or conta.get("fornecedor") or {}
    return str((contato or {}).get("nome") or "") if isinstance(contato, dict) else ""


def empresa_do_cnpj(cnpj: str) -> Optional[str]:
    cnpj = _digitos(cnpj)
    return next((emp for emp, info in INTER_EMPRESAS.items() if info["cnpj"] == cnpj), None)


def boleto_da_polp(item: Dict[str, Any], empresa: str) -> Dict[str, Any]:
    """Campos da Polp que a automação usa (valores em reais, datas AAAA-MM-DD)."""
    emissor = item.get("issuer") if isinstance(item.get("issuer"), dict) else {}
    linha = _digitos(item.get("digitable_line"))
    barras = _digitos(item.get("barcode"))
    if not barras and linha:
        info = parse_boleto(linha)
        barras = info.codigo_barras if info else ""
    return {
        "id": str(item.get("id")),
        "dda_id": str(item.get("dda_id") or ""),
        "empresa": empresa,
        "codigo_barras": barras,
        "linha_digitavel": linha,
        "beneficiario_nome": str(emissor.get("name") or emissor.get("fantasyName") or ""),
        "beneficiario_cnpj": _digitos(emissor.get("taxId")),
        "sacador_cnpj": _digitos(item.get("guarantor_tax_id")),
        "valor": str(_centavos(item.get("cost")) or ""),
        "valor_atualizado": str(_centavos(item.get("cost_updated")) or ""),
        "vencimento": str(item.get("due_date") or "")[:10],
        "emissao": str(item.get("issue_date") or "")[:10],
        "documento": str(item.get("document_number") or ""),
        "status_polp": item.get("status"),
        "status_polp_label": str(item.get("status_label") or ""),
        "tipo_label": str(item.get("type_label") or ""),
        "fraude": bool(item.get("is_fraud")),
    }


class EstadoDDA:
    def __init__(self, pasta: Optional[Path] = None, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or settings
        self._pasta = Path(pasta) if pasta else None
        self._lock = threading.RLock()
        self._dados: Optional[Dict[str, Any]] = None

    @property
    def arquivo(self) -> Path:
        return (self._pasta or Path(self.cfg.DATA_DIR) / "dda") / "estado.json"

    def ler(self) -> Dict[str, Any]:
        with self._lock:
            if self._dados is None:
                dados: Dict[str, Any] = {"boletos": {}, "cursores": {}, "execucoes": [], "avisos": [], "proximo_aviso": 1}
                if self.arquivo.exists():
                    try:
                        dados.update(json.loads(self.arquivo.read_text(encoding="utf-8")))
                    except Exception as e:
                        # Não sobrescreve: tem os pagamentos agendados no Inter.
                        raise RuntimeError(f"Estado do DDA ilegível em {self.arquivo}: {e}") from e
                self._dados = dados
            return self._dados

    @contextmanager
    def alterar(self) -> Iterator[Dict[str, Any]]:
        with self._lock:
            dados = copy.deepcopy(self.ler())
            yield dados
            self._dados = dados
            self.arquivo.parent.mkdir(parents=True, exist_ok=True)
            save_json_state(self.arquivo, dados, "DDA")


def _evento(boleto: Dict[str, Any], texto: str, usuario: str = "") -> None:
    boleto.setdefault("eventos", []).append({"em": agora(), "texto": texto, **({"usuario": usuario} if usuario else {})})
    del boleto["eventos"][:-MAX_EVENTOS]
    boleto["atualizado_em"] = agora()


def _mudar(boleto: Dict[str, Any], situacao: str, mensagem: str, usuario: str = "") -> None:
    boleto["situacao"] = situacao
    boleto["mensagem"] = mensagem
    _evento(boleto, f"{situacao}: {mensagem}", usuario)


def _aviso(dados: Dict[str, Any], tipo: str, titulo: str, mensagem: str) -> None:
    aviso_id = int(dados.get("proximo_aviso") or 1)
    dados["avisos"].append({"id": aviso_id, "tipo": tipo, "titulo": titulo, "mensagem": mensagem, "criado_em": agora()})
    dados["proximo_aviso"] = aviso_id + 1
    del dados["avisos"][:-MAX_AVISOS]


def _rotulo(b: Dict[str, Any]) -> str:
    return f"{b.get('beneficiario_nome') or b.get('beneficiario_cnpj')} R$ {b.get('valor')} venc. {b.get('vencimento')}"


class RotinaDDA:
    def __init__(
        self,
        estado: Optional[EstadoDDA] = None,
        cfg: Optional[Settings] = None,
        polp: Optional[PolpClient] = None,
        inter: Optional[InterClient] = None,
        tiny: Optional[TinyClient] = None,
        token_tiny: Optional[TokenTiny] = None,
        hoje: Optional[Callable[[], date]] = None,
    ) -> None:
        self.cfg = cfg or settings
        self.estado = estado or EstadoDDA(cfg=self.cfg)
        self.polp = polp or PolpClient(self.cfg)
        self.inter = inter or InterClient(base_url=self.cfg.INTER_BASE_URL, certs_dir=self.cfg.INTER_CERTS_DIR)
        self.tiny = tiny or TinyClient()
        self._token_tiny = token_tiny or self._token_tiny_padrao
        self._hoje = hoje or hoje_sp
        self._execucao = threading.Lock()

    # --- tokens ----------------------------------------------------------------------------

    def _token_tiny_padrao(self, empresa: str) -> Optional[str]:
        from app.token_repository import TokenRepository

        repo = TokenRepository(self.cfg)
        if repo.is_configured():
            res = repo.get_token_by_cnpj_or_account(account_id=empresa)
            if res:
                return res[0]
        return None

    def token_tiny(self, empresa: str) -> str:
        token = self._token_tiny(empresa)
        if not token or token in ("mock", "seu_token_aqui"):
            raise RuntimeError(f"Sem token do Tiny para '{empresa}'.")
        return token

    # --- rodada ----------------------------------------------------------------------------

    def executar(self, origem: str = "agendada", usuario: str = "") -> Dict[str, Any]:
        if not self._execucao.acquire(blocking=False):
            raise RuntimeError("Já existe uma rodada do DDA em andamento.")
        inicio = agora()
        resumo: Dict[str, Any] = {"origem": origem, "usuario": usuario, "inicio": inicio, "erros": []}
        try:
            for etapa, funcao in (
                ("sincronizar", self.sincronizar),
                ("casar", self.casar),
                ("agendar", self.agendar),
                ("acompanhar", self.acompanhar),
            ):
                if etapa == "agendar" and not self.cfg.DDA_AGENDAR_NO_INTER:
                    resumo[etapa] = "desligado (DDA_AGENDAR_NO_INTER=false)"
                    continue
                try:
                    resumo[etapa] = funcao()
                except Exception as e:
                    logger.error(f"[DDA] Etapa '{etapa}' falhou: {e}", exc_info=True)
                    resumo["erros"].append(f"{etapa}: {e}")
            self._limpar_antigos()
            return resumo
        finally:
            resumo["fim"] = agora()
            with self.estado.alterar() as dados:
                dados["execucoes"].append(resumo)
                del dados["execucoes"][:-MAX_EXECUCOES]
                if resumo["erros"]:
                    _aviso(dados, "erro", "Rotina do DDA com erro", "; ".join(resumo["erros"])[:900])
            self._execucao.release()

    # --- 1. Polp ---------------------------------------------------------------------------

    def sincronizar(self) -> Dict[str, int]:
        """Boletos criados/atualizados na Polp desde a última leitura de cada cadastro."""
        novos = atualizados = ignorados = 0
        ddas = self.polp.listar_ddas()
        for dda in ddas:
            dda_id = str(dda.get("id") or "")
            empresa = empresa_do_cnpj(dda.get("tax_id") or "")
            if not dda_id or not empresa:
                continue
            desde = self.estado.ler()["cursores"].get(dda_id)
            marco = datetime.now(timezone.utc).replace(tzinfo=None)
            itens = self.polp.listar_boletos(dda_id, desde=desde)
            with self.estado.alterar() as dados:
                for item in itens:
                    dono = empresa_do_cnpj(item.get("owner_tax_id") or "") or empresa
                    novo = boleto_da_polp(item, dono)
                    atual = dados["boletos"].get(novo["id"])
                    if atual is None:
                        if novo["status_polp"] in (BOLETO_PAGO, BOLETO_CANCELADO, BOLETO_BAIXADO):
                            ignorados += 1  # já resolvido antes de chegar aqui: nada a fazer
                            continue
                        novo.update(situacao=SIT_NOVO, mensagem="", criado_em=agora(), eventos=[])
                        _evento(novo, "Recebido da Polp.")
                        dados["boletos"][novo["id"]] = novo
                        novos += 1
                        continue
                    status_antes = atual.get("status_polp")
                    atual.update({k: v for k, v in novo.items() if k not in ("empresa",)})
                    atualizados += 1
                    if status_antes != novo["status_polp"]:
                        _evento(atual, f"Polp: {novo['status_polp_label'] or novo['status_polp']}.")
                    self._encerrar_pela_polp(atual)
                dados["cursores"][dda_id] = (marco - MARGEM_CURSOR).isoformat(timespec="microseconds")
                dados.setdefault("cadastros", {})[dda_id] = {
                    "empresa": empresa, "status": dda.get("status"), "status_label": dda.get("status_label"),
                    "boletos_synced_at": dda.get("boletos_synced_at"), "lido_em": agora(),
                }
        logger.info(f"[DDA] Polp: {len(ddas)} cadastro(s), {novos} boleto(s) novo(s), {atualizados} atualizado(s), {ignorados} já resolvido(s).")
        return {"cadastros": len(ddas), "novos": novos, "atualizados": atualizados, "ja_resolvidos": ignorados}

    @staticmethod
    def _encerrar_pela_polp(b: Dict[str, Any]) -> None:
        """Pago/cancelado/baixado na CIP antes de a automação agendar: sai das pendências."""
        if b.get("situacao") in FINAIS or b.get("situacao") in A_ACOMPANHAR:
            return
        if b.get("status_polp") in (BOLETO_PAGO, BOLETO_CANCELADO, BOLETO_BAIXADO):
            _mudar(b, SIT_ENCERRADO, f"Boleto {b.get('status_polp_label') or 'resolvido'} na CIP, fora da automação.")

    # --- 2. casamento com o Tiny -----------------------------------------------------------

    def casar(self) -> Dict[str, int]:
        dados = self.estado.ler()
        pendentes = [b for b in dados["boletos"].values() if b.get("situacao") in A_CASAR and not b.get("fraude")]
        por_empresa: Dict[str, List[Dict[str, Any]]] = {}
        for b in pendentes:
            por_empresa.setdefault(b["empresa"], []).append(b)
        contagem = {"casados": 0, "sem_conta": 0, "ambiguos": 0}
        for empresa, boletos in por_empresa.items():
            datas = [d for d in (_data(b.get("vencimento")) for b in boletos) if d]
            if not datas:
                continue
            token = self.token_tiny(empresa)
            contas = self.tiny.list_contas_pagar_abertas(
                token,
                data_inicial_vencimento=(min(datas) - timedelta(days=JANELA_TINY_ANTES)).isoformat(),
                data_final_vencimento=(max(datas) + timedelta(days=JANELA_TINY_DEPOIS)).isoformat(),
            )
            with self.estado.alterar() as dados:
                em_uso = {
                    (b["empresa"], int(b["conta_id"])) for b in dados["boletos"].values()
                    if b.get("conta_id") and b.get("situacao") not in (FINAIS | A_CASAR)
                }
                for b0 in boletos:
                    b = dados["boletos"][b0["id"]]
                    if b.get("situacao") not in A_CASAR:
                        continue
                    candidatos = [c for c in contas if self._mesma_conta(b, c) and (empresa, int(c["id"])) not in em_uso]
                    if len(candidatos) == 1:
                        c = candidatos[0]
                        self._vincular(b, c, "Casado com a conta a pagar do Tiny (fornecedor, vencimento e valor).")
                        em_uso.add((empresa, int(c["id"])))
                        contagem["casados"] += 1
                    elif candidatos:
                        b["candidatos"] = [self._resumo_conta(c) for c in candidatos]
                        if b.get("situacao") != SIT_AMBIGUO:
                            _mudar(b, SIT_AMBIGUO, f"{len(candidatos)} contas do Tiny com o mesmo fornecedor, vencimento e valor: escolha no painel.")
                        contagem["ambiguos"] += 1
                    else:
                        b["candidatos"] = []
                        if b.get("situacao") != SIT_SEM_CONTA:
                            _mudar(b, SIT_SEM_CONTA, "Nenhuma conta a pagar em aberto no Tiny com o mesmo fornecedor, vencimento e valor.")
                        contagem["sem_conta"] += 1
        return contagem

    @staticmethod
    def _mesma_conta(b: Dict[str, Any], conta: Dict[str, Any]) -> bool:
        if not conta.get("id"):
            return False
        doc = _cnpj_contato(conta)
        if not doc or doc not in {b.get("beneficiario_cnpj"), b.get("sacador_cnpj")} - {""}:
            return False
        if _data(conta.get("dataVencimento") or conta.get("vencimento")) != _data(b.get("vencimento")):
            return False
        valor = _decimal(conta.get("valor"))
        return valor is not None and valor == _decimal(b.get("valor"))

    @staticmethod
    def _resumo_conta(c: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": int(c["id"]),
            "fornecedor": _nome_contato(c),
            "historico": str(c.get("historico") or "")[:200],
            "numero_documento": str(c.get("numeroDocumento") or ""),
            "valor": str(_decimal(c.get("valor")) or ""),
            "vencimento": str(_data(c.get("dataVencimento") or c.get("vencimento")) or ""),
        }

    def _vincular(self, b: Dict[str, Any], conta: Dict[str, Any], mensagem: str, usuario: str = "") -> None:
        """Liga o boleto à conta. Com `usuario` (escolha/criação no painel) já fica validado; o
        casamento automático espera alguém validar no painel antes do agendamento."""
        b["conta_id"] = int(conta["id"])
        b["conta"] = self._resumo_conta(conta)
        b["candidatos"] = []
        b.pop("validacao", None)
        if usuario:
            b["validacao"] = {"por": usuario, "em": agora()}
        _mudar(b, SIT_CASADO, f"{mensagem} Conta #{b['conta_id']}.", usuario)

    # --- 3. agendamento no Inter -----------------------------------------------------------

    def agendar(self) -> Dict[str, int]:
        hoje = self._hoje()
        feitos = vencidos = erros = 0
        casados = [dict(b) for b in self.estado.ler()["boletos"].values() if b.get("situacao") == SIT_CASADO]
        aguardando = sum(1 for b in casados if not b.get("validacao"))
        casados = [b for b in casados if b.get("validacao")]
        for b in casados:
            venc = _data(b.get("vencimento"))
            if venc is None or not b.get("codigo_barras"):
                self._salvar(b["id"], lambda x: _mudar(x, SIT_ERRO, "Boleto sem vencimento ou código de barras."))
                erros += 1
                continue
            if venc < hoje:
                self._salvar(b["id"], lambda x: _mudar(x, SIT_VENCIDO, "Venceu antes de ser agendado: pague à mão (juros/multa)."))
                vencidos += 1
                continue
            try:
                resultado = self._agendar_um(b, venc, hoje)
            except Exception as e:
                logger.error(f"[DDA] Agendamento de {_rotulo(b)} falhou: {e}")
                self._salvar(b["id"], lambda x, e=e: _mudar(x, SIT_ERRO, f"Agendamento no Inter falhou: {e}"))
                erros += 1
                continue
            if resultado:
                feitos += 1
        return {"agendados": feitos, "vencidos": vencidos, "erros": erros, "aguardando_validacao": aguardando}

    def _agendar_um(self, b: Dict[str, Any], venc: date, hoje: date) -> bool:
        empresa = b["empresa"]
        # A conta ainda está em aberto? (pode ter sido baixada à mão desde o casamento)
        token = self.token_tiny(empresa)
        conta, _ = self.tiny.obter_conta_pagar_v3(token, int(b["conta_id"]))
        situacao = str(conta.get("situacao") or "").strip().lower()
        if situacao not in SITUACOES_CONTA_PAGAR_BAIXAVEIS:
            self._salvar(b["id"], lambda x: _mudar(x, SIT_ENCERRADO, f"Conta #{b['conta_id']} já está '{situacao}' no Tiny: não agendado."))
            return False
        # Já incluído no Inter (rodada anterior caiu depois do POST)? Adota em vez de duplicar.
        existentes = [
            p for p in self.inter.buscar_pagamentos_boleto(empresa, codigo_barras=b["codigo_barras"])
            if str(p.get("statusPagamento") or "").upper() not in INTER_RECUSADOS
        ]
        if existentes:
            p = existentes[0]
            self._salvar(b["id"], lambda x: self._registrar_inter(x, p, "Pagamento já existia no Inter: acompanhando."))
            return True
        try:
            resposta = self.inter.pagar_boleto(
                empresa, b["codigo_barras"], Decimal(b["valor"]), venc,
                data_pagamento=venc if venc > hoje else None,
                cnpj_beneficiario=b.get("beneficiario_cnpj"),
            )
        except PagamentoInterIncerto as e:
            achados = self.inter.buscar_pagamentos_boleto(empresa, codigo_barras=b["codigo_barras"])
            if not achados:
                raise RuntimeError(f"{e}; o pagamento não apareceu no Inter, a próxima rodada tenta de novo") from e
            resposta = achados[0]
        msg = f"Agendado no Inter para {venc:%d/%m/%Y}, aguardando aprovação."
        self._salvar(b["id"], lambda x: self._registrar_inter(x, resposta, msg))
        with self.estado.alterar() as dados:
            _aviso(dados, "agendado", "Boleto agendado no Inter", f"{INTER_EMPRESAS[empresa]['nome']}: {_rotulo(b)} — aprove no Internet Banking.")
        return True

    @staticmethod
    def _registrar_inter(x: Dict[str, Any], p: Dict[str, Any], mensagem: str) -> None:
        x["inter"] = {
            **(x.get("inter") or {}),
            "codigo_transacao": p.get("codigoTransacao") or (x.get("inter") or {}).get("codigo_transacao"),
            "status": str(p.get("statusPagamento") or ""),
            "aprovacoes_necessarias": p.get("quantidadeAprovadores") or p.get("aprovacoesNecessarias"),
            "aprovacoes_realizadas": p.get("aprovacoesRealizadas"),
            "data_agendamento": p.get("dataAgendamento") or p.get("dataPagamento"),
        }
        _mudar(x, SIT_AGENDADO, mensagem)

    # --- 4. acompanhamento e baixa ---------------------------------------------------------

    def acompanhar(self) -> Dict[str, int]:
        pagos = baixados = recusados = 0
        alvos = [dict(b) for b in self.estado.ler()["boletos"].values() if b.get("situacao") in A_ACOMPANHAR]
        for b in alvos:
            transacao = (b.get("inter") or {}).get("codigo_transacao")
            if not transacao:
                continue
            try:
                if b["situacao"] == SIT_AGENDADO:
                    achados = self.inter.buscar_pagamentos_boleto(b["empresa"], codigo_transacao=transacao)
                    if not achados:
                        continue
                    p = achados[0]
                    status = str(p.get("statusPagamento") or "").upper()
                    if status in INTER_RECUSADOS:
                        self._salvar(b["id"], lambda x, p=p, s=status: (
                            x.setdefault("inter", {}).update(status=s), _mudar(x, SIT_RECUSADO, f"Inter: {s}. Reagende ou descarte no painel.")))
                        with self.estado.alterar() as dados:
                            _aviso(dados, "recusado", "Pagamento recusado/cancelado no Inter",
                                   f"{INTER_EMPRESAS[b['empresa']]['nome']}: {_rotulo(b)} — status {status}.")
                        recusados += 1
                        continue
                    if status not in INTER_PAGOS:
                        self._salvar(b["id"], lambda x, p=p, s=status: x.setdefault("inter", {}).update(
                            status=s, aprovacoes_realizadas=p.get("aprovacoesRealizadas"),
                            aprovacoes_necessarias=p.get("aprovacoesNecessarias") or (x.get("inter") or {}).get("aprovacoes_necessarias")))
                        continue
                    valor_pago = _decimal(p.get("valorPago")) or Decimal(b["valor"])
                    data_pag = _data(p.get("dataPagamento")) or self._hoje()
                    self._salvar(b["id"], lambda x, s=status: (
                        x.setdefault("inter", {}).update(status=s, valor_pago=str(valor_pago), data_pagamento=data_pag.isoformat()),
                        _mudar(x, SIT_PAGO, f"Pago no Inter em {data_pag:%d/%m/%Y} (R$ {valor_pago}).")))
                    pagos += 1
                if self._baixar(b["id"]):
                    baixados += 1
            except Exception as e:
                logger.error(f"[DDA] Acompanhamento de {_rotulo(b)} falhou: {e}")
                self._salvar(b["id"], lambda x, e=e: _evento(x, f"Falha ao acompanhar/baixar: {e}"))
        return {"pagos": pagos, "baixados": baixados, "recusados": recusados}

    def _baixar(self, boleto_id: str) -> bool:
        b = dict(self.estado.ler()["boletos"][boleto_id])
        inter = b.get("inter") or {}
        empresa, conta_id = b["empresa"], int(b["conta_id"])
        token = self.token_tiny(empresa)
        conta, token = self.tiny.obter_conta_pagar_v3(token, conta_id)
        situacao = str(conta.get("situacao") or "").strip().lower()
        if situacao not in SITUACOES_CONTA_PAGAR_BAIXAVEIS:
            self._salvar(boleto_id, lambda x: _mudar(x, SIT_BAIXADO, f"Conta #{conta_id} já estava '{situacao}' no Tiny."))
            return True
        valor_conta = _decimal(conta.get("valor")) or Decimal(b["valor"])
        valor_pago = Decimal(inter.get("valor_pago") or b["valor"])
        conta_origem = self.tiny.resolve_conta_origem_inter(token=token, account_id=empresa)
        if not conta_origem:
            raise RuntimeError(f"Conta 'Banco Inter' de {INTER_EMPRESAS[empresa]['nome']} não encontrada no Tiny (ou há mais de uma).")
        self.tiny.baixar_conta_pagar_v3(
            token=token,
            conta_id=conta_id,
            valor_pago=float(valor_pago),
            data_pagamento=inter.get("data_pagamento") or self._hoje().isoformat(),
            conta_origem_id=conta_origem,
            juros=float(max(Decimal("0"), valor_pago - valor_conta)),
            desconto=float(max(Decimal("0"), valor_conta - valor_pago)),
            historico=f"Pago via DDA/Banco Inter (transação {inter.get('codigo_transacao')})",
            conta_atual=conta,
        )
        self._salvar(boleto_id, lambda x: _mudar(x, SIT_BAIXADO, f"Conta #{conta_id} baixada no Tiny (R$ {valor_pago})."))
        logger.info(f"[DDA] {_rotulo(b)}: conta #{conta_id} baixada no Tiny ({empresa}).")
        return True

    # --- ações do painel -------------------------------------------------------------------

    def _salvar(self, boleto_id: str, mudar: Callable[[Dict[str, Any]], Any]) -> Dict[str, Any]:
        with self.estado.alterar() as dados:
            b = dados["boletos"].get(boleto_id)
            if b is None:
                raise KeyError(boleto_id)
            mudar(b)
            return copy.deepcopy(b)

    def vincular_conta(self, boleto_id: str, conta_id: int, usuario: str) -> Dict[str, Any]:
        """Escolha manual da conta (ambíguo ou sem conta): mesma checagem de valor, sem tolerância."""
        b = dict(self.estado.ler()["boletos"][boleto_id])
        if b.get("situacao") not in A_CASAR | {SIT_RECUSADO, SIT_ERRO}:
            raise ValueError(f"Boleto em '{b.get('situacao')}' não aceita troca de conta.")
        conta, _ = self.tiny.obter_conta_pagar_v3(self.token_tiny(b["empresa"]), int(conta_id))
        situacao = str(conta.get("situacao") or "").strip().lower()
        if situacao not in SITUACOES_CONTA_PAGAR_BAIXAVEIS:
            raise ValueError(f"Conta #{conta_id} está '{situacao}' no Tiny.")
        if _decimal(conta.get("valor")) != _decimal(b.get("valor")):
            raise ValueError(f"Conta #{conta_id} é de R$ {conta.get('valor')}, o boleto é de R$ {b.get('valor')}.")
        em_uso = any(
            x.get("conta_id") == int(conta_id) and x["id"] != boleto_id and x.get("situacao") not in FINAIS | A_CASAR
            for x in self.estado.ler()["boletos"].values() if x.get("empresa") == b["empresa"]
        )
        if em_uso:
            raise ValueError(f"Conta #{conta_id} já está ligada a outro boleto.")
        conta = {**conta, "id": int(conta_id)}
        return self._salvar(boleto_id, lambda x: self._vincular(x, conta, "Conta escolhida no painel.", usuario))

    def criar_conta(self, boleto_id: str, categoria_id: int, historico: str, usuario: str) -> Dict[str, Any]:
        """Boleto sem conta: cria a conta a pagar no Tiny (fornecedor pelo CNPJ, nunca cria contato)."""
        b = dict(self.estado.ler()["boletos"][boleto_id])
        if b.get("situacao") != SIT_SEM_CONTA:
            raise ValueError(f"Boleto em '{b.get('situacao')}': só 'sem conta' cria conta.")
        if b.get("conta_criada_incerta"):
            raise ValueError("Uma tentativa anterior ficou sem confirmação do Tiny: confira as contas do fornecedor antes.")
        token = self.token_tiny(b["empresa"])
        doc = b.get("beneficiario_cnpj") or b.get("sacador_cnpj")
        contatos = [c for c in self.tiny.buscar_contatos_v3(token, cpf_cnpj=doc) if _digitos(c.get("cpfCnpj")) == doc and c.get("id")]
        if len(contatos) != 1:
            raise ValueError(
                f"{'Mais de um' if contatos else 'Nenhum'} contato com o CNPJ {doc} no Tiny "
                "(a automação não cria contatos: cadastre o fornecedor)."
            )
        try:
            conta_id = self.tiny.criar_conta_pagar_v3(
                token, historico=historico.strip()[:500] or f"Boleto DDA - {b.get('beneficiario_nome')}",
                data=b.get("emissao") or self._hoje().isoformat(), data_vencimento=b["vencimento"],
                valor=Decimal(b["valor"]), contato_id=int(contatos[0]["id"]), categoria_id=int(categoria_id),
                numero_documento=b.get("documento") or "",
            )
        except LancamentoCaixaIncerto as e:
            # Pode ter criado: trava novas tentativas até alguém conferir no Tiny.
            self._salvar(boleto_id, lambda x, e=e: (
                x.update(conta_criada_incerta=True), _evento(x, f"Criação da conta sem confirmação do Tiny: {e}", usuario)))
            raise
        conta = {"id": conta_id, "valor": b["valor"], "dataVencimento": b["vencimento"], "historico": historico,
                 "cliente": {"nome": contatos[0].get("nome"), "cpfCnpj": doc}}
        return self._salvar(boleto_id, lambda x: self._vincular(x, conta, "Conta a pagar criada no Tiny pelo painel.", usuario))

    def validar(self, ids: List[str], usuario: str) -> Dict[str, Any]:
        """Validação humana dos casamentos automáticos: libera o agendamento no Inter."""
        validados: List[str] = []
        recusados: List[Dict[str, str]] = []
        with self.estado.alterar() as dados:
            for bid in dict.fromkeys(ids):
                b = dados["boletos"].get(bid)
                if b is None:
                    recusados.append({"id": bid, "motivo": "Boleto não encontrado."})
                elif b.get("situacao") != SIT_CASADO:
                    recusados.append({"id": bid, "motivo": f"Boleto em '{b.get('situacao')}', não em casado."})
                elif b.get("validacao"):
                    validados.append(bid)
                else:
                    b["validacao"] = {"por": usuario, "em": agora()}
                    _evento(b, f"Casamento com a conta #{b.get('conta_id')} validado para agendamento.", usuario)
                    validados.append(bid)
        return {"validados": validados, "recusados": recusados}

    def criar_contas_lote(
        self, itens: List[Dict[str, Any]], usuario: str, progresso: Optional[Callable[[str, int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Cria no Tiny as contas dos boletos sem conta, um por vez; falha de um não para os outros."""
        resultados: List[Dict[str, Any]] = []
        for i, item in enumerate(itens):
            bid = str(item.get("boleto_id"))
            if progresso:
                progresso("Criando as contas a pagar no Tiny", i, len(itens))
            try:
                if bid not in self.estado.ler()["boletos"]:
                    raise ValueError("Boleto não encontrado.")
                b = self.criar_conta(bid, int(item["categoria_id"]), str(item.get("historico") or ""), usuario)
                resultados.append({"boleto_id": bid, "ok": True, "conta_id": b.get("conta_id")})
            except Exception as e:
                logger.warning(f"[DDA] Criação em lote da conta do boleto {bid} falhou: {e}")
                resultados.append({"boleto_id": bid, "ok": False, "erro": str(e)})
        if progresso:
            progresso("Concluído", len(itens), len(itens))
        return {
            "resultados": resultados,
            "total_sucessos": sum(1 for r in resultados if r["ok"]),
            "total_falhas": sum(1 for r in resultados if not r["ok"]),
        }

    def descartar(self, boleto_id: str, motivo: str, usuario: str) -> Dict[str, Any]:
        b = self.estado.ler()["boletos"][boleto_id]
        if b.get("situacao") == SIT_AGENDADO:
            raise ValueError("Boleto agendado no Inter: cancele o agendamento no Internet Banking antes.")
        return self._salvar(boleto_id, lambda x: _mudar(x, SIT_DESCARTADO, motivo.strip()[:300] or "Descartado no painel.", usuario))

    def reabrir(self, boleto_id: str, usuario: str) -> Dict[str, Any]:
        """Recusado/erro/descartado/vencido volta para o casamento (e daí para o agendamento)."""
        b = self.estado.ler()["boletos"][boleto_id]
        if b.get("situacao") not in (SIT_RECUSADO, SIT_ERRO, SIT_DESCARTADO, SIT_VENCIDO):
            raise ValueError(f"Boleto em '{b.get('situacao')}' não pode ser reaberto.")

        def mudar(x: Dict[str, Any]) -> None:
            x.pop("validacao", None)  # volta a precisar de conferência antes do Inter
            if x.get("inter"):
                x.setdefault("inter_anteriores", []).append(x.pop("inter"))
            if x.get("conta_id"):
                _mudar(x, SIT_CASADO, f"Reaberto no painel com a conta #{x['conta_id']}.", usuario)
            else:
                _mudar(x, SIT_NOVO, "Reaberto no painel.", usuario)

        return self._salvar(boleto_id, mudar)

    # --- leitura ---------------------------------------------------------------------------

    def categorias(self, empresa: str) -> List[Dict[str, str]]:
        """Categorias do Tiny da empresa para o "criar conta" do painel (cache de 30 min no cliente)."""
        if empresa not in INTER_EMPRESAS:
            raise ValueError(f"Empresa desconhecida: {empresa}")
        itens = self.tiny.list_categorias_receita_despesa_v3(self.token_tiny(empresa))
        return sorted(
            (
                {"id": str(c["id"]), "nome": str(c["descricao"]), "grupo": str(c.get("grupo") or "")}
                for c in itens if c.get("id") and c.get("descricao")
            ),
            key=lambda c: (c["grupo"], c["nome"]),
        )

    def _limpar_antigos(self) -> None:
        limite = (agora_sp() - timedelta(days=DIAS_GUARDAR_FINAIS)).isoformat()
        with self.estado.alterar() as dados:
            for bid in [k for k, b in dados["boletos"].items() if b.get("situacao") in FINAIS and str(b.get("atualizado_em") or "") < limite]:
                del dados["boletos"][bid]

    def status(self) -> Dict[str, Any]:
        dados = self.estado.ler()
        por_situacao: Dict[str, int] = {}
        for b in dados["boletos"].values():
            por_situacao[b.get("situacao") or ""] = por_situacao.get(b.get("situacao") or "", 0) + 1
        cadastros = dados.get("cadastros") or {}
        return {
            "configurado": self.polp.configurada(),
            "cadastros": [
                {**c, "ativo": c.get("status") == DDA_STATUS_SUCESSO, "nome": INTER_EMPRESAS.get(c["empresa"], {}).get("nome")}
                for c in cadastros.values()
            ],
            "ativo": self.cfg.DDA_ATIVO,
            "agendar_no_inter": self.cfg.DDA_AGENDAR_NO_INTER,
            "intervalo_minutos": self.cfg.DDA_INTERVALO_MINUTOS,
            "por_situacao": por_situacao,
            "ultima_execucao": dados["execucoes"][-1] if dados["execucoes"] else None,
            "em_execucao": self._execucao.locked(),
        }

    def boletos(self) -> List[Dict[str, Any]]:
        itens = list(self.estado.ler()["boletos"].values())
        return sorted(itens, key=lambda b: (b.get("situacao") in FINAIS, b.get("vencimento") or "", b.get("id")))


rotina = RotinaDDA()


def proxima_espera_segundos(cfg: Optional[Settings] = None) -> int:
    return int((cfg or settings).DDA_INTERVALO_MINUTOS) * 60


def resumo_avisos(depois_de: int) -> Tuple[List[Dict[str, Any]], int]:
    dados = rotina.estado.ler()
    return [a for a in dados["avisos"] if int(a["id"]) > depois_de], int(dados.get("proximo_aviso") or 1) - 1
