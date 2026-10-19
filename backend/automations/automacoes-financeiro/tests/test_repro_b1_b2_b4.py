"""Testes de reprodução para B1, B2 e B4 (Fase 1 - QA Engineer)."""
import os
from decimal import Decimal
from unittest.mock import MagicMock, patch
import pytest
import requests

from app.config import Settings
from app.tiny_client import TinyClient
from app.ml_apis import (
    obter_credenciais_tms,
    sincronizar_tokens_ml_tms,
    renovar_token_ml_oauth,
    _mesmo_instante,
)
import app.ml_reconciliation as ml
import app.ml_reconciliation_rotina as rot


# ==============================================================================
# B1: Baixa de conta a receber repete POST após timeout de leitura (baixa em dobro)
# ==============================================================================

def test_b1_baixar_conta_receber_read_timeout_com_baixa_ja_confirmada_faz_apenas_1_post():
    """
    B1: Após ReadTimeout, se a conta já foi baixada no Tiny (comprovado pela releitura),
    NÃO deve fazer um segundo POST (evitar baixa dupla).
    """
    client = TinyClient()
    mock_post = MagicMock(side_effect=[
        requests.exceptions.ReadTimeout("Timeout de leitura do Tiny"),
        MagicMock(status_code=200, json=lambda: {}),
    ])
    # Releitura indica que a baixa entrou
    mock_obter = MagicMock(return_value={
        "id": 12345,
        "situacao": "liquidado",
        "saldo": 0.0,
        "valorPago": 100.0,
    })

    with patch("requests.post", mock_post), \
         patch.object(client, "obter_conta_receber_v3", mock_obter), \
         patch("time.sleep"):
        client.baixar_conta_receber_v3(
            token="fake_token",
            conta_id=12345,
            valor_pago=100.0,
            data_pagamento="2026-10-13",
            conta_destino_id=1,
            categoria_id=2,
        )

    # Esperado: 1 único POST e consulta de releitura chamada
    assert mock_post.call_count == 1
    assert mock_obter.called


def test_b1_read_timeout_com_releitura_falhando_levanta_estado_incerto():
    """
    B1: Após ReadTimeout, se a releitura falhar, deve levantar RuntimeError informando
    estado incerto e NÃO tentar novo POST cego.
    """
    client = TinyClient()
    mock_post = MagicMock(side_effect=[
        requests.exceptions.ReadTimeout("Timeout de leitura"),
        MagicMock(status_code=200, json=lambda: {}),
    ])
    mock_obter = MagicMock(side_effect=requests.RequestException("Erro ao reler conta"))

    with patch("requests.post", mock_post), \
         patch.object(client, "obter_conta_receber_v3", mock_obter), \
         patch("time.sleep"):
        with pytest.raises(RuntimeError, match="incerto|Confira no Tiny"):
            client.baixar_conta_receber_v3(
                token="fake_token",
                conta_id=12345,
                valor_pago=100.0,
                data_pagamento="2026-10-13",
                conta_destino_id=1,
                categoria_id=2,
            )

    assert mock_post.call_count == 1


def test_b1_read_timeout_sem_baixa_repete_post_e_sucesso():
    """
    B1: Após ReadTimeout, se a releitura demonstrar que a baixa NÃO entrou (conta intocada),
    deve repetir o POST e concluir com sucesso (2 POSTs, 1 releitura).
    """
    client = TinyClient()
    mock_post = MagicMock(side_effect=[
        requests.exceptions.ReadTimeout("Timeout de leitura"),
        MagicMock(status_code=200, json=lambda: {}),
    ])
    # Releitura indica conta ainda aberta e sem pagamento
    mock_obter = MagicMock(return_value={
        "id": 12345,
        "situacao": "aberto",
        "saldo": 100.0,
        "valorPago": 0.0,
    })

    with patch("requests.post", mock_post), \
         patch.object(client, "obter_conta_receber_v3", mock_obter), \
         patch("time.sleep"):
        client.baixar_conta_receber_v3(
            token="fake_token",
            conta_id=12345,
            valor_pago=100.0,
            data_pagamento="2026-10-13",
            conta_destino_id=1,
            categoria_id=2,
            conta_atual={"situacao": "aberto", "saldo": 100.0, "valorPago": 0.0},
        )

    assert mock_post.call_count == 2
    assert mock_obter.call_count == 1


