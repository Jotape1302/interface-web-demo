"""
Varredura direta na SEFAZ (NFeDistribuicaoDFe por NSU) contra cada CNPJ/certificado
configurado — substitui a antiga esteira baseada em pasta do Google Drive. Roda 1x/dia
(agendada em `api.py`) ou sob demanda (botão "Rodar agora" -> POST /api/v1/danfe/scan-sefaz).

Fluxo: para cada CNPJ, consulta "o que é novo desde o último NSU salvo", classifica cada
documento retornado (NF-e completa, resumo de NFC-e, ou evento a ignorar), filtra o que já
foi visto e o que não é uma compra (situação cancelada/denegada, ou nota emitida por nós),
e estagia cada nota nova em `pending_review/` pelo mesmo pipeline usado pelo upload manual.
"""
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from app.config import Settings, settings
from app.json_store import erro_gravacao, save_json_state
from app.nfe_client import (
    DistNsuResult,
    MultiSefazA1Provider,
    NFeData,
    NFeProviderError,
    NFeXmlParser,
    SefazA1Provider,
    SefazDocEntry,
    load_sefaz_providers,
    parse_res_nfe,
    res_nfe_summary_to_nfe_data,
)
from app.audit import record_audit_error
from app.review_pipeline import already_launched_in_tiny, stage_note_for_review

logger = logging.getLogger("automacao_nfe.sefaz_scan")

# Teto de segurança por CNPJ/execução: evita que uma varredura fique presa em loop caso a
# SEFAZ tenha um histórico muito grande de NSU pendente (o checkpoint garante que a próxima
# execução diária continue de onde parou).
MAX_PAGES_PER_RUN = 20

# Intervalo mínimo entre execuções (agendada ou manual): a SEFAZ bloqueia por 1h
# (cStat 656 - Consumo Indevido) quando o webservice NFeDistribuicaoDFe é consultado
# repetidamente em pouco tempo. Usamos 3660s (61 min) com 1 min de margem para garantir
# que qualquer divergência de relógio entre o servidor e os clusters da SEFAZ não reinicie o bloqueio.
SCAN_COOLDOWN_SECONDS = 3660

# Pausa entre a consulta de um CNPJ e o próximo dentro da MESMA varredura.
INTER_CNPJ_DELAY_SECONDS = 4

# Pausa entre uma página de distDFeInt e a próxima, DENTRO da varredura do mesmo CNPJ
# (loop de paginação em _scan_one_cnpj, até MAX_PAGES_PER_RUN páginas).
INTER_PAGE_DELAY_SECONDS = 2

# Impede duas varreduras rodando ao mesmo tempo no mesmo processo: o agendador diário
# (thread própria) e o botão manual (POST /api/v1/danfe/scan-sefaz, rodado em threadpool
# pelo FastAPI) chamam a mesma run_daily_scan() e nada impedia as duas de coincidir.
# Isso importa em especial quando uma varredura demora minutos (histórico grande a
# catalogar) e o usuário, vendo um timeout HTTP no navegador (ex: 504 do proxy) antes do
# backend terminar, clica em "Rodar Varredura Agora" de novo — o cooldown normal (baseado
# em last_scan_finished_at) não pega esse caso, porque a varredura em andamento ainda não
# terminou de escrever esse timestamp. Duas varreduras batendo na SEFAZ ao mesmo tempo só
# pioram o risco de cStat 656. Lock não-bloqueante: se já tem uma rodando, pula sem
# esperar (mesmo padrão do cooldown normal, ver run_daily_scan).
_scan_lock = threading.Lock()

# Nome de exibição canônico por CNPJ monitorado — o "motor" (varredura SEFAZ) identifica
# a empresa pelo CNPJ do certificado (provider.cnpj, sempre confiável) em vez de confiar
# no texto livre que cada fornecedor declarou em <dest><xNome> no XML da nota (que na
# prática já veio inconsistente — ex.: "NORVIA ACABAMENTOS LTDA 14708" em vez de um nome
# que identifique a filial). Sobrescreve nfe_data.destinatario_nome sempre que o CNPJ é
# um dos monitorados; CNPJs desconhecidos mantêm o texto declarado pelo fornecedor.
COMPANY_DISPLAY_NAME_BY_CNPJ: Dict[str, str] = {
    "36592814000100": "REVESTA DECORACOES LTDA",
    "43820617000166": "FABRILUX ACABAMENTOS LTDA",
    "27184930000107": "NORVIA ACABAMENTOS LTDA (CAMPINAS)",
    "27184930000280": "NORVIA ACABAMENTOS LTDA (CURITIBA)",
}


