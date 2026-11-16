"""
Histórico de categoria dos boletos DDA (fornecedor → categoria do Tiny) e sugestão no painel.

Duas fontes, sempre por empresa (cada empresa é uma conta Tiny com IDs de categoria próprios):

1. **Tiny** — as saídas de caixa (GET /caixa, tipo D) de cada categoria, lidas pelo Dashboard
   Financeiro na sincronização (financial_dashboard._sync_one_company já consulta uma categoria
   por vez; a lista de /caixa não devolve a categoria do item). Cada lançamento vira um registro
   (fornecedor pelo CNPJ do contato, senão pelo nome). Transferências entre as empresas ficam de
   fora. Nada é apagado quando sai da janela do dashboard: o histórico só cresce (até MESES_GUARDAR).
2. **Painel** — a categoria escolhida ao criar a conta do boleto (ou a da conta ligada à mão), com
   o que a tela sugeria na hora: é o gabarito do classificador Qwen e o rótulo
   confirmado/corrigido do fine-tuning.

Precedência da sugestão (`sugestao_boleto`), como na revisão de NF-e:
  painel (última escolha com o fornecedor) > Tiny dominante (≥ DOMINANTE das vezes, ao menos
  MIN_VEZES) > Qwen alta/média > Tiny sem categoria dominante > Qwen baixa > nenhuma.

Cada registro ganha um `seq` crescente ao entrar ou mudar: é o cursor de
GET /api/v1/dda/qwen/confirmadas-recentes, que leva o histórico ao PC do TI (agentes-qwen).

Estado em DATA_DIR/dda/historico_categorias.json.
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
import unicodedata
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.config import Settings, settings
from app.fuso import agora_sp
from app.inter_client import INTER_EMPRESAS
from app.json_store import save_json_state

logger = logging.getLogger("automacao_nfe.dda_categoria")

DOMINANTE = 0.8
MIN_VEZES = 2
MESES_GUARDAR = 25
CONFIANCAS_QWEN = ("alta", "media", "baixa")
QWEN_MOTIVO_MAX = 500
DISTRIBUICAO_MAX = 4

_SUFIXOS = re.compile(r"\b(ltda|me|epp|eireli|s ?a|s/a|sa|cia|comercio|com|ind|industria)\b")


def _digitos(valor: Any) -> str:
    return re.sub(r"\D", "", str(valor or ""))


def nome_normalizado(nome: Any) -> str:
    """Nome do fornecedor sem acento, pontuação e sufixo societário: casa 'X LTDA' com 'X Ltda.'."""
    texto = unicodedata.normalize("NFKD", str(nome or "")).encode("ascii", "ignore").decode().lower()
    texto = re.sub(r"[^a-z0-9 ]+", " ", texto)
    return re.sub(r"\s+", " ", _SUFIXOS.sub(" ", texto)).strip()


def chave_fornecedor(cnpj: Any, nome: Any) -> Optional[str]:
    doc = _digitos(cnpj)
    if len(doc) in (11, 14):
        return doc
    nome = nome_normalizado(nome)
    return f"nome:{nome}" if nome else None


def empresa_do_cnpj(cnpj: Any) -> Optional[str]:
    doc = _digitos(cnpj)
    return next((emp for emp, info in INTER_EMPRESAS.items() if info["cnpj"] == doc), None)


def versao_boleto(b: Dict[str, Any]) -> str:
    """O que muda a classificação do boleto: outro valor, vencimento ou fornecedor pede outra."""
    return "|".join(str(b.get(c) or "") for c in ("valor", "vencimento", "beneficiario_cnpj", "sacador_cnpj"))


class HistoricoCategorias:
    def __init__(self, pasta: Optional[Path] = None, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or settings
        self._pasta = Path(pasta) if pasta else None
        self._lock = threading.RLock()
        self._dados: Optional[Dict[str, Any]] = None
        self._indice: Optional[Tuple[int, Dict]] = None
        self._lido_de: Optional[Path] = None
        self._somente_leitura = False

    @property
    def arquivo(self) -> Path:
        return (self._pasta or Path(self.cfg.DATA_DIR) / "dda") / "historico_categorias.json"

    def ler(self) -> Dict[str, Any]:
        with self._lock:
            if self._dados is not None and self._lido_de != self.arquivo:
                # DATA_DIR mudou (testes): relê do lugar novo.
                self._dados, self._indice = None, None
            if self._dados is None:
                self._lido_de = self.arquivo
                dados: Dict[str, Any] = {"seq": 0, "registros": {}, "atualizado_tiny": {}}
                if self.arquivo.exists():
                    try:
                        dados.update(json.loads(self.arquivo.read_text(encoding="utf-8")))
                    except Exception as e:
                        # Ilegível: começa vazio em memória, sem gravar por cima (o Tiny repõe na
                        # próxima sincronização, mas as escolhas do painel estão só nele).
                        logger.error(f"[DDA_CATEGORIA] Histórico ilegível em {self.arquivo}: {e}")
                        self._dados = dados
                        self._somente_leitura = True
                        return dados
                self._dados = dados
                self._somente_leitura = False
            return self._dados

    def _gravar(self, dados: Dict[str, Any]) -> None:
        self._dados = dados
        self._indice = None
        if self._somente_leitura:
            return
        self.arquivo.parent.mkdir(parents=True, exist_ok=True)
        save_json_state(self.arquivo, dados, "DDA_CATEGORIA")

    def _upsert(self, dados: Dict[str, Any], registro: Dict[str, Any]) -> bool:
        atual = dados["registros"].get(registro["chave"])
        if atual is not None and {k: v for k, v in atual.items() if k != "seq"} == registro:
            return False
        dados["seq"] = int(dados.get("seq") or 0) + 1
        dados["registros"][registro["chave"]] = {**registro, "seq": dados["seq"]}
        return True

    # --- escrita ----------------------------------------------------------------------------

    def registrar_lancamentos_tiny(self, empresa: str, lancamentos: Iterable[Dict[str, Any]]) -> int:
        """Saídas de caixa de uma empresa (financial_dashboard). Devolve quantos registros entraram ou mudaram."""
        limite = (agora_sp().date() - timedelta(days=31 * MESES_GUARDAR)).isoformat()
        with self._lock:
            dados = copy.deepcopy(self.ler())
            mudou = 0
            for l in lancamentos:
                chave_forn = chave_fornecedor(l.get("fornecedor_cnpj"), l.get("fornecedor_nome"))
                if l.get("id") in (None, "") or not l.get("categoria_id") or not chave_forn:
                    continue
                registro = {
                    "chave": f"tiny:{empresa}:{l['id']}",
                    "fonte": "tiny",
                    "empresa": empresa,
                    "fornecedor": chave_forn,
                    "fornecedor_cnpj": _digitos(l.get("fornecedor_cnpj")),
                    "fornecedor_nome": str(l.get("fornecedor_nome") or "")[:200],
                    "valor": round(float(l.get("valor") or 0), 2),
                    "data": str(l.get("data") or "")[:10],
                    "categoria_id": str(l["categoria_id"]),
                    "categoria_nome": str(l.get("categoria_nome") or ""),
                    "categoria_grupo": str(l.get("categoria_grupo") or ""),
                    "historico": str(l.get("historico") or "")[:200],
                }
                mudou += self._upsert(dados, registro)
            antigos = [k for k, r in dados["registros"].items() if r.get("fonte") == "tiny" and r.get("data", "9") < limite]
            for k in antigos:
                del dados["registros"][k]
            dados.setdefault("atualizado_tiny", {})[empresa] = agora_sp().isoformat(timespec="seconds")
            if mudou or antigos:
                self._gravar(dados)
            else:
                self._dados = dados
            return mudou

    def registrar_escolha(
        self,
        boleto: Dict[str, Any],
        categoria: Dict[str, Any],
        acao: str,
        usuario: str,
        sugestao: Optional[Dict[str, Any]],
    ) -> None:
        """Escolha do painel (`acao`: 'criou' a conta ou 'ligou' a uma conta do Tiny)."""
        chave_forn = chave_fornecedor(boleto.get("beneficiario_cnpj") or boleto.get("sacador_cnpj"), boleto.get("beneficiario_nome"))
        if not chave_forn or not categoria.get("id"):
            return
        qwen = boleto.get("qwen") if (boleto.get("qwen") or {}).get("versao") == versao_boleto(boleto) else None
        registro = {
            "chave": f"painel:{boleto['id']}",
            "fonte": "painel",
            "empresa": boleto["empresa"],
            "fornecedor": chave_forn,
            "fornecedor_cnpj": _digitos(boleto.get("beneficiario_cnpj") or boleto.get("sacador_cnpj")),
            "fornecedor_nome": str(boleto.get("beneficiario_nome") or "")[:200],
            "valor": round(float(boleto.get("valor") or 0), 2),
            "data": str(boleto.get("vencimento") or "")[:10],
            "categoria_id": str(categoria["id"]),
            "categoria_nome": str(categoria.get("nome") or ""),
            "categoria_grupo": str(categoria.get("grupo") or ""),
            "boleto_id": str(boleto["id"]),
            "documento": str(boleto.get("documento") or ""),
            "emissao": str(boleto.get("emissao") or ""),
            "tipo_label": str(boleto.get("tipo_label") or ""),
            "acao": acao,
            "usuario": usuario,
            "confirmado_em": agora_sp().isoformat(timespec="seconds"),
            "sugestao": {k: v for k, v in (sugestao or {}).items() if k != "alternativas"} or None,
            "alternativas": (sugestao or {}).get("alternativas"),
            "qwen": {k: qwen.get(k) for k in ("categoria_id", "confianca", "modelo")} if qwen else None,
        }
        with self._lock:
            dados = copy.deepcopy(self.ler())
            if self._upsert(dados, registro):
                self._gravar(dados)

    # --- índice e sugestão --------------------------------------------------------------------

    def _indice_atual(self) -> Dict:
        with self._lock:
            dados = self.ler()
            seq = int(dados.get("seq") or 0)
            if self._indice and self._indice[0] == seq:
                return self._indice[1]
            tiny: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
            valores: Dict[Tuple[str, str, str], List[float]] = defaultdict(list)
            ultima: Dict[Tuple[str, str, str], str] = {}
            painel: Dict[Tuple[str, str], Dict[str, Any]] = {}
            for r in dados["registros"].values():
                k = (r["empresa"], r["fornecedor"])
                if r["fonte"] == "painel":
                    if k not in painel or str(r.get("confirmado_em")) > str(painel[k].get("confirmado_em")):
                        painel[k] = r
                    continue
                tiny[k][r["categoria_id"]] += 1
                valores[(*k, r["categoria_id"])].append(r.get("valor") or 0.0)
                ultima[(*k, r["categoria_id"])] = max(ultima.get((*k, r["categoria_id"]), ""), r.get("data") or "")
            indice = {"tiny": tiny, "valores": valores, "ultima": ultima, "painel": painel}
            self._indice = (seq, indice)
            return indice

    def historico_boleto(self, b: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """O que o histórico diz do fornecedor do boleto, ou None se ele é novo na empresa."""
        indice = self._indice_atual()
        chaves = [c for c in (
            chave_fornecedor(b.get("beneficiario_cnpj"), None),
            chave_fornecedor(b.get("sacador_cnpj"), None),
            chave_fornecedor(None, b.get("beneficiario_nome")),
        ) if c]
        for chave in dict.fromkeys(chaves):
            k = (b.get("empresa"), chave)
            escolha = indice["painel"].get(k)
            contagem = indice["tiny"].get(k) or Counter()
            if not escolha and not contagem:
                continue
            total = sum(contagem.values())
            distribuicao = [
                {
                    "categoria_id": cat,
                    "vezes": n,
                    "valor_medio": round(sum(indice["valores"][(*k, cat)]) / n, 2),
                    "ultima": indice["ultima"].get((*k, cat)),
                }
                for cat, n in sorted(contagem.items(), key=lambda kv: (-kv[1], kv[0]))[:DISTRIBUICAO_MAX]
            ]
            pelo = "cnpj" if not chave.startswith("nome:") else "nome"
            if escolha:
                return {"categoria_id": escolha["categoria_id"], "nivel": "painel", "pelo": pelo, "vezes_tiny": total,
                        "distribuicao": distribuicao}
            topo = distribuicao[0]
            dominante = total >= MIN_VEZES and topo["vezes"] / total >= DOMINANTE
            return {"categoria_id": topo["categoria_id"], "nivel": "tiny" if dominante else "tiny_fraco", "pelo": pelo,
                    "vezes_tiny": total, "distribuicao": distribuicao}
        return None

    def confirmadas(self, depois_de: int, limite: int) -> Tuple[List[Dict[str, Any]], int, bool]:
        """Registros com seq > depois_de, em ordem: (página, último seq, fim)."""
        with self._lock:
            novos = sorted((r for r in self.ler()["registros"].values() if int(r["seq"]) > depois_de), key=lambda r: r["seq"])
        pagina = novos[:limite]
        return [dict(r) for r in pagina], (int(pagina[-1]["seq"]) if pagina else depois_de), len(novos) <= limite

    def resumo(self) -> Dict[str, Any]:
        dados = self.ler()
        por_fonte: Counter = Counter()
        por_empresa: Counter = Counter()
        for r in dados["registros"].values():
            por_fonte[r["fonte"]] += 1
            por_empresa[r["empresa"]] += 1
        return {"registros": dict(por_fonte), "por_empresa": dict(por_empresa), "atualizado_tiny": dados.get("atualizado_tiny") or {}}


def qwen_do_boleto(b: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Sugestão do Qwen gravada no boleto, se for da versão atual dele."""
    q = b.get("qwen") or {}
    if q.get("versao") == versao_boleto(b) and q.get("categoria_id") and q.get("confianca") in CONFIANCAS_QWEN:
        return q
    return None


