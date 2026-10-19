from app.estado import Estado
from app.padronizacao import Padronizacao, vazio_dimensoes
from tests.conftest import MLFalso, TinyFalso, item, produto_tiny


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
    )
    return p, estado_dim, estado_fretes


def test_fontes_que_batem_dao_alta_confiabilidade_e_viram_pendencia_de_revisao(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "PV83", "Cantoneira Alumínio 16x16mm 3m", {"altura": 1.6, "largura": 1.6, "comprimento": 300, "pesoLiquido": 0.8})])
    ml = MLFalso(
        [item("MLB1", "Cantoneira Alumínio Siena 16x16mm 3m", modo="not_specified", sku="PV83",
              atributos=[{"id": "WEIGHT", "value_name": "800 g"}])],
        descricoes={"MLB1": "Comprimento: 3 m. Largura: 1,6 cm. Altura: 1,6 cm"},
    )
    p, estado_dim, estado_fretes = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny})
    ex = p.coletar()

    assert ex["status"] == "ok", ex
    prod = estado_dim.ler()["produtos"]["PV83"]
    assert prod["status"] == "pendente", "tudo passa por revisão, mesmo com alta confiabilidade"
    assert prod["confiabilidade"] == "alta"
    assert prod["sugestao"] == {"altura": 1.6, "largura": 1.6, "comprimento": 300.0, "peso": 800}
    locais = {(f["fonte"], f["local"]) for f in prod["fontes"]}
    assert ("tiny_ficha", "Tiny Norvia Campinas") in locais
    assert ("ml_descricao", "ML Norvia Campinas · MLB1") in locais
    assert estado_fretes.ler()["avisos"][-1]["tipo"] == "dimensoes_pendencias"


def test_fontes_divergentes_baixam_a_confiabilidade(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "X", "Perfil 10x13x50", {"altura": 5, "largura": 29, "comprimento": 300, "pesoLiquido": 1})])
    ml = MLFalso([item("MLB1", "Perfil Rodapé Embutido 10 X 13 X 50 X 3m", sku="X")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"revesta": tiny})
    p.coletar()
    prod = estado_dim.ler()["produtos"]["X"]
    assert prod["confiabilidade"] in ("baixa", "media") and prod["status"] == "pendente"


def test_validar_grava_no_banco_e_envia_ao_tiny_e_ao_ml(tmp_path, repo):
    tiny_g = TinyFalso([produto_tiny(10, "PV83", "Cantoneira 16x16mm 3m")])
    tiny_p = TinyFalso([produto_tiny(77, "PV83", "Cantoneira 16x16mm 3m")])
    ml = MLFalso([item("MLB1", "Cantoneira 16x16mm 3m", sku="PV83", atributos=[{"id": "LENGTH", "value_name": "3 m"}])])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"norvia_campinas": tiny_g, "revesta": tiny_p})
    p.coletar()

    res = p.validar([{"sku": "PV83", "altura": 300, "largura": 1.6, "comprimento": 1.6, "peso": 800}], "Ana")
    assert res == {"gravados": ["PV83"], "recusados": []}
    linha = repo.obter("PV83")
    # Normalizado: comprimento = maior lado. Embalagem 5x7x300.
    assert (linha["altura_cm"], linha["largura_cm"], linha["comprimento_cm"], linha["peso_g"]) == (1.6, 1.6, 300, 800)
    assert linha["embalagem_comprimento_cm"] == 300 and linha["validado_por"] == "Ana"

    envio = p.enviar(["PV83"])
    assert envio == {"ok": 1, "com_erro": 0}
    assert [g[0] for g in tiny_g.gravados] == [10] and [g[0] for g in tiny_p.gravados] == [77]
    assert ml.atributos_enviados == [("MLB1", [{"id": "LENGTH", "value_name": "300 cm"}])], "só os atributos que o anúncio usa"
    assert ml.medidas_enviadas == [("MLB1", (5.0, 7.0, 300.0), 800)]
    prod = estado_dim.ler()["produtos"]["PV83"]
    assert prod["status"] == "padronizado" and prod["envio"]["status"] == "ok"
    assert set(repo.obter("PV83")["envios"]) == {"tiny:norvia_campinas", "tiny:revesta", "ml:norvia:MLB1"}


def test_validar_exige_tres_lados_e_peso(tmp_path, repo, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "DIMENSOES_SO_ANUNCIADOS", False)  # produto só no Tiny
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil")])
    p, _, _ = _padronizacao(tmp_path, repo, {}, {"revesta": tiny})
    p.coletar()
    res = p.validar([{"sku": "A", "altura": 1, "largura": 2, "comprimento": 3}, {"sku": "NAO", "altura": 1, "largura": 1, "comprimento": 1, "peso": 1}], None)
    assert res["gravados"] == [] and "peso" in res["recusados"][0] and "NAO" in res["recusados"][1]
    assert repo.obter("A") is None


