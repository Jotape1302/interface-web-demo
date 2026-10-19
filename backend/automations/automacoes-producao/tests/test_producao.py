from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import impressora
from app.api import app
from app.config import Settings, settings
from app.etiquetas_zpl import avisos_etiqueta, gerar_zpl, gtin_valido

ORION = {
    "sku": "HNYRPI11-3M-01",
    "descricao": "Rodapé Orion Autocolante com Friso para Difusor LED em Aluminio 70mm x 17mm - Norvia - Branco - 3m",
    "gtin": "7908737101294",
    "localizacao": "A1-RA-P2-N1-AP1 / CASA06",
    "copias": 10,
    "op": "1234",
}


CHAVE = "chave-de-teste-com-mais-de-32-caracteres"


@pytest.fixture(autouse=True)
def chave_configurada():
    with patch.object(settings, "CHAVE_API", CHAVE):
        yield


@pytest.fixture(autouse=True)
def limites_zerados():
    from app.limite import limitador

    limitador.limpar()
    yield
    limitador.limpar()


@pytest.fixture
def client():
    return TestClient(app, headers={"X-Api-Key": CHAVE})


@pytest.fixture
def impressora_fake():
    with patch("app.api.imprimir", return_value="ELGIN L42DT") as imp:
        yield imp


def test_gtin_valido():
    assert gtin_valido("7908737101294")
    assert not gtin_valido("7908737101295")
    assert not gtin_valido("SEM GTIN")
    assert not gtin_valido(None)


def test_gerar_zpl_completo():
    zpl = gerar_zpl(ORION, copias=5, dpi=203, largura_mm=60, altura_mm=40)
    assert zpl.startswith("^XA") and zpl.rstrip().endswith("^XZ")
    assert "^PW480" in zpl and "^LL320" in zpl
    assert "^CI28" in zpl and "Rodapé Orion" in zpl
    assert "^BEN" in zpl and "^FD790873710129^FS" in zpl
    assert "^BCN" in zpl and "^FDHNYRPI11-3M-01^FS" in zpl
    assert "^PQ5,0,1,N" in zpl


def test_gerar_zpl_sem_acentos():
    zpl = gerar_zpl(ORION, remover_acentos=True)
    assert "Rodape Orion" in zpl and "Rodapé" not in zpl


def test_gerar_zpl_sem_gtin_nao_desenha_ean():
    zpl = gerar_zpl({**ORION, "gtin": None})
    assert "^BEN" not in zpl and "^BCN" in zpl
    assert any("sem GTIN" in a for a in avisos_etiqueta({**ORION, "gtin": None}))


def test_imprimir_monta_zpl_e_manda_para_impressora(client, impressora_fake):
    with patch.object(settings, "LINGUAGEM", "zpl"):
        r = client.post("/etiquetas/imprimir", json=ORION)
    assert r.status_code == 200
    corpo = r.json()
    assert corpo["sucesso"] is True
    assert corpo["impressora"] == "ELGIN L42DT"
    assert corpo["copias"] == 10 and corpo["op"] == "1234"
    assert corpo["avisos"] == []
    zpl = impressora_fake.call_args.args[0]
    assert "^PQ10,0,1,N" in zpl and "^FDHNYRPI11-3M-01^FS" in zpl
    assert impressora_fake.call_args.kwargs["codificacao"] == "utf-8"


def test_sem_copias_recusa(client, impressora_fake):
    sem = {k: v for k, v in ORION.items() if k != "copias"}
    r = client.post("/etiquetas/imprimir", json=sem)
    assert r.status_code == 422 and "copias" in r.json()["erro"]
    impressora_fake.assert_not_called()


def test_copias_acima_do_limite_recusa(client, impressora_fake):
    r = client.post("/etiquetas/imprimir", json={**ORION, "copias": 5000})
    assert r.status_code == 422 and "copias" in r.json()["erro"]
    impressora_fake.assert_not_called()


def test_imprimir_json_invalido(client, impressora_fake):
    r = client.post("/etiquetas/imprimir", json={"descricao": "Sem SKU", "copias": 0})
    assert r.status_code == 422
    corpo = r.json()
    assert corpo["sucesso"] is False
    assert "sku" in corpo["erro"] and "copias" in corpo["erro"]
    impressora_fake.assert_not_called()


def test_imprimir_sem_impressora_responde_503(client):
    with patch("app.api.imprimir", side_effect=impressora.ImpressoraIndisponivel("Impressora não encontrada")):
        r = client.post("/etiquetas/imprimir", json=ORION)
    assert r.status_code == 503
    assert r.json() == {"sucesso": False, "erro": "Impressora não encontrada"}


