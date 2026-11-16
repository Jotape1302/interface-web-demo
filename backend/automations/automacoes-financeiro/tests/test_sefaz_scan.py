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
    assert result.recusado is True
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
    assert result.consultado is False
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
        <infNFe Id="NFe35230927184930000107550010000001231000000123" versao="4.00">
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
        <infNFe Id="NFe41230927184930000280550010000004561000000456" versao="4.00">
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


def test_nova_tentativa_no_mesmo_dia_para_cnpj_recusado(tmp_path):
    """10/11: 3 dos 4 CNPJs recusados (cStat 656) às 06h só eram consultados de novo no dia seguinte."""
    cfg = settings.model_copy(update={"DATA_DIR": tmp_path})
    ok = CnpjScanResult(cnpj="11111111000111", status="ok")
    recusado = CnpjScanResult(cnpj="22222222000122", status="cooldown")
    com_erro = CnpjScanResult(cnpj="33333333000133", status="erro", erro="timeout")
    resumo = lambda *r: sefaz_scan.SefazScanSummary(started_at="", finished_at="", resultados=list(r))  # noqa: E731

    assert sefaz_scan.segundos_ate_nova_tentativa(resumo(ok), cfg) is None
    sefaz_scan.save_cnpj_cooldown(recusado.cnpj, sefaz_scan.SCAN_COOLDOWN_SECONDS, cfg)
    espera = sefaz_scan.segundos_ate_nova_tentativa(resumo(ok, recusado), cfg)
    assert sefaz_scan.SCAN_COOLDOWN_SECONDS < espera <= sefaz_scan.SCAN_COOLDOWN_SECONDS + sefaz_scan.MARGEM_RETENTATIVA_SECONDS
    # Erro sem cooldown: tenta de novo em 10 min, mais a margem.
    assert sefaz_scan.segundos_ate_nova_tentativa(resumo(com_erro), cfg) == 600 + sefaz_scan.MARGEM_RETENTATIVA_SECONDS


def test_parcelas_do_xml_da_nfe():
    from app.nfe_client import NFeXmlParser
    com_dup = SAMPLE_PROC_NFE_XML.replace(
        "<total>",
        "<cobr><dup><nDup>001</nDup><dVenc>2026-10-10</dVenc><vDup>800.00</vDup></dup>"
        "<dup><nDup>002</nDup><dVenc>2026-11-10</dVenc><vDup>800.00</vDup></dup>"
        "<dup><nDup>003</nDup><dVenc>2026-12-10</dVenc><vDup>800.00</vDup></dup></cobr><total>",
    )
    chave = "35230912345678000123550010000001231000000123"
    assert NFeXmlParser.parse(com_dup, chave).parcelas_nfe == 3
    assert NFeXmlParser.parse(SAMPLE_PROC_NFE_XML, chave).parcelas_nfe is None


