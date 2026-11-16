import atexit
import io
import os
import re
import shutil
import stat
import tempfile
import time
import zipfile
from datetime import datetime

# Antes de importar o app: MOCK_MODE (sem IA nem RSS de verdade), chave fixa, data/ temporário e
# sem o agendador de sexta.
_TMP_DATA_DIR = tempfile.mkdtemp(prefix="marketing-")
_TMP_PUBLICO_DIR = tempfile.mkdtemp(prefix="marketing-publico-")
atexit.register(shutil.rmtree, _TMP_DATA_DIR, ignore_errors=True)
atexit.register(shutil.rmtree, _TMP_PUBLICO_DIR, ignore_errors=True)

os.environ["MOCK_MODE"] = "true"
os.environ["INTERNAL_AUTH_DISABLED"] = "false"
os.environ["AUTOMATIONS_INTERNAL_KEY"] = "test-internal-key-marketing-32-chars-long-secret"
os.environ["DATA_DIR"] = _TMP_DATA_DIR
os.environ["PUBLICO_DIR"] = _TMP_PUBLICO_DIR
os.environ["GERAR_SEXTA_AUTOMATICO"] = "false"

import pytest  # noqa: E402
import requests  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app import config, rotina  # noqa: E402
from app.ai.finops_router import (  # noqa: E402
    IAIndisponivel,
    _chamar_gemini_json,
    _chamar_groq_json,
    _executar_com_provedores,
    _obter_segundos_espera_429,
    _resumo_factual_catalogo,
    selecionar_melhores_pautas_da_semana,
    validar_copy_edicao,
)
from app.ambientes import gerenciador  # noqa: E402
from app.api import app  # noqa: E402
from app.collectors import rss_collector  # noqa: E402
from app.collectors.rss_collector import extrair_texto_limpo_artigo  # noqa: E402
from app.config import FUSO_SP, PRODUTOS_NORVIA, frases_completas  # noqa: E402
from app.instagram.carrossel import (  # noqa: E402
    _desenhar_bloco_texto_na_caixa,
    gerar_slides_carrossel,
    gerar_zip_carrossel,
)
from app.templates.email_builder import renderizar_email_marketing  # noqa: E402

client = TestClient(app)
CHAVE = {"X-Internal-Key": "test-internal-key-marketing-32-chars-long-secret"}
COM_USUARIO = {**CHAVE, "X-Usuario": "Maria%20Lu%C3%ADsa"}


@pytest.fixture(autouse=True)
def _limpo(monkeypatch):
    rotina._geracao["em_andamento"] = False
    rotina._geracao["iniciada_em"] = None
    rotina._geracao["iniciada_por"] = None
    rotina._geracao["ultimo_erro"] = None
    for caminho in (config.CAMINHO_RASCUNHOS_JSON, config.CAMINHO_EXECUCOES_JSON, config.CAMINHO_ESTADO_JSON):
        caminho.unlink(missing_ok=True)
    # Garante que o estoque inicial de ambientes está pronto
    gerenciador.inicializar_estoque_inicial()
    # MOCK_MODE: o coletor devolve as matérias de exemplo sem ir à rede (mesma assinatura do real).
    assert rss_collector.coletar_todas_noticias(limite_por_fonte=4)


def _gerar_e_esperar():
    resp = client.post("/api/v1/gerar-lote-semanal", headers=COM_USUARIO)
    assert resp.status_code == 202
    for _ in range(300):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)
    return client.get("/api/v1/rascunhos", headers=CHAVE).json()


def test_health_sem_chave():
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/api/v1/health").json()["servico"] == "automacoes-marketing"


def test_chave_interna_obrigatoria_e_ligada_por_padrao():
    assert config.Settings.model_fields["INTERNAL_AUTH_DISABLED"].default is False
    assert client.get("/api/v1/status").status_code == 401
    assert client.get("/api/v1/status", headers={"X-Internal-Key": "errada"}).status_code == 401
    assert client.get("/api/v1/status", headers=CHAVE).status_code == 200


def test_catalogo_so_marca_norvia_e_contagem_do_arquivo():
    dados = client.get("/api/v1/catalogo?apenas_proprios=true", headers=CHAVE).json()
    assert dados["total"] == 84
    for p in dados["produtos"]:
        assert p.get("marca_propria") is True
        assert "viscardi" not in p["nome"].lower()
    status = client.get("/api/v1/status", headers=CHAVE).json()
    assert (status["total_produtos_catalogo"], status["total_produtos_marca_propria"]) == (213, 84)


def test_sem_rascunho_nem_execucao_a_lista_vem_vazia():
    assert client.get("/api/v1/rascunhos", headers=CHAVE).json() == []
    assert client.get("/api/v1/execucoes", headers=CHAVE).json() == []


def test_gera_segunda_e_quinta_em_segundo_plano_com_numeracao_sequencial():
    rascunhos = _gerar_e_esperar()
    assert [r["dia_semana"] for r in rascunhos] == ["Segunda-feira", "Quinta-feira"]
    assert [r["edicao_numero"] for r in rascunhos] == [1, 2]
    segunda = datetime.fromisoformat(rascunhos[0]["data_prevista"])
    assert segunda.weekday() == 0
    execs = client.get("/api/v1/execucoes", headers=CHAVE).json()
    assert execs[0]["tipo"] == "marketing_lote_semanal_gerado" and execs[0]["sucesso"] is True
    assert execs[0]["detalhes"]["gerado_por"] == "Maria Luísa"
    # Mesma semana de novo: os números ficam.
    assert [r["edicao_numero"] for r in _gerar_e_esperar()] == [1, 2]


def test_aprovacao_usa_o_usuario_do_gateway_e_sobrevive_a_nova_geracao():
    rid = _gerar_e_esperar()[0]["id"]
    assert client.post(f"/api/v1/rascunhos/{rid}/aprovar", headers=CHAVE).status_code == 400
    resp = client.post(f"/api/v1/rascunhos/{rid}/aprovar", headers=COM_USUARIO, json={"aprovado_por": "outro"})
    assert resp.status_code == 200
    assert resp.json()["rascunho"]["aprovado_por"] == "Maria Luísa"

    rascunhos = _gerar_e_esperar()
    aprovado = next(r for r in rascunhos if r["id"] == rid)
    assert aprovado["status"] == "aprovado" and aprovado["aprovado_por"] == "Maria Luísa"
    # Aprovada não troca de produto (responde 400 antes de disparar thread)
    troca = client.post(f"/api/v1/rascunhos/{rid}/produto", headers=COM_USUARIO, json={"produto_slug": "perfil_led_embutir"})
    assert troca.status_code == 400


def test_trocar_produto_renderiza_de_novo():
    rid = _gerar_e_esperar()[1]["id"]
    # perfil_led_embutir tem imagem aprovada no estoque inicial
    resp = client.post(f"/api/v1/rascunhos/{rid}/produto", headers=COM_USUARIO, json={"produto_slug": "perfil_led_embutir"})
    assert resp.status_code == 202
    for _ in range(300):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)
    rascunhos = client.get("/api/v1/rascunhos", headers=CHAVE).json()
    r = next(item for item in rascunhos if item["id"] == rid)
    assert r["produto_slug"] == "perfil_led_embutir"
    assert "html_email_preview" in r
    # Linha sem imagem aprovada é rejeitada com 400
    assert client.post(f"/api/v1/rascunhos/{rid}/produto", headers=COM_USUARIO, json={"produto_slug": "cantoneira"}).status_code == 400
    # Slug inexistente responde 400
    assert client.post(f"/api/v1/rascunhos/{rid}/produto", headers=COM_USUARIO, json={"produto_slug": "x"}).status_code == 400


def test_geracao_repetida_em_andamento_responde_409(monkeypatch):
    monkeypatch.setitem(rotina._geracao, "em_andamento", True)
    assert client.post("/api/v1/gerar-lote-semanal", headers=COM_USUARIO).status_code == 409


