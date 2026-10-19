import pytest
from datetime import date
from decimal import Decimal
from pathlib import Path

from app.config import Settings
from app.nfe_client import NFeXmlParser, MockNFeProvider, get_nfe_provider, NFeData, NFeDuplicate

SAMPLE_XML_WITH_DUPLICATES = """<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe35230912345678000123550010000001231000000123" versao="4.00">
      <ide>
        <nNF>123456</nNF>
        <dhEmi>2024-05-10T14:30:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>12345678000195</CNPJ>
        <xNome>DISTRIBUIDORA DE ALIMENTOS EXEMPLO LTDA</xNome>
      </emit>
      <total>
        <ICMSTot>
          <vNF>2400.00</vNF>
        </ICMSTot>
      </total>
      <cobr>
        <dup>
          <nDup>001</nDup>
          <dVenc>2024-06-10</dVenc>
          <vDup>1200.00</vDup>
        </dup>
        <dup>
          <nDup>002</nDup>
          <dVenc>2024-07-10</dVenc>
          <vDup>1200.00</vDup>
        </dup>
      </cobr>
    </infNFe>
  </NFe>
</nfeProc>
"""

SAMPLE_XML_NO_DUPLICATES = """<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe35230912345678000123550010000001231000000123" versao="4.00">
      <ide>
        <nNF>98765</nNF>
        <dEmi>2024-08-20</dEmi>
      </ide>
      <emit>
        <CNPJ>98765432000109</CNPJ>
        <xNome>FORNECEDOR A VISTA S/A</xNome>
      </emit>
      <total>
        <ICMSTot>
          <vNF>550.50</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
</nfeProc>
"""


def test_nfe_xml_parser_with_duplicates():
    chave = "35230912345678000123550010000001231000000123"
    nfe_data = NFeXmlParser.parse(SAMPLE_XML_WITH_DUPLICATES, chave)

    assert nfe_data.chave == chave
    assert nfe_data.numero_nota == "123456"
    assert nfe_data.data_emissao == date(2024, 5, 10)
    assert nfe_data.emitente_nome == "DISTRIBUIDORA DE ALIMENTOS EXEMPLO LTDA"
    assert nfe_data.emitente_cnpj == "12345678000195"
    assert nfe_data.valor_total == Decimal("2400.00")
    assert len(nfe_data.duplicatas) == 2


def test_nfe_xml_parser_fallback_effective_duplicatas():
    chave = "35230912345678000123550010000001231000000123"
    nfe_data = NFeXmlParser.parse(SAMPLE_XML_NO_DUPLICATES, chave)

    assert nfe_data.numero_nota == "98765"
    assert nfe_data.valor_total == Decimal("550.50")
    assert len(nfe_data.duplicatas) == 0

    effective = nfe_data.get_effective_duplicatas()
    assert len(effective) == 1
    assert effective[0].numero == "001"
    assert effective[0].vencimento == date(2024, 8, 20)
    assert effective[0].valor == Decimal("550.50")


def test_get_effective_duplicatas_always_collapses_to_single_parcela():
    """
    Padronização de negócio: mesmo quando a extração (OCR/regex) confunde itens de um
    cupom com parcelas de pagamento (ex.: 4 itens virando 4 "duplicatas"), o lançamento
    no Tiny deve sempre ser 1 parcela única com o valor total real da nota.
    """
    nfe_data = NFeData(
        chave="35230912345678000123550010000001231000000123",
        numero_nota="1420",
        data_emissao=date(2026, 9, 8),
        emitente_nome="SUPERMERCADO EXEMPLO",
        emitente_cnpj="12345678000195",
        valor_total=Decimal("193.27"),
        duplicatas=[
            NFeDuplicate(numero="001", vencimento=date(2026, 9, 10), valor=Decimal("48.00")),
            NFeDuplicate(numero="002", vencimento=date(2026, 9, 15), valor=Decimal("50.00")),
            NFeDuplicate(numero="003", vencimento=date(2026, 9, 20), valor=Decimal("45.27")),
            NFeDuplicate(numero="004", vencimento=date(2026, 9, 25), valor=Decimal("50.00")),
        ],
    )

    effective = nfe_data.get_effective_duplicatas()

    assert len(effective) == 1
    assert effective[0].numero == "001"
    assert effective[0].valor == Decimal("193.27")
    # Usa o vencimento mais próximo entre os identificados, nunca o mais distante
    assert effective[0].vencimento == date(2026, 9, 10)


