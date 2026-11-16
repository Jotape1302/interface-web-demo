"""
Sugestão do classificador Qwen (PC do TI) na revisão de NF-e: campos opcionais no
`.review.json`, precedência histórico × Qwen × regra, forma de pagamento determinística
(XML → histórico do fornecedor) e as rotas internas usadas pelo coletor da VPS.
"""
import json
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import category_history
from app.api import app
from app.config import settings
from app.forma_pagamento import forma_do_xml, sugerir
from app.nfe_client import NFeData, NFeXmlParser
from app.nfe_items import NFeItem
from app.review_store import get_pending, list_confirmed, stage_for_review, update_qwen_suggestions, write_record_json
from app.tiny_client import TinyContaResult

FABRILUX = "43820617000166"
NORVIA_CURITIBA = "27184930000280"
FORNECEDOR = "12345678000195"
COMPRAS = "480897321"
LIMPEZA = "701885961"
ESCRITORIO = "484437483"
CHAVE = "35261112345678000123550010000001231000000123"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    monkeypatch.setattr(settings, "ARCHIVED_DIR", tmp_path / "archived")
    monkeypatch.setattr(category_history, "_cache", {"signature": None, "index": None})
    settings.ensure_directories()
    return tmp_path


def _nfe(chave=CHAVE, dest=FABRILUX, t_pag=None, t_band=None):
    return NFeData(
        chave=chave,
        numero_nota="123",
        data_emissao=date(2026, 11, 1),
        emitente_nome="FORNECEDOR TESTE LTDA",
        emitente_cnpj=FORNECEDOR,
        valor_total=Decimal("300.00"),
        destinatario_cnpj=dest,
        meio_pagamento_nfe=t_pag,
        bandeira_cartao_nfe=t_band,
    )


def _itens():
    return [
        NFeItem(item_id="1", descricao="Detergente", valor_total=Decimal("100.00"), codigo="P1", ncm="3402"),
        NFeItem(item_id="2", descricao="Papel A4", valor_total=Decimal("200.00"), codigo="P2", ncm="4802"),
    ]


def _stage(tmp_path, nfe=None, itens=None, nome="nota.xml", regra=COMPRAS):
    nfe = nfe or _nfe()
    itens = itens or _itens()
    arquivo = tmp_path / nome
    arquivo.write_bytes(b"<xml/>")
    return stage_for_review(arquivo, nfe, itens, {i.item_id: regra for i in itens})


def _confirmada(tmp_path, chave, itens_cat, forma="boleto", confirmado_em=None, ncm_por_item=None, meio=None):
    """Nota já confirmada em processed/ com as categorias escolhidas (o que o histórico lê)."""
    itens = [
        NFeItem(item_id=i, descricao="Item", valor_total=Decimal("10"), codigo=cod, ncm=(ncm_por_item or {}).get(i))
        for i, (cod, _cat) in itens_cat.items()
    ]
    record = _stage(tmp_path, _nfe(chave=chave, t_pag=meio), itens, nome=f"{chave}.xml")
    for ri in record.itens:
        ri.categoria_sugerida_id = itens_cat[ri.item_id][1]
    destino = settings.PROCESSED_DIR / record.file_path.name
    record.file_path.rename(destino)
    (record.file_path.parent / (record.file_path.name + ".review.json")).unlink()
    record.file_path = destino
    record.forma_pagamento = forma
    record.confirmado_em = confirmado_em
    write_record_json(record)
    return record


# --- review_store --------------------------------------------------------------------------


def test_review_json_antigo_sem_campos_qwen_continua_valido(dirs):
    record = _stage(dirs)
    json_path = record.file_path.with_name(record.file_path.name + ".review.json")
    payload = json.loads(json_path.read_text())
    for chave in ("qwen_modelo", "qwen_classificado_em", "confirmado_em", "forma_pagamento"):
        payload.pop(chave)
    for it in payload["itens"]:
        for chave in ("qwen_categoria_id", "qwen_confianca", "qwen_motivo"):
            it.pop(chave)
    payload["nfe_data"].pop("bandeira_cartao_nfe")
    json_path.write_text(json.dumps(payload))

    lido = get_pending(CHAVE)
    assert lido is not None
    assert lido.qwen_classificado_em is None and lido.itens[0].qwen_categoria_id is None
    assert lido.nfe_data.bandeira_cartao_nfe is None