def test_texto_do_rss_e_da_ia_vai_escapado_no_html():
    produto = config.PRODUTOS_NORVIA["rodape_invertido"]
    copy = {
        "titulo_principal": "<script>alert(1)</script>",
        "texto_hero": 'O detalhe em alumínio "<img src=x>" garante acabamento contínuo.',
        "destaque_hero": '<img src=x>',
        "cards": [
            {"produto_slug": "rodape_invertido", "pasta_tema": "PASTA 01", "frase": 'Frase com "aspas" & tag <script>', "etiqueta_tecnica": "REF. NRV01"},
            {"produto_slug": "perfil_led_embutir", "pasta_tema": "PASTA 02", "frase": "Frase técnica dois", "etiqueta_tecnica": "REF. NRV02"},
            {"produto_slug": "listelo_velino", "pasta_tema": "PASTA 03", "frase": "Frase técnica três", "etiqueta_tecnica": "REF. NRV03"},
        ],
    }
    imagens = rotina._selecionar_imagens_rascunho("rodape_invertido", copy)
    html = renderizar_email_marketing(copy, produto, para_rd_station=True, imagens=imagens)
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "<img src=x>" not in html and "&lt;img src=x&gt;" in html
    assert "{{unsubscribe_url}}" in html, "macro do RD Station intacta"


def test_proxima_geracao_e_a_sexta_na_hora_configurada(monkeypatch):
    monkeypatch.setattr(config.settings, "GERAR_SEXTA_AUTOMATICO", True)
    monkeypatch.setattr(config.settings, "HORA_GERACAO_SEXTA", 8)
    quinta = datetime(2026, 11, 12, 15, 0, tzinfo=FUSO_SP)
    assert rotina.proxima_geracao_agendada(quinta) == datetime(2026, 11, 13, 8, 0, tzinfo=FUSO_SP)
    sexta_depois = datetime(2026, 11, 13, 9, 0, tzinfo=FUSO_SP)
    assert rotina.proxima_geracao_agendada(sexta_depois) == datetime(2026, 11, 20, 8, 0, tzinfo=FUSO_SP)
    monkeypatch.setattr(config.settings, "GERAR_SEXTA_AUTOMATICO", False)
    assert rotina.proxima_geracao_agendada(quinta) is None


def test_feeds_sem_materia_falham_a_geracao_sem_inventar_fonte(monkeypatch):
    monkeypatch.setattr(rotina, "coletar_todas_noticias", lambda limite_por_fonte=12: [])
    assert _gerar_e_esperar() == []
    st = client.get("/api/v1/status", headers=CHAVE).json()["geracao"]
    assert "0 matéria" in st["ultimo_erro"]
    execs = client.get("/api/v1/execucoes", headers=CHAVE).json()
    assert execs[0]["sucesso"] is False


# ==============================================================================
# PARTE A — CORREÇÕES DA REVISÃO (docs/antigravity/email-marketing-padrao-arch-journal.md)
# ==============================================================================

def test_a1_troca_libera_lock_finally():
    """A1: Aprovar o rascunho logo depois do 202 da troca -> liberação de lock no finally; geração volta a responder 202."""
    rascunhos = _gerar_e_esperar()
    rid = rascunhos[1]["id"]
    resp = client.post(f"/api/v1/rascunhos/{rid}/produto", headers=COM_USUARIO, json={"produto_slug": "perfil_led_embutir"})
    assert resp.status_code == 202

    # Imediatamente aprova o rascunho
    client.post(f"/api/v1/rascunhos/{rid}/aprovar", headers=COM_USUARIO)

    # Espera a thread de troca finalizar
    for _ in range(300):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)

    # A trava em_andamento DEVE ser False (liberada pelo finally)
    st = client.get("/api/v1/status", headers=CHAVE).json()["geracao"]
    assert st["em_andamento"] is False

    # A geração de lote volta a responder 202 (e não 409)
    resp2 = client.post("/api/v1/gerar-lote-semanal", headers=COM_USUARIO)
    assert resp2.status_code == 202
    for _ in range(300):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)


def test_a2_concorrencia_aprovacao_e_troca_mesclagem(monkeypatch):
    """A2: Com IA lenta (mock), aprovar a segunda enquanto a quinta é refeita -> segunda continua aprovada.

    Se a quinta virar aprovada durante o trabalho, descarta o resultado.
    """
    rascunhos = _gerar_e_esperar()
    id_segunda = rascunhos[0]["id"]
    id_quinta = rascunhos[1]["id"]

    orig_copy = rotina.gerar_copy_edicao_norvia

    def mock_copy_lento(*args, **kwargs):
        time.sleep(0.3)
        return orig_copy(*args, **kwargs)

    monkeypatch.setattr(rotina, "gerar_copy_edicao_norvia", mock_copy_lento)

    # Inicia troca na quinta-feira
    resp = client.post(f"/api/v1/rascunhos/{id_quinta}/produto", headers=COM_USUARIO, json={"produto_slug": "perfil_led_embutir"})
    assert resp.status_code == 202

    # Enquanto a troca está executando, aprova a segunda-feira
    time.sleep(0.05)
    resp_aprov = client.post(f"/api/v1/rascunhos/{id_segunda}/aprovar", headers=COM_USUARIO)
    assert resp_aprov.status_code == 200

    # Espera a troca da quinta terminar
    for _ in range(300):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)

    rascunhos_finais = client.get("/api/v1/rascunhos", headers=CHAVE).json()
    segunda_final = next(r for r in rascunhos_finais if r["id"] == id_segunda)
    # A aprovação da segunda DEVE sobreviver à mesclagem
    assert segunda_final["status"] == "aprovado"
    assert segunda_final["aprovado_por"] == "Maria Luísa"

    # Agora testa descarte se a própria edição for aprovada durante a regeneração
    # Garante que não há geração em andamento
    assert not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]

    resp2 = client.post(f"/api/v1/rascunhos/{id_quinta}/produto", headers=COM_USUARIO, json={"produto_slug": "listelo_velino"})
    assert resp2.status_code == 202
    time.sleep(0.05)
    # Aprova a quinta enquanto ela está sendo gerada
    client.post(f"/api/v1/rascunhos/{id_quinta}/aprovar", headers=COM_USUARIO)

    for _ in range(300):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)

    rascunhos_finais2 = client.get("/api/v1/rascunhos", headers=CHAVE).json()
    quinta_final = next(r for r in rascunhos_finais2 if r["id"] == id_quinta)
    assert quinta_final["status"] == "aprovado"
    execs = client.get("/api/v1/execucoes", headers=CHAVE).json()
    assert any(e["tipo"] == "marketing_troca_descartada_ja_aprovado" for e in execs)


def test_a3_carrossel_ajuste_caixa_e_erro_estouro():
    """A3: Função caber na caixa reduz fonte até o mínimo; se não couber levanta erro; nada desenhado abaixo de y=1240."""
    img = Image.new("RGB", (1080, 1350), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Texto de 240 caracteres cabe sem erros e respeita y <= 1240
    texto_240 = (
        "Na arquitetura contemporânea, o encontro de revestimentos no mesmo nível "
        "exige precisão absoluta para acomodar a dilatação térmica natural dos materiais "
        "sem criar degraus ou ressaltos que comprometam a estética minimalista e o alto padrão."
    )
    y_final = _desenhar_bloco_texto_na_caixa(
        draw=draw,
        texto=texto_240,
        x=90,
        y=400,
        max_w=900,
        max_h=600,
        tam_fonte_inicial=52,
        tam_fonte_minimo=24,
        bold=False,
        cor=(0, 0, 0),
    )
    assert y_final <= 1240

    # Todos os tipos de slide do carrossel geram com texto de 240 caracteres
    produto = PRODUTOS_NORVIA["rodape_invertido"]
    slides_240 = [
        {"tipo": "capa", "titulo": "Capa com Título Elegante", "texto": texto_240},
        {"tipo": "texto", "titulo": "Desafio Construtivo", "texto": texto_240},
        {"tipo": "produto", "titulo": "Rodapé Invertido Veles", "texto": texto_240},
        {"tipo": "cta", "titulo": "Acesse Nosso Portfólio", "texto": texto_240},
    ]
    arquivos = gerar_slides_carrossel("draft-teste-a3", slides_240, produto)
    assert len(arquivos) == 4
    for a in arquivos:
        assert a.exists()

    # Texto absurdo que não cabe na caixa mesmo com fonte mínima -> levanta ValueError
    texto_gigante = ("Palavras extremamente longas e repetidas que certamente vão transbordar. " * 30)[:2500]
    with pytest.raises(ValueError) as exc:
        _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=texto_gigante,
            x=90,
            y=1100,
            max_w=900,
            max_h=100,
            tam_fonte_inicial=32,
            tam_fonte_minimo=24,
            bold=False,
            cor=(0, 0, 0),
        )
    assert "não coube na área" in str(exc.value)


