from app.estado import Estado
from app.padronizacao import Padronizacao, vazio_dimensoes
from tests.conftest import MLFalso, TinyFalso, item, medidas, produto_tiny


def _padronizacao(tmp_path, repo, ml_por_conta, tiny_por_conta):
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    estado_fretes = Estado(tmp_path)
    p = Padronizacao(
        estado_dim,
        repo,
        fabrica_ml=lambda f: ml_por_conta.setdefault(f, MLFalso([])),
        fabrica_tiny=lambda c: tiny_por_conta.setdefault(c, TinyFalso([])),
        pausa=0,
        estado_fretes=estado_fretes,
        espera_conferencia=0,
    )
    return p, estado_dim, estado_fretes


def _pacote(a, l, c, peso):
    return [
        {"id": "SELLER_PACKAGE_HEIGHT", "value_name": f"{a} cm"},
        {"id": "SELLER_PACKAGE_WIDTH", "value_name": f"{l} cm"},
        {"id": "SELLER_PACKAGE_LENGTH", "value_name": f"{c} cm"},
        {"id": "SELLER_PACKAGE_WEIGHT", "value_name": f"{peso} g"},
    ]


def test_anuncio_diferente_do_tiny_fica_a_enviar_com_as_diferencas(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV83", "Cantoneira 16x16mm 3m", medidas(1.6, 1.6, 300, 0.85, pesoLiquido=0.8))])
    ml = MLFalso([item("MLB1", "Cantoneira 16x16mm 3m", sku="PV83",
                       atributos=[{"id": "LENGTH", "value_name": "2 m"}, {"id": "WEIGHT", "value_name": "500 g"}])])
    p, estado_dim, estado_fretes = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    ex = p.coletar()

    assert ex["status"] == "ok", ex
    prod = estado_dim.ler()["produtos"]["PV83"]
    assert prod["status"] == "pendente"
    anuncio = prod["anuncios"][0]
    assert anuncio["situacao"] == "diferente" and anuncio["conta_tiny"] == "Tiny Norvia Campinas"
    assert anuncio["ficha_alvo"] == {"LENGTH": 300.0, "WEIGHT": 850.0}, "peso bruto na ficha"
    assert anuncio["embalagem_alvo"] == {"altura": 1.6, "largura": 1.6, "comprimento": 300.0, "peso": 850}, "embalagem = Tiny"
    assert any("LENGTH" in d for d in anuncio["diferencas"]) and any("Embalagem" in d for d in anuncio["diferencas"])
    assert prod["tiny"][0]["medidas"] == {"altura": 1.6, "largura": 1.6, "comprimento": 300.0, "peso": 850}
    assert estado_fretes.ler()["avisos"][-1]["tipo"] == "dimensoes_pendencias"
    assert ml.atributos_enviados == [] and ml.medidas_enviadas == [], "a coleta não envia nada"


def test_anuncio_igual_ao_tiny_ja_esta_padronizado(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil 1m", medidas(1.6, 1.6, 98, 0.4))])
    ml = MLFalso([item("MLB1", "Perfil 1m", sku="A", atributos=[{"id": "LENGTH", "value_name": "98 cm"}, *_pacote(2, 2, 98, 400)])])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    prod = estado_dim.ler()["produtos"]["A"]
    assert prod["status"] == "padronizado" and prod["anuncios"][0]["diferencas"] == []


def test_cada_conta_do_ml_le_o_tiny_da_propria_empresa(tmp_path, repo):
    tiny_g = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    tiny_p = TinyFalso([produto_tiny(77, "A", "Perfil", medidas(1, 1, 200, 0.6))])
    ml_h = MLFalso([item("MLB1", "Perfil", sku="A")])
    ml_p = MLFalso([item("MLB2", "Perfil", sku="A")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml_h, "revesta": ml_p},
                                     {"norvia_campinas": tiny_g, "revesta": tiny_p})
    p.coletar()
    por_mlb = {a["mlb"]: a for a in estado_dim.ler()["produtos"]["A"]["anuncios"]}
    assert por_mlb["MLB1"]["embalagem_alvo"]["comprimento"] == 100 and por_mlb["MLB1"]["embalagem_alvo"]["peso"] == 300
    assert por_mlb["MLB2"]["embalagem_alvo"]["comprimento"] == 200 and por_mlb["MLB2"]["embalagem_alvo"]["peso"] == 600
    assert p.padroes_por_filial()["revesta"]["A"]["comprimento_cm"] == 200
    assert p.padroes_por_filial()["norvia"]["A"]["comprimento_cm"] == 100


def test_sem_sku_ou_sem_peso_bruto_no_tiny_fica_sem_medida(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, None, pesoLiquido=0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A"), item("MLB2", "Outro", sku="NAO-EXISTE")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    produtos = estado_dim.ler()["produtos"]
    assert produtos["A"]["status"] == "sem_medida" and "peso bruto" in produtos["A"]["motivos"][0]
    assert produtos["NAO-EXISTE"]["status"] == "sem_medida" and "não encontrado" in produtos["NAO-EXISTE"]["motivos"][0]
    assert p.padroes_por_filial()["norvia"] == {}, "sem peso bruto não vai para o Tipo de frete"
    assert p.confirmar(["A"], None)["recusados"], "nada a enviar"


def test_confirmar_envia_so_ao_ml_e_marca_padronizado(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV83", "Cantoneira", medidas(1.6, 1.6, 300, 0.8))])
    ml = MLFalso([item("MLB1", "Cantoneira", sku="PV83", atributos=[{"id": "LENGTH", "value_name": "3 m"}])])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()

    res = p.confirmar(["PV83", "NAO"], "Ana")
    assert res["aceitos"] == ["PV83"] and "NAO" in res["recusados"][0]
    assert estado_dim.ler()["produtos"]["PV83"]["envio"]["status"] == "enviando"
    assert p.confirmar(["PV83"], "Ana")["recusados"], "envio já em andamento"

    assert p.enviar(["PV83"]) == {"ok": 1, "com_erro": 0}
    assert ml.atributos_enviados == [], "LENGTH já era 300 cm: só a embalagem estava diferente"
    assert ml.medidas_enviadas == [("MLB1", (1.6, 1.6, 300.0), 800)]
    prod = estado_dim.ler()["produtos"]["PV83"]
    assert prod["status"] == "padronizado" and prod["envio"]["status"] == "ok"
    assert set(prod["envio"]["destinos"]) == {"ml:norvia:MLB1"}, "nada vai para o Tiny"


def test_ml_responde_ok_mas_nao_guarda_vira_erro_e_embalagem_posta_de_volta_fica_bloqueada(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV83", "Cantoneira", medidas(1.6, 1.6, 300, 0.8))])
    ml = MLFalso([item("MLB1", "Cantoneira", sku="PV83", dims_ml="84x9x5,1000",
                       atributos=[{"id": "LENGTH", "value_name": "3 m"}, {"id": "THICKNESS", "value_name": "0.9 mm"}])])
    ml.ignorar_envio = True
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    p.confirmar(["PV83"], "Ana")
    assert p.enviar(["PV83"]) == {"ok": 0, "com_erro": 1}
    prod = estado_dim.ler()["produtos"]["PV83"]
    destino = prod["envio"]["destinos"]["ml:norvia:MLB1"]
    assert destino["status"] == "erro" and "respondeu OK" in destino["mensagem"]
    assert "ficha THICKNESS" in destino["mensagem"] and "shipping.dimensions 84x9x5,1000" in destino["mensagem"]
    assert prod["anuncios"][0]["situacao"] == "diferente", "não finge que ficou igual"

    # Embalagem que ficou no envio e o ML pôs de volta depois (catálogo / medida do ML): bloqueado,
    # fora do "a enviar", enquanto o ML mantiver a dele.
    ml.ignorar_envio = False
    p.confirmar(["PV83"], "Ana")
    assert p.enviar(["PV83"]) == {"ok": 1, "com_erro": 0}
    assert estado_dim.ler()["produtos"]["PV83"]["envio"]["destinos"]["ml:norvia:MLB1"]["embalagem"]
    ml.itens["MLB1"]["attributes"] = [a for a in ml.itens["MLB1"]["attributes"] if not a["id"].startswith("SELLER_PACKAGE_")]
    p.coletar()
    prod = estado_dim.ler()["produtos"]["PV83"]
    anuncio = prod["anuncios"][0]
    assert anuncio["situacao"] == "bloqueado_ml" and "pôs de volta a embalagem 84 x 9 x 5" in anuncio["mensagem"]
    assert prod["status"] == "bloqueado" and p.confirmar(["PV83"], "Ana")["recusados"]
    p.coletar()
    assert estado_dim.ler()["produtos"]["PV83"]["anuncios"][0]["situacao"] == "bloqueado_ml", "continua na coleta seguinte"
    # O ML passa a usar as medidas do Tiny: fica igual.
    ml.itens["MLB1"]["shipping"]["dimensions"] = "2x2x300,800"
    p.coletar()
    assert estado_dim.ler()["produtos"]["PV83"]["anuncios"][0]["situacao"] == "igual"


def test_ficha_que_o_ml_mantem_sai_do_a_enviar_ate_o_valor_mudar_no_ml(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV83", "Perfil", medidas(5, 5, 300, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="PV83", dims_ml="300x5x5,300",
                       atributos=[{"id": "LENGTH", "value_name": "300 cm"}, {"id": "THICKNESS", "value_name": "1 mm"}])])
    ml.ignorar_ficha = True
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    p.confirmar(["PV83"], "Ana")
    assert p.enviar(["PV83"]) == {"ok": 1, "com_erro": 0}, "a embalagem ficou: reenviar a ficha não adianta"
    dados = estado_dim.ler()
    destino = dados["produtos"]["PV83"]["envio"]["destinos"]["ml:norvia:MLB1"]
    assert destino["status"] == "ok" and "não aceita alterar a ficha" in destino["mensagem"]
    assert dados["ficha_mantida_ml"] == {"MLB1": {"THICKNESS": 0.1}}

    p.coletar()
    prod = estado_dim.ler()["produtos"]["PV83"]
    assert prod["status"] == "padronizado" and prod["anuncios"][0]["situacao"] == "igual"
    assert "THICKNESS" in prod["anuncios"][0]["mensagem"]

    # Alguém muda a espessura no ML: volta a comparar com o Tiny.
    ml.itens["MLB1"]["attributes"] = [a for a in ml.itens["MLB1"]["attributes"] if a["id"] != "THICKNESS"] + [
        {"id": "THICKNESS", "value_name": "2 cm"}]
    p.coletar()
    assert estado_dim.ler()["produtos"]["PV83"]["anuncios"][0]["ficha_diferente"] == ["THICKNESS"]



def test_ficha_recusada_pelo_ml_ainda_envia_a_embalagem(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A", atributos=[{"id": "LENGTH", "value_name": "2 m"}])])
    ml.recusar_ficha = True
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    p.confirmar(["A"], None)
    p.enviar(["A"])
    destino = estado_dim.ler()["produtos"]["A"]["envio"]["destinos"]["ml:norvia:MLB1"]
    assert destino["status"] == "ok" and "Ficha técnica não aceita" in destino["mensagem"]
    assert ml.medidas_enviadas == [("MLB1", (1.0, 1.0, 100.0), 300)]


def test_cache_nao_rele_o_que_nao_mudou_e_carrinho_fica_de_fora(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil"), produto_tiny(11, "NAO-ANUNCIADO", "Outro")])
    ml = MLFalso([item("MLB1", "Perfil", sku="A"), item("MLB2", "Anúncio sem SKU"), item("MLB3", "Carrinho de Rodameio", sku="C")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    etapas = []
    original = p._progresso
    p._progresso = lambda etapa, feitos, total: (etapas.append(etapa), original(etapa, feitos, total))
    p.coletar()
    p.coletar()
    assert tiny.lidos == [10], "só o SKU anunciado, e só relido quando dataAlteracao muda"
    assert list(estado_dim.ler()["produtos"]) == ["A"]
    assert [a["mlb"] for a in estado_dim.ler()["anuncios_sem_sku"]] == ["MLB2"]
    assert any("Tiny Norvia Campinas" in e for e in etapas) and any("ML Norvia" in e for e in etapas)
    assert estado_dim.ler()["progresso"] is None and estado_dim.ler()["em_execucao"] is None


def test_tiny_fora_do_ar_nao_vira_sku_inexistente(tmp_path, repo):
    class TinyQuebrado(TinyFalso):
        def produtos(self):
            raise RuntimeError("HTTP 503")

    ml = MLFalso([item("MLB1", "Perfil", sku="A")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": TinyQuebrado([])})
    ex = p.coletar()
    assert ex["status"] == "parcial"
    assert "não respondeu" in estado_dim.ler()["produtos"]["A"]["motivos"][0]


def test_sem_anuncios_do_ml_para_antes_do_tiny_e_explica(tmp_path, repo):
    from app.ml_client import ContaNaoConectada

    tiny = TinyFalso([produto_tiny(10, "A", "Perfil")])

    def ml_expirado(filial):
        raise ContaNaoConectada("Access token expirado (HTTP 401)")

    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(estado_dim, repo, fabrica_ml=ml_expirado, fabrica_tiny=lambda c: tiny, pausa=0, esperas_token=())
    ex = p.coletar()
    assert ex["status"] == "erro"
    assert any("401" in e for e in ex["resumo"]["erros"]) and any("antes do Tiny" in e for e in ex["resumo"]["erros"])
    assert tiny.lidos == [] and estado_dim.ler()["em_execucao"] is None


def _ml_401_ate(renova_na, contas):
    """Fábrica que recusa o token das `contas` até a tentativa `renova_na` (1 = primeira)."""
    from app.ml_client import ContaNaoConectada

    tentativas = {}

    def fabrica(filial):
        tentativas[filial] = tentativas.get(filial, 0) + 1
        if filial in contas and tentativas[filial] < renova_na:
            raise ContaNaoConectada(f"Access token da conta {filial} expirado ou inválido (HTTP 401).")
        return contas.get(filial) or MLFalso([])

    return fabrica, tentativas


def test_401_na_agendada_espera_o_token_novo_e_segue(tmp_path, repo, caplog):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A")])
    fabrica, tentativas = _ml_401_ate(3, {"norvia": ml})
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(estado_dim, repo, fabrica_ml=fabrica, fabrica_tiny=lambda c: tiny, pausa=0, esperas_token=(0, 0))
    with caplog.at_level("WARNING"):
        ex = p.coletar("agendada")
    assert ex["status"] == "ok" and tentativas["norvia"] == 3
    assert "A" in estado_dim.ler()["produtos"]
    assert not [r for r in caplog.records if r.levelname == "ERROR"]  # resolvido na espera: sem incidente


def test_401_que_persiste_em_uma_conta_gera_um_erro_so(tmp_path, repo, caplog):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A")])
    fabrica, tentativas = _ml_401_ate(99, {"revesta": None})
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(
        estado_dim, repo, fabrica_ml=lambda f: ml if f == "norvia" else fabrica(f),
        fabrica_tiny=lambda c: tiny, pausa=0, esperas_token=(0, 0),
    )
    with caplog.at_level("WARNING"):
        ex = p.coletar("agendada")
    assert ex["status"] == "parcial" and tentativas["revesta"] == 3
    erros = [r.getMessage() for r in caplog.records if r.levelname == "ERROR"]
    assert len(erros) == 1 and "revesta" in erros[0]


def test_401_nas_duas_contas_gera_um_erro_so(tmp_path, repo, caplog):
    fabrica, _ = _ml_401_ate(99, {"norvia": None, "revesta": None})
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(estado_dim, repo, fabrica_ml=fabrica, fabrica_tiny=lambda c: TinyFalso([]), pausa=0, esperas_token=(0,))
    with caplog.at_level("WARNING"):
        ex = p.coletar("agendada")
    assert ex["status"] == "erro"
    erros = [r.getMessage() for r in caplog.records if r.levelname == "ERROR"]
    assert len(erros) == 1 and "antes do Tiny" in erros[0]


def test_coleta_manual_nao_espera_o_token(tmp_path, repo):
    fabrica, tentativas = _ml_401_ate(2, {"norvia": None})
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(estado_dim, repo, fabrica_ml=fabrica, fabrica_tiny=lambda c: TinyFalso([]), pausa=0, esperas_token=(3600,))
    p.coletar("manual")
    assert tentativas["norvia"] == 1


def test_desligamento_interrompe_a_espera_do_token(tmp_path, repo):
    fabrica, tentativas = _ml_401_ate(99, {"norvia": None})
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(estado_dim, repo, fabrica_ml=fabrica, fabrica_tiny=lambda c: TinyFalso([]), pausa=0, esperas_token=(3600, 3600))
    p.parar.set()
    ex = p.coletar("agendada")
    assert ex["status"] == "erro" and tentativas["norvia"] == 1


def test_anuncio_em_revisao_no_ml_fica_bloqueado_e_fora_de_a_enviar(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A", status="under_review", atributos=[{"id": "LENGTH", "value_name": "2 m"}])])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    prod = estado_dim.ler()["produtos"]["A"]
    anuncio = prod["anuncios"][0]
    assert anuncio["situacao"] == "bloqueado_ml" and "revisão" in anuncio["mensagem"]
    assert prod["status"] == "bloqueado", "pendência, mas não conta como a enviar"
    assert p.confirmar(["A"], None)["recusados"], "nada a enviar"


def test_recusa_not_modifiable_vira_bloqueado_e_nao_falha_o_envio(tmp_path, repo):
    from app.ml_client import MLAPIError

    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A", atributos=[{"id": "LENGTH", "value_name": "2 m"}])])
    erro = ('HTTP 400 - {"cause":[{"code":"item.attributes.not_modifiable","references":["attributes","item.catalog_listing"]}],'
            '"message":"Cannot update item MLB1 [status:active, has_bids:false]"}')

    def recusa(*_a, **_k):
        raise MLAPIError(erro, 400)

    ml.atualizar_atributos = recusa
    ml.enviar_medidas = recusa
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    p.confirmar(["A"], "Ana")
    assert p.enviar(["A"]) == {"ok": 1, "com_erro": 0}
    dados = estado_dim.ler()
    prod = dados["produtos"]["A"]
    assert prod["envio"]["status"] == "bloqueado"
    assert prod["envio"]["destinos"]["ml:norvia:MLB1"]["status"] == "bloqueado"
    assert prod["anuncios"][0]["situacao"] == "bloqueado_ml" and prod["status"] == "bloqueado"
    assert "MLB1" in dados["rejeitados_ml"]
    # A próxima coleta mantém o anúncio bloqueado (sem tentar de novo antes do prazo).
    p.coletar()
    assert estado_dim.ler()["produtos"]["A"]["anuncios"][0]["situacao"] == "bloqueado_ml"


def test_peso_pequeno_para_a_embalagem_vira_bloqueado_ate_o_tiny_mudar(tmp_path, repo):
    from app.ml_client import MLAPIError

    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.08))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A")])
    erro = ('HTTP 400 - {"cause":[{"code":"item.attribute.invalid.seller.package.dimensions","references":["item.attributes"],'
            '"message":"The packaging attributes [seller_package_weight] are too small for the product dimensions"}]}')

    def recusa(*_a, **_k):
        raise MLAPIError(erro, 400)

    ml.enviar_medidas = recusa
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    p.confirmar(["A"], "Ana")
    assert p.enviar(["A"]) == {"ok": 1, "com_erro": 0}, "reenviar o mesmo peso não adianta: não é erro"
    prod = estado_dim.ler()["produtos"]["A"]
    assert prod["envio"]["status"] == "bloqueado" and prod["status"] == "bloqueado"
    assert "peso bruto no Tiny" in prod["anuncios"][0]["mensagem"]
    p.coletar()
    assert estado_dim.ler()["produtos"]["A"]["anuncios"][0]["situacao"] == "bloqueado_ml"
    # Peso corrigido no Tiny: outra embalagem, o anúncio volta para "a enviar".
    tiny.produtos_por_id[10] = {**produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.4)), "dataAlteracao": "2"}
    p.coletar()
    assert estado_dim.ler()["produtos"]["A"]["anuncios"][0]["situacao"] == "diferente"


def test_recusa_antiga_expira_e_o_anuncio_volta_para_a_enviar(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(1, 1, 100, 0.3))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A", atributos=[{"id": "LENGTH", "value_name": "2 m"}])])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    with estado_dim.alterar() as dados:
        dados["rejeitados_ml"] = {"MLB1": {"em": "2020-01-01T00:00:00-03:00", "mensagem": "x"}}
    p.coletar()
    dados = estado_dim.ler()
    assert dados["produtos"]["A"]["anuncios"][0]["situacao"] == "diferente"
    assert dados["rejeitados_ml"] == {}


def test_codigo_legado_no_seller_custom_field_nao_vira_produto(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV308", "Perfil 3m", medidas(1.6, 1.6, 300, 0.85, pesoLiquido=0.8))])
    com_sku = item("MLB1", "Perfil 3m", sku="PV308")
    com_sku["seller_custom_field"] = "4203"
    # Sem SELLER_SKU, o seller_custom_field é o único candidato e vale; com variação legada que o
    # Tiny não conhece, o anúncio fica só no SKU que existe lá.
    so_legado = item("MLB2", "Perfil 2m")
    so_legado["seller_custom_field"] = "PV308"
    variacoes = item("MLB3", "Perfil 1m", sku="PV308")
    variacoes["variations"] = [{"attributes": [{"id": "SELLER_SKU", "value_name": "3901"}]}]
    ml = MLFalso([com_sku, so_legado, variacoes])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})

    assert p.coletar()["status"] == "ok"
    produtos = estado_dim.ler()["produtos"]
    assert set(produtos) == {"PV308"}
    assert {a["mlb"] for a in produtos["PV308"]["anuncios"]} == {"MLB1", "MLB2", "MLB3"}


def test_sku_fora_do_tiny_sem_outro_candidato_continua_aparecendo(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV308", "Perfil 3m", medidas(1.6, 1.6, 300, 0.85, pesoLiquido=0.8))])
    ml = MLFalso([item("MLB1", "Perfil 3m", sku="PV308"), item("MLB9", "Outro", sku="XYZ1")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})

    p.coletar()
    produtos = estado_dim.ler()["produtos"]
    assert set(produtos) == {"PV308", "XYZ1"}
    assert produtos["XYZ1"]["status"] == "sem_medida"


def test_erro_de_envio_some_quando_o_produto_ja_esta_igual_ao_tiny(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil 1m", medidas(1.6, 1.6, 98, 0.4))])
    ml = MLFalso([item("MLB1", "Perfil 1m", sku="A", atributos=[{"id": "LENGTH", "value_name": "98 cm"}, *_pacote(2, 2, 98, 400)])])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    with estado_dim.alterar() as dados:
        dados["produtos"]["A"]["envio"] = {"status": "erro", "em": "2026-10-27T16:43:15-03:00", "destinos": {}}
    p.coletar()
    prod = estado_dim.ler()["produtos"]["A"]
    assert prod["status"] == "padronizado" and "envio" not in prod


def test_anuncio_me1_recebe_tambem_o_shipping_dimensions_e_so_bloqueia_depois_dele(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(5, 5, 300, 0.25))])
    ml = MLFalso([item("MLB1", "Perfil", modo="me1", sku="A", dims_ml="84x9x5,1000")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    # Envio antigo (só SELLER_PACKAGE_*) que o ML desfez: o ME1 não vira bloqueado, vai de novo.
    with estado_dim.alterar() as dados:
        dados["produtos"]["A"]["envio"] = {"status": "ok", "em": "2026-10-28T09:10:00-03:00", "destinos": {
            "ml:norvia:MLB1": {"status": "ok", "em": "2026-10-28T09:10:00-03:00"}}}
    p.coletar()
    assert estado_dim.ler()["produtos"]["A"]["anuncios"][0]["situacao"] == "diferente"

    p.confirmar(["A"], "Ana")
    assert p.enviar(["A"]) == {"ok": 1, "com_erro": 0}
    assert ml.dimensoes_envio == [("MLB1", "5x5x300,250", "me1")]
    assert estado_dim.ler()["produtos"]["A"]["envio"]["destinos"]["ml:norvia:MLB1"]["dimensoes_envio"] is True

    # Mesmo com o shipping.dimensions o ML volta para o dele: agora sim, bloqueado.
    ml.itens["MLB1"]["attributes"] = [a for a in ml.itens["MLB1"]["attributes"] if not a["id"].startswith("SELLER_PACKAGE_")]
    ml.itens["MLB1"]["shipping"]["dimensions"] = "84x9x5,1000"
    p.coletar()
    assert estado_dim.ler()["produtos"]["A"]["anuncios"][0]["situacao"] == "bloqueado_ml"


def test_anuncio_me2_nao_recebe_shipping_dimensions(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", medidas(5, 5, 100, 0.25))])
    ml = MLFalso([item("MLB1", "Perfil", sku="A")])
    p, _, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    p.coletar()
    p.confirmar(["A"], "Ana")
    assert p.enviar(["A"]) == {"ok": 1, "com_erro": 0}
    assert ml.medidas_enviadas and ml.dimensoes_envio == []