def test_b1_connect_timeout_repete_sem_releitura():
    """
    B1: Em ConnectTimeout comprovado (falha antes do envio), repete sem reler a conta.
    """
    client = TinyClient()
    mock_post = MagicMock(side_effect=[
        requests.exceptions.ConnectTimeout("Falha ao conectar no Tiny"),
        MagicMock(status_code=200, json=lambda: {}),
    ])
    mock_obter = MagicMock()

    with patch("requests.post", mock_post), \
         patch.object(client, "obter_conta_receber_v3", mock_obter), \
         patch("time.sleep"):
        client.baixar_conta_receber_v3(
            token="fake_token",
            conta_id=12345,
            valor_pago=100.0,
            data_pagamento="2026-10-13",
            conta_destino_id=1,
            categoria_id=2,
        )

    assert mock_post.call_count == 2
    mock_obter.assert_not_called()


# ==============================================================================
# B2: Produto e frete em 2 POSTs sob uma única tentativa pendente
# ==============================================================================


def test_b2_produto_e_frete_tentativa_unica_descarta_pendencia_e_baixa_duplo(tmp_path):
    """
    B2: Se o POST do produto entra (80) e o do frete falha (20), o estado por POST
    deve evitar que na próxima execução o produto seja baixado novamente (total R$ 180 em vez de 100).
    """
    cfg = Settings(DATA_DIR=tmp_path)
    estado = rot.EstadoML(cfg=cfg)

    posts_efetuados = []

    class FakeTiny:
        def __init__(self):
            self.contas = {
                101: {"id": 101, "situacao": "aberto", "valor": 200.0, "saldo": 200.0, "valorPago": 0.0}
            }

        def obter_contas_financeiras_v3(self, token):
            return [{"id": 1, "descricao": "Banco Inter"}]

        def list_categorias_receita_despesa_v3(self, token):
            return [
                {"id": 10, "descricao": "Vendas Mercado Livre"},
                {"id": 20, "descricao": "Fretes sobre Vendas"},
            ]

        def obter_conta_receber_v3(self, token, cid):
            return self.contas[cid]

    tiny = FakeTiny()
    rotina = rot.RotinaConciliacaoML(
        estado=estado,
        cfg=cfg,
        tiny=tiny,
        fabrica_mp=lambda e: None,
        fabrica_ml=lambda e: None,
        obter_token_tiny=lambda emp: "tok-tiny",
    )
    cat_frete = rotina.resolvedor.categoria_frete_id(ml.EMPRESAS_ML["norvia_campinas"])

    def baixar_conta_receber_v3_com_falha_frete(token, cid, valor_pago, categoria_id, **kw):
        if categoria_id == cat_frete:  # frete falha na 1ª tentativa
            raise RuntimeError("Erro ao baixar frete no Tiny (400)")
        posts_efetuados.append((categoria_id, Decimal(str(valor_pago))))
        # produto entra com sucesso
        tiny.contas[cid]["valorPago"] += float(valor_pago)
        tiny.contas[cid]["saldo"] -= float(valor_pago)
        tiny.contas[cid]["situacao"] = "parcial"

    tiny.baixar_conta_receber_v3 = baixar_conta_receber_v3_com_falha_frete

    grupo = ml.GrupoRecebimento(
        id="G1",
        id_venda="VENDA-1",
        indices=[0, 1],
        chaves=["k-prod", "k-frete"],
        valor_total=Decimal("100.00"),
        data="2026-10-13",
        nome_cliente="Cliente Teste",
        situacao=ml.SIT_APTO_BAIXA,
        valor_produtos=Decimal("80.00"),
        valor_frete=Decimal("20.00"),
        conta_id=101,
        conta_saldo=Decimal("200.00"),
        conta_valor=Decimal("200.00"),
        conta_valor_pago=Decimal("0.00"),
        contas_vinculadas=[{"id": 101, "valor": 200.0, "saldo": 200.0, "valorPago": 0.0}],
    )

    analise = ml.Analise(
        id="A1",
        empresa_id="norvia_campinas",
        empresa_nome="Norvia Campinas",
        conta_lancamento="Banco Inter",
        criada_em="2026-10-13T10:00:00",
        periodo_de="2026-10-13",
        periodo_ate="2026-10-13",
        origem="manual",
        execucao_id="ex1",
        movimentos=[],
        grupos=[grupo],
        lancamentos=ml.ResultadoLancamentos([], []),
        comparativo=[],
        fontes={},
        tiny_consultado=True,
    )
    estado.salvar_analise(analise)

    # 1ª Execução: produto (80) entra, frete (20) falha
    res1 = rotina.baixar("A1", ["G1"], usuario="admin")
    assert res1["total_falhas"] == 1

    # 2ª Execução: o frete agora responderia com sucesso
    def baixar_frete_sucesso(token, cid, valor_pago, categoria_id, **kw):
        posts_efetuados.append((categoria_id, Decimal(str(valor_pago))))
        tiny.contas[cid]["valorPago"] += float(valor_pago)
        tiny.contas[cid]["saldo"] -= float(valor_pago)
        if tiny.contas[cid]["saldo"] <= 0:
            tiny.contas[cid]["situacao"] = "liquidado"

    tiny.baixar_conta_receber_v3 = baixar_frete_sucesso

    # Se B2 não estiver corrigido, a pendência foi descartada e o produto é baixado de novo!
    rotina.baixar("A1", ["G1"], usuario="admin")

    _, cat_prod = rotina.resolvedor.ids(ml.EMPRESAS_ML["norvia_campinas"])
    posts_produto = [p for p in posts_efetuados if p[0] == cat_prod]
    total_baixado = sum(p[1] for p in posts_efetuados)

    assert len(posts_produto) == 1, f"Produto foi baixado {len(posts_produto)} vezes! Esperado 1."
    assert total_baixado <= Decimal("100.00"), f"Total baixado ({total_baixado}) excedeu R$ 100!"