def test_carrossel_geracao_e_endpoints(monkeypatch):
    """Geração de imagens JPEG 1080x1350, arquivo ZIP e endpoints de download."""
    produto = PRODUTOS_NORVIA["rodape_invertido"]
    carrossel_slides = [
        {"tipo": "capa", "titulo": "Transição de Pisos sem Erros", "texto": "O detalhe técnico que evita descolamento."},
        {"tipo": "texto", "titulo": "O Desafio da Dilatação", "texto": "Pisos flutuantes exigem juntas adequadas."},
        {"tipo": "texto", "titulo": "A Solução em Alumínio", "texto": "Proteção de bordas e acabamento estético."},
        {"tipo": "produto", "titulo": "Rodapé Invertido Norvia", "texto": "Especificações e medidas em alumínio reforçado."},
        {"tipo": "produto", "titulo": "Cores e Medidas", "texto": "Barras de 1m a 3m nas cores oficiais Norvia."},
        {"tipo": "cta", "titulo": "Consulte o Catálogo", "texto": "Acesse norvia.example e conheça todos os acabamentos."},
    ]
    # 1. Geração de imagens JPEG 1080x1350
    arquivos = gerar_slides_carrossel("draft-teste-carrossel", carrossel_slides, produto)
    assert len(arquivos) == 6
    for f in arquivos:
        assert f.exists()
        with Image.open(f) as img:
            assert img.size == (1080, 1350)
            assert img.format == "JPEG"

    # 2. Geração do ZIP
    zip_bytes = gerar_zip_carrossel("draft-teste-carrossel", legenda="Legenda oficial de teste")
    assert zip_bytes is not None and len(zip_bytes) > 0
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        nomes = zf.namelist()
        assert "slide-01.jpg" in nomes
        assert "slide-06.jpg" in nomes
        assert "legenda.txt" in nomes
        assert zf.read("legenda.txt").decode("utf-8") == "Legenda oficial de teste"

    # 3. Download via API
    monkeypatch.setattr(rotina, "listar_rascunhos", lambda: [{
        "id": "draft-teste-carrossel",
        "copy": {"legenda_instagram": "Legenda via API"},
    }])

    # Slide individual
    res_slide = client.get("/api/v1/rascunhos/draft-teste-carrossel/carrossel/1", headers=CHAVE)
    assert res_slide.status_code == 200
    assert res_slide.headers["content-type"] == "image/jpeg"

    # Slide inexistente -> 404
    assert client.get("/api/v1/rascunhos/draft-teste-carrossel/carrossel/99", headers=CHAVE).status_code == 404

    # Zip
    res_zip = client.get("/api/v1/rascunhos/draft-teste-carrossel/carrossel.zip", headers=CHAVE)
    assert res_zip.status_code == 200
    assert res_zip.headers["content-type"] == "application/zip"

    # Path traversal e IDs maliciosos -> 400 ou 404
    assert client.get("/api/v1/rascunhos/../carrossel/1", headers=CHAVE).status_code in (400, 404)
    assert client.get("/api/v1/rascunhos/draft..test/carrossel/1", headers=CHAVE).status_code in (400, 404)
    assert client.get("/api/v1/rascunhos/invalid*id/carrossel.zip", headers=CHAVE).status_code in (400, 404)


def test_tamanho_prompts_menor_que_12k():
    """Tamanho dos prompts respeita teto de contexto FinOps (< 12k chars)."""
    artigos_18 = [
        {
            "indice": i + 1,
            "fonte": "ArchDaily Brasil",
            "titulo": f"Projeto de Arquitetura Contemporânea {i+1} com Acabamentos e Pisos",
            "resumo": "Um resumo detalhado com aproximadamente quatrocentos caracteres descrevendo os ambientes, salas integradas, encontros de pisos laminados, rodapés invertidos e soluções de iluminação linear em LED. " * 2,
            "link": f"https://example.com/artigo-{i+1}",
        }
        for i in range(18)
    ]
    prompt_sel = "SELEÇÃO:\n" + "\n".join(f"{a['indice']}. [{a['fonte']}] {a['titulo']}: {a['resumo'][:400]}" for a in artigos_18)
    assert len(prompt_sel) < 12000, f"Prompt de seleção excedeu 12k: {len(prompt_sel)}"

    texto_materia = "Texto completo extraído do artigo com detalhes de arquitetura. " * 60
    prompt_triagem = f"TRIAGEM:\n{texto_materia[:3000]}\nPRODUTO:\n{_resumo_factual_catalogo()}"
    assert len(prompt_triagem) < 12000, f"Prompt de triagem excedeu 12k: {len(prompt_triagem)}"

    prompt_copy = f"COPY:\n{_resumo_factual_catalogo()}\nMATÉRIA:\n{texto_materia[:3000]}"
    assert len(prompt_copy) < 12000, f"Prompt de redação excedeu 12k: {len(prompt_copy)}"


def test_frases_completas_e_sanitizacao_catalogo():
    """A4: O trecho que terminava em .../… é descartado, não pontuado; quebras de linha e múltiplos espaços colapsados."""
    exemplo_a4 = "…Fabricado em alumínio. Este rodapé oferece um acabamento de..."
    assert frases_completas(exemplo_a4, limite=200) == "Fabricado em alumínio."

    com_quebra = "Medidas:\n46mm x 12mm. Fabricado em alumínio com acabamento premium."
    res = frases_completas(com_quebra, limite=60)
    assert res == "Medidas: 46mm x 12mm."
    assert "\n" not in res

    # Todas as linhas do catálogo sanitizadas não terminam em reticências
    for slug, prod in PRODUTOS_NORVIA.items():
        assert not prod["resumo_card"].endswith("..."), f"Reticências em resumo_card de {slug}"
        assert not prod["resumo_card"].endswith("…"), f"Reticências em resumo_card de {slug}"
        assert not prod["descricao_curta"].endswith("..."), f"Reticências em descricao_curta de {slug}"
        assert not prod["descricao_curta"].endswith("…"), f"Reticências em descricao_curta de {slug}"
        assert len(prod["resumo_card"]) <= 220
        assert len(prod["descricao_curta"]) <= 420


def test_a5_ia_indisponivel_na_selecao_levanta_excecao(monkeypatch):
    """A5: Falha de IA na seleção levanta IAIndisponivel e não mascara em guia técnico em silêncio.

    Modelo de JSON no prompt usa 'um dos slugs permitidos'.
    """
    artigos = [
        {"fonte": "ArchDaily", "titulo": "Casa 1", "resumo": "Resumo 1", "link": "https://example.com/1"},
        {"fonte": "ArchDaily", "titulo": "Casa 2", "resumo": "Resumo 2", "link": "https://example.com/2"},
    ]

    def mock_ia_falha(*args, **kwargs):
        raise IAIndisponivel("Falha simulada de conectividade com todos os provedores")

    monkeypatch.setattr("app.ai.finops_router._executar_com_provedores", mock_ia_falha)
    monkeypatch.setattr(config.settings, "MOCK_MODE", False)

    with pytest.raises(IAIndisponivel):
        selecionar_melhores_pautas_da_semana(artigos)


