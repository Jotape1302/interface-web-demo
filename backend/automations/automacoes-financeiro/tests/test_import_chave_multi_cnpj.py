"""
Importação por chave no pool de CNPJs (MultiSefazA1Provider): cStat 640/137 de todos = nota de
outra empresa (422 explicando), erro de outro tipo num CNPJ aparece em vez da última resposta, e
os códigos vêm do `c_stat` da exceção, nunca do texto (a chave pode conter "632", "618"...).
"""
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.api import app
from app.nfe_client import MultiSefazA1Provider, NFeData, NFeNaoDestinadaError, NFeProviderError, nome_curto_empresa

# Emitente 76.139.148/0001-73 e, de propósito, "632" e "618" no meio dos dígitos da chave.
CHAVE = "35260976139148000173550020006326181020680908"
CNPJS = ["36592814000100", "43820617000166", "27184930000107", "27184930000280"]
REJ_640 = "SEFAZ retornou rejeição: cStat 640 - Rejeicao: CNPJ/CPF do interessado nao possui permissao para consultar esta NF-e"


def _prov(cnpj, resultado):
    prov = MagicMock()
    prov.cnpj = cnpj
    if isinstance(resultado, Exception):
        prov.get_nfe_data.side_effect = resultado
    else:
        prov.get_nfe_data.return_value = resultado
    return prov


def _pool(*resultados):
    return MultiSefazA1Provider([_prov(c, r) for c, r in zip(CNPJS, resultados)])


def test_nome_curto_empresa():
    assert [nome_curto_empresa(c) for c in CNPJS] == ["Revesta", "Fabrilux", "Norvia Campinas", "Norvia Curitiba"]
    assert nome_curto_empresa("123") == "123"


def test_todos_640_ou_137_e_nota_de_outra_empresa():
    with pytest.raises(NFeNaoDestinadaError) as exc:
        _pool(*[NFeProviderError(REJ_640, c_stat="640")] * 3, NFeProviderError("nenhum", c_stat="137")).get_nfe_data(CHAVE)
    assert exc.value.c_stat == "640" and exc.value.cnpjs == CNPJS


def test_640_nao_para_a_busca_e_o_destinatario_e_achado():
    nfe = NFeData(chave=CHAVE, numero_nota="1", data_emissao=date(2026, 9, 1), emitente_nome="F",
                  emitente_cnpj="76139148000173", valor_total=Decimal("1"))
    erro = NFeProviderError(REJ_640, c_stat="640")
    assert _pool(erro, erro, nfe, erro).get_nfe_data(CHAVE).destinatario_cnpj == "27184930000107"


def test_erro_de_outro_tipo_aparece_mesmo_nao_sendo_o_ultimo():
    with pytest.raises(NFeProviderError) as exc:
        _pool(
            NFeProviderError(REJ_640, c_stat="640"),
            NFeProviderError("SEFAZ retornou rejeição: cStat 656 - Consumo Indevido", c_stat="656"),
            NFeProviderError(REJ_640, c_stat="640"),
            NFeProviderError(REJ_640, c_stat="640"),
        ).get_nfe_data(CHAVE)
    assert not isinstance(exc.value, NFeNaoDestinadaError)
    assert exc.value.c_stat == "656"
    assert "Fabrilux: SEFAZ retornou rejeição: cStat 656" in str(exc.value)
    assert "640" not in str(exc.value)


def test_digitos_da_chave_nao_disparam_tratamento_de_codigo():
    """Antes, '618' no texto (a chave vem na mensagem do 137) virava NFC-e montada da chave."""
    sem_doc = NFeProviderError(f"Nenhum documento retornado pela SEFAZ para a chave {CHAVE} (cStat 137 - x).", c_stat="137")
    with pytest.raises(NFeNaoDestinadaError):
        _pool(sem_doc, sem_doc, sem_doc, sem_doc).get_nfe_data(CHAVE)


@patch("app.routers.danfe.get_nfe_provider")
def test_import_key_explica_a_nota_de_outra_empresa(mock_factory):
    mock_factory.return_value = _pool(*[NFeProviderError(REJ_640, c_stat="640")] * 4)
    res = TestClient(app).post("/api/v1/danfe/import-key", json={"chave": CHAVE})
    assert res.status_code == 422
    detalhe = res.json()["detail"]
    assert "Revesta, Fabrilux, Norvia Campinas, Norvia Curitiba" in detalhe
    assert "76.139.148/0001-73" in detalhe and "Upload Manual" in detalhe
    assert "mais de 90 dias" not in detalhe


@patch("app.routers.danfe.get_nfe_provider")
def test_import_key_632_so_pelo_codigo(mock_factory):
    prov = MagicMock()
    prov.get_nfe_data.side_effect = NFeProviderError(f"Falha qualquer na chave {CHAVE}")
    mock_factory.return_value = prov
    res = TestClient(app).post("/api/v1/danfe/import-key", json={"chave": CHAVE})
    assert res.status_code == 502 and "90 dias" not in res.json()["detail"]


@patch("app.routers.danfe.get_nfe_provider")
def test_import_key_656_vira_422_em_warning(mock_factory, caplog):
    """Limite de consultas da SEFAZ: 422 explicando e log em WARNING (ERROR viraria incidente)."""
    rej_656 = "SEFAZ retornou rejeição: cStat 656 - Rejeicao: Consumo Indevido (Ultrapassou o limite de 20 consultas por hora)"
    mock_factory.return_value = _pool(*[NFeProviderError(rej_656, c_stat="656")] * 4)
    with caplog.at_level("WARNING"):
        res = TestClient(app).post("/api/v1/danfe/import-key", json={"chave": CHAVE})
    assert res.status_code == 422
    detalhe = res.json()["detail"]
    assert "cStat 656, limite de 20 por hora" in detalhe and "Upload Manual" in detalhe
    import_key = [r for r in caplog.records if "[IMPORT_KEY]" in r.getMessage()]
    assert not [r for r in import_key if r.levelname == "ERROR"]
    assert [r for r in import_key if r.levelname == "WARNING"]