def test_update_qwen_grava_so_na_mesma_versao_pendente(dirs):
    record = _stage(dirs)
    sug = {"1": (LIMPEZA, "alta", "detergente é limpeza")}
    assert update_qwen_suggestions(CHAVE, "outra-versao", sug, "qwen2.5:14b", "2026-11-03T10:00:00-03:00") == "desatualizada"
    assert get_pending(CHAVE).qwen_classificado_em is None

    assert update_qwen_suggestions(CHAVE, record.staged_at, sug, "qwen2.5:14b", "2026-11-03T10:00:00-03:00") == "gravado"
    lido = get_pending(CHAVE)
    assert (lido.itens[0].qwen_categoria_id, lido.itens[0].qwen_confianca, lido.itens[0].qwen_motivo) == (LIMPEZA, "alta", "detergente é limpeza")
    assert lido.itens[1].qwen_categoria_id is None
    assert lido.qwen_modelo == "qwen2.5:14b"

    assert update_qwen_suggestions("chave-inexistente", record.staged_at, sug, "m", "t") == "nao_pendente"


def test_gravacao_nao_deixa_temporario_que_pareca_review_json(dirs):
    record = _stage(dirs)
    update_qwen_suggestions(CHAVE, record.staged_at, {"1": (LIMPEZA, "alta", "")}, "m", "t")
    assert [p.name for p in settings.PENDING_REVIEW_DIR.iterdir() if p.name.endswith(".review.json")] == [
        record.file_path.name + ".review.json"
    ]
    assert not [p for p in settings.PENDING_REVIEW_DIR.iterdir() if p.name.endswith(".tmp")]


# --- forma de pagamento -----------------------------------------------------------------


@pytest.mark.parametrize(
    "t_pag,t_band,dest,esperado",
    [
        ("17", None, FABRILUX, "pix"),
        ("15", None, FABRILUX, "boleto"),
        ("03", "02", FABRILUX, "clara"),
        ("04", "06", FABRILUX, "caixa_elo"),
        ("03", "01", NORVIA_CURITIBA, "caixa_visa_norvia"),
        ("03", "01", FABRILUX, "caixa_visa"),
        ("03", None, FABRILUX, None),  # cartão sem bandeira: o XML não crava
        ("03", "03", FABRILUX, None),  # bandeira sem forma correspondente
        ("01", None, FABRILUX, None),  # dinheiro
        (None, None, FABRILUX, None),
    ],
)
def test_forma_do_xml(t_pag, t_band, dest, esperado):
    assert forma_do_xml(t_pag, t_band, dest) == esperado


def test_sugerir_forma_xml_vence_historico_e_sem_nada_deixa_a_regra_do_painel():
    assert sugerir("17", None, FABRILUX, "boleto") == ("pix", "xml")
    assert sugerir("03", None, FABRILUX, "clara") == ("clara", "historico")
    assert sugerir(None, None, FABRILUX, None) == (None, None)


def test_xml_extrai_bandeira_do_cartao():
    xml = """<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe{chave}">
      <ide><nNF>9</nNF><dhEmi>2026-11-01T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>{forn}</CNPJ><xNome>F</xNome></emit><dest><CNPJ>{dest}</CNPJ><xNome>D</xNome></dest>
      <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
      <pag><detPag><tPag>03</tPag><vPag>10.00</vPag><card><tpIntegra>2</tpIntegra><tBand>02</tBand></card></detPag></pag>
    </infNFe></NFe><protNFe><infProt><chNFe>{chave}</chNFe></infProt></protNFe></nfeProc>""".format(chave=CHAVE, forn=FORNECEDOR, dest=FABRILUX)
    nfe = NFeXmlParser.parse(xml, CHAVE)
    assert (nfe.meio_pagamento_nfe, nfe.bandeira_cartao_nfe) == ("03", "02")