def test_b2_falha_frete_com_releitura_indisponivel_mantem_pendencia(tmp_path):
    """
    B2: Se o frete falha e a releitura do Tiny falhar (indisponível), deve levantar erro
    de estado incerto SEM descartar a pendência.
    """
    cfg = Settings(DATA_DIR=tmp_path)
    estado = rot.EstadoML(cfg=cfg)

    class FakeTiny:
        def __init__(self):
            self.contas = {
                101: {"id": 101, "situacao": "aberto", "valor": 100.0, "saldo": 100.0, "valorPago": 0.0}
            }

        def obter_contas_financeiras_v3(self, token):
            return [{"id": 1, "descricao": "Banco Inter"}]

        def list_categorias_receita_despesa_v3(self, token):
            return [
                {"id": 10, "descricao": "Vendas Mercado Livre"},
                {"id": 20, "descricao": "Fretes sobre Vendas"},
            ]

        def obter_conta_receber_v3(self, token, cid):
            return self.contas[cid]

        def baixar_conta_receber_v3(self, token, cid, valor_pago, categoria_id, **kw):
            cat_frete = 20
            if categoria_id == cat_frete:
                raise RuntimeError("Falha de rede ao baixar frete")
            self.contas[cid]["valorPago"] += float(valor_pago)
            self.contas[cid]["saldo"] -= float(valor_pago)

    tiny = FakeTiny()
    rotina = rot.RotinaConciliacaoML(
        estado=estado,
        cfg=cfg,
        tiny=tiny,
        fabrica_mp=lambda e: None,
        fabrica_ml=lambda e: None,
        obter_token_tiny=lambda emp: "tok-tiny",
    )
    cat_frete = rotina.resolvedor.categoria_frete_id(ml.EMPRESAS_ML["norvia_campinas"])

    def baixar_conta_receber_v3_com_falha(token, cid, valor_pago, categoria_id, **kw):
        if categoria_id == cat_frete:
            raise RuntimeError("Falha de rede ao baixar frete")
        tiny.contas[cid]["valorPago"] += float(valor_pago)
        tiny.contas[cid]["saldo"] -= float(valor_pago)

    tiny.baixar_conta_receber_v3 = baixar_conta_receber_v3_com_falha

    grupo = ml.GrupoRecebimento(
        id="G1",
        id_venda="VENDA-1",
        indices=[0, 1],
        chaves=["k-prod", "k-frete"],
        valor_total=Decimal("100.00"),
        data="2026-10-13",
        nome_cliente="Cliente Teste",
        situacao=ml.SIT_APTO_BAIXA,
        valor_produtos=Decimal("80.00"),
        valor_frete=Decimal("20.00"),
        conta_id=101,
        conta_saldo=Decimal("100.00"),
        conta_valor=Decimal("100.00"),
        conta_valor_pago=Decimal("0.00"),
        contas_vinculadas=[{"id": 101, "valor": 100.0, "saldo": 100.0, "valorPago": 0.0}],
    )

    analise = ml.Analise(
        id="A1",
        empresa_id="norvia_campinas",
        empresa_nome="Norvia Campinas",
        conta_lancamento="Banco Inter",
        criada_em="2026-10-13T10:00:00",
        periodo_de="2026-10-13",
        periodo_ate="2026-10-13",
        origem="manual",
        execucao_id="ex1",
        movimentos=[],
        grupos=[grupo],
        lancamentos=ml.ResultadoLancamentos([], []),
        comparativo=[],
        fontes={},
        tiny_consultado=True,
    )
    estado.salvar_analise(analise)

    # Simula erro de releitura ao tentar confirmar se frete entrou
    original_obter = tiny.obter_conta_receber_v3
    def obter_com_falha(token, cid):
        # A primeira leitura (antes da baixa) funciona; na checagem após o erro de frete falha
        if tiny.contas[cid]["saldo"] < 100.0:
            raise RuntimeError("Tiny offline na releitura")
        return original_obter(token, cid)

    tiny.obter_conta_receber_v3 = obter_com_falha

    res = rotina.baixar("A1", ["G1"], usuario="admin")
    assert res["total_falhas"] == 1

    # A pendência do frete DEVE estar mantida no estado
    pendencias = estado.ler().get("baixas_pendentes") or {}
    chk_frete = "norvia_campinas|101|VENDA-1|frete"
    assert chk_frete in pendencias