def test_mock_nfe_provider():
    provider = MockNFeProvider()
    chave = "35230912345678000123550010000001231000000123"
    data = provider.get_nfe_data(chave)

    assert data.chave == chave
    assert data.emitente_cnpj == "12345678000123"
    assert len(data.duplicatas) == 2


def test_get_nfe_provider_factory():
    cfg = Settings(NFE_PROVIDER="mock")
    provider = get_nfe_provider(cfg)
    assert isinstance(provider, MockNFeProvider)


def test_receita_federal_provider_factory_and_fetch():
    from unittest.mock import patch
    from app.nfe_client import ReceitaFederalProvider

    cfg = Settings(
        NFE_PROVIDER="receita_oficial",
        RECEITA_API_TOKEN="token_teste_serpro"
    )
    provider = get_nfe_provider(cfg)
    assert isinstance(provider, ReceitaFederalProvider)

    mock_resp = {
        "numero": "54321",
        "dataEmissao": "2024-04-15",
        "emitente": {
            "razaoSocial": "SERPRO FORNECEDOR OFICIAL S/A",
            "cnpj": "00000000000191"
        },
        "total": {
            "valorTotal": 980.00
        },
        "cobranca": {
            "duplicatas": [
                {"numero": "001", "vencimento": "2024-05-15", "valor": 980.00}
            ]
        }
    }

    import json
    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.headers = {"Content-Type": "application/json"}
        mock_get.return_value.text = json.dumps(mock_resp)
        mock_get.return_value.json.return_value = mock_resp

        chave = "35230912345678000123550010000001231000000123"
        data = provider.get_nfe_data(chave)

        assert data.numero_nota == "54321"
        assert data.emitente_nome == "SERPRO FORNECEDOR OFICIAL S/A"
        assert data.emitente_cnpj == "00000000000191"
        assert data.valor_total == Decimal("980.0")
        assert len(data.duplicatas) == 1


def test_sefaz_a1_provider_factory_and_fetch():
    import base64
    import gzip
    from unittest.mock import patch, MagicMock
    from pathlib import Path
    from app.nfe_client import SefazA1Provider

    cfg = Settings(
        NFE_PROVIDER="sefaz_a1",
        SEFAZ_CERTS_DIR=None,
        SEFAZ_CERT_PATH=Path("test_cert.pem"),
        SEFAZ_CNPJ="12345678000195",
        SEFAZ_UF="SP"
    )
    provider = get_nfe_provider(cfg)
    assert isinstance(provider, SefazA1Provider)

    # Simula docZip compactado com o XML completo
    gzipped = gzip.compress(SAMPLE_XML_WITH_DUPLICATES.encode("utf-8"))
    b64_doc = base64.b64encode(gzipped).decode("utf-8")

    soap_response = f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDistDFeInteresseResult>
        <retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>1</tpAmb>
          <cStat>138</cStat>
          <xMotivo>Documento localizado</xMotivo>
          <loteDistDFeInt>
            <docZip NSU="000000000000001" schema="procNFe_v4.00.xsd">{b64_doc}</docZip>
          </loteDistDFeInt>
        </retDistDFeInt>
      </nfeDistDFeInteresseResult>
    </nfeDistDFeInteresseResponse>
  </soap:Body>