def test_sem_chave_ou_chave_errada_recusa(impressora_fake):
    anonimo = TestClient(app)
    for rota in ("/etiquetas/imprimir", "/etiquetas/zpl"):
        assert anonimo.post(rota, json=ORION).status_code == 401
        assert anonimo.post(rota, json=ORION, headers={"X-Api-Key": "errada"}).status_code == 401
    r = anonimo.get("/status")
    assert r.status_code == 401 and r.json()["sucesso"] is False
    impressora_fake.assert_not_called()


def test_chave_por_bearer(impressora_fake):
    r = TestClient(app).post("/etiquetas/imprimir", json=ORION, headers={"Authorization": f"Bearer {CHAVE}"})
    assert r.status_code == 200


def test_servidor_sem_chave_configurada_nao_fica_aberto(client, impressora_fake):
    with patch.object(settings, "CHAVE_API", None):
        r = client.post("/etiquetas/imprimir", json=ORION)
    assert r.status_code == 503 and "CHAVE_API" in r.json()["erro"]
    impressora_fake.assert_not_called()


def test_docs_desligado(client):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_sem_chave_no_env_impede_subir():
    from app import main

    with patch.object(settings, "CHAVE_API", None), pytest.raises(SystemExit):
        main.conferir_chave_configurada()


def test_chave_curta_impede_subir():
    from app import main

    with patch.object(settings, "CHAVE_API", "curta"), pytest.raises(SystemExit):
        main.conferir_chave_configurada()


def test_zpl_nao_imprime(client, impressora_fake):
    with patch.object(settings, "LINGUAGEM", "zpl"):
        r = client.post("/etiquetas/zpl", json=ORION)
    assert r.status_code == 200
    assert r.text.startswith("^XA")
    impressora_fake.assert_not_called()