def test_a6_triagem_extracao_limpa_e_validadores(monkeypatch):
    """A6: Limpeza de artigo remove tags e limita 3000 chars; validador checa reticências em qualquer nível."""
    html_sujo = """
    <html>
      <head><script>alert('malicious')</script><style>body { color: red; }</style></head>
      <body>
        <article>
          <h1>Título da Matéria de Arquitetura</h1>
          <p>Primeiro parágrafo de conteúdo factual sobre interiores contemporâneos e arquitetura residencial de alto padrão.</p>
          <p>Segundo parágrafo detalhando acabamento em alumínio, transição perfeita e iluminação linear difusa integrada.</p>
        </article>
      </body>
    </html>
    """
    monkeypatch.setattr(config.settings, "MOCK_MODE", False)

    class MockResp:
        text = html_sujo
        ok = True
        status_code = 200

        def raise_for_status(self):
            pass

    monkeypatch.setattr(requests, "get", lambda *args, **kwargs: MockResp())

    limpo = extrair_texto_limpo_artigo("https://fake-link-real.com", fallback_resumo="fallback")
    assert "<script>" not in limpo
    assert "<style>" not in limpo
    assert "alert" not in limpo
    assert "Primeiro parágrafo" in limpo
    assert len(limpo) <= 3000

    # Validação de tradução do título original
    produto = PRODUTOS_NORVIA["rodape_invertido"]
    copy_valido = _obter_copy_valido(produto)
    erros = validar_copy_edicao(
        dict(copy_valido, titulo_principal="Casa em Cascais / ARX Portugal"),
        produto,
        titulo_original_materia="Casa em Cascais / ARX Portugal",
    )
    assert any("título principal em inglês" in e for e in erros)

    # Reticências aninhadas dentro de cards são detectadas
    copy_reticencias = dict(copy_valido)
    copy_reticencias["cards"] = [
        {"produto_slug": "rodape_invertido", "pasta_tema": "TEMA", "frase": "Frase cortada no meio...", "etiqueta_tecnica": "REF"},
        copy_valido["cards"][1],
        copy_valido["cards"][2],
    ]
    erros_ret = validar_copy_edicao(copy_reticencias, produto)
    assert any("reticências" in e for e in erros_ret)