@dataclass
class NewNoteFound:
    nfe_data: NFeData
    xml_content: str
    source_schema: str  # "procNFe" | "resNFe"


@dataclass
class CnpjScanResult:
    cnpj: str
    novas_notas: List[NewNoteFound] = field(default_factory=list)
    canceladas_ignoradas: int = 0
    eventos_ignorados: int = 0
    duplicadas_ignoradas: int = 0
    ja_lancadas_tiny: int = 0
    # Documentos com destinatário divergente do CNPJ consultado e de todo CNPJ monitorado
    # (ex.: fornecedor errou o CNPJ do destinatário no XML). Ficam definitivamente fora do
    # alcance da varredura por NSU assim que o checkpoint avança — só contam aqui para dar
    # visibilidade; recuperação é manual (consulta direta por chave, ver `get_nfe_data`).
    destinatario_divergente_ignorado: int = 0
    # resNFe com tpNF=1 (nota de saída: fomos nós que emitimos, não uma compra a pagar).
    notas_saida_ignoradas: int = 0
    erro: Optional[str] = None
    ult_nsu_final: Optional[str] = None
    status: str = "ok"  # "ok" | "erro" | "cooldown"
    cooldown_until: Optional[str] = None
    cooldown_seconds_remaining: int = 0


@dataclass
class SefazScanSummary:
    started_at: str
    finished_at: str
    resultados: List[CnpjScanResult] = field(default_factory=list)

    @property
    def total_novas_notas(self) -> int:
        return sum(len(r.novas_notas) for r in self.resultados)


def _extract_chave_from_full_xml(xml_content: str) -> Optional[str]:
    match = re.search(r'Id=["\'](?:NFe|NFCe)?(\d{44})["\']', xml_content) or re.search(
        r"<chNFe>(\d{44})</chNFe>", xml_content
    )
    return match.group(1) if match else None


def _nsu_state_path(cfg: Settings) -> Path:
    return cfg.DATA_DIR / "sefaz_nsu_state.json"


def _cooldown_state_path(cfg: Settings) -> Path:
    return cfg.DATA_DIR / "sefaz_cooldown_state.json"


def _seen_keys_path(cfg: Settings) -> Path:
    return cfg.DATA_DIR / "sefaz_seen_keys.json"


def _scan_status_path(cfg: Settings) -> Path:
    return cfg.DATA_DIR / "sefaz_scan_status.json"


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"[SEFAZ_SCAN] Falha ao ler {path.name}: {e}")
        return default


def _save_json(path: Path, data: Any, cfg: Settings) -> None:
    # Atômico e com erro exposto no status (ver app/json_store.py). Crítico para o NSU: sem
    # gravá-lo, toda varredura recomeça do mesmo ponto, o que a SEFAZ pune com cStat 656.
    save_json_state(path, data, "SEFAZ_SCAN")


def load_nsu_state(cfg: Settings) -> Dict[str, str]:
    data = _load_json(_nsu_state_path(cfg), {})
    return data if isinstance(data, dict) else {}


def save_nsu_checkpoint(cnpj: str, ult_nsu: str, cfg: Settings) -> None:
    state = load_nsu_state(cfg)
    state[cnpj] = ult_nsu
    _save_json(_nsu_state_path(cfg), state, cfg)


def load_cooldown_state(cfg: Settings) -> Dict[str, str]:
    """Lê o mapa de timestamp ISO até quando cada CNPJ deve aguardar antes de nova consulta."""
    data = _load_json(_cooldown_state_path(cfg), {})
    return data if isinstance(data, dict) else {}


def save_cnpj_cooldown(cnpj: str, seconds: int, cfg: Settings) -> str:
    """Registra que um determinado CNPJ deve aguardar N segundos (ex: 3600s) antes de nova consulta."""
    until_iso = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
    state = load_cooldown_state(cfg)
    state[cnpj] = until_iso
    _save_json(_cooldown_state_path(cfg), state, cfg)
    return until_iso


