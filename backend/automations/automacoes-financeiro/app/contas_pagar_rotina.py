"""
Rotina diária e persistência de estado para Contas a Pagar (Inter × Tiny).

Guarda em DATA_DIR/contas_pagar/estado.json:
- Pendências persistentes: casamentos (matches), débitos sem par (unmatched_inter)
  e contas em aberto no Tiny (unmatched_tiny).
- Contas fora da janela consultada permanecem salvas até serem baixadas (pela tela ou no Tiny).
- Releitura de baixas externas no Tiny: contas liquidadas externamente são removidas das
  pendências e registradas em historico_saidas.
- Remoção imediata pós-baixa confirmada pela tela.
"""
from __future__ import annotations

import copy
import json
import logging
import threading
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from app.config import Settings, settings
from app.json_store import save_json_state, write_json_atomic
from app.tiny_client import SITUACOES_CONTA_PAGAR_BAIXAVEIS, TinyClient
from app.token_repository import TokenRepository

logger = logging.getLogger("automacao_nfe.contas_pagar_rotina")

MAX_HISTORICO_SAIDAS = 5000
MAX_EXECUCOES_HISTORICO = 60


def agora_iso() -> str:
    """Horário atual com fuso horário de Brasília."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def proxima_execucao_contas_pagar(cfg: Optional[Settings] = None, agora_dt: Optional[datetime] = None) -> datetime:
    """Calcula a próxima execução diária baseada em CONTAS_PAGAR_ROTINA_HOUR."""
    cfg = cfg or settings
    agora_dt = agora_dt or datetime.now()
    alvo = agora_dt.replace(hour=cfg.CONTAS_PAGAR_ROTINA_HOUR, minute=0, second=0, microsecond=0)
    return alvo if alvo > agora_dt else alvo + timedelta(days=1)


def _to_decimal(val: Any) -> Decimal:
    if val is None or val == "":
        return Decimal("0.00")
    try:
        return Decimal(str(val))
    except Exception:
        return Decimal("0.00")


def estado_inicial() -> Dict[str, Any]:
    return {
        "status": "vazio",
        "atualizado_em": None,
        "data_inicio": None,
        "data_fim": None,
        "dados_de": None,
        "do_cache": False,
        "summary": {
            "total_casados": 0,
            "valor_total_casados": 0.0,
            "total_inter_sem_par": 0,
            "valor_inter_sem_par": 0.0,
            "total_tiny_sem_par": 0,
            "valor_tiny_sem_par": 0.0,
            "total_ja_baixadas": 0,
            "valor_ja_baixadas": 0.0,
            "total_transferencias_internas": 0,
            "valor_transferencias_internas": 0.0,
            "total_transferencias_aptas": 0,
            "valor_transferencias_aptas": 0.0,
        },
        "matches": [],
        "unmatched_inter": [],
        "unmatched_tiny": [],
        "ja_baixadas": [],
        "transferencias_internas": [],
        "avisos": [],
        "historico_saidas": [],
        "execucoes": [],
        "ultima_execucao": None,
    }


class EstadoContasPagar:
    """Gerencia a persistência atômica e as regras de fusão das pendências de Contas a Pagar."""

    def __init__(self, data_dir: Optional[Path] = None):
        # Sem data_dir, o DATA_DIR é lido a cada uso: a instância global é criada no import,
        # antes de testes ou da configuração trocarem settings.DATA_DIR.
        self._data_dir = Path(data_dir) if data_dir else None
        self._lock = threading.Lock()

    @property
    def data_dir(self) -> Path:
        return self._data_dir or Path(settings.DATA_DIR)

    @property
    def caminho_arquivo(self) -> Path:
        return self.data_dir / "contas_pagar" / "estado.json"

    def carregar(self) -> Dict[str, Any]:
        with self._lock:
            p = self.caminho_arquivo
            if not p.exists():
                return estado_inicial()
            try:
                with open(p, "r", encoding="utf-8") as f:
                    dados = json.load(f)
                if isinstance(dados, dict):
                    # Garante chaves essenciais
                    base = estado_inicial()
                    for k, v in base.items():
                        if k not in dados:
                            dados[k] = v
                    return dados
            except Exception as e:
                logger.error(f"[CONTAS_PAGAR_ROTINA] Erro ao ler {p}: {e}")
            return estado_inicial()

    def salvar(self, dados: Dict[str, Any]) -> bool:
        with self._lock:
            p = self.caminho_arquivo
            return save_json_state(p, dados, "CONTAS_PAGAR_ESTADO")

    def recalcular_summary(self, estado: Dict[str, Any]) -> None:
        matches = estado.get("matches", [])
        unmatched_inter = estado.get("unmatched_inter", [])
        unmatched_tiny = estado.get("unmatched_tiny", [])
        ja_baixadas = estado.get("ja_baixadas", [])
        transferencias = estado.get("transferencias_internas", [])

        transf_aptas = [t for t in transferencias if t.get("situacao") == "apta_baixa"]

        estado["summary"] = {
            "total_casados": len(matches),
            "valor_total_casados": float(sum((_to_decimal(m.get("valor_pago")) for m in matches), Decimal("0.00"))),
            "total_inter_sem_par": len(unmatched_inter),
            "valor_inter_sem_par": float(sum((_to_decimal(i.get("valor_pago")) for i in unmatched_inter), Decimal("0.00"))),
            "total_tiny_sem_par": len(unmatched_tiny),
            "valor_tiny_sem_par": float(sum((_to_decimal(c.get("valor")) for c in unmatched_tiny), Decimal("0.00"))),
            "total_ja_baixadas": len(ja_baixadas),
            "valor_ja_baixadas": float(sum((_to_decimal(j.get("valor_pago") or j.get("valor_tiny")) for j in ja_baixadas), Decimal("0.00"))),
            "total_transferencias_internas": len(transferencias),
            "valor_transferencias_internas": float(sum((_to_decimal(t.get("valor_pago")) for t in transferencias), Decimal("0.00"))),
            "total_transferencias_aptas": len(transf_aptas),
            "valor_transferencias_aptas": float(sum((_to_decimal(t.get("valor_pago")) for t in transf_aptas), Decimal("0.00"))),
        }

    def mesclar_preview(
        self,
        preview_data: Dict[str, Any],
        tipo_execucao: str = "rotina",
        sucesso: bool = True,
        mensagem: str = "Execução concluída com sucesso.",
    ) -> Dict[str, Any]:
        """
        Mescla um novo resultado de prévia com o estado persistido:
        - Atualiza a janela com os novos dados.
        - Preserva pendências fora da janela que continuam em aberto.
        - Descarta contas já baixadas.
        """
        anterior = self.carregar()

        novos_matches: List[Dict[str, Any]] = preview_data.get("matches", [])
        novos_unmatched_inter: List[Dict[str, Any]] = preview_data.get("unmatched_inter", [])
        novos_unmatched_tiny: List[Dict[str, Any]] = preview_data.get("unmatched_tiny", [])
        novos_ja_baixadas: List[Dict[str, Any]] = preview_data.get("ja_baixadas", [])
        novas_transferencias: List[Dict[str, Any]] = preview_data.get("transferencias_internas", [])

        # Chaves de contas já removidas
        removidas: Set[Tuple[str, int]] = {
            (s.get("empresa", "").lower(), int(s.get("conta_pagar_id", 0)))
            for s in anterior.get("historico_saidas", [])
            if s.get("conta_pagar_id")
        }

        # 1. Matches: chave (empresa, conta_pagar_id). A conta aparece uma vez só; se a prévia
        # nova a casou com outra transação do Inter, vale a mais recente.
        matches_map: Dict[Tuple[str, int], Dict[str, Any]] = {}
        # Preserva matches anteriores se não foram baixados
        for m in anterior.get("matches", []):
            emp = str(m.get("empresa") or "").lower()
            cid = int(m.get("conta_pagar_id") or 0)
            itx = str(m.get("inter_transacao_id") or "")
            if (emp, cid) not in removidas and cid > 0 and itx:
                matches_map[(emp, cid)] = m

        # Novos matches entram ou atualizam
        for m in novos_matches:
            emp = str(m.get("empresa") or "").lower()
            cid = int(m.get("conta_pagar_id") or 0)
            itx = str(m.get("inter_transacao_id") or "")
            if (emp, cid) not in removidas and cid > 0 and itx:
                matches_map[(emp, cid)] = m

        # 2. Contas em aberto Tiny (unmatched_tiny): chave (empresa, conta_id)
        # Se uma conta agora foi casada, ela não fica em unmatched_tiny
        contas_casadas: Set[Tuple[str, int]] = set(matches_map.keys())

        tiny_map: Dict[Tuple[str, int], Dict[str, Any]] = {}
        for c in anterior.get("unmatched_tiny", []):
            emp = str(c.get("empresa") or "").lower()
            cid = int(c.get("id") or 0)
            if (emp, cid) not in removidas and (emp, cid) not in contas_casadas and cid > 0:
                tiny_map[(emp, cid)] = c

        for c in novos_unmatched_tiny:
            emp = str(c.get("empresa") or "").lower()
            cid = int(c.get("id") or 0)
            if (emp, cid) not in removidas and (emp, cid) not in contas_casadas and cid > 0:
                tiny_map[(emp, cid)] = c

        # 3. Transações Inter sem par (unmatched_inter): chave (empresa, transacao_id)
        inter_casadas: Set[str] = {str(m.get("inter_transacao_id") or "") for m in matches_map.values()}
        inter_casadas |= {str(j.get("inter_transacao_id") or "") for j in novos_ja_baixadas}
        inter_casadas |= {str(t.get("transacao_id") or "") for t in novas_transferencias}
        inter_casadas.discard("")
        inter_map: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for itx in anterior.get("unmatched_inter", []):
            emp = str(itx.get("empresa") or "").lower()
            tid = str(itx.get("transacao_id") or "")
            if tid and tid not in inter_casadas:
                inter_map[(emp, tid)] = itx

        for itx in novos_unmatched_inter:
            emp = str(itx.get("empresa") or "").lower()
            tid = str(itx.get("transacao_id") or "")
            if tid and tid not in inter_casadas:
                inter_map[(emp, tid)] = itx

        # 4. Já baixadas e transferências
        empresas_na_previa = {
            str(x.get("empresa") or "").lower()
            for lista in (novos_matches, novos_unmatched_inter, novos_unmatched_tiny, novos_ja_baixadas, novas_transferencias)
            for x in lista
        }
        ja_baixadas_map: Dict[Tuple[str, int, str], Dict[str, Any]] = {}
        ja_baixadas_antigas = [
            j for j in anterior.get("ja_baixadas", []) if str(j.get("empresa") or "").lower() not in empresas_na_previa
        ]
        for j in ja_baixadas_antigas + novos_ja_baixadas:
            emp = str(j.get("empresa") or "").lower()
            cid = int(j.get("conta_pagar_id") or 0)
            itx = str(j.get("inter_transacao_id") or "")
            ja_baixadas_map[(emp, cid, itx)] = j

        transf_map: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for t in anterior.get("transferencias_internas", []) + novas_transferencias:
            emp = str(t.get("empresa") or "").lower()
            tid = str(t.get("transacao_id") or "")
            if tid:
                transf_map[(emp, tid)] = t

        # Monta estado final
        agora = agora_iso()
        execucao_info = {
            "tipo": tipo_execucao,
            "em": agora,
            "sucesso": sucesso,
            "mensagem": mensagem,
        }

        execucoes = anterior.get("execucoes", [])
        execucoes.append(execucao_info)
        if len(execucoes) > MAX_EXECUCOES_HISTORICO:
            execucoes = execucoes[-MAX_EXECUCOES_HISTORICO:]

        avisos_consolidados = list(dict.fromkeys(preview_data.get("avisos", [])))

        estado_final = {
            "status": "ok" if sucesso else "erro",
            "atualizado_em": agora,
            "data_inicio": preview_data.get("data_inicio") or anterior.get("data_inicio"),
            "data_fim": preview_data.get("data_fim") or anterior.get("data_fim"),
            "dados_de": preview_data.get("dados_de") or agora,
            "do_cache": bool(preview_data.get("do_cache", False)),
            "matches": list(matches_map.values()),
            "unmatched_tiny": list(tiny_map.values()),
            "unmatched_inter": list(inter_map.values()),
            "ja_baixadas": list(ja_baixadas_map.values()),
            "transferencias_internas": list(transf_map.values()),
            "avisos": avisos_consolidados,
            "historico_saidas": anterior.get("historico_saidas", []),
            "execucoes": execucoes,
            "ultima_execucao": execucao_info,
        }

        self.recalcular_summary(estado_final)
        self.salvar(estado_final)
        return estado_final

    def remover_contas_baixadas(
        self,
        itens: List[Dict[str, Any]],
        motivo: str = "automacao",
        detalhes: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Remove imediatamente as contas baixadas do estado persistente e registra em historico_saidas.
        `itens`: lista contendo dicts com ao menos "empresa" e "conta_pagar_id".
        """
        estado = self.carregar()
        if estado.get("status") == "vazio":
            return estado

        para_remover: Set[Tuple[str, int]] = set()
        agora = agora_iso()
        novas_saidas: List[Dict[str, Any]] = []

        for item in itens:
            emp = str(item.get("empresa") or "").lower()
            cid = int(item.get("conta_pagar_id") or item.get("id") or 0)
            if cid > 0:
                para_remover.add((emp, cid))
                novas_saidas.append({
                    "removido_em": agora,
                    "empresa": emp,
                    "conta_pagar_id": cid,
                    "numero_documento": str(item.get("numero_documento") or "-"),
                    "valor": float(_to_decimal(item.get("valor_pago") or item.get("valor") or 0)),
                    "motivo": motivo,
                    "detalhes": detalhes or {},
                })

        if not para_remover:
            return estado

        # Remove de matches
        estado["matches"] = [
            m for m in estado.get("matches", [])
            if (str(m.get("empresa") or "").lower(), int(m.get("conta_pagar_id") or 0)) not in para_remover
        ]

        # Remove de unmatched_tiny
        estado["unmatched_tiny"] = [
            c for c in estado.get("unmatched_tiny", [])
            if (str(c.get("empresa") or "").lower(), int(c.get("id") or 0)) not in para_remover
        ]

        # Atualiza transferencias_internas se casadas com conta baixada
        for t in estado.get("transferencias_internas", []):
            conc = t.get("conciliacao")
            if conc and (str(conc.get("empresa") or "").lower(), int(conc.get("conta_pagar_id") or 0)) in para_remover:
                t["situacao"] = "ja_baixada"
                t["conta_ja_baixada"] = conc
                t["conciliacao"] = None

        # Histórico de saídas
        historico = estado.get("historico_saidas", [])
        historico.extend(novas_saidas)
        if len(historico) > MAX_HISTORICO_SAIDAS:
            historico = historico[-MAX_HISTORICO_SAIDAS:]
        estado["historico_saidas"] = historico

        estado["atualizado_em"] = agora
        self.recalcular_summary(estado)
        self.salvar(estado)
        return estado

    def conferir_baixas_externas(
        self,
        tiny_client: TinyClient,
        token_repo: TokenRepository,
        cfg: Optional[Settings] = None,
    ) -> int:
        """
        Releitura de contas em aberto no Tiny para verificar se foram baixadas fora da automação.
        Se foram baixadas ou canceladas, remove das pendências e grava no histórico de saídas.
        """
        cfg = cfg or settings
        if cfg.MOCK_MODE:
            logger.info("[CONTAS_PAGAR_ROTINA] MOCK_MODE ativo: pulando checagem de baixas externas.")
            return 0

        estado = self.carregar()
        if estado.get("status") == "vazio":
            return 0

        contas_para_checar: Dict[Tuple[str, int], Dict[str, Any]] = {}
        for m in estado.get("matches", []):
            emp = str(m.get("empresa") or "").lower()
            cid = int(m.get("conta_pagar_id") or 0)
            if cid > 0:
                contas_para_checar[(emp, cid)] = m

        for c in estado.get("unmatched_tiny", []):
            emp = str(c.get("empresa") or "").lower()
            cid = int(c.get("id") or 0)
            if cid > 0 and (emp, cid) not in contas_para_checar:
                contas_para_checar[(emp, cid)] = c

        if not contas_para_checar:
            return 0

        baixadas_externamente: List[Dict[str, Any]] = []

        for (emp, cid), dados_conta in contas_para_checar.items():
            tiny_token = None
            if token_repo.is_configured():
                res = token_repo.get_token_by_cnpj_or_account(account_id=emp)
                if res:
                    tiny_token = res[0]
            if not tiny_token:
                tiny_token = cfg.TINY_API_TOKEN

            if not tiny_token or tiny_token in ("mock", "seu_token_aqui"):
                continue

            try:
                conta_atual, _ = tiny_client.obter_conta_pagar_v3(token=tiny_token, conta_id=cid)
                situacao = str(conta_atual.get("situacao") or "").strip().lower()
                saldo_bruto = conta_atual.get("saldo")
                saldo_zerado = saldo_bruto not in (None, "") and _to_decimal(saldo_bruto) <= Decimal("0.00")

                # Saiu das situações em aberto ou o saldo informado zerou (saldo ausente não conta)
                if not situacao:
                    continue
                if situacao not in SITUACOES_CONTA_PAGAR_BAIXAVEIS or (saldo_zerado and situacao != "aberto"):
                    logger.info(
                        f"[CONTAS_PAGAR_ROTINA] Conta #{cid} ({emp}) foi liquidada externamente no Tiny (situação '{situacao}'). Removendo."
                    )
                    baixadas_externamente.append({
                        "empresa": emp,
                        "conta_pagar_id": cid,
                        "numero_documento": dados_conta.get("numero_documento"),
                        "valor": dados_conta.get("valor_tiny") or dados_conta.get("valor"),
                        "situacao_tiny": situacao,
                    })
            except Exception as e:
                logger.warning(f"[CONTAS_PAGAR_ROTINA] Não foi possível checar conta #{cid} ({emp}) no Tiny: {e}")

        if baixadas_externamente:
            self.remover_contas_baixadas(baixadas_externamente, motivo="baixa_externa_tiny")
            logger.info(f"[CONTAS_PAGAR_ROTINA] {len(baixadas_externamente)} contas removidas por baixa externa no Tiny.")

        return len(baixadas_externamente)


# Instância singleton padrão
store_contas_pagar = EstadoContasPagar()