def test_b2_caminho_feliz_dois_posts_e_grupo_conciliado(tmp_path):
    """
    B2: Caminho feliz com produto e frete baixados com sucesso em 2 POSTs -> grupo conciliado.
    """
    cfg = Settings(DATA_DIR=tmp_path)
    estado = rot.EstadoML(cfg=cfg)

    posts = []

    class FakeTiny:
        def __init__(self):
            self.contas = {
                101: {"id": 101, "situacao": "aberto", "valor": 100.0, "saldo": 100.0, "valorPago": 0.0}
            }

        def obter_contas_financeiras_v3(self, token):
            return [{"id": 1, "descricao": "Banco Inter"}]

        def list_categorias_receita_despesa_v3(self, token):
            return [
                {"id": 10, "descricao": "Vendas Mercado Livre"},
                {"id": 20, "descricao": "Fretes sobre Vendas"},
            ]

        def obter_conta_receber_v3(self, token, cid):
            return self.contas[cid]

        def baixar_conta_receber_v3(self, token, cid, valor_pago, categoria_id, **kw):
            posts.append((categoria_id, Decimal(str(valor_pago))))
            self.contas[cid]["valorPago"] += float(valor_pago)
            self.contas[cid]["saldo"] -= float(valor_pago)
            if self.contas[cid]["saldo"] <= 0:
                self.contas[cid]["situacao"] = "liquidado"

    tiny = FakeTiny()
    rotina = rot.RotinaConciliacaoML(
        estado=estado,
        cfg=cfg,
        tiny=tiny,
        fabrica_mp=lambda e: None,
        fabrica_ml=lambda e: None,
        obter_token_tiny=lambda emp: "tok-tiny",
    )

    grupo = ml.GrupoRecebimento(
        id="G1",
        id_venda="VENDA-1",
        indices=[0, 1],
        chaves=["k-prod", "k-frete"],
        valor_total=Decimal("100.00"),
        data="2026-10-13",
        nome_cliente="Cliente Teste",
        situacao=ml.SIT_APTO_BAIXA,
        valor_produtos=Decimal("80.00"),
        valor_frete=Decimal("20.00"),
        conta_id=101,
        conta_saldo=Decimal("100.00"),
        conta_valor=Decimal("100.00"),
        conta_valor_pago=Decimal("0.00"),
        contas_vinculadas=[{"id": 101, "valor": 100.0, "saldo": 100.0, "valorPago": 0.0}],
    )

    analise = ml.Analise(
        id="A1",
        empresa_id="norvia_campinas",
        empresa_nome="Norvia Campinas",
        conta_lancamento="Banco Inter",
        criada_em="2026-10-13T10:00:00",
        periodo_de="2026-10-13",
        periodo_ate="2026-10-13",
        origem="manual",
        execucao_id="ex1",
        movimentos=[],
        grupos=[grupo],
        lancamentos=ml.ResultadoLancamentos([], []),
        comparativo=[],
        fontes={},
        tiny_consultado=True,
    )
    estado.salvar_analise(analise)

    res = rotina.baixar("A1", ["G1"], usuario="admin")
    assert res["total_sucessos"] == 1
    assert len(posts) == 2
    analise_depois = estado.analise("A1")
    assert analise_depois is not None
    assert analise_depois.grupos[0].situacao == ml.SIT_CONCILIADO