def test_nsu_pulado_no_656_e_recuperado_por_cons_nsu(tmp_path, monkeypatch):
    """10/11: a SEFAZ recusava (656 "Deve ser utilizado o ultNSU") e o cursor pulava sem receber
    os documentos do intervalo. Eles vão para a fila e voltam por consNSU na rodada seguinte."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    cnpj = "36592814000100"
    sefaz_scan.save_nsu_checkpoint(cnpj, "000000000000100", settings)

    provider = MagicMock()
    provider.cnpj = cnpj
    provider.consultar_distribuicao_nsu.return_value = DistNsuResult(
        c_stat="656", x_motivo="Consumo Indevido", ult_nsu="000000000000103", max_nsu="000000000000000", docs=[])
    result = _scan_one_cnpj(provider, set(), settings)
    assert result.status == "cooldown" and result.nsu_pendentes == 3
    assert sefaz_scan.load_nsu_pendentes(cnpj, settings) == [101, 102, 103]
    resumo = sefaz_scan.SefazScanSummary(started_at="", finished_at="", resultados=[result])
    assert sefaz_scan.segundos_ate_nova_tentativa(resumo, settings) is not None

    # Rodada seguinte: 101 traz uma nota, 102 não existe mais, 103 é recusado e fica na fila.
    sefaz_scan.clear_cnpj_cooldown(cnpj, settings)
    monkeypatch.setattr(sefaz_scan, "already_launched_in_tiny", lambda nfe: False)
    monkeypatch.setattr(sefaz_scan.time, "sleep", lambda s: None)
    nota = SAMPLE_PROC_NFE_XML.replace("12345678000195", cnpj)
    respostas = {
        "101": DistNsuResult(c_stat="138", x_motivo="ok", ult_nsu="101", max_nsu="103",
                             docs=[SefazDocEntry(nsu="101", schema="procNFe_v4.00.xsd", xml_content=nota)]),
        "102": DistNsuResult(c_stat="137", x_motivo="nenhum", ult_nsu="102", max_nsu="103", docs=[]),
        "103": DistNsuResult(c_stat="656", x_motivo="Consumo Indevido", ult_nsu="103", max_nsu="103", docs=[]),
    }
    provider.consultar_nsu.side_effect = lambda nsu: respostas[nsu]
    provider.consultar_distribuicao_nsu.reset_mock()
    result = _scan_one_cnpj(provider, set(), settings)
    assert len(result.novas_notas) == 1 and result.nsu_recuperados == 2
    assert result.status == "cooldown" and result.nsu_pendentes == 1
    assert sefaz_scan.load_nsu_pendentes(cnpj, settings) == [103]
    provider.consultar_distribuicao_nsu.assert_not_called()


def test_envelope_cons_nsu():
    provider = SefazA1Provider(cert_path="x.pfx", cert_password="x", cnpj="36592814000100", uf="SP")
    xml = provider._build_dist_nsu_envelope("101", especifico=True)
    assert "<consNSU>" in xml and "<NSU>000000000000101</NSU>" in xml and "<distNSU>" not in xml
    assert "<ultNSU>000000000000101</ultNSU>" in provider._build_dist_nsu_envelope("101")


def _doc_historico(cnpj, n):
    data = f"2026-08-{n - 18:02d}" if n < 30 else f"2026-09-{(n - 29) % 28 + 1:02d}"
    chave = f"3523091234567800012355001{n:09d}1000000123"
    xml = (SAMPLE_PROC_NFE_XML.replace("12345678000195", cnpj).replace("2026-09-10", data)
           .replace("35230912345678000123550010000001231000000123", chave))
    return SefazDocEntry(nsu=f"{n:015d}", schema="procNFe_v4.00.xsd", xml_content=xml)


def _sefaz_historico(cnpj, max_nsu, por_pagina=50):
    """consNSU: 632 antes do NSU 20, um documento por NSU depois. distNSU: até `por_pagina`."""
    def cons(nsu):
        n = int(nsu)
        if n < 20:
            return DistNsuResult(c_stat="632", x_motivo="fora de prazo", ult_nsu=nsu, max_nsu=str(max_nsu), docs=[])
        return DistNsuResult(c_stat="138", x_motivo="ok", ult_nsu=nsu, max_nsu=str(max_nsu), docs=[_doc_historico(cnpj, n)])

    def dist(ult):
        u = int(ult)
        if u >= max_nsu:
            return DistNsuResult(c_stat="137", x_motivo="nenhum", ult_nsu=f"{max_nsu:015d}", max_nsu=f"{max_nsu:015d}", docs=[])
        fim = min(u + por_pagina, max_nsu)
        return DistNsuResult(c_stat="138", x_motivo="ok", ult_nsu=f"{fim:015d}", max_nsu=f"{max_nsu:015d}",
                             docs=[_doc_historico(cnpj, n) for n in range(u + 1, fim + 1)])
    return cons, dist


def test_historico_do_mais_antigo_ao_cursor(tmp_path, monkeypatch):
    """10/11: a recuperação acha por busca binária (consNSU) o primeiro documento da data de corte e
    anda para frente; desde 11/11 o avanço é por distNSU, 50 por página, em sequência até o fim da
    fila, e o cursor da varredura fica nesse ponto (a SEFAZ exige continuar o último ultNSU)."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    monkeypatch.setattr(sefaz_scan.time, "sleep", lambda s: None)
    monkeypatch.setattr(sefaz_scan, "already_launched_in_tiny", lambda nfe: False)
    cnpj = "36592814000100"
    sefaz_scan.save_nsu_checkpoint(cnpj, "000000000000150", settings)
    assert sefaz_scan.iniciar_historico(cnpj, "2026-08-12", settings) == 150

    provider = MagicMock()
    provider.cnpj = cnpj
    provider.consultar_nsu.side_effect, provider.consultar_distribuicao_nsu.side_effect = _sefaz_historico(cnpj, 150)

    result = _scan_one_cnpj(provider, set(), settings)
    assert result.status == "ok" and result.nsu_pendentes == 0
    assert not sefaz_scan.load_historico(cnpj, settings)
    consultados = [int(c.args[0]) for c in provider.consultar_nsu.call_args_list]
    assert len(consultados) <= 9  # só a busca binária (2026-08-12 = NSU 30)
    dist = [int(c.args[0]) for c in provider.consultar_distribuicao_nsu.call_args_list]
    assert dist == [29, 79, 129]  # de 30 a 150 em 3 páginas; já é o fim da fila, sem varredura normal
    assert result.nsu_recuperados == len(consultados) + 121
    assert len(result.novas_notas) >= 121
    assert sefaz_scan.get_cnpj_cooldown_remaining_seconds(cnpj, settings) > 0