</soap:Envelope>"""

    with patch.object(provider, "_prepare_certificates", return_value=("mock_cert.pem", "mock_key.pem")), \
         patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = soap_response
        mock_post.return_value = mock_resp

        chave = "35230912345678000123550010000001231000000123"
        data = provider.get_nfe_data(chave)

        assert data.chave == chave
        assert data.numero_nota == "123456"
        assert data.emitente_nome == "DISTRIBUIDORA DE ALIMENTOS EXEMPLO LTDA"
        assert data.valor_total == Decimal("2400.00")
        assert len(data.duplicatas) == 2


def test_sefaz_a1_provider_res_nfe():
    import base64
    import gzip
    from unittest.mock import patch, MagicMock
    from pathlib import Path
    from app.nfe_client import SefazA1Provider

    provider = SefazA1Provider(
        cert_path=Path("cert.pem"),
        cnpj="12345678000195",
        uf="SP"
    )

    res_xml = """<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
      <chNFe>35230912345678000123550010000001231000000123</chNFe>
      <CNPJ>99887766000111</CNPJ>
      <xNome>FORNECEDOR RESUMO LTDA</xNome>
      <vNF>1580.45</vNF>
      <dhEmi>2024-06-01T10:00:00-03:00</dhEmi>
    </resNFe>"""

    gzipped = gzip.compress(res_xml.encode("utf-8"))
    b64_doc = base64.b64encode(gzipped).decode("utf-8")

    soap_response = f"""<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
      <cStat>138</cStat>
      <xMotivo>Documento localizado</xMotivo>
      <docZip schema="resNFe_v1.01.xsd">{b64_doc}</docZip>
    </retDistDFeInt>
  </soap:Body>
