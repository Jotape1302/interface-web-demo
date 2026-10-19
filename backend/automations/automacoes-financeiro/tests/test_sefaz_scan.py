import base64
import gzip
import json
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.config import settings
from app.nfe_client import DistNsuResult, NFeProviderError, SefazA1Provider, SefazDocEntry, parse_res_nfe
from app import sefaz_scan
from app.sefaz_scan import CnpjScanResult, _handle_doc, _scan_one_cnpj, run_daily_scan

SAMPLE_PROC_NFE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe35230912345678000123550010000001231000000123" versao="4.00">
      <ide>
        <nNF>123456</nNF>
        <dhEmi>2026-09-10T14:30:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>98765432000109</CNPJ>
        <xNome>DISTRIBUIDORA DE ALIMENTOS EXEMPLO LTDA</xNome>
      </emit>
      <dest>
        <CNPJ>12345678000195</CNPJ>
        <xNome>NORVIA LTDA</xNome>
      </dest>
      <total>
        <ICMSTot>
          <vNF>2400.00</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
</nfeProc>
"""

SAMPLE_RES_NFE_XML = """<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <chNFe>35230999999999000199650010000009999000000999</chNFe>
  <CNPJ>99887766000111</CNPJ>
  <xNome>FORNECEDOR RESUMO LTDA</xNome>
  <IE>123456789</IE>
  <dhEmi>2026-09-11T10:00:00-03:00</dhEmi>
  <tpNF>0</tpNF>
  <vNF>158.45</vNF>
  <cSitNFe>1</cSitNFe>
</resNFe>"""

SAMPLE_RES_NFE_CANCELADA_XML = (
    SAMPLE_RES_NFE_XML
    .replace("<cSitNFe>1</cSitNFe>", "<cSitNFe>2</cSitNFe>")
    .replace("35230999999999000199650010000009999000000999", "35230999999999000199650010000009999000000888")
)

SAMPLE_RES_EVENTO_XML = """<resEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <chNFe>35230912345678000123550010000001231000000123</chNFe>
  <tpEvento>110111</tpEvento>
</resEvento>"""


def _gzip_b64(xml: str) -> str:
    return base64.b64encode(gzip.compress(xml.encode("utf-8"))).decode("utf-8")


def _build_lote_response(cstat: str, ult_nsu: str, max_nsu: str, docs: list[tuple[str, str, str]]) -> str:
    doc_zips = "\n".join(
        f'<docZip NSU="{nsu}" schema="{schema}">{_gzip_b64(xml)}</docZip>' for nsu, schema, xml in docs
    )
    return f"""<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
      <cStat>{cstat}</cStat>
      <xMotivo>Documento(s) localizado(s)</xMotivo>
      <ultNSU>{ult_nsu}</ultNSU>
      <maxNSU>{max_nsu}</maxNSU>
      <loteDistDFeInt>
        {doc_zips}
      </loteDistDFeInt>
    </retDistDFeInt>
  </soap:Body>