# --- precedência na tela ------------------------------------------------------------------


def _tela(client):
    resp = client.get("/api/v1/danfe/pending-review")
    assert resp.status_code == 200
    return {i["item_id"]: i for i in resp.json()["pending"][0]["itens"]}, resp.json()["pending"][0]


def test_codigo_e_ncm_do_historico_vencem_qwen_alta(client, dirs):
    _confirmada(dirs, "A" * 44, {"1": ("P1", ESCRITORIO), "9": ("OUTRO", ESCRITORIO)}, ncm_por_item={"9": "4802"})
    record = _stage(dirs)
    update_qwen_suggestions(CHAVE, record.staged_at, {"1": (LIMPEZA, "alta", "x"), "2": (LIMPEZA, "alta", "y")}, "m", "t")

    itens, _ = _tela(client)
    assert (itens["1"]["categoria_sugerida_id"], itens["1"]["categoria_sugerida_origem"], itens["1"]["categoria_sugerida_nivel"]) == (ESCRITORIO, "historico", "codigo")
    assert (itens["2"]["categoria_sugerida_id"], itens["2"]["categoria_sugerida_nivel"]) == (ESCRITORIO, "ncm")
    assert itens["1"]["categoria_sugerida_confianca"] is None


def test_qwen_media_vence_historico_so_do_fornecedor_e_baixa_nao(client, dirs):
    _confirmada(dirs, "A" * 44, {"9": ("OUTRO", ESCRITORIO)})  # só o fornecedor casa
    record = _stage(dirs)
    update_qwen_suggestions(CHAVE, record.staged_at, {"1": (LIMPEZA, "media", "detergente"), "2": (LIMPEZA, "baixa", "chute")}, "m", "t")

    itens, _ = _tela(client)
    assert (itens["1"]["categoria_sugerida_id"], itens["1"]["categoria_sugerida_origem"]) == (LIMPEZA, "qwen")
    assert (itens["1"]["categoria_sugerida_confianca"], itens["1"]["categoria_sugerida_motivo"]) == ("media", "detergente")
    assert (itens["2"]["categoria_sugerida_id"], itens["2"]["categoria_sugerida_origem"], itens["2"]["categoria_sugerida_nivel"]) == (ESCRITORIO, "historico", "fornecedor")


def test_sem_historico_qwen_baixa_vence_regra_e_id_fora_do_catalogo_e_ignorado(client, dirs):
    record = _stage(dirs)
    update_qwen_suggestions(CHAVE, record.staged_at, {"1": (LIMPEZA, "baixa", "talvez"), "2": ("999", "alta", "inventado")}, "m", "t")

    itens, _ = _tela(client)
    assert (itens["1"]["categoria_sugerida_id"], itens["1"]["categoria_sugerida_origem"]) == (LIMPEZA, "qwen")
    assert (itens["2"]["categoria_sugerida_id"], itens["2"]["categoria_sugerida_origem"]) == (COMPRAS, "regra")


def test_forma_pagamento_sugerida_na_tela(client, dirs):
    _confirmada(dirs, "A" * 44, {"9": ("OUTRO", ESCRITORIO)}, forma="caixa_elo")
    _stage(dirs, _nfe(t_pag="03"))
    _, nota = _tela(client)
    assert (nota["forma_pagamento_sugerida"], nota["forma_pagamento_origem"]) == ("caixa_elo", "historico")
    assert nota["meio_pagamento_nfe_historico"] is None


def test_meio_de_pagamento_nfe_do_historico_e_o_ultimo_lancado_com_o_fornecedor(client, dirs):
    _confirmada(dirs, "A" * 44, {"9": ("OUTRO", ESCRITORIO)}, meio="17", confirmado_em="2026-10-01T10:00:00")
    _confirmada(dirs, "B" * 44, {"9": ("OUTRO", ESCRITORIO)}, meio="04", confirmado_em="2026-10-02T10:00:00")
    _stage(dirs, _nfe(t_pag="99"))
    _, nota = _tela(client)
    assert nota["meio_pagamento_nfe_historico"] == "04"