def clear_cnpj_cooldown(cnpj: Optional[str] = None, cfg: Optional[Settings] = None) -> None:
    """Limpa o cooldown de um CNPJ específico ou de todos."""
    cfg = cfg or settings
    if cnpj:
        state = load_cooldown_state(cfg)
        state.pop(cnpj, None)
        _save_json(_cooldown_state_path(cfg), state, cfg)
    else:
        _save_json(_cooldown_state_path(cfg), {}, cfg)


def get_cnpj_cooldown_remaining_seconds(cnpj: str, cfg: Settings) -> int:
    """Retorna quantos segundos de cooldown restam para um CNPJ específico."""
    state = load_cooldown_state(cfg)
    until_str = state.get(cnpj)
    if not until_str:
        return 0
    try:
        until_dt = datetime.fromisoformat(until_str)
    except ValueError:
        return 0
    remaining = (until_dt - datetime.now(timezone.utc)).total_seconds()
    return max(0, int(remaining))


def is_scan_running() -> bool:
    """Retorna True se houver uma varredura SEFAZ ativa neste processo."""
    return _scan_lock.locked()



def load_seen_keys(cfg: Settings) -> Set[str]:
    data = _load_json(_seen_keys_path(cfg), [])
    return set(data) if isinstance(data, list) else set()


def save_seen_keys(keys: Set[str], cfg: Settings) -> None:
    _save_json(_seen_keys_path(cfg), sorted(keys), cfg)


def _resolve_providers(cfg: Settings) -> List[SefazA1Provider]:
    provider = load_sefaz_providers(cfg)
    if isinstance(provider, MultiSefazA1Provider):
        return provider.providers
    if isinstance(provider, SefazA1Provider):
        return [provider]
    logger.warning("[SEFAZ_SCAN] Nenhum provedor SEFAZ A1 (certificado digital) configurado. Varredura não será executada.")
    return []


def _handle_doc(doc: SefazDocEntry, provider: SefazA1Provider, seen_keys: Set[str], result: CnpjScanResult) -> None:
    content = doc.xml_content

    if "<resEvento" in content:
        result.eventos_ignorados += 1
        return

    if "<nfeProc" in content or "<NFe" in content:
        chave = _extract_chave_from_full_xml(content)
        if not chave:
            logger.warning(f"[SEFAZ_SCAN] procNFe sem chave identificável (NSU {doc.nsu}). Ignorando.")
            return
        if chave in seen_keys:
            result.duplicadas_ignoradas += 1
            return
        try:
            nfe_data = NFeXmlParser.parse(content, chave)
        except Exception as e:
            logger.warning(f"[SEFAZ_SCAN] Falha ao interpretar procNFe (chave {chave}): {e}")
            return
        if not nfe_data.destinatario_cnpj:
            nfe_data.destinatario_cnpj = provider.cnpj
        if nfe_data.destinatario_cnpj != provider.cnpj and nfe_data.destinatario_cnpj not in COMPANY_DISPLAY_NAME_BY_CNPJ:
            # Não somos o destinatário desta nota (ex.: nota emitida por nós para terceiro) — não é uma compra a pagar.
            # OU o fornecedor errou o CNPJ do destinatário no XML (acontece na prática) — nesse
            # caso a nota é nossa mas fica invisível pra sempre pra varredura por NSU (o checkpoint
            # avança de qualquer forma). Loga para permitir recuperação manual por chave.
            result.destinatario_divergente_ignorado += 1
            logger.warning(
                f"[SEFAZ_SCAN] Nota {chave} (NSU {doc.nsu}) tem destinatário {nfe_data.destinatario_cnpj} "
                f"divergente do CNPJ consultado ({provider.cnpj}) e de nenhum CNPJ monitorado. "
                f"Fornecedor: {nfe_data.emitente_nome} ({nfe_data.emitente_cnpj}). Ignorando — se for uma "
                f"compra nossa, o CNPJ do destinatário está errado no XML e a recuperação é manual (consulta por chave)."
            )
            return
        if nfe_data.destinatario_cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ[nfe_data.destinatario_cnpj]
        elif provider.cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ[provider.cnpj]
        seen_keys.add(chave)
        if already_launched_in_tiny(nfe_data):
            logger.info(f"[SEFAZ_SCAN] Nota {chave} já lançada no Tiny ERP. Ignorando (não vai para revisão).")
            result.ja_lancadas_tiny += 1
            return
        result.novas_notas.append(NewNoteFound(nfe_data=nfe_data, xml_content=content, source_schema="procNFe"))
        return

    if "<resNFe" in content:
        summary = parse_res_nfe(content)
        if not summary.chave or len(summary.chave) != 44:
            logger.warning(f"[SEFAZ_SCAN] resNFe sem chave válida (NSU {doc.nsu}). Ignorando.")
            return
        if summary.chave in seen_keys:
            result.duplicadas_ignoradas += 1
            return
        if summary.c_sit_nfe != "1":
            # 2 = Cancelada, 3 = Denegada: não é uma compra válida a lançar. Como o checkpoint
            # de NSU avança de qualquer forma, se esse status estiver errado (bug de parsing,
            # nota reclassificada depois pela SEFAZ etc.) a nota some para sempre — loga a
            # chave para permitir investigar/recuperar manualmente depois.
            result.canceladas_ignoradas += 1
            logger.info(
                f"[SEFAZ_SCAN] resNFe {summary.chave} (NSU {doc.nsu}) com cSitNFe={summary.c_sit_nfe} "
                f"(não autorizada). Ignorando."
            )
            return
        if summary.tp_nf not in (None, "0"):
            # tpNF=1 (saída): fomos nós que emitimos, não é uma compra. Mesmo risco de perda
            # silenciosa do caso acima se tpNF vier errado — loga a chave por segurança.
            result.notas_saida_ignoradas += 1
            logger.info(
                f"[SEFAZ_SCAN] resNFe {summary.chave} (NSU {doc.nsu}) com tpNF={summary.tp_nf} "
                f"(nota de saída). Ignorando."
            )
            return
        nfe_data = res_nfe_summary_to_nfe_data(summary, dest_cnpj=provider.cnpj)
        if nfe_data.destinatario_cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ[nfe_data.destinatario_cnpj]
        elif provider.cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ[provider.cnpj]
        seen_keys.add(summary.chave)
        if already_launched_in_tiny(nfe_data):
            logger.info(f"[SEFAZ_SCAN] Nota {summary.chave} já lançada no Tiny ERP. Ignorando (não vai para revisão).")
            result.ja_lancadas_tiny += 1
            return
        result.novas_notas.append(NewNoteFound(nfe_data=nfe_data, xml_content=content, source_schema="resNFe"))
        return

    logger.debug(f"[SEFAZ_SCAN] docZip NSU={doc.nsu} schema='{doc.schema}' com conteúdo não reconhecido. Ignorando.")