</soap:Envelope>"""


def test_parse_res_nfe_extracts_fields():
    summary = parse_res_nfe(SAMPLE_RES_NFE_XML)
    assert summary.chave == "35230999999999000199650010000009999000000999"
    assert summary.cnpj_emit == "99887766000111"
    assert summary.nome_emit == "FORNECEDOR RESUMO LTDA"
    assert summary.v_nf == Decimal("158.45")
    assert summary.c_sit_nfe == "1"
    assert summary.tp_nf == "0"


def test_consultar_distribuicao_nsu_parses_lote_and_pagination_fields():
    provider = SefazA1Provider(cert_path=Path("cert.pem"), cnpj="12345678000195", uf="SP")
    soap_response = _build_lote_response(
        cstat="138",
        ult_nsu="000000000000005",
        max_nsu="000000000000010",
        docs=[("000000000000005", "procNFe_v4.00.xsd", SAMPLE_PROC_NFE_XML)],
    )

    with patch.object(provider, "_prepare_certificates", return_value=("mock_cert.pem", "mock_key.pem")), \
         patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = soap_response
        mock_post.return_value = mock_resp

        result: DistNsuResult = provider.consultar_distribuicao_nsu("0")

    assert result.c_stat == "138"
    assert result.ult_nsu == "000000000000005"
    assert result.max_nsu == "000000000000010"
    assert len(result.docs) == 1
    assert isinstance(result.docs[0], SefazDocEntry)
    assert "DISTRIBUIDORA DE ALIMENTOS" in result.docs[0].xml_content


def test_handle_doc_classifies_proc_nfe_res_nfe_and_resevento():
    provider = SefazA1Provider(cert_path=Path("cert.pem"), cnpj="12345678000195", uf="SP")
    seen_keys: set[str] = set()

    result = CnpjScanResult(cnpj=provider.cnpj)
    _handle_doc(SefazDocEntry(nsu="1", schema="procNFe_v4.00.xsd", xml_content=SAMPLE_PROC_NFE_XML), provider, seen_keys, result)
    assert len(result.novas_notas) == 1
    assert result.novas_notas[0].nfe_data.chave == "35230912345678000123550010000001231000000123"
    assert result.novas_notas[0].nfe_data.destinatario_cnpj == "12345678000195"

    result2 = CnpjScanResult(cnpj="99887766000111")
    _handle_doc(SefazDocEntry(nsu="2", schema="resNFe_v1.01.xsd", xml_content=SAMPLE_RES_NFE_XML), provider, seen_keys, result2)
    assert len(result2.novas_notas) == 1
    assert result2.novas_notas[0].nfe_data.valor_total == Decimal("158.45")

    result3 = CnpjScanResult(cnpj=provider.cnpj)
    _handle_doc(SefazDocEntry(nsu="3", schema="resNFe_v1.01.xsd", xml_content=SAMPLE_RES_NFE_CANCELADA_XML), provider, seen_keys, result3)
    assert result3.novas_notas == []
    assert result3.canceladas_ignoradas == 1

    result4 = CnpjScanResult(cnpj=provider.cnpj)
    _handle_doc(SefazDocEntry(nsu="4", schema="resEvento_v1.01.xsd", xml_content=SAMPLE_RES_EVENTO_XML), provider, seen_keys, result4)
    assert result4.novas_notas == []
    assert result4.eventos_ignorados == 1


def test_handle_doc_skips_already_seen_chave():
    provider = SefazA1Provider(cert_path=Path("cert.pem"), cnpj="12345678000195", uf="SP")
    seen_keys = {"35230912345678000123550010000001231000000123"}
    result = CnpjScanResult(cnpj=provider.cnpj)

    _handle_doc(SefazDocEntry(nsu="1", schema="procNFe_v4.00.xsd", xml_content=SAMPLE_PROC_NFE_XML), provider, seen_keys, result)

    assert result.novas_notas == []
    assert result.duplicadas_ignoradas == 1


def test_scan_one_cnpj_paginates_until_no_more_documents(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    monkeypatch.setattr(sefaz_scan.time, "sleep", lambda s: None)

    provider = MagicMock()
    provider.cnpj = "12345678000195"
    provider.consultar_distribuicao_nsu.side_effect = [
        DistNsuResult(
            c_stat="138", x_motivo="ok", ult_nsu="000000000000001", max_nsu="000000000000002",
            docs=[SefazDocEntry(nsu="1", schema="procNFe_v4.00.xsd", xml_content=SAMPLE_PROC_NFE_XML)],
        ),
        DistNsuResult(c_stat="137", x_motivo="Nenhum documento localizado", ult_nsu="000000000000002", max_nsu="000000000000002", docs=[]),
    ]

    result = _scan_one_cnpj(provider, set(), settings)

    assert len(result.novas_notas) == 1
    assert result.erro is None
    assert provider.consultar_distribuicao_nsu.call_count == 2

    saved_state = json.loads((tmp_path / "data" / "sefaz_nsu_state.json").read_text(encoding="utf-8"))
    assert saved_state["12345678000195"] == "000000000000002"


def test_scan_one_cnpj_saves_nsu_and_cooldown_on_cstat_656(tmp_path, monkeypatch):
    """Quando a SEFAZ retorna cStat 656 (Consumo Indevido), salva ultNSU/maxNSU retornados e entra em cooldown de 1h."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    provider = MagicMock()
    provider.cnpj = "36592814000100"
    provider.consultar_distribuicao_nsu.return_value = DistNsuResult(
        c_stat="656",
        x_motivo="Rejeicao: Consumo Indevido (Deve ser utilizado o ultNSU nas solicitacoes subsequentes. Tente apos 1 hora)",
        ult_nsu="000000000000450",
        max_nsu="000000000000450",
        docs=[],
    )

    result = _scan_one_cnpj(provider, set(), settings)

    assert result.status == "cooldown"
    assert result.erro is None
    assert result.ult_nsu_final == "000000000000450"
    assert result.cooldown_seconds_remaining == sefaz_scan.SCAN_COOLDOWN_SECONDS

    saved_state = json.loads((tmp_path / "data" / "sefaz_nsu_state.json").read_text(encoding="utf-8"))
    assert saved_state["36592814000100"] == "000000000000450"

    cooldown_state = json.loads((tmp_path / "data" / "sefaz_cooldown_state.json").read_text(encoding="utf-8"))
    assert "36592814000100" in cooldown_state