# ==============================================================================
# B4: Renovação de tokens ML ignora MOCK_MODE e lê .env de outra automação
# ==============================================================================

def test_b4_mock_mode_respeitado_sem_chamadas_de_rede():
    """
    B4: Com MOCK_MODE=true, sincronizar_tokens_ml_tms não deve fazer chamadas de rede
    e deve devolver resposta de mock conforme contrato.
    """
    cfg = Settings(MOCK_MODE=True)
    mock_session = MagicMock()

    res = sincronizar_tokens_ml_tms(cfg, http=mock_session)

    # Deve retornar dicionário de tokens mockados e não chamar rede
    assert "norvia" in res and "revesta" in res
    assert res["norvia"]["access_token"] == "mock-token-norvia"
    assert res["revesta"]["access_token"] == "mock-token-revesta"
    assert mock_session.post.call_count == 0
    assert mock_session.get.call_count == 0


def test_b4_obter_credenciais_tms_nao_le_env_de_outras_pastas(tmp_path, monkeypatch):
    """
    B4: obter_credenciais_tms não deve varrer arquivos .env no cwd ou pastas de outras automações.
    """
    # Cria um .env falso no diretório atual
    env_falso = tmp_path / ".env"
    env_falso.write_text("TMS_USER=usuario_infiltrado\nTMS_PASSWORD=senha_infiltrada\n", encoding="utf-8")

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TMS_USER", raising=False)
    monkeypatch.delenv("TMS_PASSWORD", raising=False)
    monkeypatch.delenv("TMS_NAME", raising=False)
    monkeypatch.delenv("TMS_PASS", raising=False)

    cfg = Settings(TMS_USER=None, TMS_PASSWORD=None)
    _, user, pwd = obter_credenciais_tms(cfg)

    assert user != "usuario_infiltrado", "obter_credenciais_tms leu .env no diretório de trabalho!"
    assert pwd != "senha_infiltrada", "obter_credenciais_tms leu senha do .env no diretório de trabalho!"


# ==============================================================================
# SA-07: Renovação OAuth própria desligada por padrão
# ==============================================================================

def test_sa07_oauth_proprio_desligado_por_padrao_nao_chama_rede():
    """
    SA-07: Sem ML_OAUTH_RENOVACAO_PROPRIA=True, renovar_token_ml_oauth não chama rede
    e retorna None.
    """
    cfg = Settings(
        ML_OAUTH_RENOVACAO_PROPRIA=False,
        ML_NORVIA_CLIENT_ID="cid_test",
        ML_NORVIA_CLIENT_SECRET="secret_test",
    )
    mock_session = MagicMock()

    res = renovar_token_ml_oauth("norvia", "TG-refresh-test", cfg=cfg, http=mock_session)

    assert res is None
    assert mock_session.post.call_count == 0


# ==============================================================================
# SA-08: Rota de sincronização de tokens sem vazar detalhe e com cooldown
# ==============================================================================