def test_ficha_recusada_pelo_ml_ainda_envia_a_embalagem(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil")])
    ml = MLFalso([item("MLB1", "Perfil", sku="A", atributos=[{"id": "LENGTH", "value_name": "1 m"}])])
    ml.recusar_ficha = True
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"revesta": tiny})
    p.coletar()
    p.validar([{"sku": "A", "altura": 1, "largura": 1, "comprimento": 100, "peso": 300}], None)
    p.enviar(["A"])
    destino = estado_dim.ler()["produtos"]["A"]["envio"]["destinos"]["ml:norvia:MLB1"]
    assert destino["status"] == "ok" and "Ficha técnica não aceita" in destino["mensagem"]
    assert ml.medidas_enviadas == [("MLB1", (5.0, 7.0, 100.0), 300)]


def test_ficha_alterada_depois_do_padrao_vira_divergente(tmp_path, repo, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "DIMENSOES_SO_ANUNCIADOS", False)  # produto só no Tiny
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil", {"altura": 1, "largura": 1, "comprimento": 100, "pesoLiquido": 0.3})])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {}, {"revesta": tiny})
    p.coletar()
    p.validar([{"sku": "A", "altura": 1, "largura": 1, "comprimento": 100, "peso": 300}], None)
    p.coletar()
    assert estado_dim.ler()["produtos"]["A"]["status"] == "padronizado"

    tiny.produtos_por_id[10]["dimensoes"]["comprimento"] = 200
    tiny.produtos_por_id[10]["dataAlteracao"] = "9"
    p.coletar()
    prod = estado_dim.ler()["produtos"]["A"]
    assert prod["status"] == "divergente" and "Dimensões Tiny" in prod["motivos"][0]


def test_cache_nao_rele_o_que_nao_mudou_e_carrinho_fica_de_fora(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil"), produto_tiny(11, "C", "Carrinho de Rodameio")])
    ml = MLFalso([item("MLB1", "Perfil", sku="A"), item("MLB2", "Anúncio sem SKU")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"revesta": tiny})
    p.coletar()
    p.coletar()
    assert tiny.lidos == [10], "cadastro do Tiny só é relido quando dataAlteracao muda"
    assert ml.descricoes_lidas == ["MLB1", "MLB2"], "descrição só é relida quando o anúncio muda"
    assert list(estado_dim.ler()["produtos"]) == ["A"]
    assert [a["mlb"] for a in estado_dim.ler()["anuncios_sem_sku"]] == ["MLB2"]


def test_tiny_so_le_o_cadastro_dos_skus_anunciados_e_mostra_progresso(tmp_path, repo):
    tiny = TinyFalso([produto_tiny(10, "A", "Perfil"), produto_tiny(11, "NAO-ANUNCIADO", "Outro")])
    ml = MLFalso([item("MLB1", "Perfil", sku="A")])
    p, estado_dim, _ = _padronizacao(tmp_path, repo, {"norvia": ml}, {"revesta": tiny})
    etapas = []
    original = p._progresso
    p._progresso = lambda etapa, feitos, total: (etapas.append(etapa), original(etapa, feitos, total))
    p.coletar()
    assert tiny.lidos == [10], "produto sem anúncio não tem o cadastro lido"
    assert list(estado_dim.ler()["produtos"]) == ["A"]
    assert any("Tiny Revesta" in e for e in etapas) and any("ML Norvia" in e for e in etapas)
    assert estado_dim.ler()["progresso"] is None and estado_dim.ler()["em_execucao"] is None


def test_sem_anuncios_do_ml_para_antes_do_tiny_e_explica(tmp_path, repo):
    from app.ml_client import ContaNaoConectada

    tiny = TinyFalso([produto_tiny(10, "A", "Perfil")])

    def ml_expirado(filial):
        raise ContaNaoConectada("Access token expirado (HTTP 401)")

    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    p = Padronizacao(estado_dim, repo, fabrica_ml=ml_expirado, fabrica_tiny=lambda c: tiny, pausa=0)
    ex = p.coletar()
    assert ex["status"] == "erro"
    assert any("401" in e for e in ex["resumo"]["erros"]) and any("antes do Tiny" in e for e in ex["resumo"]["erros"])
    assert tiny.lidos == [] and estado_dim.ler()["em_execucao"] is None