def test_scan_one_cnpj_skips_when_in_cooldown(tmp_path, monkeypatch):
    """Se o CNPJ estiver em cooldown preventivo, a chamada à SEFAZ é pulada para não reiniciar bloqueio."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    sefaz_scan.save_cnpj_cooldown("27184930000280", 1800, settings)

    provider = MagicMock()
    provider.cnpj = "27184930000280"

    result = _scan_one_cnpj(provider, set(), settings)

    assert result.status == "cooldown"
    assert result.cooldown_seconds_remaining > 0
    provider.consultar_distribuicao_nsu.assert_not_called()


def test_scan_one_cnpj_force_bypasses_cooldown(tmp_path, monkeypatch):
    """Com force=True, o cooldown é ignorado e a SEFAZ é consultada."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    sefaz_scan.save_cnpj_cooldown("27184930000280", 1800, settings)

    provider = MagicMock()
    provider.cnpj = "27184930000280"
    provider.consultar_distribuicao_nsu.return_value = DistNsuResult(
        c_stat="137", x_motivo="Nenhum documento", ult_nsu="0", max_nsu="0", docs=[]
    )

    result = _scan_one_cnpj(provider, set(), settings, force=True)

    assert result.status == "ok"
    provider.consultar_distribuicao_nsu.assert_called_once()