def sugestao_boleto(b: Dict[str, Any], historico: HistoricoCategorias) -> Optional[Dict[str, Any]]:
    """Categoria pré-selecionada do boleto sem conta (precedência no docstring do módulo)."""
    hist = historico.historico_boleto(b)
    qwen = qwen_do_boleto(b)
    alternativas = {
        "historico": {k: hist[k] for k in ("categoria_id", "nivel", "vezes_tiny")} if hist else None,
        "qwen": {"categoria_id": qwen["categoria_id"], "confianca": qwen["confianca"]} if qwen else None,
    }
    escolha: Optional[Dict[str, Any]] = None
    if hist and hist["nivel"] in ("painel", "tiny"):
        escolha = {"categoria_id": hist["categoria_id"], "origem": "historico", "nivel": hist["nivel"]}
    elif qwen and qwen["confianca"] != "baixa":
        escolha = {"categoria_id": qwen["categoria_id"], "origem": "qwen", "confianca": qwen["confianca"], "motivo": qwen.get("motivo")}
    elif hist:
        escolha = {"categoria_id": hist["categoria_id"], "origem": "historico", "nivel": hist["nivel"]}
    elif qwen:
        escolha = {"categoria_id": qwen["categoria_id"], "origem": "qwen", "confianca": qwen["confianca"], "motivo": qwen.get("motivo")}
    if escolha is None:
        return None
    if hist:
        escolha["distribuicao"] = hist["distribuicao"]
        escolha["vezes_tiny"] = hist["vezes_tiny"]
    escolha["alternativas"] = alternativas
    return escolha


historico = HistoricoCategorias()


def coletar_lancamento(item: Dict[str, Any], categoria_id: str, categoria_nome: str, categoria_grupo: str) -> Optional[Dict[str, Any]]:
    """Item de GET /caixa (tipo D) no formato de registrar_lancamentos_tiny, ou None."""
    if item.get("tipo") != "D" or not item.get("id"):
        return None
    contato = item.get("contato") if isinstance(item.get("contato"), dict) else {}
    cnpj, nome = _digitos(contato.get("cpfCnpj")), str(contato.get("nome") or "")
    if not cnpj and not nome:
        return None
    data = str(item.get("data") or "")[:10]
    try:
        date.fromisoformat(data)
    except ValueError:
        return None
    return {
        "id": item["id"], "data": data, "valor": item.get("valor"), "historico": item.get("historico"),
        "categoria_id": categoria_id, "categoria_nome": categoria_nome, "categoria_grupo": categoria_grupo,
        "fornecedor_cnpj": cnpj, "fornecedor_nome": nome,
    }