def test_sa08_tokens_sincronizar_contrato_sem_token_prefixo_e_com_cooldown():
    """
    SA-08: POST /api/v1/conciliacao-ml/tokens/sincronizar:
    - Retorna ok: False se conta falhar
    - Sem token_prefixo
    - 429 na segunda chamada dentro de 60s
    """
    from fastapi.testclient import TestClient
    from app.api import app
    import app.api as api_mod

    api_mod._ML_TOKENS_SYNC_LAST_TS = 0.0

    client = TestClient(app)

    # 1. Mock de sincronização com apenas 1 conta renovada
    with patch("app.api.sincronizar_todos_tokens_ml", return_value={"norvia": {"access_token": "token_norvia"}}), \
         patch("app.api._candidatos_ml_tokens_files", return_value=[]), \
         patch("app.api.token_esta_valido", side_effect=lambda d: bool(d.get("access_token"))):
        resp = client.post("/api/v1/conciliacao-ml/tokens/sincronizar")
        assert resp.status_code == 200
        dados = resp.json()
        assert dados["ok"] is False  # revesta não renovou
        assert "token_prefixo" not in str(dados)
        assert dados["contas"]["norvia"]["renovado"] is True
        assert dados["contas"]["revesta"]["renovado"] is False
        assert dados["contas"]["revesta"].get("motivo") is not None

        # 2. Segunda chamada imediata dispara 429
        resp2 = client.post("/api/v1/conciliacao-ml/tokens/sincronizar")
        assert resp2.status_code == 429
        assert "segundos" in resp2.json()["detail"]

    # 3. Exceção inesperada gera 500 genérico com erro_id sem vazar stack trace
    api_mod._ML_TOKENS_SYNC_LAST_TS = 0.0
    with patch("app.api.sincronizar_todos_tokens_ml", side_effect=Exception("DB_PASSWORD_LEAK")):
        resp3 = client.post("/api/v1/conciliacao-ml/tokens/sincronizar")
        assert resp3.status_code == 500
        d3 = resp3.json()
        assert "DB_PASSWORD_LEAK" not in d3["detail"]
        assert "erro_id" in d3


# ==============================================================================
# SA-09 & SA-10: sync_ml_tokens.py segurança CLI
# ==============================================================================

def test_sa09_cli_sync_tokens_sem_argumento_password():
    """SA-09: argparse de sync_ml_tokens não deve aceitar --password."""
    import scripts.sync_ml_tokens as sync_script

    with pytest.raises(SystemExit):
        # argparse levanta SystemExit ao encontrar argumento desconhecido
        sync_script.main_parser = None
        with patch("sys.argv", ["sync_ml_tokens.py", "--password", "secret123"]):
            sync_script.main()


def test_sa09_carregar_env_sem_arquivo_nao_le_env(tmp_path, monkeypatch):
    """SA-09: carregar_env() sem argumento explícito não lê .env do disco."""
    import scripts.sync_ml_tokens as sync_script

    arquivo_env = tmp_path / ".env"
    arquivo_env.write_text("TMS_PASSWORD=vazamento_env\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TMS_PASSWORD", raising=False)

    sync_script.carregar_env(None)
    assert os.environ.get("TMS_PASSWORD") is None


def test_sa10_insecure_recusa_host_publico():
    """SA-10: http_request_json com insecure=True recusa host público."""
    import scripts.sync_ml_tokens as sync_script

    with pytest.raises(ValueError, match="permitida apenas em hosts loopback"):
        sync_script.http_request_json("https://servidor.norvia.example/api", insecure=True)


# ==============================================================================
# I2: Frete em reprocessamento não baixa em dobro e reconhece grupo legado
# ==============================================================================