def test_retry_429_e_gemini_404_e_erros_granulares(monkeypatch, caplog):
    """A7: Motivos de falha detalhados (429, 404, 413, timeout); provedor sem chave não conta como falha."""
    resp_429 = requests.Response()
    resp_429.status_code = 429
    resp_429.headers["Retry-After"] = "2.5"
    assert _obter_segundos_espera_429(resp_429) == 2.5

    sleeps = []
    monkeypatch.setattr(time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(config.settings, "GROQ_API_KEY", "fake-groq-key")

    tentativas = 0

    def mock_post_retry(*args, **kwargs):
        nonlocal tentativas
        tentativas += 1
        if tentativas == 1:
            r = requests.Response()
            r.status_code = 429
            r.headers["Retry-After"] = "2"
            return r
        r = requests.Response()
        r.status_code = 200
        r._content = b'{"choices": [{"message": {"content": "{\\"resultado\\": \\"ok\\"}"}}]}'
        return r

    monkeypatch.setattr(requests, "post", mock_post_retry)
    dados, erro = _chamar_groq_json("prompt_sistema", "prompt_usuario")
    assert dados is not None and dados.get("resultado") == "ok"
    assert erro == ""
    assert sleeps == [2.0]

    # Gemini 404 modelo indisponível
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "fake-gemini-key")

    def mock_post_404(*args, **kwargs):
        r = requests.Response()
        r.status_code = 404
        r._content = b'{"error": {"message": "models/gemini-2.5-flash is not found"}}'
        return r

    monkeypatch.setattr(requests, "post", mock_post_404)
    res_gemini, erro_gem = _chamar_gemini_json("prompt_sistema", "prompt_usuario")
    assert res_gemini is None
    assert "GEMINI_FREE_MODEL" in erro_gem or "GEMINI_FREE_MODEL" in caplog.text

    # Provedores sem chave são desconsiderados
    monkeypatch.setattr(config.settings, "GROQ_API_KEY", "")
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "")
    monkeypatch.setattr(config.settings, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(config.settings, "OPENAI_API_KEY", "")

    with pytest.raises(IAIndisponivel) as exc_info:
        _executar_com_provedores("prompt_s", "prompt_u", [("Groq", _chamar_groq_json)], validador_fn=lambda d: [])
    assert "nenhum provedor" in str(exc_info.value).lower() and "chave" in str(exc_info.value).lower()


# ==============================================================================
# PARTE B — NOVO PADRÃO ARCH JOURNAL (docs/antigravity/email-marketing-padrao-arch-journal.md)
# ==============================================================================

def _obter_copy_valido(produto):
    return {
        "assunto": "Transição perfeita de pisos no mesmo nível",
        "assunto_alt": "Perfil T Norvia: acabamento e dilatação",
        "preheader": "Como a arquitetura moderna especifica a transição entre laminados e porcelanatos.",
        "selo_pauta": "PAUTA DA SEMANA • TENDÊNCIAS DE ACABAMENTO",
        "titulo_principal": "Encontro de Revestimentos: Como Fazer a Transição no Mesmo Nível com Perfil T",
        "texto_hero": "Na arquitetura contemporânea, a união entre revestimentos exige precisão. O minimalismo contínuo substitui arremates pesados pela precisão em alumínio.",
        "destaque_hero": "minimalismo contínuo",
        "cta_hero_texto": "EXPLORAR A TENDÊNCIA NA PRÁTICA →",
        "cards": [
            {
                "produto_slug": produto["slug"],
                "pasta_tema": "PASTA 01 // TRANSIÇÃO",
                "frase": "Acabamento rente e seguro para pisos no mesmo nível.",
                "etiqueta_tecnica": "REF. NRVPTL02 EM ALUMÍNIO",
            },
            {
                "produto_slug": "perfil_led_embutir",
                "pasta_tema": "PASTA 02 // ILUMINAÇÃO",
                "frase": "Linha contínua de luz difusa em forros e marcenaria.",
                "etiqueta_tecnica": "EMBUTIR COM DIFUSOR",
            },
            {
                "produto_slug": "listelo_velino",
                "pasta_tema": "PASTA 03 // FILETE",
                "frase": "Alinhamento milimétrico em porcelanatos e paredes.",
                "etiqueta_tecnica": "ALUMÍNIO ANODIZADO",
            },
        ],
        "carrossel": [
            {"tipo": "capa", "titulo": "Transição de Pisos sem Erros", "texto": "O detalhe técnico que evita descolamento."},
            {"tipo": "texto", "titulo": "O Desafio da Dilatação", "texto": "Pisos flutuantes exigem juntas adequadas."},
            {"tipo": "texto", "titulo": "A Solução em Alumínio", "texto": "Proteção de bordas e acabamento estético."},
            {"tipo": "produto", "titulo": "Perfil T 45mm Norvia", "texto": "Especificações e medidas em alumínio reforçado."},
            {"tipo": "produto", "titulo": "Cores e Medidas", "texto": "Barras de 1m a 3m nas cores oficiais Norvia."},
            {"tipo": "cta", "titulo": "Consulte o Catálogo", "texto": "Acesse norvia.example e conheça todos os acabamentos."},
        ],
        "legenda_instagram": "A transição perfeita entre revestimentos.\n\nO Perfil T Norvia garante a junta de dilatação sem degraus.\n\n#Norvia #Arquitetura",
    }


def test_validar_copy_edicao_regras():
    """B4: Validador do novo padrão Arch Journal."""
    produto = PRODUTOS_NORVIA["rodape_invertido"]
    copy_valido = _obter_copy_valido(produto)

    # Caso válido passa sem erros
    assert validar_copy_edicao(copy_valido, produto) == []

    # Campo obrigatório ausente
    c_sem_assunto = dict(copy_valido)
    del c_sem_assunto["assunto"]
    assert any("assunto" in p for p in validar_copy_edicao(c_sem_assunto, produto))

    # destaque_hero não está no texto_hero
    c_destaque_errado = dict(copy_valido, destaque_hero="termo que nao existe no texto")
    assert any("destaque_hero" in p for p in validar_copy_edicao(c_destaque_errado, produto))

    # cards != 3
    assert any("cards" in p for p in validar_copy_edicao(dict(copy_valido, cards=copy_valido["cards"][:2]), produto))

    # primeiro card com slug diferente do produto da edição
    cards_slug_errado = list(copy_valido["cards"])
    cards_slug_errado[0] = dict(cards_slug_errado[0], produto_slug="perfil_led_embutir")
    assert any("primeiro card" in p for p in validar_copy_edicao(dict(copy_valido, cards=cards_slug_errado), produto))

    # cards com slug repetido
    cards_repetidos = [copy_valido["cards"][0], copy_valido["cards"][0], copy_valido["cards"][2]]
    assert any("repetir" in p for p in validar_copy_edicao(dict(copy_valido, cards=cards_repetidos), produto))

    # Linha sem imagem aprovada em card (ex.: cantoneira)
    cards_sem_aprovada = list(copy_valido["cards"])
    cards_sem_aprovada[1] = dict(cards_sem_aprovada[1], produto_slug="cantoneira")
    assert any("sem imagem" in p for p in validar_copy_edicao(dict(copy_valido, cards=cards_sem_aprovada), produto))

    # Limites de caracteres
    assert any("selo_pauta" in p for p in validar_copy_edicao(dict(copy_valido, selo_pauta="A" * 51), produto))
    assert any("texto_hero" in p for p in validar_copy_edicao(dict(copy_valido, texto_hero="B" * 381), produto))
    assert any("cta_hero_texto" in p for p in validar_copy_edicao(dict(copy_valido, cta_hero_texto="C" * 41), produto))


def test_b1_b2_b6_html_links_destinos_reais_e_rd_station():
    """B1, B2, B6: HTML do RD Station com links para destinos reais, zero #, sem data: base64, tamanho < 100 KB, zero CDN externa."""
    produto = PRODUTOS_NORVIA["rodape_invertido"]
    copy = _obter_copy_valido(produto)
    imagens = rotina._selecionar_imagens_rascunho("rodape_invertido", copy)
    html = renderizar_email_marketing(copy, produto, para_rd_station=True, imagens=imagens)

    # 1. Catálogo Canva (escapado em HTML com &amp;)
    url_canva = "https://www.canva.com/design/DAG_ErVS6gc/0eOY1pTRuMsk6BI1ZshLPg/view?utm_content=DAG_ErVS6gc&utm_campaign=designshare&utm_medium=link2&utm_source=uniquelinks&utlId=h1ee67a76ae#1"
    assert url_canva in html or url_canva.replace("&", "&amp;") in html

    # 2. Atendimento WhatsApp
    url_whats = "https://wa.me/5543991875825?text=Ol%C3%A1%21%20Sou%20especificador%20e%20vim%20pelo%20Arch%20Journal%20da%20Norvia."
    assert url_whats in html

    # 3. Descadastro RD Station
    assert "{{unsubscribe_url}}" in html

    # 4. UTM nos links para norvia.example
    assert "utm_source=rdstation" in html
    assert "utm_medium=email" in html
    assert "utm_campaign=arch-journal-" in html

    # 5. Nenhum href="#" solto e nenhum link vazio
    assert 'href="#"' not in html
    assert 'href=""' not in html

    # 6. Sem imagens data: base64 nem cdn.vnda.com.br
    assert 'src="data:' not in html
    assert "cdn.vnda.com.br" not in html

    # 7. Todas as imagens começam com URL pública e existem em PUBLICO_DIR
    url_base = config.settings.MARKETING_URL_PUBLICA_IMAGENS.rstrip("/")
    imgs_src = re.findall(r'<img[^>]+src="([^"]+)"', html)
    assert any("logo-norvia.png" in s for s in imgs_src)
    assert any("logo-norvia-negativo.png" in s for s in imgs_src)
    for src in imgs_src:
        assert src.startswith("http"), f"Imagem com caminho relativo: {src}"
        rel = src.removeprefix(url_base + "/")
        assert (config.PUBLICO_DIR / rel).exists(), f"Imagem ausente em PUBLICO_DIR: {rel}"

    # 8. Tamanho do HTML estritamente menor que 100 KB
    tamanho_kb = len(html.encode("utf-8")) / 1024
    assert tamanho_kb < 100, f"HTML com {tamanho_kb:.1f} KB excede limite de 100 KB"

    # 9. Todas as imagens aprovadas do estoque têm <= 250 KB
    for p in config.PASTA_AMBIENTES_PUBLICO.glob("**/*.jpg"):
        tam_img = p.stat().st_size
        assert tam_img <= 250 * 1024, f"Imagem {p.name} com {tam_img/1024:.1f} KB excede 250 KB"


def test_b3_b6_ambientes_geracao_aprovacao_e_limites(monkeypatch):
    """B3, B6: Gestão do Banco de Ambientes: listagem, geração em mock, aprovação/recusa, permissão 0644 e limite diário."""
    # 1. Listagem inicial contém as fotos do modelo aprovado
    ambientes = client.get("/api/v1/ambientes", headers=CHAVE).json()
    assert len(ambientes) >= 4
    assert any(a["produto_slug"] == "rodape_invertido" and a["status"] == "aprovada" for a in ambientes)

    # 2. Geração de imagens em mock
    resp_gerar = client.post("/api/v1/ambientes/gerar", headers=COM_USUARIO, json={"produto_slug": "rodape_invertido", "quantidade": 2})
    assert resp_gerar.status_code == 202

    # Aguarda geração
    candidatas = []
    for _ in range(100):
        candidatas = [a for a in client.get("/api/v1/ambientes", headers=CHAVE).json() if a["status"] == "candidata"]
        if len(candidatas) >= 2:
            break
        time.sleep(0.02)
    assert len(candidatas) >= 2

    candidata = candidatas[0]
    cid = candidata["id"]
    assert candidata["status"] == "candidata"
    # Candidata não foi para o volume público
    assert not (config.PASTA_AMBIENTES_PUBLICO / "rodape_invertido" / f"{cid}.jpg").exists()

    # 3. Aprovação requer X-Usuario
    assert client.post(f"/api/v1/ambientes/{cid}/aprovar", headers=CHAVE).status_code == 400

    # Aprovação com usuário
    resp_aprov = client.post(f"/api/v1/ambientes/{cid}/aprovar", headers=COM_USUARIO)
    assert resp_aprov.status_code == 200
    assert resp_aprov.json()["ambiente"]["status"] == "aprovada"
    assert resp_aprov.json()["ambiente"]["aprovada_por"] == "Maria Luísa"

    # Arquivo 3:2 e 4:5 copiado para público com permissão 0644
    caminho_pub = config.PASTA_AMBIENTES_PUBLICO / "rodape_invertido" / f"{cid}.jpg"
    caminho_pub_4x5 = config.PASTA_AMBIENTES_PUBLICO / "rodape_invertido" / f"{cid}_4x5.jpg"
    assert caminho_pub.exists()
    assert caminho_pub_4x5.exists()
    assert stat.S_IMODE(caminho_pub.stat().st_mode) == 0o644

    # 4. Recusa marca como recusada e não copia para público
    cid2 = candidatas[1]["id"]
    assert client.post(f"/api/v1/ambientes/{cid2}/recusar", headers=CHAVE).status_code == 400
    resp_rec = client.post(f"/api/v1/ambientes/{cid2}/recusar", headers=COM_USUARIO)
    assert resp_rec.status_code == 200
    assert resp_rec.json()["ambiente"]["status"] == "recusada"
    assert not (config.PASTA_AMBIENTES_PUBLICO / "rodape_invertido" / f"{cid2}.jpg").exists()

    # 5. Limite diário de 20 imagens responde 429
    monkeypatch.setattr(gerenciador, "contar_geracoes_hoje", lambda: 20)
    resp_limite = client.post("/api/v1/ambientes/gerar", headers=COM_USUARIO, json={"produto_slug": "rodape_invertido", "quantidade": 1})
    assert resp_limite.status_code == 429
    assert "Limite diário" in resp_limite.json()["detail"]

    # 6. Rodízio de imagens para a mesma linha
    img1 = gerenciador.escolher_imagem_aprovada("rodape_invertido")
    assert img1 is not None
    gerenciador.registrar_hero_usado("rodape_invertido", img1["id"])
    img2 = gerenciador.escolher_imagem_aprovada("rodape_invertido")
    assert img2 is not None
    assert img1["id"] != img2["id"], "O rodízio deve alternar fotos aprovadas da mesma linha"

    # 7. Regras de aplicação correta no prompt
    assert "NO MESMO NÍVEL" in gerenciador.REGRAS_APLICACAO_LINHA["perfil_t"].upper()
    assert "ALTURAS DIFERENTES" in gerenciador.REGRAS_APLICACAO_LINHA["redutor_piso"].upper()
    assert "QUINA" in gerenciador.REGRAS_APLICACAO_LINHA["cantoneira"].upper()
    assert "BASE DA PAREDE" in gerenciador.REGRAS_APLICACAO_LINHA["rodape_invertido"].upper()


# ==============================================================================
# PARTE C — CORREÇÕES (docs/antigravity/email-marketing-arch-journal-correcoes.md)
# ==============================================================================

def test_c0_render_por_linha_existem_em_referencias_e_frontend():
    """C0/C2/C6.5: Todos os arquivos de RENDER_POR_LINHA existem em referencias/renders e frontend/public/marketing/produtos."""
    from pathlib import Path
    from app.ambientes.provedores import RENDER_POR_LINHA

    repo_root = Path(__file__).resolve().parents[4]
    frontend_prods = repo_root / "frontend" / "public" / "marketing" / "produtos"
    for slug in PRODUTOS_NORVIA:
        nome_arquivo = RENDER_POR_LINHA.get(slug)
        assert nome_arquivo, f"Falta render 3D mapeado para '{slug}'"
        assert (config.PASTA_REFERENCIAS / "renders" / nome_arquivo).exists(), f"Render ausente em referencias/renders: {nome_arquivo}"
        assert (frontend_prods / nome_arquivo).exists(), f"Render ausente em frontend/public/marketing/produtos: {nome_arquivo}"


def test_c1_gemini_imagem_real_http_e_erros(monkeypatch):
    """C1: Geração real Gemini via requests.post (inline_data, retry 429, 404, sem chave -> 400, concorrente -> 409)."""
    import base64
    from app.ambientes import provedores

    # Sem chave com MOCK_MODE=False responde 400
    monkeypatch.setattr(config.settings, "MOCK_MODE", False)
    monkeypatch.setattr(config.settings, "MARKETING_IMAGEM_PROVEDOR", "gemini")
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "")
    resp_sem_chave = client.post("/api/v1/ambientes/gerar", headers=COM_USUARIO, json={"produto_slug": "perfil_t", "quantidade": 1})
    assert resp_sem_chave.status_code == 400

    # Quantidade fora de 1..4 responde 422
    assert client.post("/api/v1/ambientes/gerar", headers=COM_USUARIO, json={"produto_slug": "perfil_t", "quantidade": 5}).status_code == 422

    # Gera um PNG válido em memória para resposta Gemini
    buf = io.BytesIO()
    Image.new("RGB", (1400, 1000), color=(20, 40, 60)).save(buf, format="PNG")
    b64_png = base64.b64encode(buf.getvalue()).decode("ascii")

    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "fake-gemini-img-key")
    monkeypatch.setattr(time, "sleep", lambda s: None)

    chamadas = {"count": 0}

    def mock_post_429_depois_ok(url, headers=None, json=None, timeout=None):
        chamadas["count"] += 1
        assert headers.get("x-goog-api-key") == "fake-gemini-img-key"
        assert json["generationConfig"]["responseModalities"] == ["IMAGE"]
        r = requests.Response()
        if chamadas["count"] == 1:
            r.status_code = 429
            r.headers["Retry-After"] = "1"
            return r
        r.status_code = 200
        payload = {"candidates": [{"content": {"parts": [{"inline_data": {"mime_type": "image/png", "data": b64_png}}]}}]}
        import json as _json
        r._content = _json.dumps(payload).encode("utf-8")
        return r

    monkeypatch.setattr(requests, "post", mock_post_429_depois_ok)
    raw_bytes, refs_usadas = provedores.gerar_composicao_ambiente("perfil_t", "prompt teste")
    assert refs_usadas and refs_usadas[0].endswith(".png")
    img_3x2, w3, h3 = provedores.processar_e_recortar_jpeg(raw_bytes, proporcao="3:2")
    assert (w3, h3) == (1200, 800)
    assert len(img_3x2) <= 250 * 1024
    assert chamadas["count"] == 2

    # 4:5 recorta para 800x1000 (sem upscale de 1400x1000)
    img_4x5, w4, h4 = provedores.processar_e_recortar_jpeg(raw_bytes, proporcao="4:5")
    assert (w4, h4) == (800, 1000)
    assert len(img_4x5) <= 250 * 1024

    # 404 levanta RuntimeError descritivo
    def mock_post_404(url, headers=None, json=None, timeout=None):
        r = requests.Response()
        r.status_code = 404
        r._content = b'{"error": {"message": "model not found"}}'
        return r

    monkeypatch.setattr(requests, "post", mock_post_404)
    with pytest.raises(RuntimeError, match="404"):
        provedores.gerar_composicao_ambiente("perfil_t", "prompt 404")

    # Concorrência responde 409
    with gerenciador._geracao_img_lock:
        gerenciador._geracao_img_estado["em_andamento"] = True
    try:
        resp_conc = client.post("/api/v1/ambientes/gerar", headers=COM_USUARIO, json={"produto_slug": "perfil_t", "quantidade": 1})
        assert resp_conc.status_code == 409
    finally:
        with gerenciador._geracao_img_lock:
            gerenciador._geracao_img_estado["em_andamento"] = False