def test_notas_confirmadas_mantem_a_escolha_humana_como_regra(client, dirs):
    _confirmada(dirs, "A" * 44, {"1": ("P1", ESCRITORIO)})
    nota = client.get("/api/v1/danfe/notas", params={"status_filter": "confirmed"}).json()["notas"][0]
    assert nota["itens"][0]["categoria_sugerida_origem"] == "regra"
    assert "forma_pagamento_sugerida" not in nota


# --- confirm-lancamento ----------------------------------------------------------------


@patch("app.routers.danfe.TinyClient")
def test_confirmacao_registra_qwen_no_treino_e_grava_pagamento_e_data(mock_tiny_class, client, dirs):
    record = _stage(dirs)
    update_qwen_suggestions(CHAVE, record.staged_at, {"1": (LIMPEZA, "alta", "detergente"), "2": (LIMPEZA, "alta", "papel?")}, "qwen2.5:14b", "t")
    mock_tiny = MagicMock()
    mock_tiny.lancar_grupo_categorizado.side_effect = lambda nfe, grupo, idx, total, **kw: TinyContaResult(
        conta_id=idx, nro_documento="123", valor=grupo.valor_total, vencimento=nfe.data_emissao, situacao="aberto", is_duplicate=False
    )
    mock_tiny_class.return_value = mock_tiny

    resp = client.post("/api/v1/danfe/confirm-lancamento", json={
        "chave": CHAVE,
        "itens": [{"item_id": "1", "categoria_id": LIMPEZA}, {"item_id": "2", "categoria_id": ESCRITORIO}],
        "forma_pagamento": "boleto",
    })
    assert resp.status_code == 200
    sugestao = resp.json()["treino"]["sugestao"]
    assert sugestao["1"]["origem"] == "qwen" and sugestao["1"]["confianca"] == "alta"
    assert sugestao["1"]["motivo"] == "detergente" and sugestao["1"]["qwen_modelo"] == "qwen2.5:14b"
    assert sugestao["2"]["alternativas"] == {"historico": None, "qwen": {"categoria_id": LIMPEZA, "confianca": "alta"}, "regra": COMPRAS}
    assert "alternativas" not in resp.json()["treino"]["contexto"]["itens"][0]

    [confirmada] = list_confirmed()
    assert confirmada.forma_pagamento == "boleto" and confirmada.confirmado_em
    assert confirmada.itens[1].categoria_sugerida_id == ESCRITORIO  # escolha humana
    assert confirmada.itens[1].qwen_categoria_id == LIMPEZA  # palpite preservado para medir acerto


# --- rotas internas do Qwen -----------------------------------------------------------


def test_pendentes_traz_catalogo_e_pula_classificadas_e_casadas_por_codigo(client, dirs):
    _confirmada(dirs, "A" * 44, {"1": ("P1", ESCRITORIO), "2": ("P2", ESCRITORIO)})
    _stage(dirs)  # os dois itens casam pelo código: o Qwen não precisa olhar
    outra = "35261112345678000123550010000009991000000999"
    rec = _stage(dirs, _nfe(chave=outra), [NFeItem(item_id="1", descricao="Novo", valor_total=Decimal("5"), codigo="NOVO")], nome="b.xml")

    corpo = client.get("/api/v1/danfe/qwen/pendentes").json()
    assert {c["id"] for c in corpo["categorias"]} >= {COMPRAS, LIMPEZA}
    assert [n["chave"] for n in corpo["notas"]] == [outra]
    item = corpo["notas"][0]["itens"][0]
    assert item["classificar"] is True and item["historico"] == {"categoria_id": ESCRITORIO, "nivel": "fornecedor"}
    assert corpo["notas"][0]["staged_at"] == rec.staged_at

    update_qwen_suggestions(outra, rec.staged_at, {"1": (LIMPEZA, "alta", "")}, "m", "t")
    assert client.get("/api/v1/danfe/qwen/pendentes").json()["notas"] == []