def test_i2_frete_ja_exportado_nao_entra_no_valor_e_grupo_legado_conciliado():
    """
    I2: Linha de frete cuja chave já foi exportada não entra no valor do grupo;
    grupo com chave de produto já baixada sob chave antiga continua reconhecido como SIT_CONCILIADO.
    """
    mov_prod = ml.Movimento(
        indice=1,
        data="10/10/2026",
        tipo_operacao=ml.TIPO_RECEBIMENTO,
        descricao_mp="Venda produto",
        id_pagamento="PAG100",
        id_pedido="PED100",
        id_pacote="",
        valor=Decimal("150.00"),
        linha_relatorio=2,
    )
    mov_frete = ml.Movimento(
        indice=2,
        data="10/10/2026",
        tipo_operacao=ml.TIPO_RECEBIMENTO_FRETE,
        descricao_mp="Frete",
        id_pagamento="PAG100",
        id_pedido="PED100",
        id_pacote="",
        valor=Decimal("20.00"),
        linha_relatorio=3,
    )

    # 1. Frete já exportado em período anterior
    exportados = {mov_frete.chave: "2026-10-09"}
    grupos = ml.obter_grupos([mov_prod, mov_frete], exportados=exportados)
    assert len(grupos) == 1
    g = grupos[0]
    assert g.valor_frete == Decimal("0")
    assert g.valor_total == Decimal("150.00")

    # 2. Grupo com produto já baixado no registro legado continua SIT_CONCILIADO
    chave_prod_legada = f"PAG100|10/10/2026|{ml.TIPO_RECEBIMENTO}|150.00|2"
    baixas_legadas = {chave_prod_legada: "2026-10-08"}
    grupos_legados = ml.obter_grupos([mov_prod, mov_frete], baixas_feitas=baixas_legadas)
    assert grupos_legados[0].situacao == ml.SIT_CONCILIADO


# ==============================================================================
# I3: Reservas de operações diferentes só anuladas se uma não tiver SOURCE_ID
# ==============================================================================

def test_i3_reservas_com_source_id_diferentes_nao_sao_anuladas():
    """
    I3: Duas reservas com pagamentos diferentes, mesma data e valor oposto,
    ambas com SOURCE_ID (id_pagamento), NÃO devem ser anuladas.
    """
    res1 = ml.Movimento(
        indice=1,
        data="10/10/2026",
        tipo_operacao=ml.TIPO_RESERVA[1],  # Dinheiro retido
        descricao_mp="Retenção",
        id_pagamento="OP_A",
        id_pedido="",
        id_pacote="",
        valor=Decimal("-50.00"),
        linha_relatorio=2,
    )
    res2 = ml.Movimento(
        indice=2,
        data="10/10/2026",
        tipo_operacao=ml.TIPO_RESERVA[0],  # Liberação de dinheiro retido
        descricao_mp="Liberação",
        id_pagamento="OP_B",
        id_pedido="",
        id_pacote="",
        valor=Decimal("50.00"),
        linha_relatorio=3,
    )

    marcas = ml.verificar_anulacoes([res1, res2])
    assert marcas.get(1) != ml.SIT_ANULADA
    assert marcas.get(2) != ml.SIT_ANULADA


# ==============================================================================
# I4: _mesmo_instante rejeita datas com horários diferentes
# ==============================================================================

def test_i4_mesmo_instante_rejeita_janela_diferente():
    """I4: _mesmo_instante com mesmo dia e horas diferentes não deve coincidir."""
    t1 = "2026-10-10T08:00:00Z"
    t2 = "2026-10-10T14:00:00Z"
    assert _mesmo_instante(t1, t2) is False


# ==============================================================================
# S2: Parcela sem saldo e sem valor deixa conta_saldo None
# ==============================================================================

def test_s2_parcelas_com_saldo_desconhecido_deixa_grupo_com_saldo_none():
    """S2: Parcela sem saldo nem valor informados deixa grupo.conta_saldo None."""
    g = ml.GrupoRecebimento(
        id="G1",
        id_venda="123",
        indices=[1],
        chaves=["k1"],
        valor_total=Decimal("100.00"),
        valor_produtos=Decimal("100.00"),
        valor_frete=Decimal("0.00"),
        data="10/10/2026",
        nome_cliente="Cliente",
    )
    contas = [
        {"id": 1, "situacao": "aberto", "saldo": 50.0, "valor": 50.0},
        {"id": 2, "situacao": "aberto", "saldo": None, "valor": None},
    ]
    ml.aplicar_contas_ao_grupo(g, contas)
    assert g.conta_saldo is None
    ml.avaliar_conta(g)
    assert g.situacao == ml.SIT_SALDO_DESCONHECIDO