def test_c3_sem_linhas_elegiveis_falha_sem_fallback(monkeypatch):
    """C3: Sem linhas aprovadas (ou < 3 para cards), IA falha com IAIndisponivel sem fallback silencioso."""
    from app.ai.finops_router import gerar_copy_edicao_norvia

    monkeypatch.setattr(gerenciador, "listar_produtos_elegiveis", lambda: [])
    with pytest.raises(IAIndisponivel, match="Nenhuma linha"):
        selecionar_melhores_pautas_da_semana([{"titulo": "Sala", "resumo_rss": "Piso", "fonte_nome": "Teste", "link": "https://ex.com"}])

    monkeypatch.setattr(gerenciador, "listar_produtos_elegiveis", lambda: ["rodape_invertido", "perfil_led_embutir"])
    with pytest.raises(IAIndisponivel, match="3 linhas"):
        gerar_copy_edicao_norvia(
            artigo={"titulo": "Sala", "fonte_nome": "Teste", "link": "https://ex.com"},
            triagem={"produto_norvia_slug": "rodape_invertido", "titulo_traduzido_ptbr": "Sala"},
        )


def test_c4_imagens_estaveis_no_rascunho_e_recusa_invalida_render():
    """C4: Re-renderizar mesmo rascunho mantém mesmas imagens; recusar imagem usada invalida renderização."""
    rascunhos = _gerar_e_esperar()
    r = rascunhos[0]
    assert "imagens" in r and r["imagens"]["hero"] and len(r["imagens"]["cards"]) == 3 and r["imagens"]["carrossel"]

    prod = PRODUTOS_NORVIA[r["produto_slug"]]
    html1 = renderizar_email_marketing(r["copy"], prod, para_rd_station=True, imagens=r["imagens"])
    html2 = renderizar_email_marketing(r["copy"], prod, para_rd_station=True, imagens=r["imagens"])
    assert html1 == html2

    # Se recusar a imagem do hero, renderizar_email_marketing deve falhar
    hero_id = r["imagens"]["hero"]
    resp_rec = client.post(f"/api/v1/ambientes/{hero_id}/recusar", headers=COM_USUARIO)
    assert resp_rec.status_code == 200
    with pytest.raises(ValueError, match="não está aprovada"):
        renderizar_email_marketing(r["copy"], prod, para_rd_station=True, imagens=r["imagens"])


def test_c5_rodape_sem_atendimento_data_e_cta(monkeypatch):
    """C5: MARKETING_LINK_ATENDIMENTO vazio omite separador • e link; data_prevista vira ED. DD/MM/AAAA; sem &nbsp; no CTA."""
    produto = PRODUTOS_NORVIA["rodape_invertido"]
    copy = _obter_copy_valido(produto)
    copy["data_prevista"] = "2026-11-16"
    imagens = rotina._selecionar_imagens_rascunho("rodape_invertido", copy)

    monkeypatch.setattr(config.settings, "MARKETING_LINK_ATENDIMENTO", "")
    html = renderizar_email_marketing(copy, produto, para_rd_station=True, imagens=imagens)
    assert "ED. 16/11/2026" in html
    assert "Atendimento para Especificadores" not in html
    assert "@norvia.acabamentos</a>\n              </p>" in html
    assert "EXPLORAR A TENDÊNCIA NA PRÁTICA &nbsp;" not in html


# ==============================================================================
# PARTE D — CORREÇÕES 2 (docs/antigravity/email-marketing-arch-journal-correcoes-2.md)
# ==============================================================================