def test_sugestoes_valida_catalogo_item_e_versao(client, dirs):
    record = _stage(dirs)
    base = {"chave": CHAVE, "staged_at": record.staged_at, "modelo": "qwen2.5:14b"}

    fora = client.post("/api/v1/danfe/qwen/sugestoes", json={**base, "itens": [{"item_id": "1", "categoria_id": "123", "confianca": "alta"}]})
    assert fora.status_code == 422 and "123" in fora.json()["detail"]
    sem_item = client.post("/api/v1/danfe/qwen/sugestoes", json={**base, "itens": [{"item_id": "77", "categoria_id": LIMPEZA, "confianca": "alta"}]})
    assert sem_item.status_code == 422
    confianca = client.post("/api/v1/danfe/qwen/sugestoes", json={**base, "itens": [{"item_id": "1", "categoria_id": LIMPEZA, "confianca": "certeza"}]})
    assert confianca.status_code == 422
    versao = client.post("/api/v1/danfe/qwen/sugestoes", json={**base, "staged_at": "x", "itens": [{"item_id": "1", "categoria_id": LIMPEZA, "confianca": "alta"}]})
    assert versao.status_code == 409
    sumiu = client.post("/api/v1/danfe/qwen/sugestoes", json={**base, "chave": "9" * 44, "itens": []})
    assert sumiu.status_code == 404
    assert get_pending(CHAVE).qwen_classificado_em is None

    ok = client.post("/api/v1/danfe/qwen/sugestoes", json={**base, "itens": [{"item_id": "1", "categoria_id": LIMPEZA, "confianca": "alta", "motivo": "m" * 900}]})
    assert ok.status_code == 200 and ok.json()["itens"] == 1
    assert len(get_pending(CHAVE).itens[0].qwen_motivo) == 500


def test_confirmadas_recentes_pagina_pelo_cursor(client, dirs):
    _confirmada(dirs, "B" * 44, {"1": ("P1", ESCRITORIO)}, confirmado_em="2026-11-02T10:00:00-03:00")
    _confirmada(dirs, "A" * 44, {"1": ("P1", LIMPEZA)}, confirmado_em="2026-11-01T10:00:00-03:00")
    _confirmada(dirs, "C" * 44, {"1": ("P1", COMPRAS)}, confirmado_em="2026-11-02T10:00:00-03:00")

    p1 = client.get("/api/v1/danfe/qwen/confirmadas-recentes", params={"limit": 2}).json()
    assert [c["chave"][0] for c in p1["confirmadas"]] == ["A", "B"] and p1["fim"] is False
    assert p1["confirmadas"][0]["itens"][0]["categoria_id"] == LIMPEZA
    assert p1["confirmadas"][0]["forma_pagamento"] == "boleto"

    p2 = client.get("/api/v1/danfe/qwen/confirmadas-recentes", params={"limit": 2, "cursor": p1["cursor"]}).json()
    assert [c["chave"][0] for c in p2["confirmadas"]] == ["C"] and p2["fim"] is True
    p3 = client.get("/api/v1/danfe/qwen/confirmadas-recentes", params={"cursor": p2["cursor"]}).json()
    assert p3["confirmadas"] == [] and p3["cursor"] == p2["cursor"]

    assert client.get("/api/v1/danfe/qwen/confirmadas-recentes", params={"cursor": "lixo|x"}).status_code == 422


def test_rotas_qwen_exigem_chave_interna(client, dirs, monkeypatch):
    monkeypatch.setenv("INTERNAL_AUTH_DISABLED", "false")
    monkeypatch.setenv("AUTOMATIONS_INTERNAL_KEY", "k" * 40)
    assert client.get("/api/v1/danfe/qwen/pendentes").status_code == 401
    assert client.get("/api/v1/danfe/qwen/pendentes", headers={"X-Internal-Key": "k" * 40}).status_code == 200