</soap:Envelope>"""

    with patch.object(provider, "_prepare_certificates", return_value=("mock_cert.pem", "mock_key.pem")), \
         patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = soap_response
        mock_post.return_value = mock_resp

        chave = "35230912345678000123550010000001231000000123"
        data = provider.get_nfe_data(chave)

        assert data.chave == chave
        assert data.emitente_cnpj == "99887766000111"
        assert data.emitente_nome == "FORNECEDOR RESUMO LTDA"
        assert data.valor_total == Decimal("1580.45")


def test_multi_sefaz_a1_provider_cascade_success():
    from unittest.mock import MagicMock
    from app.nfe_client import MultiSefazA1Provider, NFeProviderError, NFeData
    import pytest

    prov1 = MagicMock()
    prov1.cnpj = "11111111000111"
    prov1.get_nfe_data.side_effect = NFeProviderError("SEFAZ retornou rejeição: cStat 137 - Nenhum documento localizado")

    prov2 = MagicMock()
    prov2.cnpj = "22222222000122"
    expected_data = NFeData(
        chave="35230912345678000123550010000001231000000123",
        numero_nota="123",
        data_emissao=date.today(),
        emitente_nome="FORNECEDOR FILIAL 2",
        emitente_cnpj="99999999000199",
        valor_total=Decimal("300.00"),
        duplicatas=[]
    )
    prov2.get_nfe_data.return_value = expected_data

    multi = MultiSefazA1Provider([prov1, prov2])
    res = multi.get_nfe_data("35230912345678000123550010000001231000000123")

    assert res.chave == expected_data.chave
    assert res.emitente_nome == "FORNECEDOR FILIAL 2"
    assert prov1.get_nfe_data.called
    assert prov2.get_nfe_data.called


def test_multi_sefaz_a1_provider_all_failed():
    from unittest.mock import MagicMock
    from app.nfe_client import MultiSefazA1Provider, NFeProviderError
    import pytest

    prov1 = MagicMock()
    prov1.cnpj = "11111111000111"
    prov1.get_nfe_data.side_effect = NFeProviderError("SEFAZ retornou rejeição: cStat 137 - Nenhum documento localizado")

    multi = MultiSefazA1Provider([prov1])
    with pytest.raises(NFeProviderError) as exc_info:
        multi.get_nfe_data("35230912345678000123550010000001231000000123")

    assert "não foi localizada em nenhum" in str(exc_info.value)


def test_collect_candidate_passwords():
    from app.nfe_client import collect_candidate_passwords
    from pathlib import Path

    cfg = Settings(
        SEFAZ_PASSWORDS="matriz:senha1, filial:senha2, senha3",
        SEFAZ_CERT_PASSWORD="senhaFallback"
    )
    candidates = collect_candidate_passwords(Path("matriz.pfx"), cfg)
    assert "senha1" in candidates
    assert candidates[0] == "senha1"
    assert "senha2" in candidates
    assert "senha3" in candidates
    assert "senhaFallback" in candidates


def test_enrich_nfe_data_from_file_context_prefix_and_marcador():
    from pathlib import Path
    from app.nfe_client import NFeData, enrich_nfe_data_from_file_context

    base_nfe = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="1189663",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )

    # Caso 1: Arquivo Revesta
    file_revesta = Path("NFC-e Revesta - AUTO POSTO EXEMPLO LTDA - R$43,15.pdf")
    enriched = enrich_nfe_data_from_file_context(base_nfe, file_revesta)

    assert enriched.numero_documento_custom == "NFC-e Revesta"
    assert enriched.marcador_empresa == "Revesta"
    assert enriched.destinatario_nome == "Revesta"
    assert enriched.destinatario_cnpj == "36592814000100"
    assert enriched.emitente_nome == "AUTO POSTO EXEMPLO LTDA"
    assert enriched.valor_total == Decimal("43.15")

    # Caso 2: Arquivo Curitiba
    base_curitiba = NFeData(
        chave="41260700000000000000650010000000011000000011",
        numero_nota="1",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_curitiba = Path("NFC-e Norvia Curitiba - POSTO SHELL - R$150,00.pdf")
    enriched_curitiba = enrich_nfe_data_from_file_context(base_curitiba, file_curitiba)

    assert enriched_curitiba.numero_documento_custom == "NFC-e Norvia Curitiba"
    assert enriched_curitiba.marcador_empresa == "NorviaLDA"
    assert enriched_curitiba.destinatario_cnpj == "27184930000280"
    assert enriched_curitiba.valor_total == Decimal("150.00")

    # Caso 3: Arquivo Fabrilux
    base_fabrilux = NFeData(
        chave="41260700000000000000650010000000022000000022",
        numero_nota="2",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_fabrilux = Path("NFC-e Fabrilux - KALUNGA COMERCIO - R$320,50.pdf")
    enriched_fabrilux = enrich_nfe_data_from_file_context(base_fabrilux, file_fabrilux)

    assert enriched_fabrilux.numero_documento_custom == "NFC-e Fabrilux"
    assert enriched_fabrilux.marcador_empresa == "Fabrilux"
    assert enriched_fabrilux.destinatario_cnpj == "43820617000166"
    assert enriched_fabrilux.valor_total == Decimal("320.50")


def test_enrich_nfe_data_from_file_context_payment_markers():
    from app.nfe_client import NFeData, enrich_nfe_data_from_file_context

    # 1. Norvia com marcador de caixa 'Clara'
    base_clara = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="101",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_clara = Path("NFC-e Norvia - Clara - AUTO POSTO EXEMPLO - R$43,15.pdf")
    res_clara = enrich_nfe_data_from_file_context(base_clara, file_clara)

    assert res_clara.numero_documento_custom == "NFC-e Norvia"
    assert res_clara.marcador_caixa == "Cartão Clara"
    assert res_clara.marcador_empresa == "Norvia"
    assert res_clara.marcadores == ["Cartão Clara", "Norvia"]
    assert res_clara.emitente_nome == "AUTO POSTO EXEMPLO"
    assert res_clara.valor_total == Decimal("43.15")

    # 2. Norvia com marcador 'Caixa Visa Norvia'
    base_visa_norvia = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="102",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_visa = Path("NFC-e Norvia - Caixa Visa Norvia - FORNECEDOR XYZ.pdf")
    res_visa = enrich_nfe_data_from_file_context(base_visa_norvia, file_visa)

    assert res_visa.numero_documento_custom == "NFC-e Norvia"
    assert res_visa.marcador_caixa == "Caixa Visa Norvia"
    assert res_visa.marcador_empresa == "Norvia"
    assert res_visa.marcadores == ["Caixa Visa Norvia", "Norvia"]
    assert res_visa.emitente_nome == "FORNECEDOR XYZ"

    # 3. Revesta com marcador 'Caixa Visa'
    base_visa_revesta = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="103",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_revesta_visa = Path("NFC-e Revesta - Caixa Visa - AUTO POSTO EXEMPLO - R$43,15.pdf")
    res_p_visa = enrich_nfe_data_from_file_context(base_visa_revesta, file_revesta_visa)

    assert res_p_visa.numero_documento_custom == "NFC-e Revesta"
    assert res_p_visa.marcador_caixa == "Caixa Visa"
    assert res_p_visa.marcador_empresa == "Revesta"
    assert res_p_visa.marcadores == ["Caixa Visa", "Revesta"]
    assert res_p_visa.valor_total == Decimal("43.15")

    # 4. Revesta com marcador 'Caixa Elo' sem fornecedor explícito
    base_elo = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="104",
        data_emissao=date(2026, 7, 16),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_elo = Path("NFC-e Revesta - Caixa Elo.pdf")
    res_elo = enrich_nfe_data_from_file_context(base_elo, file_elo)

    assert res_elo.numero_documento_custom == "NFC-e Revesta"
    assert res_elo.marcador_caixa == "Caixa Elo"
    assert res_elo.marcador_empresa == "Revesta"
    # Verifica vencimento calculado para Elo (próximo dia 15)
    assert res_elo.duplicatas[0].vencimento == date(2026, 8, 15)

    # 5. Revesta com marcador 'Caixa Elo' e fornecedor com número no nome ('SUPERMERCADO 77')
    base_supermercado = NFeData(
        chave="41260958203741000150651090001747321223392183",
        numero_nota="174732",
        data_emissao=date(2026, 9, 10),
        emitente_nome="",
        emitente_cnpj="58203741000150",
        valor_total=Decimal("0.00")
    )
    file_super = Path("NFC-e Revesta - Caixa Elo - SUPERMERCADO 77 - R$40,03.jpeg")
    res_super = enrich_nfe_data_from_file_context(base_supermercado, file_super)

    assert res_super.numero_documento_custom == "NFC-e Revesta"
    assert res_super.marcador_caixa == "Caixa Elo"
    assert res_super.emitente_nome == "SUPERMERCADO 77"
    assert res_super.valor_total == Decimal("40.03")
    assert res_super.duplicatas[0].valor == Decimal("40.03")
    assert res_super.duplicatas[0].vencimento == date(2026, 10, 15)
    assert res_super.marcadores == ["Caixa Elo", "Revesta"]


def test_calculate_marker_vencimento_rules():
    from app.nfe_client import calculate_marker_vencimento

    # 1. Visa e Elo: Notas do dia 1 ao 31 sempre vencem no próximo dia 15
    # Início do mês (dia 1)
    assert calculate_marker_vencimento(date(2026, 7, 1), "Caixa Visa") == date(2026, 8, 15)
    assert calculate_marker_vencimento(date(2026, 7, 1), "Caixa Elo") == date(2026, 8, 15)
    assert calculate_marker_vencimento(date(2026, 7, 1), "Caixa Visa Norvia") == date(2026, 8, 15)

    # Meio do mês (dia 15 ou 20)
    assert calculate_marker_vencimento(date(2026, 7, 15), "Caixa Visa") == date(2026, 8, 15)
    assert calculate_marker_vencimento(date(2026, 7, 20), "Caixa Elo") == date(2026, 8, 15)

    # Fim do mês (dia 31)
    assert calculate_marker_vencimento(date(2026, 7, 31), "Caixa Visa") == date(2026, 8, 15)
    assert calculate_marker_vencimento(date(2026, 8, 31), "Caixa Elo") == date(2026, 9, 15)

    # Virada de ano (dezembro -> janeiro)
    assert calculate_marker_vencimento(date(2026, 12, 5), "Caixa Visa") == date(2027, 1, 15)
    assert calculate_marker_vencimento(date(2026, 12, 31), "Caixa Elo") == date(2027, 1, 15)

    # 2. Clara: Ciclo de 03 do mês M até 02 do mês M+1 -> Vencimento sempre em 09 do mês M+1
    # Início do ciclo (03 de Julho -> vence em 09/08)
    assert calculate_marker_vencimento(date(2026, 7, 3), "Clara") == date(2026, 8, 9)
    # Meio do ciclo (15 ou 31 de Julho -> vence em 09/08)
    assert calculate_marker_vencimento(date(2026, 7, 15), "Clara") == date(2026, 8, 9)
    assert calculate_marker_vencimento(date(2026, 7, 31), "Clara") == date(2026, 8, 9)
    # Fim do ciclo (01 e 02 de Agosto -> ainda vencem em 09/08)
    assert calculate_marker_vencimento(date(2026, 8, 1), "Clara") == date(2026, 8, 9)
    assert calculate_marker_vencimento(date(2026, 8, 2), "Clara") == date(2026, 8, 9)
    # Próximo ciclo (03 de Agosto -> já vence em 09/09)
    assert calculate_marker_vencimento(date(2026, 8, 3), "Clara") == date(2026, 9, 9)
    # Virada de ano:
    # 03 de Dezembro a 02 de Janeiro -> vence em 09/01 do ano seguinte
    assert calculate_marker_vencimento(date(2026, 12, 3), "Clara") == date(2027, 1, 9)
    assert calculate_marker_vencimento(date(2026, 12, 31), "Clara") == date(2027, 1, 9)
    assert calculate_marker_vencimento(date(2027, 1, 1), "Clara") == date(2027, 1, 9)
    assert calculate_marker_vencimento(date(2027, 1, 2), "Clara") == date(2027, 1, 9)
    # 03 de Janeiro -> já vence em 09/02
    assert calculate_marker_vencimento(date(2027, 1, 3), "Clara") == date(2027, 2, 9)


def test_enrich_nfe_data_pure_filename_and_internal_text():
    from app.nfe_client import NFeData, enrich_nfe_data_from_file_context

    # Nome do arquivo exatamente no padrão puro: 'NFC-e Norvia - Clara.pdf'
    base = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="505",
        data_emissao=date.today(),
        emitente_nome="",
        emitente_cnpj="",
        valor_total=Decimal("0.00")
    )
    file_path = Path("NFC-e Norvia - Clara.pdf")

    # Texto interno extraído do documento (OCR ou texto de PDF)
    internal_text = """
    AUTO POSTO EXEMPLO LTDA
    AV BRASIL 1500 - CENTRO
    CNPJ: 12.345.678/0001-90
    DOCUMENTO AUXILIAR DA NOTA FISCAL DE CONSUMIDOR ELETRONICA
    EMISSAO: 16/07/2026 14:20:00
    VALOR TOTAL R$ 85,50
    VALOR A PAGAR R$ 85,50
    """

    enriched = enrich_nfe_data_from_file_context(base, file_path, raw_ocr_text=internal_text)

    # Validações dos metadados extraídos
    assert enriched.numero_documento_custom == "NFC-e Norvia"
    assert enriched.marcador_caixa == "Cartão Clara"
    assert enriched.marcador_empresa == "Norvia"
    assert enriched.marcadores == ["Cartão Clara", "Norvia"]

    # Validações dos dados obtidos do conteúdo interno
    assert enriched.emitente_nome == "AUTO POSTO EXEMPLO LTDA"
    assert enriched.emitente_cnpj == "12345678000190"
    assert enriched.valor_total == Decimal("85.50")
    assert enriched.data_emissao == date(2026, 7, 16)

    # Validação do vencimento da Clara (emitida em 16/07 -> vence em 09/08)
    assert enriched.duplicatas[0].vencimento == date(2026, 8, 9)
    assert enriched.duplicatas[0].valor == Decimal("85.50")
    assert len(enriched.duplicatas) == 1


def test_single_installment_when_enriching_mock_with_marcador():
    """Garante que dados simulados com múltiplas duplicatas sejam consolidados em 1 única parcela ao usar marcador."""
    from app.nfe_client import MockNFeProvider, enrich_nfe_data_from_file_context

    mock_prov = MockNFeProvider()
    # Chave modelo 55 mockada (possui 2 duplicatas de R$ 750 no mock base)
    base_nfe = mock_prov.get_nfe_data("35230912345678000123550010000001231000000123")
    assert len(base_nfe.duplicatas) == 2

    file_path = Path("NFC-e Revesta - Caixa Elo - SUPERMERCADO 77 - R$40,03.jpeg")
    enriched = enrich_nfe_data_from_file_context(base_nfe, file_path)

    # Deve consolidar em exatamente 1 parcela de R$ 40,03
    assert len(enriched.duplicatas) == 1
    assert enriched.duplicatas[0].numero == "001"
    assert enriched.duplicatas[0].valor == Decimal("40.03")
    assert enriched.duplicatas[0].vencimento == date(2000 + int(base_nfe.chave[2:4]), int(base_nfe.chave[4:6]) + 1, 15)


def test_mock_nfe_provider_nfce_model_65():
    """Garante que MockNFeProvider reconheça modelo 65 (NFC-e) e retorne estrutura compatível sem duplicatas fictícias."""
    from app.nfe_client import MockNFeProvider

    mock_prov = MockNFeProvider()
    chave_nfce = "41260958203741000150651090001747321223392183"
    data = mock_prov.get_nfe_data(chave_nfce)

    assert data.chave == chave_nfce
    assert data.numero_nota == "174732"
    assert data.emitente_cnpj == "58203741000150"
    assert len(data.duplicatas) == 0


def test_extract_fiscal_data_with_multiple_duplicatas():
    from app.nfe_client import extract_fiscal_data_from_text

    text = """
    SUPERMERCADO 77 LTDA
    CNPJ: 58.203.741/0001-50
    EMISSAO: 10/09/2026
    DADOS DA FATURA
    001 10/10/2026 R$ 150,00
    002 10/11/2026 R$ 150,00
    003 10/12/2026 R$ 150,00
    VALOR TOTAL: R$ 450,00
    """
    res = extract_fiscal_data_from_text(text)
    assert res["emitente_nome"] == "SUPERMERCADO 77 LTDA"
    assert res["emitente_cnpj"] == "58203741000150"
    assert res["valor_total"] == Decimal("450.00")
    assert len(res["duplicatas"]) == 3
    assert res["duplicatas"][0].valor == Decimal("150.00")
    assert res["duplicatas"][1].valor == Decimal("150.00")
    assert res["duplicatas"][2].valor == Decimal("150.00")


def test_enrich_preserves_multiple_real_duplicatas_with_card_marker():
    from app.nfe_client import NFeData, NFeDuplicate, enrich_nfe_data_from_file_context

    base_nfe = NFeData(
        chave="41260958203741000150550010000001231000000122",
        numero_nota="123",
        data_emissao=date(2026, 7, 10),
        emitente_nome="DISTRIBUIDORA REAL LTDA",
        emitente_cnpj="58203741000150",
        valor_total=Decimal("300.00"),
        duplicatas=[
            NFeDuplicate(numero="001", vencimento=date(2026, 8, 10), valor=Decimal("150.00")),
            NFeDuplicate(numero="002", vencimento=date(2026, 9, 10), valor=Decimal("150.00")),
        ]
    )

    file_path = Path("NFC-e Revesta - Caixa Visa.pdf")
    enriched = enrich_nfe_data_from_file_context(base_nfe, file_path)

    # Garante que as 2 parcelas reais da nota foram preservadas com seus valores individuais
    assert len(enriched.duplicatas) == 2
    assert enriched.duplicatas[0].valor == Decimal("150.00")
    assert enriched.duplicatas[1].valor == Decimal("150.00")
    # Vencimentos calculados para Visa (ciclo 1: 15/08, ciclo 2: 15/09)
    assert enriched.duplicatas[0].vencimento == date(2026, 8, 15)
    assert enriched.duplicatas[1].vencimento == date(2026, 9, 15)


def test_load_sefaz_providers_registers_filial_curitiba_from_matriz_cert(tmp_path):
    from unittest.mock import patch
    from app.config import Settings
    from app.nfe_client import MultiSefazA1Provider, SefazA1Provider, load_sefaz_providers

    certs_dir = tmp_path / "secrets"
    certs_dir.mkdir()
    matriz_cert = certs_dir / "27184930000107.pfx"
    matriz_cert.write_bytes(b"dummy-cert-matriz")

    cfg = Settings(
        SEFAZ_CERTS_DIR=certs_dir,
        SEFAZ_CERT_PASSWORD="senha_matriz_teste",
        SEFAZ_AMBIENTE="1",
        CNPJ_COMPANY_MAP="27184930000107:norvia_campinas,27184930000280:norvia_curitiba",
    )

    with patch("app.nfe_client.extract_cert_metadata", return_value=("27184930000107", "SP", "senha_matriz_teste")):
        provider = load_sefaz_providers(cfg)

    assert isinstance(provider, MultiSefazA1Provider)
    cnpjs = {p.cnpj: p for p in provider.providers}
    assert "27184930000107" in cnpjs
    assert "27184930000280" in cnpjs

    # Campinas é Matriz (SP)
    assert cnpjs["27184930000107"].uf == "SP"
    # Curitiba é Filial (PR)
    assert cnpjs["27184930000280"].uf == "PR"
    assert cnpjs["27184930000280"].cert_path == matriz_cert


def test_nfe_xml_parser_identifies_curitiba_vs_campinas_by_cnpj():
    from app.nfe_client import NFeXmlParser

    xml_campinas = """<?xml version="1.0" encoding="UTF-8"?>
    <nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
      <NFe>
        <infNFe Id="NFe35230927184930000107550010000001231000000120" versao="4.00">
          <ide><nNF>123</nNF><dhEmi>2026-09-10T14:30:00-03:00</dhEmi></ide>
          <emit><CNPJ>98765432000109</CNPJ><xNome>FORNECEDOR SP LTDA</xNome></emit>
          <dest><CNPJ>27184930000107</CNPJ><xNome>NORVIA MATRIZ QUALQUER NOME</xNome></dest>
          <total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>
        </infNFe>
      </NFe>
    </nfeProc>"""

    xml_curitiba = """<?xml version="1.0" encoding="UTF-8"?>
    <nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
      <NFe>
        <infNFe Id="NFe41230927184930000280550010000004561000000450" versao="4.00">
          <ide><nNF>456</nNF><dhEmi>2026-09-10T14:30:00-03:00</dhEmi></ide>
          <emit><CNPJ>98765432000109</CNPJ><xNome>FORNECEDOR PR LTDA</xNome></emit>
          <dest><CNPJ>27184930000280</CNPJ><xNome>NORVIA ACABAMENTOS FORNECEDOR SEM FILIAL NO NOME</xNome></dest>
          <total><ICMSTot><vNF>250.00</vNF></ICMSTot></total>
        </infNFe>
      </NFe>
    </nfeProc>"""

    data_g = NFeXmlParser.parse(xml_campinas, "35230927184930000107550010000001231000000120")
    assert data_g.destinatario_cnpj == "27184930000107"
    assert data_g.destinatario_nome == "NORVIA ACABAMENTOS LTDA (CAMPINAS)"

    data_l = NFeXmlParser.parse(xml_curitiba, "41230927184930000280550010000004561000000450")
    assert data_l.destinatario_cnpj == "27184930000280"
    assert data_l.destinatario_nome == "NORVIA ACABAMENTOS LTDA (CURITIBA)"




@pytest.mark.parametrize(
    "nome, esperado",
    [
        ("41260552740396000107550010000000241143751412.xml", None),  # XML salvo com a chave
        ("invoice-2000017019020870.xml", None),  # nome de download de marketplace
        ("danfe.pdf", None),
        ("NFC-e Revesta - Caixa Elo.pdf", "NFC-e Revesta"),
        ("Recibo - Norvia.pdf", "Recibo"),
    ],
)
def test_nome_de_arquivo_so_vira_numero_documento_no_padrao_do_drive(nome, esperado):
    from pathlib import Path
    from app.nfe_client import NFeData, enrich_nfe_data_from_file_context

    nfe = NFeData(chave="4" * 44, numero_nota="24", data_emissao=date(2026, 6, 15),
                  emitente_nome="CAFE EXEMPLO", emitente_cnpj="52740396000107", valor_total=Decimal("194.60"))
    assert enrich_nfe_data_from_file_context(nfe, Path(nome)).numero_documento_custom == esperado