def test_d1_rodizio_circular_e_sem_efeito_colateral(monkeypatch):
    """D1: Rodízio circular A,B,A,B e A,B,C,A; card 01 != hero; falha no carrossel não suja estado.json."""
    from app.ambientes import gerenciador
    from app.historico import ler_estado

    # Caso com 2 fotos aprovadas: A, B, A, B
    indice_2 = [
        {"id": "img_a", "produto_slug": "perfil_t", "status": "aprovada", "aprovada_em": "2026-11-01T10:00:00"},
        {"id": "img_b", "produto_slug": "perfil_t", "status": "aprovada", "aprovada_em": "2026-11-02T10:00:00"},
    ]
    gerenciador._gravar_indice(indice_2)
    seq_2 = []
    for _ in range(4):
        escolha = gerenciador.escolher_imagem_aprovada("perfil_t")
        assert escolha is not None
        seq_2.append(escolha["id"])
        gerenciador.registrar_hero_usado("perfil_t", escolha["id"])
    assert seq_2 == ["img_a", "img_b", "img_a", "img_b"]

    # Caso com 3 fotos aprovadas: A, B, C, A
    indice_3 = [
        {"id": "img_1", "produto_slug": "cantoneira", "status": "aprovada", "aprovada_em": "2026-11-01T10:00:00"},
        {"id": "img_2", "produto_slug": "cantoneira", "status": "aprovada", "aprovada_em": "2026-11-02T10:00:00"},
        {"id": "img_3", "produto_slug": "cantoneira", "status": "aprovada", "aprovada_em": "2026-11-03T10:00:00"},
    ]
    gerenciador._gravar_indice(indice_3)
    seq_3 = []
    for _ in range(4):
        escolha = gerenciador.escolher_imagem_aprovada("cantoneira")
        assert escolha is not None
        seq_3.append(escolha["id"])
        gerenciador.registrar_hero_usado("cantoneira", escolha["id"])
    assert seq_3 == ["img_1", "img_2", "img_3", "img_1"]

    # card 01 != hero quando há >= 2 fotos aprovadas
    prod = PRODUTOS_NORVIA["cantoneira"]
    copy = _obter_copy_valido(prod)
    for card in copy["cards"]:
        card["produto_slug"] = "cantoneira"
    imagens = rotina._selecionar_imagens_rascunho("cantoneira", copy)
    assert imagens["hero"] is not None
    assert imagens["cards"][0] != imagens["hero"]

    # Restaura estoque inicial para gerar lote completo
    gerenciador._gravar_indice([])
    gerenciador.inicializar_estoque_inicial()

    # Se _gerar_carrossel_para_rascunho falhar durante troca, estado.json não deve ter sido alterado
    rotina._salvar_rascunhos([])
    rascunhos = _gerar_e_esperar()
    assert rascunhos, f"Lote falhou: {client.get('/api/v1/status', headers=CHAVE).json()}"
    alvo = next((r for r in rascunhos if r.get("status") == "pendente_aprovacao"), None)
    assert alvo is not None, f"Statuses: {[r.get('status') for r in rascunhos]}"
    estado_antes = ler_estado().get("ultimo_hero_por_linha", {}).copy()

    def _falhar_carrossel(*_args, **_kwargs):
        raise RuntimeError("falha simulada no carrossel")

    monkeypatch.setattr(rotina, "_gerar_carrossel_para_rascunho", _falhar_carrossel)
    novo_slug = next(s for s in gerenciador.listar_produtos_elegiveis() if s != alvo["produto_slug"])
    resp_troca = client.post(
        f"/api/v1/rascunhos/{alvo['id']}/produto",
        headers=COM_USUARIO,
        json={"produto_slug": novo_slug},
    )
    assert resp_troca.status_code == 202, resp_troca.json()
    for _ in range(200):
        if not client.get("/api/v1/status", headers=CHAVE).json()["geracao"]["em_andamento"]:
            break
        time.sleep(0.02)
    assert ler_estado().get("ultimo_hero_por_linha", {}) == estado_antes