def test_historico_em_lote_vai_ao_fim_da_fila_e_leva_o_cursor(tmp_path, monkeypatch):
    """11/11: página antiga recusada (o Tiny consultou na última hora): a rodada segue por consNSU e
    faz a varredura normal. Lote aceito: segue até o maxNSU, passando do cursor, e o cursor vai
    junto. Lote interrompido: a próxima rodada continua do mesmo ponto, sem varredura normal."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    monkeypatch.setattr(sefaz_scan.time, "sleep", lambda s: None)
    monkeypatch.setattr(sefaz_scan, "already_launched_in_tiny", lambda nfe: False)
    cnpj = "27184930000107"
    sefaz_scan.save_nsu_checkpoint(cnpj, "000000000000300", settings)
    sefaz_scan.iniciar_historico(cnpj, "2026-08-12", settings)
    h = sefaz_scan.load_historico(cnpj, settings)
    h.update(fase="avanco", proximo=30)
    sefaz_scan._save_historico(cnpj, h, settings)

    cons, dist = _sefaz_historico(cnpj, 300, por_pagina=40)
    estado = {"recusar_antiga": True, "max": 300}
    chamadas = []

    def dist_sefaz(ult):
        chamadas.append(int(ult))
        if estado["recusar_antiga"] and int(ult) < 300:
            return DistNsuResult(c_stat="656", x_motivo="Deve ser utilizado o ultNSU", ult_nsu="000000000000300", max_nsu="", docs=[])
        return _sefaz_historico(cnpj, estado["max"], por_pagina=40)[1](ult)

    provider = MagicMock()
    provider.cnpj = cnpj
    provider.consultar_nsu.side_effect = cons
    provider.consultar_distribuicao_nsu.side_effect = dist_sefaz

    # 1ª rodada: página antiga recusada → consNSU (14, a recusa conta no limite) + varredura normal.
    result = _scan_one_cnpj(provider, set(), settings)
    assert chamadas == [29, 300]
    assert [int(c.args[0]) for c in provider.consultar_nsu.call_args_list] == list(range(30, 44))
    assert sefaz_scan.load_historico(cnpj, settings)["proximo"] == 44

    # 2ª rodada: lote aceito, mas para no limite de páginas: cursor intacto, sem varredura normal.
    sefaz_scan.clear_cnpj_cooldown(cnpj, settings)
    estado.update(recusar_antiga=False, max=420)
    monkeypatch.setattr(sefaz_scan, "MAX_PAGINAS_HISTORICO_POR_RODADA", 3)
    chamadas.clear()
    result = _scan_one_cnpj(provider, set(), settings)
    assert chamadas == [43, 83, 123]
    assert result.status == "ok" and result.nsu_pendentes > 0
    assert sefaz_scan.load_historico(cnpj, settings)["proximo"] == 164
    assert sefaz_scan.load_nsu_state(settings)[cnpj] == "000000000000300"

    # 3ª rodada: continua de 164 até o maxNSU 420, passando do cursor; o cursor vai para 420.
    sefaz_scan.clear_cnpj_cooldown(cnpj, settings)
    monkeypatch.setattr(sefaz_scan, "MAX_PAGINAS_HISTORICO_POR_RODADA", 400)
    chamadas.clear()
    result = _scan_one_cnpj(provider, set(), settings)
    assert chamadas == list(range(163, 420, 40))
    assert sefaz_scan.load_historico(cnpj, settings) is None
    assert sefaz_scan.load_nsu_state(settings)[cnpj] == "000000000000420"
    assert result.status == "ok" and result.nsu_pendentes == 0


def test_historico_para_no_cursor_de_quando_foi_ligado(tmp_path, monkeypatch):
    """10/11: o que vem depois do cursor do início a varredura normal baixa (e os pulos do 656 vão
    para a fila); a recuperação não volta a consultar esses NSUs. Sem "ate" (ligada antes), usa o
    cursor menos a faixa da fila."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    cnpj = "27184930000107"
    sefaz_scan.save_nsu_checkpoint(cnpj, "000000000000050", settings)
    sefaz_scan.iniciar_historico(cnpj, "2026-08-12", settings)
    sefaz_scan.save_nsu_checkpoint(cnpj, "000000000000090", settings)
    h = sefaz_scan.load_historico(cnpj, settings)
    assert sefaz_scan.fim_historico(cnpj, h, settings) == 50
    h.pop("ate")
    sefaz_scan.enfileirar_nsu_pendentes(cnpj, 71, 90, settings)
    assert sefaz_scan.fim_historico(cnpj, h, settings) == 70
    h["fase"], h["proximo"] = "avanco", 70
    sefaz_scan._passo_historico(h, 70, [], 70)
    assert h["concluido"]