def test_preflight_cors_e_rede_local(client):
    r = client.options(
        "/etiquetas/imprimir",
        headers={
            "Origin": "https://sistema-op.exemplo.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-api-key",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"
    assert r.headers["access-control-allow-private-network"] == "true"


def test_status(client):
    with patch("app.api.encontrar_impressora", return_value="ELGIN L42DT"):
        r = client.get("/status")
    assert r.json() == {"status": "ok", "impressora": "ELGIN L42DT", "impressoraEncontrada": True, "linguagem": "epl"}


def test_simulacao_nao_toca_na_impressora():
    assert impressora.imprimir("^XA^XZ", Settings(SIMULACAO=True)) == "simulação"


def test_impressora_windows_por_palavra_chave():
    with patch.object(impressora, "win32print", object()), patch.object(
        impressora, "impressoras_windows", return_value=["Microsoft Print to PDF", "ELGIN L42DT"]
    ):
        assert impressora.encontrar_impressora(Settings(IMPRESSORA=None)) == "ELGIN L42DT"
        assert impressora.encontrar_impressora(Settings(IMPRESSORA="Outra")) is None


def test_sem_impressora_lista_as_instaladas():
    with patch.object(impressora, "encontrar_impressora", return_value=None), patch.object(
        impressora, "impressoras_windows", return_value=["Microsoft Print to PDF"]
    ):
        with pytest.raises(impressora.ImpressoraIndisponivel, match="Microsoft Print to PDF"):
            impressora.imprimir("^XA^XZ", Settings(SIMULACAO=False))


# ---------------------------------------------------------------------------
# AUT-06: limite de requisições e de cópias por minuto (cada pedido segue 1–1000)
# ---------------------------------------------------------------------------

def test_limite_de_requisicoes_por_minuto(client, impressora_fake):
    with patch.object(settings, "LIMITE_REQUISICOES_MINUTO", 3):
        codigos = [client.post("/etiquetas/zpl", json={**ORION, "copias": 1}).status_code for _ in range(4)]
    assert codigos == [200, 200, 200, 429]


def test_limite_responde_429_com_retry_after(client, impressora_fake):
    with patch.object(settings, "LIMITE_REQUISICOES_MINUTO", 1):
        client.post("/etiquetas/imprimir", json=ORION)
        r = client.post("/etiquetas/imprimir", json=ORION)
    assert r.status_code == 429
    assert r.json()["sucesso"] is False and "por minuto" in r.json()["erro"]
    assert int(r.headers["Retry-After"]) >= 1


def test_mil_copias_num_pedido_continua_permitido(client, impressora_fake):
    r = client.post("/etiquetas/imprimir", json={**ORION, "copias": 1000})
    assert r.status_code == 200 and r.json()["copias"] == 1000


def test_teto_de_copias_por_minuto(client, impressora_fake):
    with patch.object(settings, "LIMITE_COPIAS_MINUTO", 1500):
        assert client.post("/etiquetas/imprimir", json={**ORION, "copias": 1000}).status_code == 200
        r = client.post("/etiquetas/imprimir", json={**ORION, "copias": 600})
        assert r.status_code == 429 and "etiquetas por minuto" in r.json()["erro"]
        assert client.post("/etiquetas/imprimir", json={**ORION, "copias": 500}).status_code == 200
    assert impressora_fake.call_count == 2


def test_pedido_recusado_por_chave_nao_gasta_limite(impressora_fake):
    with patch.object(settings, "LIMITE_REQUISICOES_MINUTO", 1):
        sem_chave = TestClient(app)
        assert sem_chave.post("/etiquetas/imprimir", json=ORION).status_code == 401
        assert TestClient(app, headers={"X-Api-Key": CHAVE}).post("/etiquetas/imprimir", json=ORION).status_code == 200


def test_janela_libera_depois_de_um_minuto():
    from app.limite import LimitadorJanela

    lim = LimitadorJanela()
    assert lim.consumir("ip", "copias", 1000, 1000, agora=0.0) is None
    assert lim.consumir("ip", "copias", 1, 1000, agora=30.0) == 31
    assert lim.consumir("outro-ip", "copias", 1000, 1000, agora=30.0) is None
    assert lim.consumir("ip", "copias", 1000, 1000, agora=60.5) is None


def test_ip_real_do_cloudflare_so_vale_vindo_do_loopback():
    from types import SimpleNamespace
    from app.limite import cliente_da_requisicao

    via_tunel = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"), headers={"cf-connecting-ip": "200.1.2.3"})
    forjado = SimpleNamespace(client=SimpleNamespace(host="192.168.0.50"), headers={"cf-connecting-ip": "200.1.2.3"})
    assert cliente_da_requisicao(via_tunel) == "200.1.2.3"
    assert cliente_da_requisicao(forjado) == "192.168.0.50"


def test_falha_da_impressora_nao_vaza_detalhe(client):
    with patch("app.api.imprimir", side_effect=OSError("C:\\Users\\encarregado\\segredo")):
        r = client.post("/etiquetas/imprimir", json=ORION)
    assert r.status_code == 500
    assert "segredo" not in r.json()["erro"] and "id" in r.json()["erro"]


def test_cors_configuravel_por_env():
    s = Settings(CORS_ORIGINS="https://op.norvia.example, https://outro.exemplo")
    assert s.origens_cors() == ["https://op.norvia.example", "https://outro.exemplo"]
    assert Settings(CORS_ORIGINS="").origens_cors() == ["*"]


# ---------------------------------------------------------------------------
# EPL (PPLB): a linguagem que a Elgin L42-DT imprime de fato
# ---------------------------------------------------------------------------

from app.etiquetas_epl import codificar_epl, escapar, gerar_epl, quebrar_linhas  # noqa: E402

REGUA = {
    "sku": "REG-PVC-BRANCO-200",
    "descricao": "Régua PVC Branco 200cm Revesta Acabamento",
    "gtin": "7890873710129",
    "localizacao": "Rua B - Prateleira 4",
    "copias": 1,
}


def _linhas(epl):
    return epl.split("\r\n")


def test_epl_cabecalho_e_copias():
    epl = gerar_epl(REGUA, copias=7, densidade=12, gap_dots=30)
    linhas = _linhas(epl)
    assert linhas[:6] == ["", "N", "I8,A,055", "q480", "Q320,30", "D12"]
    assert linhas[-2:] == ["P7", ""]
    assert gerar_epl(REGUA, copias=5000).rstrip().endswith("P1000")


def test_epl_com_ean_e_code128():
    epl = gerar_epl(REGUA)
    assert 'E30,2,2,80,B,"789087371012"' in epl  # 12 dígitos, legível com barras altas
    code128 = [l for l in _linhas(epl) if l.startswith("B") and ",0,1," in l]
    assert len(code128) == 1 and code128[0].endswith(',N,"REG-PVC-BRANCO-200"')
    assert 'A16,13,0,3,1,1,N,"Régua PVC Branco 200cm Revesta"' in epl


def test_epl_gtin_de_12_digitos_vira_ean13():
    assert 'E30,2,2,80,B,"079087371012"' in gerar_epl({**REGUA, "gtin": "790873710129"})


def test_epl_sem_ean_texto_usa_largura_toda():
    epl = gerar_epl({**REGUA, "gtin": "123"})
    assert "E30" not in epl
    # sem EAN a faixa do meio tem 448 pontos: "Rua B - Prateleira 4" cabe numa linha
    assert 'A16,137,0,2,1,1,N,"Rua B - Prateleira 4"' in epl


def test_epl_sku_nao_ascii_sem_code128():
    epl = gerar_epl({**REGUA, "sku": "RÉGUA-01"})
    assert not [l for l in _linhas(epl) if l.startswith("B") and ",0,1," in l]
    assert '"RÉGUA-01"' in epl  # o SKU continua como texto


def test_epl_escapa_aspas_e_barra():
    assert escapar('Perfil 1/2" \\ x') == 'Perfil 1/2\\" \\\\ x'
    epl = gerar_epl({**REGUA, "descricao": 'Tubo 3/4" com \\ barra', "sku": 'A"B'})
    assert 'N,"Tubo 3/4\\" com \\\\ barra"' in epl
    assert ',N,"A\\"B"' in epl


def test_epl_quebra_em_4_linhas_com_reticencias():
    longo = "Perfil de aluminio anodizado para fita LED com difusor leitoso " * 3
    epl = gerar_epl({**REGUA, "descricao": longo})
    nome = [l for l in _linhas(epl) if l.startswith("A16,") and int(l.split(",")[1]) < 100]
    assert len(nome) == 4
    assert nome[-1].endswith('..."')
    assert all(len(l.split('N,"', 1)[1]) - 1 <= 38 for l in nome)


def test_epl_produto_longo_nao_corta_microtexturizado():
    prod = {
        "sku": "HNYRPI06-2M-26",
        "descricao": "Rodapé Invertido Curvo Lete em Aluminio com Aba para LED 60mm x 20mm - Norvia - Off-White Microtexturizado - 2m",
        "gtin": "7908737102215",
        "localizacao": "A1-RC-P1-N1-AP2",
        "copias": 1,
    }
    epl = gerar_epl(prod)
    # Não pode ter reticências no nome: deve caber inteiro
    assert "..." not in epl
    assert "Microtexturizado - 2m" in epl
    # EAN deve ter barras altas (80 pontos)
    assert 'E30,2,2,80,B,"790873710221"' in epl


def test_quebrar_linhas_corta_palavra_maior_que_a_linha():
    assert quebrar_linhas("ABCDEFGHIJ KL", 4, 4) == ["ABCD", "EFGH", "IJ", "KL"]
    assert quebrar_linhas("um dois tres quatro", 9, 2) == ["um dois", "tres..."]


def test_epl_codificado_em_cp1252():
    dados = codificar_epl(gerar_epl(REGUA))
    assert "Régua".encode("cp1252") in dados and "Régua".encode("utf-8") not in dados
    assert codificar_epl('"emoji ☺"') == b'"emoji ?"'


def test_epl_remover_acentos():
    epl = gerar_epl(REGUA, remover_acentos=True)
    assert '"Regua PVC Branco 200cm Revesta"' in epl


def test_epl_densidade_invalida():
    with pytest.raises(ValueError):
        gerar_epl(REGUA, densidade=16)


def test_imprimir_em_epl_por_padrao(client, impressora_fake):
    r = client.post("/etiquetas/imprimir", json={**REGUA, "copias": 3})
    assert r.status_code == 200
    comando = impressora_fake.call_args.args[0]
    assert comando.startswith("\r\nN\r\n") and comando.rstrip().endswith("P3")
    assert impressora_fake.call_args.kwargs["codificacao"] == "cp1252"


def test_rota_comandos_e_zpl_seguem_a_linguagem(client, impressora_fake):
    epl = client.post("/etiquetas/comandos", json=REGUA)
    assert epl.status_code == 200 and "I8,A,055" in epl.text and epl.headers["x-linguagem"] == "epl"
    assert "I8,A,055" in client.post("/etiquetas/zpl", json=REGUA).text
    with patch.object(settings, "LINGUAGEM", "zpl"):
        assert client.post("/etiquetas/comandos", json=REGUA).text.startswith("^XA")
    impressora_fake.assert_not_called()


def test_impressora_envia_epl_em_cp1252(tmp_path):
    destino = tmp_path / "lp0"
    destino.write_bytes(b"")
    cfg = Settings(SIMULACAO=False, DISPOSITIVO_USB=str(destino))
    with patch.object(impressora, "win32print", None):
        impressora.imprimir('A1,1,0,1,1,1,N,"Régua"', cfg, codificacao="cp1252")
        assert destino.read_bytes() == 'A1,1,0,1,1,1,N,"Régua"'.encode("cp1252")
        impressora.imprimir("^FDRégua^FS", cfg)
        assert destino.read_bytes() == "^FDRégua^FS".encode("utf-8")


def test_config_linguagem_e_limites():
    assert Settings(LINGUAGEM="ZPL").LINGUAGEM == "zpl"
    for invalido in ({"LINGUAGEM": "pdf"}, {"DENSIDADE": 16}, {"GAP_DOTS": -1}):
        with pytest.raises(Exception):
            Settings(**invalido)


def test_config_invalida_no_env_para_com_mensagem_clara(monkeypatch):
    from app import config

    monkeypatch.setenv("LINGUAGEM", "pdf")
    with pytest.raises(SystemExit, match="Configuração inválida no .env — LINGUAGEM"):
        config._carregar()