def test_d3_4x5_gemini_sem_upscale_e_rota(monkeypatch):
    """D3: 2 chamadas Gemini por opção (3:2 e 4:5 com base 3:2), fallback para recorte, sem upscale, rota _4x5."""
    import base64
    import io
    from PIL import Image
    from app.ambientes import gerenciador, provedores

    # 1. Sem upscale: 600x400 permanece 600x400 em 3:2 e vira 320x400 em 4:5
    img_pequena = Image.new("RGB", (600, 400), (40, 60, 90))
    buf_peq = io.BytesIO()
    img_pequena.save(buf_peq, format="JPEG", quality=90)
    _, w32, h32 = provedores.processar_e_recortar_jpeg(buf_peq.getvalue(), "3:2")
    _, w45, h45 = provedores.processar_e_recortar_jpeg(buf_peq.getvalue(), "4:5")
    assert (w32, h32) == (600, 400)
    assert (w45, h45) == (320, 400)

    # 2. Mock Gemini HTTP: 2 chamadas por opção (1a 3:2, 2a 4:5 com inline_data da 3:2)
    monkeypatch.setattr(config.settings, "MOCK_MODE", False)
    monkeypatch.setattr(config.settings, "MARKETING_IMAGEM_PROVEDOR", "gemini")
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "chave-teste-d3")

    def _make_jpeg_b64(w, h, color):
        im = Image.new("RGB", (w, h), color)
        b = io.BytesIO()
        im.save(b, format="JPEG", quality=85)
        return base64.b64encode(b.getvalue()).decode("ascii")

    b64_3x2 = _make_jpeg_b64(1200, 800, (10, 20, 30))
    b64_4x5 = _make_jpeg_b64(960, 1200, (30, 40, 50))
    chamadas = []

    class _FakeResp:
        def __init__(self, status_code, payload_dict=None, text=""):
            self.status_code = status_code
            self.ok = 200 <= status_code < 300
            self._payload = payload_dict or {}
            self.text = text

        def json(self):
            return self._payload

    def _fake_post_sucesso(url, headers=None, json=None, timeout=90):
        chamadas.append(json)
        ar = json["generationConfig"]["imageConfig"]["aspectRatio"]
        b64_ret = b64_4x5 if ar == "4:5" else b64_3x2
        return _FakeResp(
            200,
            {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": {"data": b64_ret}}]}}]},
        )

    monkeypatch.setattr(provedores.requests, "post", _fake_post_sucesso)
    gerenciador._gravar_indice([])
    gerenciador._executar_geracao_tarefa("perfil_t", "tester-d3", 1)

    assert len(chamadas) == 2
    assert chamadas[0]["generationConfig"]["imageConfig"]["aspectRatio"] == "3:2"
    assert chamadas[1]["generationConfig"]["imageConfig"]["aspectRatio"] == "4:5"
    # 2a chamada inclui a imagem 3:2 gerada como primeiro inline_data
    parts_4x5 = chamadas[1]["contents"][0]["parts"]
    assert parts_4x5[1]["inline_data"]["mime_type"] == "image/jpeg"

    indice = gerenciador._ler_indice()
    assert len(indice) == 1
    item = indice[0]
    assert item["formato_4x5"] == "gerado"

    # Rota GET /api/v1/ambientes/<id>_4x5.jpg retorna 200
    resp_4x5 = client.get(f"/api/v1/ambientes/{item['id']}_4x5.jpg", headers=CHAVE)
    assert resp_4x5.status_code == 200

    # 3. Falha na chamada 4:5 faz fallback para recorte central e marca formato_4x5 = "recorte"
    chamadas.clear()

    def _fake_post_falha_4x5(url, headers=None, json=None, timeout=90):
        chamadas.append(json)
        ar = json["generationConfig"]["imageConfig"]["aspectRatio"]
        if ar == "4:5":
            return _FakeResp(500, text="erro simulado 4:5")
        return _FakeResp(
            200,
            {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": {"data": b64_3x2}}]}}]},
        )

    monkeypatch.setattr(provedores.requests, "post", _fake_post_falha_4x5)
    gerenciador._executar_geracao_tarefa("perfil_t", "tester-d3-fallback", 1)
    indice = gerenciador._ler_indice()
    assert len(indice) == 2
    assert indice[1]["formato_4x5"] == "recorte"


def test_d4_salvamento_incremental_e_limpeza_orfaos(monkeypatch):
    """D4: Falha na opção 3 de 3 preserva opções 1 e 2, registra erro e não deixa .jpg órfão."""
    import base64
    import io
    from PIL import Image
    from app.ambientes import gerenciador, provedores

    monkeypatch.setattr(config.settings, "MOCK_MODE", False)
    monkeypatch.setattr(config.settings, "MARKETING_IMAGEM_PROVEDOR", "gemini")
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "chave-teste-d4")

    def _make_jpeg_b64(w, h):
        im = Image.new("RGB", (w, h), (50, 70, 90))
        b = io.BytesIO()
        im.save(b, format="JPEG", quality=85)
        return base64.b64encode(b.getvalue()).decode("ascii")

    b64_3x2 = _make_jpeg_b64(1200, 800)
    b64_4x5 = _make_jpeg_b64(960, 1200)
    chamadas_3x2 = 0

    class _FakeResp:
        def __init__(self, status_code, payload_dict=None, text=""):
            self.status_code = status_code
            self.ok = 200 <= status_code < 300
            self._payload = payload_dict or {}
            self.text = text

        def json(self):
            return self._payload

    def _fake_post_falha_3a(url, headers=None, json=None, timeout=90):
        nonlocal chamadas_3x2
        ar = json["generationConfig"]["imageConfig"]["aspectRatio"]
        if ar == "3:2":
            chamadas_3x2 += 1
            if chamadas_3x2 == 3:
                return _FakeResp(500, text="erro interno simulado")
            return _FakeResp(
                200,
                {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": {"data": b64_3x2}}]}}]},
            )
        return _FakeResp(
            200,
            {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": {"data": b64_4x5}}]}}]},
        )

    monkeypatch.setattr(provedores.requests, "post", _fake_post_falha_3a)
    gerenciador._gravar_indice([])
    for p in config.PASTA_AMBIENTES_DATA.glob("*.jpg"):
        p.unlink()

    resp = client.post("/api/v1/ambientes/gerar", headers=COM_USUARIO, json={"produto_slug": "perfil_t", "quantidade": 3})
    assert resp.status_code == 202
    for _ in range(200):
        st = client.get("/api/v1/status", headers=CHAVE).json()["geracao_imagens"]
        if not st["em_andamento"]:
            break
        time.sleep(0.02)

    st_final = client.get("/api/v1/status", headers=CHAVE).json()["geracao_imagens"]
    assert "Opção 3 de 3" in (st_final.get("ultimo_erro") or "")
    assert "2 opção(ões) gerada(s) e salva(s)" in (st_final.get("ultimo_erro") or "")

    indice = gerenciador._ler_indice()
    assert len(indice) == 2
    arquivos_esperados = set()
    for item in indice:
        arquivos_esperados.add(item["arquivo_3x2"])
        arquivos_esperados.add(item["arquivo_4x5"])
    arquivos_disco = {p.name for p in config.PASTA_AMBIENTES_DATA.glob("*.jpg")}
    assert arquivos_disco == arquivos_esperados


def test_d6_exemplos_por_linha_e_credito_e_marca():
    """D6: EXEMPLOS_POR_LINHA cobre todos os slugs e arquivos existem; credito_html exige titulo_traduzido_ptbr; _publicar_marca atualiza arquivo divergente."""
    from app.ambientes import gerenciador, provedores

    for slug in PRODUTOS_NORVIA:
        assert slug in provedores.EXEMPLOS_POR_LINHA
        render_path, exemplos_paths = provedores.obter_referencias_linha(slug)
        assert render_path.exists()
        assert len(exemplos_paths) >= 1
        for ex in exemplos_paths:
            assert ex.exists()

    # credito_html omitido sem titulo_traduzido_ptbr mesmo com fonte_link
    gerenciador._gravar_indice([])
    gerenciador.inicializar_estoque_inicial()
    prod = PRODUTOS_NORVIA["rodape_invertido"]
    copy = _obter_copy_valido(prod)
    copy["fonte_link"] = "https://archdaily.com/materia"
    copy["titulo_traduzido_ptbr"] = ""
    imagens = rotina._selecionar_imagens_rascunho("rodape_invertido", copy)
    html_sem_tit = renderizar_email_marketing(copy, prod, para_rd_station=True, imagens=imagens)
    assert "Referência:" not in html_sem_tit

    # _publicar_marca sobrescreve quando arquivo em PUBLICO_DIR/marca difere
    logo_pub = config.PASTA_MARCA_PUBLICO / "logo-norvia.png"
    logo_src = config.PASTA_REFERENCIAS / "marca" / "logo-norvia.png"
    assert logo_src.exists()
    logo_pub.write_bytes(b"conteudo-antigo")
    gerenciador._publicar_marca()
    assert logo_pub.read_bytes() == logo_src.read_bytes()


def test_e4_artigo_rss_sem_fonte_link_omite_referencia():
    """E4.3: pauta artigo_rss sem fonte_link não renderiza bloco 'Referência:' no HTML."""
    from app.ambientes import gerenciador

    gerenciador._gravar_indice([])
    gerenciador.inicializar_estoque_inicial()
    prod = PRODUTOS_NORVIA["rodape_invertido"]
    copy = _obter_copy_valido(prod)
    copy["pauta"] = "artigo_rss"
    copy["fonte_link"] = ""
    copy["titulo_traduzido_ptbr"] = "Título da Matéria"
    imagens = rotina._selecionar_imagens_rascunho("rodape_invertido", copy)
    html = renderizar_email_marketing(copy, prod, para_rd_station=True, imagens=imagens)
    assert "Referência:" not in html






def test_gemini_503_tenta_de_novo_e_groq_pede_limite_de_saida(monkeypatch):
    """503 do Gemini (sobrecarga) é retentado; o Groq pede max_completion_tokens para não cortar o JSON."""
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(config.settings, "GROQ_API_KEY", "k")
    monkeypatch.setattr(time, "sleep", lambda s: None)
    chamadas = []

    class R:
        def __init__(self, code, body=None):
            self.status_code, self._b, self.headers, self.text = code, body or {}, {}, ""
            self.ok = code == 200

        def json(self):
            return self._b

    def fake_post(url, headers=None, json=None, timeout=None):
        chamadas.append(json)
        if "groq" in url:
            return R(200, {"choices": [{"message": {"content": '{"a": 1}'}}]})
        if len(chamadas) == 1:
            return R(503)
        return R(200, {"candidates": [{"content": {"parts": [{"text": '{"a": 1}'}]}}]})

    monkeypatch.setattr(requests, "post", fake_post)
    dados, motivo = _chamar_gemini_json("s", "u")
    assert dados and dados["a"] == 1 and motivo == "" and len(chamadas) == 2
    assert chamadas[0]["generationConfig"]["maxOutputTokens"] == 8192
    _chamar_groq_json("s", "u")
    assert chamadas[-1]["max_completion_tokens"] == 8192


def test_gemini_sobrecarregado_troca_para_modelo_reserva(monkeypatch):
    """503 persistente no modelo principal -> tenta o reserva; outro erro (404) não troca de modelo."""
    monkeypatch.setattr(config.settings, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(config.settings, "GEMINI_FREE_MODEL", "principal")
    monkeypatch.setattr(config.settings, "GEMINI_FALLBACK_MODELS", "reserva")
    monkeypatch.setattr(time, "sleep", lambda s: None)
    urls = []

    class R:
        def __init__(self, code, body=None):
            self.status_code, self._b, self.headers, self.text = code, body or {}, {}, ""
            self.ok = code == 200

        def json(self):
            return self._b

    def fake_post(url, headers=None, json=None, timeout=None):
        urls.append(url)
        if "/principal:" in url:
            return R(503)
        return R(200, {"candidates": [{"content": {"parts": [{"text": '{"ok": true}'}]}}]})

    monkeypatch.setattr(requests, "post", fake_post)
    dados, motivo = _chamar_gemini_json("s", "u")
    assert dados and dados["ok"] is True and dados["_provedor"].endswith("(reserva)")
    assert sum("/principal:" in u for u in urls) == 3

    urls.clear()
    monkeypatch.setattr(requests, "post", lambda url, **kw: (urls.append(url), R(404))[1])
    dados, motivo = _chamar_gemini_json("s", "u")
    assert dados is None and "404" in motivo and not any("/reserva:" in u for u in urls)