def test_pendencias_em_disco_retomam_ao_subir(tmp_path, monkeypatch):
    """11/11: depois de um rebuild, a fila de pulados/histórico em disco volta a ter rodada no fim
    do cooldown, em vez de esperar a varredura das 06h."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()
    a, b = MagicMock(cnpj="36592814000100"), MagicMock(cnpj="43820617000166")
    with patch.object(sefaz_scan, "_resolve_providers", return_value=[a, b]):
        assert sefaz_scan.segundos_ate_retomar_pendencias(settings) is None
        sefaz_scan.enfileirar_nsu_pendentes(b.cnpj, 10, 12, settings)
        sefaz_scan.save_cnpj_cooldown(b.cnpj, 1800, settings)
        sefaz_scan.save_cnpj_cooldown(a.cnpj, 3000, settings)  # sem pendência: não conta
        espera = sefaz_scan.segundos_ate_retomar_pendencias(settings)
        assert 1790 + sefaz_scan.MARGEM_RETENTATIVA_SECONDS <= espera <= 1800 + sefaz_scan.MARGEM_RETENTATIVA_SECONDS


def test_alerta_sem_varredura_conta_por_cnpj(monkeypatch):
    """16/11 (#44): com o Tiny na mesma fila, sempre algum CNPJ levava 656 e o alerta global saía para os 4,
    embora cada um conseguisse a varredura entre uma recusa e outra."""
    monkeypatch.setattr(sefaz_scan, "_falhas_seguidas", {})
    auditoria = MagicMock()
    monkeypatch.setattr(sefaz_scan, "record_audit_error", auditoria)
    resumo = lambda *r: sefaz_scan.SefazScanSummary(started_at="", finished_at="", resultados=list(r))  # noqa: E731
    recusa = lambda c: CnpjScanResult(cnpj=c, status="cooldown", recusado=True)  # noqa: E731
    ok = lambda c: CnpjScanResult(cnpj=c, status="ok")  # noqa: E731
    pulado = lambda c: CnpjScanResult(cnpj=c, status="cooldown", consultado=False)  # noqa: E731

    n = sefaz_scan.TENTATIVAS_ANTES_DO_ALERTA
    for i in range(3 * n):
        # A alterna recusa e varredura; B é sempre recusado, com rodadas puladas no meio (não zeram).
        a = recusa("A") if i % 2 else ok("A")
        b = pulado("B") if i % 7 == 3 else recusa("B")
        sefaz_scan.registrar_cnpjs_sem_varredura(resumo(a, b))

    cnpjs = [c.kwargs["emitente_cnpj"] for c in auditoria.call_args_list]
    assert cnpjs and set(cnpjs) == {"B"}
    # Erro conta; 656 que recuperou NSU pelo consNSU não conta.
    monkeypatch.setattr(sefaz_scan, "_falhas_seguidas", {"C": n - 1, "D": n - 1})
    assert sefaz_scan.registrar_cnpjs_sem_varredura(resumo(
        CnpjScanResult(cnpj="C", status="erro", erro="timeout"),
        CnpjScanResult(cnpj="D", status="cooldown", recusado=True, nsu_recuperados=1),
    )) == ["C"]
    assert "D" not in sefaz_scan._falhas_seguidas
