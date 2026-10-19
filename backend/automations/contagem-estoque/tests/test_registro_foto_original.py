import json
from datetime import datetime, timedelta
from pathlib import Path

from app.registro import AGUARDANDO, FUSO_SP, RegistroContagens


def test_registro_guarda_foto_original_e_campos_separados(tmp_path: Path):
    reg = RegistroContagens(tmp_path, retencao_dias=60)
    anotada = tmp_path / "anotada_mock.jpg"
    original = tmp_path / "original_mock.jpg"
    anotada.write_bytes(b"bytes_da_imagem_anotada")
    original.write_bytes(b"bytes_da_imagem_original")

    registro = reg.criar(
        codigo="PROD-123",
        origem_codigo="codigo_e_legenda",
        quantidade=5,
        alertas=["reflexo"],
        imagem_anotada=anotada,
        foto_original=original,
        telegram_user_id=10,
        telegram_user="Operador",
        telegram_chat_id=20,
        sku_legenda="PROD-123",
        codigos_barras=["PROD-123", "EAN-999"],
    )

    rid = registro["id"]
    assert registro["imagem"] == f"{rid}.jpg"
    assert registro["imagem_original"] == f"{rid}_original.jpg"
    assert registro["sku_legenda"] == "PROD-123"
    assert registro["codigos_barras"] == ["PROD-123", "EAN-999"]
    assert registro["status"] == AGUARDANDO

    # Confere se os arquivos foram salvos na pasta imagens/
    arquivo_anotada = tmp_path / "imagens" / f"{rid}.jpg"
    arquivo_original = tmp_path / "imagens" / f"{rid}_original.jpg"
    assert arquivo_anotada.exists() and arquivo_anotada.read_bytes() == b"bytes_da_imagem_anotada"
    assert arquivo_original.exists() and arquivo_original.read_bytes() == b"bytes_da_imagem_original"


def test_retencao_limpa_ambas_imagens_ao_expirar(tmp_path: Path):
    reg = RegistroContagens(tmp_path, retencao_dias=30)
    anotada = tmp_path / "anotada.jpg"
    original = tmp_path / "original.jpg"
    anotada.write_bytes(b"anotada")
    original.write_bytes(b"original")

    registro = reg.criar(
        codigo="SKU-ANTIGO",
        origem_codigo="legenda",
        quantidade=2,
        alertas=[],
        imagem_anotada=anotada,
        foto_original=original,
        telegram_user_id=1,
        telegram_user="Antigo",
        telegram_chat_id=1,
    )
    rid = registro["id"]
    arquivo_anotada = tmp_path / "imagens" / f"{rid}.jpg"
    arquivo_original = tmp_path / "imagens" / f"{rid}_original.jpg"
    assert arquivo_anotada.exists()
    assert arquivo_original.exists()

    # Simula envelhecimento do registro para além de 30 dias atrás
    dados = json.loads(reg.arquivo.read_text(encoding="utf-8"))
    passado = (datetime.now(FUSO_SP) - timedelta(days=35)).isoformat(timespec="seconds")
    dados[rid]["criado_em"] = passado
    reg.arquivo.write_text(json.dumps(dados), encoding="utf-8")

    # Próxima chamada a criar dispara a limpeza de antigos
    anotada_nova = tmp_path / "nova_anotada.jpg"
    original_nova = tmp_path / "nova_original.jpg"
    anotada_nova.write_bytes(b"nova_anotada")
    original_nova.write_bytes(b"nova_original")

    reg.criar(
        codigo="SKU-NOVO",
        origem_codigo="legenda",
        quantidade=1,
        alertas=[],
        imagem_anotada=anotada_nova,
        foto_original=original_nova,
        telegram_user_id=1,
        telegram_user="Novo",
        telegram_chat_id=1,
    )

    # O registro antigo e seus dois arquivos devem ter sido excluídos
    assert not arquivo_anotada.exists()
    assert not arquivo_original.exists()
    dados_atualizados = json.loads(reg.arquivo.read_text(encoding="utf-8"))
    assert rid not in dados_atualizados


def test_retrocompatibilidade_com_registros_antigos_sem_foto_original(tmp_path: Path):
    reg = RegistroContagens(tmp_path, retencao_dias=60)
    (tmp_path / "imagens").mkdir(parents=True, exist_ok=True)

    # Cria registro no formato antigo (sem imagem_original, sku_legenda nem codigos_barras)
    registro_legado = {
        "id": "legado123",
        "criado_em": (datetime.now(FUSO_SP) - timedelta(days=70)).isoformat(timespec="seconds"),
        "codigo": "SKU-LEGADO",
        "origem_codigo": "codigo_de_barras",
        "quantidade_detectada": 4,
        "quantidade_final": 4,
        "status": "confirmada",
        "alertas": [],
        "telegram_user_id": 99,
        "telegram_user": "Legado",
        "telegram_chat_id": 99,
        "foto_sha256": "fakehash",
        "imagem": "legado123.jpg",
        "concluido_em": None,
    }
    arquivo_legado_img = tmp_path / "imagens" / "legado123.jpg"
    arquivo_legado_img.write_bytes(b"imagem_legada")
    reg.arquivo.write_text(json.dumps({"legado123": registro_legado}), encoding="utf-8")

    # Leitura não falha
    lido = reg.obter("legado123")
    assert lido is not None
    assert lido["codigo"] == "SKU-LEGADO"
    assert "imagem_original" not in lido

    # Limpeza por expiração não falha na ausência de imagem_original
    anotada = tmp_path / "anotada.jpg"
    original = tmp_path / "original.jpg"
    anotada.write_bytes(b"anotada")
    original.write_bytes(b"original")

    reg.criar(
        codigo="SKU-NOVO",
        origem_codigo="legenda",
        quantidade=1,
        alertas=[],
        imagem_anotada=anotada,
        foto_original=original,
        telegram_user_id=1,
        telegram_user="Novo",
        telegram_chat_id=1,
    )

    assert not arquivo_legado_img.exists()
    assert "legado123" not in json.loads(reg.arquivo.read_text(encoding="utf-8"))


def _criar(reg: RegistroContagens, tmp_path: Path) -> dict:
    foto = tmp_path / "foto.jpg"
    foto.write_bytes(b"x")
    return reg.criar(
        codigo="PROD-1", origem_codigo="codigo_de_barras", quantidade=3, alertas=[], imagem_anotada=foto,
        foto_original=foto, telegram_user_id=1, telegram_user="Op", telegram_chat_id=2,
    )


def test_numero_sequencial_numera_antigas_e_nunca_repete(tmp_path: Path):
    # Duas contagens de antes da numeração: recebem 1 e 2 pela ordem de criação.
    agora = datetime.now(FUSO_SP)
    antigas = {
        "b": {"id": "b", "criado_em": agora.isoformat(timespec="seconds")},
        "a": {"id": "a", "criado_em": (agora - timedelta(hours=1)).isoformat(timespec="seconds")},
    }
    (tmp_path / "contagens.json").write_text(json.dumps(antigas), encoding="utf-8")
    reg = RegistroContagens(tmp_path, retencao_dias=60)
    reg.numerar_existentes()
    assert reg.obter("a")["numero"] == 1 and reg.obter("b")["numero"] == 2

    assert _criar(reg, tmp_path)["numero"] == 3
    # A retenção apagou tudo: o próximo continua de onde parou (sequencia.json).
    (tmp_path / "contagens.json").write_text("{}", encoding="utf-8")
    assert _criar(reg, tmp_path)["numero"] == 4
    assert json.loads((tmp_path / "sequencia.json").read_text())["ultimo"] == 4