def _nsu_int(val: Optional[str]) -> int:
    if not val:
        return 0
    digits = "".join(c for c in str(val) if c.isdigit())
    return int(digits) if digits else 0


def _pick_best_nsu(candidate1: Optional[str], candidate2: Optional[str], fallback: str = "0") -> str:
    """
    Escolhe o maior NSU numérico válido entre os candidatos retornados pela SEFAZ.
    Evita que strings com zeros ('000000000000000') sejam consideradas truthy e
    bloqueiem o uso de um maxNSU real e maior.
    """
    val1 = _nsu_int(candidate1)
    val2 = _nsu_int(candidate2)
    fb_val = _nsu_int(fallback)

    best_val = max(val1, val2, fb_val)
    if best_val == 0:
        return "0"
    return str(best_val).zfill(15)


def _scan_one_cnpj(
    provider: SefazA1Provider,
    seen_keys: Set[str],
    cfg: Settings,
    force: bool = False,
) -> CnpjScanResult:
    result = CnpjScanResult(cnpj=provider.cnpj)
    state = load_nsu_state(cfg)
    ult_nsu = state.get(provider.cnpj, "0")
    result.ult_nsu_final = ult_nsu

    # 1. Checagem de cooldown preventivo por CNPJ:
    # A SEFAZ bloqueia com cStat 656 se o mesmo CNPJ for consultado novamente dentro
    # de 1 hora após atingir maxNSU ou status 137. Se estiver em cooldown e não for force,
    # pulamos este CNPJ silenciosamente sem gastar chamada nem acionar novo bloqueio na SEFAZ.
    remaining_cd = get_cnpj_cooldown_remaining_seconds(provider.cnpj, cfg)
    if remaining_cd > 0 and not force:
        result.status = "cooldown"
        result.cooldown_seconds_remaining = remaining_cd
        result.cooldown_until = load_cooldown_state(cfg).get(provider.cnpj)
        mins = max(1, remaining_cd // 60)
        logger.info(
            f"[SEFAZ_SCAN] CNPJ {provider.cnpj} em cooldown preventivo da SEFAZ por mais {remaining_cd}s ({mins} min). "
            "Pulando consulta para evitar rejeição cStat 656."
        )
        return result

    try:
        for page_idx in range(MAX_PAGES_PER_RUN):
            if page_idx > 0:
                # Pausa entre páginas do MESMO CNPJ (ver INTER_PAGE_DELAY_SECONDS)
                time.sleep(INTER_PAGE_DELAY_SECONDS)

            dist: DistNsuResult = provider.consultar_distribuicao_nsu(ult_nsu)
            logger.info(
                f"[SEFAZ_SCAN] Resposta SEFAZ CNPJ {provider.cnpj} (pág {page_idx+1}): "
                f"cStat={dist.c_stat}, xMotivo='{dist.x_motivo}', ultNSU='{dist.ult_nsu}', maxNSU='{dist.max_nsu}', docs={len(dist.docs)}"
            )

            # Caso cStat 137: Nenhum documento localizado além do NSU informado
            if dist.c_stat == "137":
                # A SEFAZ retorna o ultNSU/maxNSU atualizados. Salvar imediatamente no disco
                # para que consultas futuras usem a posição correta (evita erro de quebra de sequência).
                novo_nsu = _pick_best_nsu(dist.ult_nsu, dist.max_nsu, fallback=ult_nsu)
                result.ult_nsu_final = novo_nsu
                save_nsu_checkpoint(provider.cnpj, novo_nsu, cfg)
                until = save_cnpj_cooldown(provider.cnpj, SCAN_COOLDOWN_SECONDS, cfg)
                result.cooldown_until = until
                result.cooldown_seconds_remaining = SCAN_COOLDOWN_SECONDS
                result.status = "ok"
                break

            # Caso cStat 656: Consumo Indevido
            if dist.c_stat == "656":
                logger.warning(
                    f"[SEFAZ_SCAN] CNPJ {provider.cnpj} bloqueado pela SEFAZ por 1h (cStat 656: {dist.x_motivo}). "
                    f"ultNSU_consultado={ult_nsu}, ultNSU_retornado={dist.ult_nsu}, maxNSU_retornado={dist.max_nsu}."
                )
                # Se a SEFAZ informou ultNSU/maxNSU no XML de rejeição, gravamos imediatamente no checkpoint!
                best_adv = _pick_best_nsu(dist.ult_nsu, dist.max_nsu, fallback="0")
                curr_int = _nsu_int(ult_nsu)
                adv_int = _nsu_int(best_adv)
                if adv_int > curr_int:
                    save_nsu_checkpoint(provider.cnpj, best_adv, cfg)
                    result.ult_nsu_final = best_adv
                    logger.info(
                        f"[SEFAZ_SCAN] Checkpoint NSU atualizado para {best_adv} após cStat 656 (CNPJ {provider.cnpj})."
                    )
                until = save_cnpj_cooldown(provider.cnpj, SCAN_COOLDOWN_SECONDS, cfg)
                result.status = "cooldown"
                result.cooldown_until = until
                result.cooldown_seconds_remaining = SCAN_COOLDOWN_SECONDS
                result.erro = None
                break

            if dist.c_stat != "138":
                raise NFeProviderError(
                    f"SEFAZ retornou rejeição na distribuição por NSU: cStat {dist.c_stat} - {dist.x_motivo}"
                )

            for doc in dist.docs:
                _handle_doc(doc, provider, seen_keys, result)

            novo_nsu = _pick_best_nsu(dist.ult_nsu, None, fallback=ult_nsu)
            result.ult_nsu_final = novo_nsu
            save_nsu_checkpoint(provider.cnpj, novo_nsu, cfg)

            sem_avanco = _nsu_int(novo_nsu) <= _nsu_int(ult_nsu)
            ult_nsu = novo_nsu
            if not dist.docs or sem_avanco or _nsu_int(dist.ult_nsu) >= _nsu_int(dist.max_nsu):
                # Chegou ao fim dos documentos deste CNPJ: SEFAZ exige 1h de intervalo até novos documentos
                until = save_cnpj_cooldown(provider.cnpj, SCAN_COOLDOWN_SECONDS, cfg)
                result.cooldown_until = until
                result.cooldown_seconds_remaining = SCAN_COOLDOWN_SECONDS
                result.status = "ok"
                break
    except Exception as e:
        result.status = "erro"
        result.erro = str(e)
        logger.error(f"[SEFAZ_SCAN] Erro ao varrer CNPJ {provider.cnpj} na SEFAZ: {e}", exc_info=True)

    return result


def _write_temp_xml_and_stage(found: NewNoteFound, cfg: Settings) -> None:
    """
    Como a nota veio direto da SEFAZ (sem upload de arquivo), o XML/resumo obtido vira o
    próprio "arquivo" da nota em pending_review/ — documento oficial, melhor até que o
    PDF do fluxo antigo para fins de auditoria.
    """
    cfg.ensure_directories()
    incoming_dir = cfg.DATA_DIR / "sefaz_incoming"
    incoming_dir.mkdir(parents=True, exist_ok=True)

    stem_safe = "".join(c for c in found.nfe_data.chave if c.isalnum()) or "nota_sefaz"
    temp_file = incoming_dir / f"{stem_safe}.xml"
    counter = 1
    while temp_file.exists():
        temp_file = incoming_dir / f"{stem_safe}_{counter}.xml"
        counter += 1
    temp_file.write_text(found.xml_content, encoding="utf-8")

    stage_note_for_review(found.nfe_data, temp_file, raw_ocr_text=None)


def _persist_running_status(started_at: str, cfg: Settings) -> None:
    current = _load_json(_scan_status_path(cfg), {})
    if not isinstance(current, dict):
        current = {}
    current["last_scan_started_at"] = started_at
    current["is_running"] = True
    _save_json(_scan_status_path(cfg), current, cfg)


def run_daily_scan(cfg: Optional[Settings] = None, force: bool = False) -> SefazScanSummary:
    """Ponto de entrada da varredura: chamado pelo agendador diário ou pelo botão 'Rodar agora'."""
    cfg = cfg or settings
    cfg.ensure_directories()

    if not _scan_lock.acquire(blocking=False):
        logger.warning("[SEFAZ_SCAN] Varredura pulada: outra execução já está em andamento.")
        now_iso = datetime.now(timezone.utc).isoformat()
        return SefazScanSummary(started_at=now_iso, finished_at=now_iso, resultados=[])

    try:
        remaining = scan_cooldown_remaining_seconds(cfg)
        if remaining > 0 and not force:
            logger.warning(
                f"[SEFAZ_SCAN] Varredura pulada: todos os CNPJs estão em cooldown por mais {remaining}s."
            )
            now_iso = datetime.now(timezone.utc).isoformat()
            return SefazScanSummary(started_at=now_iso, finished_at=now_iso, resultados=[])

        started_at = datetime.now(timezone.utc).isoformat()
        _persist_running_status(started_at, cfg)

        providers = _resolve_providers(cfg)
        seen_keys = load_seen_keys(cfg)

        resultados: List[CnpjScanResult] = []
        for idx, provider in enumerate(providers):
            if idx > 0:
                time.sleep(INTER_CNPJ_DELAY_SECONDS)
            cnpj_result = _scan_one_cnpj(provider, seen_keys, cfg, force=force)
            for found in cnpj_result.novas_notas:
                try:
                    _write_temp_xml_and_stage(found, cfg)
                except Exception as e:
                    logger.error(
                        f"[SEFAZ_SCAN] Falha ao estagiar nota {found.nfe_data.chave} para revisão: {e}", exc_info=True
                    )
            resultados.append(cnpj_result)

        save_seen_keys(seen_keys, cfg)

        for r in resultados:
            if r.status == "erro" or r.erro:
                record_audit_error(
                    details=f"Falha na varredura SEFAZ (CNPJ {r.cnpj}): {r.erro or 'Erro retornado pela SEFAZ'}",
                    emitente_nome=f"SEFAZ DFe ({r.cnpj})",
                    emitente_cnpj=r.cnpj,
                    original_filename=f"SEFAZ-SCAN-{r.cnpj}",
                    metodo_leitura="sefaz_dist_dfe",
                    step="sefaz_scan",
                    cfg=cfg,
                )

        summary = SefazScanSummary(
            started_at=started_at,
            finished_at=datetime.now(timezone.utc).isoformat(),
            resultados=resultados,
        )
        _persist_status(summary, cfg)
        return summary
    except Exception as e:
        logger.error(f"[SEFAZ_SCAN] Exceção crítica na varredura SEFAZ: {e}", exc_info=True)
        record_audit_error(
            details=f"Exceção crítica na varredura SEFAZ: {e}",
            original_filename="SEFAZ-SCAN-GLOBAL",
            metodo_leitura="sefaz_dist_dfe",
            step="sefaz_scan",
            cfg=cfg,
        )
        raise
    finally:
        _scan_lock.release()


def _persist_status(summary: SefazScanSummary, cfg: Settings) -> None:
    payload = {
        "last_scan_started_at": summary.started_at,
        "last_scan_finished_at": summary.finished_at,
        "total_novas_notas": summary.total_novas_notas,
        "is_running": False,
        "cnpjs": [
            {
                "cnpj": r.cnpj,
                "novas_notas": len(r.novas_notas),
                "duplicadas_ignoradas": r.duplicadas_ignoradas,
                "canceladas_ignoradas": r.canceladas_ignoradas,
                "eventos_ignorados": r.eventos_ignorados,
                "ja_lancadas_tiny": r.ja_lancadas_tiny,
                "destinatario_divergente_ignorado": r.destinatario_divergente_ignorado,
                "notas_saida_ignoradas": r.notas_saida_ignoradas,
                "ult_nsu": r.ult_nsu_final,
                "erro": r.erro,
                "status": r.status,
                "cooldown_until": r.cooldown_until or load_cooldown_state(cfg).get(r.cnpj),
                "cooldown_seconds_remaining": get_cnpj_cooldown_remaining_seconds(r.cnpj, cfg),
            }
            for r in summary.resultados
        ],
    }
    _save_json(_scan_status_path(cfg), payload, cfg)


def get_scan_status(cfg: Optional[Settings] = None) -> Dict[str, Any]:
    cfg = cfg or settings
    payload = _load_json(_scan_status_path(cfg), {})
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("last_scan_started_at", None)
    payload.setdefault("last_scan_finished_at", None)
    payload.setdefault("total_novas_notas", 0)
    payload["is_running"] = is_scan_running()
    # Não nulo = a varredura rodou mas não conseguiu gravar NSU/status (ver json_store).
    payload["erro_gravacao"] = erro_gravacao(
        _scan_status_path(cfg), _nsu_state_path(cfg), _seen_keys_path(cfg), _cooldown_state_path(cfg)
    )

    # Atualiza o tempo restante de cooldown dos CNPJs em tempo real
    cnpjs_list = payload.get("cnpjs", [])
    if isinstance(cnpjs_list, list):
        cooldown_state = load_cooldown_state(cfg)
        for c in cnpjs_list:
            if isinstance(c, dict):
                cnpj = c.get("cnpj", "")
                rem = get_cnpj_cooldown_remaining_seconds(cnpj, cfg)
                c["cooldown_seconds_remaining"] = rem
                c["cooldown_until"] = cooldown_state.get(cnpj)
                if rem > 0:
                    if c.get("status") == "ok" or (c.get("erro") and "656" in str(c.get("erro"))):
                        c["status"] = "cooldown"
                        c["erro"] = None
    payload["cnpjs"] = cnpjs_list
    return payload


def scan_cooldown_remaining_seconds(cfg: Optional[Settings] = None) -> int:
    """
    Segundos restantes até que a próxima varredura possa ser acionada.
    Se ao menos 1 CNPJ configurado estiver liberado (cooldown == 0), retorna 0 (permitido rodar).
    Se TODOS os CNPJs estiverem em cooldown, retorna o menor tempo restante entre eles.
    """
    cfg = cfg or settings
    providers = _resolve_providers(cfg)
    if not providers:
        status_data = _load_json(_scan_status_path(cfg), {})
        saved_cnpjs = [c.get("cnpj") for c in status_data.get("cnpjs", []) if isinstance(c, dict) and c.get("cnpj")]
        if not saved_cnpjs:
            return 0
        rem_list = [get_cnpj_cooldown_remaining_seconds(cnpj, cfg) for cnpj in saved_cnpjs]
        if any(r == 0 for r in rem_list):
            return 0
        return min(rem_list)

    remaining_per_cnpj = [
        get_cnpj_cooldown_remaining_seconds(p.cnpj, cfg)
        for p in providers
    ]
    if any(r == 0 for r in remaining_per_cnpj):
        return 0
    return min(remaining_per_cnpj)



def next_scan_at(cfg: Optional[Settings] = None) -> str:
    cfg = cfg or settings
    now = datetime.now()
    next_run = now.replace(hour=cfg.SEFAZ_SCAN_HOUR, minute=0, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    return next_run.isoformat()
