"""Incidentes e etapas em SQLite. Cada etapa é a saída completa de um agente numa volta.

Para o fine-tuning: `chamadas` guarda cada conversa com o modelo (prompt e resposta crus) e
`desfechos` o que aconteceu depois (testes, qualidade, PR, produção, TI). Ver treino.py.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# Estados: novo → em_andamento → um dos finais:
#   aguardando_ti   correção não é de código automatizável (ou o diagnóstico pediu humano): relatório
#   pr_aberto       qualidade aprovou e o PR foi aberto (pr_url)
#   ↳ aguardando_deploy  PR mergeado (merge_sha); espera o commit chegar à produção
#   ↳ monitorando        deploy visto (deploy_em): espera 5 execuções ok da rota ou a janela sem recorrência
#   ↳ resolvido          o monitor confirmou · reapareceu → volta+1 e novo (loop de novo)
#   pr_fechado      o PR foi fechado sem merge
#   pronto_para_pr  qualidade aprovou com PR_ABRIR=0 (branch local no clone)
#   escalado        passou de MAX_VOLTAS ou um agente falhou de vez
#   resolvido       o TI confirmou (nota_ti vai para a RAG da resolução)
# relatorio_pronto é o estado final antigo da fase 1 (incidentes de antes da fase 2).
ABERTOS = ("novo", "em_andamento")
# Correção pronta mas ainda não em produção: repetição do erro é esperada, só soma.
ANTES_DO_DEPLOY = ("pr_aberto", "pronto_para_pr", "aguardando_deploy")
# Evento dos incidentes abertos por um reporte do painel ("Reportar erro"), sem log que o coletor achou.
REPORTE = "reporte_operador"
TRECHO_MINIMO = 12  # mensagem normalizada mais curta que isto não serve para dizer que dois erros são o mesmo


def normalizar(mensagem: str) -> str:
    """Mesma regra do coletor (scripts/coletor-incidentes/coletor.py): tira ids, números e valores entre aspas."""
    m = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<id>", mensagem or "", flags=re.I)
    m = re.sub(r"'[^']*'|\"[^\"]*\"", "<v>", m)
    m = re.sub(r"\d+", "#", m)
    return re.sub(r"\s+", " ", m).strip()[:300]


def _mesmo_erro(a: str, b: str) -> bool:
    na, nb = normalizar(a), normalizar(b)
    curta, longa = sorted((na, nb), key=len)
    return len(curta) >= TRECHO_MINIMO and curta in longa


# O gateway registra como request_public_error (UpstreamError) a falha 5xx que a automação já logou:
# é o mesmo erro, visto de fora. Junta-se ao incidente da automação se chegou perto no tempo e as
# mensagens dividem um trecho longo (a mensagem da automação repassada).
ECO_JANELA = timedelta(seconds=60)
ECO_TRECHO = 40


def _instante(texto: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.fromisoformat((texto or "")[:19]).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def eco_do_gateway(gateway: dict, automacao: dict) -> bool:
    """O incidente do gateway é só o repasse da falha que o da automação já registrou?"""
    if gateway.get("servico") != "gateway" or automacao.get("servico") in (None, "gateway"):
        return False
    if not (gateway.get("mensagem") or "").startswith("UpstreamError"):
        return False
    tg, ta = _instante(gateway.get("ultimo_em")), _instante(automacao.get("ultimo_em"))
    if not tg or not ta or abs(tg - ta) > ECO_JANELA:
        return False
    a, b = normalizar(gateway["mensagem"]), normalizar(automacao.get("mensagem") or "")
    return difflib.SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b)).size >= ECO_TRECHO


def agora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Banco:
    def __init__(self, caminho: Path) -> None:
        caminho.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(caminho), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.trava = threading.Lock()
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS incidentes (
                id INTEGER PRIMARY KEY,
                assinatura TEXT NOT NULL,
                servico TEXT, evento TEXT, funcao TEXT, mensagem TEXT, amostra TEXT, commit_prod TEXT,
                ocorrencias INTEGER NOT NULL DEFAULT 1,
                primeiro_em TEXT, ultimo_em TEXT,
                estado TEXT NOT NULL DEFAULT 'novo',
                volta INTEGER NOT NULL DEFAULT 1,
                anterior_id INTEGER,
                nota_ti TEXT,
                criado_em TEXT, atualizado_em TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_incidentes_assinatura ON incidentes (assinatura);
            CREATE TABLE IF NOT EXISTS execucoes (
                id INTEGER PRIMARY KEY, servico TEXT, rota TEXT NOT NULL, ok INTEGER NOT NULL, erro INTEGER NOT NULL,
                ocorrido_em TEXT NOT NULL, commit_prod TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_execucoes_rota ON execucoes (rota, ocorrido_em);
            CREATE TABLE IF NOT EXISTS producao (id INTEGER PRIMARY KEY CHECK (id = 1), commit_prod TEXT, desde TEXT);
            CREATE TABLE IF NOT EXISTS etapas (
                id INTEGER PRIMARY KEY,
                incidente_id INTEGER NOT NULL REFERENCES incidentes (id),
                volta INTEGER NOT NULL,
                agente TEXT NOT NULL,
                modelo TEXT,
                fontes TEXT,
                saida TEXT NOT NULL,
                segundos REAL,
                criado_em TEXT
            );
            CREATE TABLE IF NOT EXISTS chamadas (
                id INTEGER PRIMARY KEY,
                incidente_id INTEGER NOT NULL REFERENCES incidentes (id),
                volta INTEGER NOT NULL,
                agente TEXT NOT NULL,
                modelo TEXT,
                mensagens TEXT NOT NULL,
                resposta TEXT,
                valida INTEGER NOT NULL,
                erro TEXT,
                segundos REAL,
                criado_em TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_chamadas_incidente ON chamadas (incidente_id, volta);
            CREATE TABLE IF NOT EXISTS desfechos (
                id INTEGER PRIMARY KEY,
                incidente_id INTEGER NOT NULL REFERENCES incidentes (id),
                volta INTEGER NOT NULL,
                evento TEXT NOT NULL,
                agente TEXT,
                detalhe TEXT,
                criado_em TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_desfechos_incidente ON desfechos (incidente_id, volta);
            CREATE TABLE IF NOT EXISTS reportes (
                id INTEGER PRIMARY KEY,  -- id do reporte no gateway (tabela incidentes do MariaDB)
                incidente_id INTEGER NOT NULL REFERENCES incidentes (id),
                automacao TEXT, referencia TEXT, por TEXT, mensagem TEXT, nota TEXT, criado_em TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_reportes_incidente ON reportes (incidente_id);
            -- Classificador de NF-e (financeiro_fila.py): uma linha por nota da revisão da VPS.
            -- Estados: pendente → classificada → entregue | descartada; erro (desistiu).
            CREATE TABLE IF NOT EXISTS notas_financeiro (
                chave TEXT PRIMARY KEY,
                staged_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                estado TEXT NOT NULL DEFAULT 'pendente',
                resultado_json TEXT,
                modelo TEXT,
                tentativas INTEGER NOT NULL DEFAULT 0,
                erro TEXT,
                http_vps INTEGER,
                recebido_em TEXT, classificado_em TEXT, entregue_em TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_notas_financeiro_estado ON notas_financeiro (estado, recebido_em);
            -- Itens já confirmados por uma pessoa na VPS: exemplos do few-shot e gabarito do fine-tuning.
            -- qwen_*: o palpite que chegou à tela; palpite_*: o que este PC classificou (mesmo se não chegou).
            CREATE TABLE IF NOT EXISTS historico_itens_financeiro (
                chave_nfe TEXT NOT NULL,
                item_id TEXT NOT NULL,
                confirmado_em TEXT, staged_at TEXT,
                destinatario_cnpj TEXT, emitente_cnpj TEXT, emitente_nome TEXT,
                codigo TEXT, ncm TEXT, descricao TEXT, quantidade REAL, valor_total REAL,
                categoria_id TEXT NOT NULL,
                forma_pagamento TEXT,
                qwen_categoria_id TEXT, qwen_confianca TEXT, qwen_modelo TEXT,
                palpite_categoria_id TEXT, palpite_confianca TEXT, palpite_modelo TEXT,
                recebido_em TEXT,
                PRIMARY KEY (chave_nfe, item_id)
            );
            CREATE INDEX IF NOT EXISTS ix_hist_fin_fornecedor ON historico_itens_financeiro (destinatario_cnpj, emitente_cnpj);
            CREATE INDEX IF NOT EXISTS ix_hist_fin_ncm ON historico_itens_financeiro (destinatario_cnpj, ncm);
            -- Cabeçalho das notas confirmadas: o prompt do dataset de treino (treino_financeiro.py) igual ao da fila.
            CREATE TABLE IF NOT EXISTS notas_confirmadas_financeiro (
                chave TEXT PRIMARY KEY,
                destinatario_nome TEXT, valor_total REAL, meio_pagamento_nfe TEXT, recebido_em TEXT
            );
            -- O que a tela da revisão sugeria em cada item na hora da confirmação (atividades_treino da VPS,
            -- `python -m agentes importar-atividades`): a "sugestão anterior" que a pessoa aceitou ou corrigiu.
            CREATE TABLE IF NOT EXISTS sugestoes_financeiro (
                chave_nfe TEXT NOT NULL,
                item_id TEXT NOT NULL,
                atividade_id INTEGER NOT NULL, criado_em TEXT,
                categoria_id TEXT, origem TEXT, nivel TEXT, confianca TEXT, motivo TEXT,
                historico_categoria_id TEXT, qwen_categoria_id TEXT, qwen_confianca TEXT, regra_categoria_id TEXT,
                escolha_categoria_id TEXT,
                PRIMARY KEY (chave_nfe, item_id)
            );
            CREATE TABLE IF NOT EXISTS financeiro_estado (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
            -- Cada conversa do classificador com o modelo (prompt e resposta crus): auditoria e fine-tuning.
            CREATE TABLE IF NOT EXISTS chamadas_financeiro (
                id INTEGER PRIMARY KEY,
                chave TEXT NOT NULL, staged_at TEXT,
                modelo TEXT, mensagens TEXT NOT NULL, resposta TEXT, valida INTEGER NOT NULL, erro TEXT, segundos REAL,
                criado_em TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_chamadas_financeiro_chave ON chamadas_financeiro (chave);
            """
        )
        colunas = {c["name"] for c in self.db.execute("PRAGMA table_info(incidentes)")}
        for coluna in ("pr_url", "branch", "rota", "merge_sha", "deploy_em", "monitor_ate"):
            if coluna not in colunas:
                self.db.execute(f"ALTER TABLE incidentes ADD COLUMN {coluna} TEXT")
        # Pedido do TI (comentário /refazer no PR) e a volta em que ele chegou: as MAX_VOLTAS contam dali.
        if "pedido_ti" not in colunas:
            self.db.execute("ALTER TABLE incidentes ADD COLUMN pedido_ti TEXT")
        if "volta_base" not in colunas:
            self.db.execute("ALTER TABLE incidentes ADD COLUMN volta_base INTEGER NOT NULL DEFAULT 0")
        # Vetor bge-m3 (float16, normalizado) do item confirmado, calculado sob demanda pelo classificador.
        if "vetor" not in {c["name"] for c in self.db.execute("PRAGMA table_info(historico_itens_financeiro)")}:
            self.db.execute("ALTER TABLE historico_itens_financeiro ADD COLUMN vetor BLOB")

    def receber(self, inc: dict) -> tuple[int, bool]:
        """Grava o incidente. (id, precisa rodar a cadeia?)

        Mesma assinatura aberta ou com correção ainda não em produção: só soma ocorrências.
        Em monitoramento (correção já em produção): reabre o mesmo incidente na volta seguinte.
        """
        self.registrar_commit(inc.get("commit"), inc.get("ocorrido_em"))
        with self.trava:
            ultimo = self.db.execute("SELECT * FROM incidentes WHERE assinatura=? ORDER BY id DESC LIMIT 1", (inc["assinatura"],)).fetchone()
            if inc.get("evento") != REPORTE and not (ultimo and ultimo["estado"] in ABERTOS + ANTES_DO_DEPLOY + ("monitorando",)):
                reporte = self._equivalente(inc.get("servico"), inc.get("mensagem"), None, so_reportes=True)
                if reporte and reporte["estado"] in ABERTOS + ANTES_DO_DEPLOY + ("monitorando",):
                    # O operador reportou antes de o log chegar: o log completa o mesmo incidente.
                    self._completar_com_log(reporte, inc)
                    ultimo = self.incidente(reporte["id"])
            if ultimo and ultimo["estado"] in ABERTOS + ANTES_DO_DEPLOY + ("monitorando",):
                reabrir = ultimo["estado"] == "monitorando"
                self.db.execute(
                    "UPDATE incidentes SET ocorrencias=ocorrencias+?, ultimo_em=?, atualizado_em=? WHERE id=?",
                    (int(inc.get("ocorrencias", 1)), inc.get("ocorrido_em"), agora(), ultimo["id"]),
                )
                if reabrir:
                    self.db.execute(
                        "INSERT INTO desfechos (incidente_id, volta, evento, detalhe, criado_em) VALUES (?,?,?,?,?)",
                        (ultimo["id"], ultimo["volta"], "reapareceu", f"commit {inc.get('commit') or '?'}", agora()),
                    )
                    self.db.execute(
                        "UPDATE incidentes SET estado='novo', volta=volta+1, amostra=?, commit_prod=?, nota_ti=? WHERE id=?",
                        (inc.get("amostra"), inc.get("commit"), f"reapareceu depois do deploy da correção (commit {inc.get('commit') or '?'})", ultimo["id"]),
                    )
                return ultimo["id"], reabrir
            novo = {**inc, "ultimo_em": inc.get("ocorrido_em")}
            for cand in self.db.execute(
                "SELECT * FROM incidentes WHERE estado != 'resolvido' AND servico != ? ORDER BY id DESC LIMIT 50", (inc.get("servico"),)
            ):
                if eco_do_gateway(novo, dict(cand)):
                    return cand["id"], False
                if eco_do_gateway(dict(cand), novo) and cand["estado"] == "novo" and cand["volta"] == 1:
                    # O repasse do gateway chegou antes do log da automação: sai da fila, a automação é a origem.
                    self.db.execute("DELETE FROM incidentes WHERE id=?", (cand["id"],))
            anterior = ultimo
            cur = self.db.execute(
                """INSERT INTO incidentes (assinatura, servico, evento, funcao, rota, mensagem, amostra, commit_prod, ocorrencias,
                   primeiro_em, ultimo_em, anterior_id, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    inc["assinatura"], inc.get("servico"), inc.get("evento"), inc.get("funcao"), inc.get("rota"), inc.get("mensagem"),
                    inc.get("amostra"), inc.get("commit"), int(inc.get("ocorrencias", 1)),
                    inc.get("ocorrido_em"), inc.get("ocorrido_em"), anterior["id"] if anterior else None, agora(), agora(),
                ),
            )
            return cur.lastrowid, True

    def _equivalente(self, servico: Optional[str], mensagem: Optional[str], referencia: Optional[str],
                     so_reportes: bool = False) -> Optional[sqlite3.Row]:
        """Incidente ainda não resolvido do mesmo serviço com o mesmo erro (chamar com a trava).

        Mesmo erro = uma mensagem normalizada contém a outra, ou a referência do reporte (execução,
        SKU, chave) aparece no log do incidente.
        """
        sql = "SELECT * FROM incidentes WHERE servico=? AND estado != 'resolvido'"
        if so_reportes:
            sql += f" AND evento='{REPORTE}'"
        for cand in self.db.execute(sql + " ORDER BY id DESC", (servico,)):
            if _mesmo_erro(cand["mensagem"] or "", mensagem or ""):
                return cand
            if referencia and len(referencia) >= 4 and not so_reportes and referencia in (cand["amostra"] or ""):
                return cand
        return None

    def _completar_com_log(self, reporte: sqlite3.Row, inc: dict) -> None:
        """Põe o log (pilha, rota, função) no incidente aberto pelo reporte, se a cadeia ainda não começou."""
        if reporte["estado"] != "novo":
            return
        self.db.execute(
            "UPDATE incidentes SET amostra=?, rota=COALESCE(rota, ?), funcao=CASE WHEN funcao='' THEN ? ELSE funcao END WHERE id=?",
            (f"{reporte['amostra']}\n\nLog do erro:\n{inc.get('amostra') or ''}", inc.get("rota"), inc.get("funcao") or "", reporte["id"]),
        )

    def receber_reporte(self, rep: dict) -> tuple[int, bool]:
        """Reporte do botão "Reportar erro" do painel. (id do incidente, precisa rodar a cadeia?)

        Sem duplicar: o mesmo reporte entregue de novo devolve o incidente já ligado; erro igual a um
        incidente ainda não resolvido (vindo do log ou de outro reporte) só se junta a ele; senão abre
        um incidente cuja assinatura é serviço + mensagem, para reportes iguais caírem no mesmo.
        """
        with self.trava:
            ja = self.db.execute("SELECT incidente_id FROM reportes WHERE id=?", (rep["id"],)).fetchone()
            if ja:
                return ja["incidente_id"], False
            alvo = self._equivalente(rep["servico"], rep["mensagem"], rep.get("referencia"))
        texto = (
            f"Erro reportado no painel por {rep.get('por') or '?'} na automação {rep.get('titulo') or rep.get('automacao')}"
            f"\nReferência: {rep.get('referencia') or '-'}\nEtapa: {rep.get('etapa') or '-'}"
            f"\nMensagem na tela: {rep['mensagem']}\nO que o operador disse: {rep.get('nota') or '-'}"
        )
        if alvo:
            inc_id, rodar = alvo["id"], False
            if alvo["estado"] == "monitorando":
                # Correção em produção e o erro voltou: mesmo caminho do log repetido.
                inc_id, rodar = self.receber({
                    "assinatura": alvo["assinatura"], "servico": alvo["servico"], "evento": alvo["evento"],
                    "amostra": f"{alvo['amostra']}\n\n{texto}", "ocorrido_em": rep.get("em") or agora(),
                })
        else:
            base = f"{rep['servico']}|{REPORTE}|{normalizar(rep['mensagem'])}"
            inc_id, rodar = self.receber({
                "assinatura": hashlib.sha1(base.encode()).hexdigest()[:16],
                "servico": rep["servico"],
                "evento": REPORTE,
                "funcao": "",
                "rota": None,
                "mensagem": rep["mensagem"][:500],
                "amostra": texto,
                "ocorrido_em": rep.get("em") or agora(),
            })
        with self.trava:
            self.db.execute(
                "INSERT OR IGNORE INTO reportes (id, incidente_id, automacao, referencia, por, mensagem, nota, criado_em) VALUES (?,?,?,?,?,?,?,?)",
                (rep["id"], inc_id, rep.get("automacao"), rep.get("referencia"), rep.get("por"), rep["mensagem"], rep.get("nota"), rep.get("em") or agora()),
            )
            somar = 1 if alvo and alvo["estado"] != "monitorando" else 0  # receber() já somou nos outros casos
            self.db.execute("UPDATE incidentes SET ocorrencias=ocorrencias+?, atualizado_em=? WHERE id=?", (somar, agora(), inc_id))
        inc = self.incidente(inc_id)
        self.gravar_desfecho(inc_id, inc["volta"], "operador_reportou", detalhe=f"{rep.get('por') or '?'}: {rep.get('nota') or rep['mensagem']}"[:600])
        return inc_id, rodar

    def reportes(self, inc_id: int) -> list:
        return self.db.execute("SELECT * FROM reportes WHERE incidente_id=? ORDER BY id", (inc_id,)).fetchall()

    def registrar_commit(self, commit: Optional[str], ocorrido_em: Optional[str]) -> None:
        """Commit em produção (git HEAD da VPS, enviado pelo coletor) e desde quando ele está lá."""
        if not commit:
            return
        with self.trava:
            atual = self.db.execute("SELECT commit_prod FROM producao WHERE id=1").fetchone()
            if not atual or atual["commit_prod"] != commit:
                self.db.execute(
                    "INSERT INTO producao VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET commit_prod=excluded.commit_prod, desde=excluded.desde",
                    (commit, ocorrido_em or agora()),
                )

    def producao(self) -> Optional[sqlite3.Row]:
        return self.db.execute("SELECT commit_prod, desde FROM producao WHERE id=1").fetchone()

    def receber_execucoes(self, payload: dict) -> int:
        self.registrar_commit(payload.get("commit"), payload.get("ocorrido_em"))
        linhas = [
            (payload.get("servico"), rota, int(c.get("ok", 0)), int(c.get("erro", 0)), payload.get("ocorrido_em") or agora(), payload.get("commit"))
            for rota, c in payload["rotas"].items()
            if isinstance(c, dict)
        ]
        with self.trava:
            self.db.executemany("INSERT INTO execucoes (servico, rota, ok, erro, ocorrido_em, commit_prod) VALUES (?,?,?,?,?,?)", linhas)
        return len(linhas)

    def execucoes_ok(self, rota: str, desde: str, servico: Optional[str] = None) -> int:
        """Execuções ok da rota (do mesmo serviço, quando informado) desde o deploy."""
        sql = "SELECT COALESCE(SUM(ok), 0) FROM execucoes WHERE rota=? AND substr(ocorrido_em, 1, 19) >= substr(?, 1, 19)"
        args: list = [rota, desde]
        if servico:
            sql, args = sql + " AND servico=?", args + [servico]
        linha = self.db.execute(sql, args).fetchone()
        return int(linha[0])

    def acompanhamento(self, rota: str, desde: str, servico: Optional[str] = None, alvo: int = 5) -> tuple[int, int]:
        """(acompanhadas, sucessos) das primeiras `alvo` execuções da rota desde o deploy.

        A contagem chega somada por minuto: dentro do mesmo minuto as falhas contam primeiro.
        """
        sql = "SELECT ok, erro FROM execucoes WHERE rota=? AND substr(ocorrido_em, 1, 19) >= substr(?, 1, 19)"
        args: list = [rota, desde]
        if servico:
            sql, args = sql + " AND servico=?", args + [servico]
        acompanhadas = falhas = 0
        for linha in self.db.execute(sql + " ORDER BY ocorrido_em, id", args):
            if acompanhadas >= alvo:
                break
            erro = min(int(linha["erro"]), alvo - acompanhadas)
            ok = min(int(linha["ok"]), alvo - acompanhadas - erro)
            acompanhadas += erro + ok
            falhas += erro
        return acompanhadas, acompanhadas - falhas

    def desfechos(self, inc_id: int) -> list:
        return self.db.execute("SELECT * FROM desfechos WHERE incidente_id=? ORDER BY id", (inc_id,)).fetchall()

    def recentes(self, limite: int = 100) -> list:
        """Os incidentes mexidos por último (painel do interface-web)."""
        return self.db.execute("SELECT * FROM incidentes ORDER BY atualizado_em DESC, id DESC LIMIT ?", (limite,)).fetchall()

    def por_estado(self, *estados: str) -> list:
        return self.db.execute(f"SELECT * FROM incidentes WHERE estado IN ({','.join('?' * len(estados))}) ORDER BY id", estados).fetchall()

    def proximo(self) -> Optional[sqlite3.Row]:
        """O incidente mais antigo ainda não concluído (um de cada vez, em ordem de chegada)."""
        return self.db.execute(
            f"SELECT * FROM incidentes WHERE estado IN ({','.join('?' * len(ABERTOS))}) ORDER BY id LIMIT 1", ABERTOS
        ).fetchone()

    def incidente(self, inc_id: int) -> Optional[sqlite3.Row]:
        return self.db.execute("SELECT * FROM incidentes WHERE id=?", (inc_id,)).fetchone()

    def listar(self, limite: int = 30) -> list:
        return self.db.execute("SELECT * FROM incidentes ORDER BY id DESC LIMIT ?", (limite,)).fetchall()

    def mudar_estado(self, inc_id: int, estado: str, **campos) -> None:
        sets = ", ".join(f"{c}=?" for c in campos)
        with self.trava:
            self.db.execute(
                f"UPDATE incidentes SET estado=?, atualizado_em=?{', ' + sets if sets else ''} WHERE id=?",
                (estado, agora(), *campos.values(), inc_id),
            )

    def gravar_etapa(self, inc_id: int, volta: int, agente: str, modelo: str, fontes: list, saida: dict, segundos: float) -> None:
        with self.trava:
            self.db.execute(
                "INSERT INTO etapas (incidente_id, volta, agente, modelo, fontes, saida, segundos, criado_em) VALUES (?,?,?,?,?,?,?,?)",
                (inc_id, volta, agente, modelo, json.dumps(fontes, ensure_ascii=False), json.dumps(saida, ensure_ascii=False), segundos, agora()),
            )

    def gravar_chamada(self, inc_id: int, volta: int, agente: str, *, modelo: str, mensagens: list, resposta: str,
                       valida: bool, erro: str, segundos: float) -> None:
        with self.trava:
            self.db.execute(
                "INSERT INTO chamadas (incidente_id, volta, agente, modelo, mensagens, resposta, valida, erro, segundos, criado_em)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (inc_id, volta, agente, modelo, json.dumps(mensagens, ensure_ascii=False), resposta, int(valida), erro, round(segundos, 1), agora()),
            )

    def gravar_desfecho(self, inc_id: int, volta: int, evento: str, agente: Optional[str] = None, detalhe: str = "") -> None:
        with self.trava:
            self.db.execute(
                "INSERT INTO desfechos (incidente_id, volta, evento, agente, detalhe, criado_em) VALUES (?,?,?,?,?,?)",
                (inc_id, volta, evento, agente, detalhe, agora()),
            )

    def etapas(self, inc_id: int, volta: Optional[int] = None) -> list:
        sql, args = "SELECT * FROM etapas WHERE incidente_id=?", [inc_id]
        if volta is not None:
            sql, args = sql + " AND volta=?", args + [volta]
        return self.db.execute(sql + " ORDER BY id", args).fetchall()

    def resolvidos(self) -> list:
        """Incidentes que o TI marcou como resolvidos (com a nota), para a RAG da resolução."""
        return self.db.execute("SELECT * FROM incidentes WHERE estado='resolvido' AND nota_ti IS NOT NULL ORDER BY id").fetchall()