def test_scan_one_cnpj_pauses_between_pages(tmp_path, monkeypatch):
    """Páginas seguidas do MESMO CNPJ pausam entre si (incidente 2026-09-18: Curitiba
    seguiu recebendo cStat 656 mesmo já com pausa entre CNPJs — faltava entre páginas)."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    sleep_calls = []
    monkeypatch.setattr(sefaz_scan.time, "sleep", lambda s: sleep_calls.append(s))

    provider = MagicMock()
    provider.cnpj = "12345678000195"
    provider.consultar_distribuicao_nsu.side_effect = [
        DistNsuResult(
            c_stat="138", x_motivo="ok", ult_nsu="000000000000001", max_nsu="000000000000003",
            docs=[SefazDocEntry(nsu="1", schema="procNFe_v4.00.xsd", xml_content=SAMPLE_PROC_NFE_XML)],
        ),
        DistNsuResult(c_stat="137", x_motivo="Nenhum documento localizado", ult_nsu="000000000000003", max_nsu="000000000000003", docs=[]),
    ]

    _scan_one_cnpj(provider, set(), settings)

    assert sleep_calls == [sefaz_scan.INTER_PAGE_DELAY_SECONDS]


def test_scan_one_cnpj_records_error_without_raising(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    provider = MagicMock()
    provider.cnpj = "12345678000195"
    provider.consultar_distribuicao_nsu.side_effect = NFeProviderError("Falha de comunicação com WebService SEFAZ (distNSU)")

    result = _scan_one_cnpj(provider, set(), settings)

    assert result.novas_notas == []
    assert "Falha de comunicação" in result.erro


def test_run_daily_scan_stages_new_note_and_persists_status(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    fake_provider = MagicMock()
    fake_provider.cnpj = "12345678000195"
    fake_provider.consultar_distribuicao_nsu.side_effect = [
        DistNsuResult(
            c_stat="138", x_motivo="ok", ult_nsu="000000000000001", max_nsu="000000000000001",
            docs=[SefazDocEntry(nsu="1", schema="procNFe_v4.00.xsd", xml_content=SAMPLE_PROC_NFE_XML)],
        ),
    ]

    with patch.object(sefaz_scan, "_resolve_providers", return_value=[fake_provider]):
        summary = run_daily_scan(settings)

    assert summary.total_novas_notas == 1
    assert list((tmp_path / "pending_review").glob("*.review.json"))

    seen_keys = json.loads((tmp_path / "data" / "sefaz_seen_keys.json").read_text(encoding="utf-8"))
    assert "35230912345678000123550010000001231000000123" in seen_keys

    status_payload = json.loads((tmp_path / "data" / "sefaz_scan_status.json").read_text(encoding="utf-8"))
    assert status_payload["total_novas_notas"] == 1
    assert status_payload["cnpjs"][0]["cnpj"] == "12345678000195"
    assert status_payload["cnpjs"][0]["status"] == "ok"


def test_run_daily_scan_skips_when_already_running(tmp_path, monkeypatch):
    """
    Se o usuário clicar 'Rodar Varredura Agora' de novo depois de um timeout HTTP
    (ex: 504 do proxy) enquanto a varredura anterior ainda está rodando em background,
    o cooldown normal (baseado em last_scan_finished_at, só gravado ao final) não pega
    esse caso. A trava de concorrência (_scan_lock) deve pular a segunda chamada.
    """
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    fake_provider = MagicMock()
    fake_provider.cnpj = "12345678000195"

    assert sefaz_scan._scan_lock.acquire(blocking=False)
    try:
        with patch.object(sefaz_scan, "_resolve_providers", return_value=[fake_provider]):
            summary = run_daily_scan(settings)
    finally:
        sefaz_scan._scan_lock.release()

    assert summary.resultados == []
    fake_provider.consultar_distribuicao_nsu.assert_not_called()
    assert not (tmp_path / "data" / "sefaz_scan_status.json").exists()


def test_run_daily_scan_pauses_between_multiple_cnpjs(tmp_path, monkeypatch):
    """
    Matriz e filial (ex: Campinas/Curitiba) usam o mesmo certificado físico — só o
    CNPJ do corpo da consulta muda. Consultar os dois sem pausa suspeita-se de contar
    como uso repetido do mesmo certificado para a SEFAZ (cStat 656, incidente 2026-09-18).
    Garante que run_daily_scan pausa entre CNPJs (exceto antes do primeiro).
    """
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    def make_provider(cnpj: str) -> MagicMock:
        provider = MagicMock()
        provider.cnpj = cnpj
        provider.consultar_distribuicao_nsu.return_value = DistNsuResult(
            c_stat="137", x_motivo="nada novo", ult_nsu="0", max_nsu="0", docs=[],
        )
        return provider

    providers = [make_provider("27184930000107"), make_provider("27184930000280")]
    sleep_calls = []
    monkeypatch.setattr(sefaz_scan.time, "sleep", lambda s: sleep_calls.append(s))

    with patch.object(sefaz_scan, "_resolve_providers", return_value=providers):
        run_daily_scan(settings)

    assert sleep_calls == [sefaz_scan.INTER_CNPJ_DELAY_SECONDS]


def test_handle_doc_identifies_and_separates_campinas_and_curitiba():
    xml_campinas = """<?xml version="1.0" encoding="UTF-8"?>
    <nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
      <NFe>
        <infNFe Id="NFe35230927184930000107550010000001231000000120" versao="4.00">
          <ide><nNF>101</nNF><dhEmi>2026-09-10T14:30:00-03:00</dhEmi></ide>
          <emit><CNPJ>98765432000109</CNPJ><xNome>FORNECEDOR LTDA</xNome></emit>
          <dest><CNPJ>27184930000107</CNPJ><xNome>NORVIA MATRIZ</xNome></dest>
          <total><ICMSTot><vNF>500.00</vNF></ICMSTot></total>
        </infNFe>
      </NFe>
    </nfeProc>"""

    xml_curitiba = """<?xml version="1.0" encoding="UTF-8"?>
    <nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
      <NFe>
        <infNFe Id="NFe41230927184930000280550010000004561000000450" versao="4.00">
          <ide><nNF>102</nNF><dhEmi>2026-09-10T14:30:00-03:00</dhEmi></ide>
          <emit><CNPJ>98765432000109</CNPJ><xNome>FORNECEDOR LTDA</xNome></emit>
          <dest><CNPJ>27184930000280</CNPJ><xNome>NORVIA ACABAMENTOS QUALQUER</xNome></dest>
          <total><ICMSTot><vNF>750.00</vNF></ICMSTot></total>
        </infNFe>
      </NFe>
    </nfeProc>"""

    xml_emissao_propria_cliente_externo = """<?xml version="1.0" encoding="UTF-8"?>
    <nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
      <NFe>
        <infNFe Id="NFe35230927184930000107550010000007891000000787" versao="4.00">
          <ide><nNF>103</nNF><dhEmi>2026-09-10T14:30:00-03:00</dhEmi></ide>
          <emit><CNPJ>27184930000107</CNPJ><xNome>NORVIA ACABAMENTOS</xNome></emit>
          <dest><CNPJ>11111111000111</CNPJ><xNome>CLIENTE FINAL LTDA</xNome></dest>
          <total><ICMSTot><vNF>900.00</vNF></ICMSTot></total>
        </infNFe>
      </NFe>
    </nfeProc>"""

    prov_campinas = SefazA1Provider(cert_path=Path("cert.pem"), cnpj="27184930000107", uf="SP")
    prov_curitiba = SefazA1Provider(cert_path=Path("cert.pem"), cnpj="27184930000280", uf="PR")

    seen_keys: set[str] = set()

    # 1. Nota Campinas via provider Campinas
    res_g = CnpjScanResult(cnpj=prov_campinas.cnpj)
    _handle_doc(SefazDocEntry(nsu="1", schema="procNFe", xml_content=xml_campinas), prov_campinas, seen_keys, res_g)
    assert len(res_g.novas_notas) == 1
    assert res_g.novas_notas[0].nfe_data.destinatario_cnpj == "27184930000107"
    assert res_g.novas_notas[0].nfe_data.destinatario_nome == "NORVIA ACABAMENTOS LTDA (CAMPINAS)"

    # 2. Nota Curitiba via provider Curitiba
    res_l = CnpjScanResult(cnpj=prov_curitiba.cnpj)
    _handle_doc(SefazDocEntry(nsu="2", schema="procNFe", xml_content=xml_curitiba), prov_curitiba, seen_keys, res_l)
    assert len(res_l.novas_notas) == 1
    assert res_l.novas_notas[0].nfe_data.destinatario_cnpj == "27184930000280"
    assert res_l.novas_notas[0].nfe_data.destinatario_nome == "NORVIA ACABAMENTOS LTDA (CURITIBA)"

    # 3. Nota Curitiba interceptada via provider Matriz Campinas (não é descartada!)
    seen_keys_cross: set[str] = set()
    res_cross = CnpjScanResult(cnpj=prov_campinas.cnpj)
    _handle_doc(SefazDocEntry(nsu="3", schema="procNFe", xml_content=xml_curitiba), prov_campinas, seen_keys_cross, res_cross)
    assert len(res_cross.novas_notas) == 1
    assert res_cross.novas_notas[0].nfe_data.destinatario_cnpj == "27184930000280"
    assert res_cross.novas_notas[0].nfe_data.destinatario_nome == "NORVIA ACABAMENTOS LTDA (CURITIBA)"

    # 4. Nota de venda emitida por nós para cliente terceiro (descartada)
    res_saida = CnpjScanResult(cnpj=prov_campinas.cnpj)
    _handle_doc(SefazDocEntry(nsu="4", schema="procNFe", xml_content=xml_emissao_propria_cliente_externo), prov_campinas, seen_keys, res_saida)
    assert len(res_saida.novas_notas) == 0
