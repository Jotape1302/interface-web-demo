import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import cv2
import numpy as np
import pytest

from app.bot import (
    MSG_ANALYZING, MSG_CORRIGIR, MSG_ENVIADO_PAINEL, MSG_ERROR, MSG_NOT_FOUND, MSG_SEM_CODIGO, StockCounterBot,
    build_application,
)
from app.config import BotSettings, DetectorSettings
from tests.test_detector import PINK, marker, shelf


def fake_update(image_bytes: bytes, user_id: int = 111, file_size: int | None = None, caption: str | None = None):
    async def download_to_drive(path):
        Path(path).write_bytes(image_bytes)

    tg_file = SimpleNamespace(download_to_drive=download_to_drive)
    photo = SimpleNamespace(get_file=AsyncMock(return_value=tg_file), file_size=file_size or len(image_bytes))
    message = MagicMock()
    message.photo = [photo]
    message.document = None
    message.caption = caption
    message.reply_text = AsyncMock()
    message.reply_photo = AsyncMock()
    update = SimpleNamespace(
        effective_message=message,
        effective_user=SimpleNamespace(id=user_id, full_name="Operador Teste", username="op"),
        effective_chat=SimpleNamespace(id=222),
    )
    return update, message


def _qr(texto: str, lado: int = 220) -> np.ndarray:
    qr = cv2.QRCodeEncoder.create().encode(texto)
    qr = cv2.copyMakeBorder(qr, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(cv2.resize(qr, (lado, lado), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)


def jpeg_with_markers(
    count: int, codigos: tuple[str, ...] = (), largura: int = 1200, altura: int = 800, rosa: bool = False
) -> bytes:
    img = shelf(largura, altura)
    for i in range(count):
        marker(img, 100 + i * 150, 200, color=PINK if rosa else (34, 144, 85))
    for j, codigo in enumerate(codigos):  # etiqueta(s) da prateleira na parte de baixo
        x = 60 + j * 300
        y = altura - 260
        img[y:y + 220, x:x + 220] = _qr(codigo)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert ok
    return buf.tobytes()


def make_bot(tmp_path: Path, debug: bool) -> StockCounterBot:
    bot_settings = BotSettings(_env_file=None, TEMP_DIR=tmp_path, STOCK_COUNTER_DEBUG=debug)
    return StockCounterBot(bot_settings, DetectorSettings(_env_file=None, MAX_PROCESSING_WIDTH=1200))


def all_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()]


def temp_files(root: Path) -> list[Path]:
    """Arquivos temporários (o registro em temp/registro/ é permanente de propósito)."""
    return [p for p in all_files(root) if "registro" not in p.parts]


def registros(tmp_path: Path) -> dict:
    arquivo = tmp_path / "registro" / "contagens.json"
    return json.loads(arquivo.read_text(encoding="utf-8")) if arquivo.exists() else {}


def fake_callback(data: str, user_id: int = 111):
    query = SimpleNamespace(
        data=data,
        answer=AsyncMock(),
        edit_message_caption=AsyncMock(),
        message=SimpleNamespace(reply_text=AsyncMock()),
    )
    update = SimpleNamespace(
        callback_query=query,
        effective_user=SimpleNamespace(id=user_id),
        effective_chat=SimpleNamespace(id=222),
        effective_message=None,
    )
    return update, query


def fake_texto(texto: str, user_id: int = 111):
    message = MagicMock()
    message.text = texto
    message.reply_text = AsyncMock()
    return SimpleNamespace(
        effective_message=message, effective_user=SimpleNamespace(id=user_id), effective_chat=SimpleNamespace(id=222)
    ), message


def test_foto_com_codigo_registra_e_vai_para_o_painel_sem_perguntar(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(3, ("PRAT-N6-AP2",)))

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert [c.args[0] for c in message.reply_text.await_args_list] == [MSG_ANALYZING, MSG_ENVIADO_PAINEL]
    kwargs = message.reply_photo.await_args.kwargs
    assert "🏷️ Produto (SKU): PRAT-N6-AP2" in kwargs["caption"] and "📦 Pacotes encontrados: 3" in kwargs["caption"]
    assert "reply_markup" not in kwargs and "A quantidade está certa?" not in kwargs["caption"]
    regs = registros(tmp_path)
    (rid, reg), = regs.items()
    assert reg["codigo"] == "PRAT-N6-AP2" and reg["origem_codigo"] == "codigo_de_barras"
    assert reg["quantidade_detectada"] == 3 and reg["status"] == "aguardando_confirmacao"
    assert (tmp_path / "registro" / "imagens" / reg["imagem"]).exists()
    assert temp_files(tmp_path) == []  # foto recebida e processada continuam sendo apagadas


def test_confirmar_conclui_o_registro(tmp_path: Path):
    bot = make_bot(tmp_path, debug=False)
    update, _ = fake_update(jpeg_with_markers(2, ("PRAT-1",)))
    asyncio.run(bot.handle_image(update, None))
    rid = next(iter(registros(tmp_path)))

    cb, query = fake_callback(f"ok:{rid}")
    asyncio.run(bot.handle_callback(cb, SimpleNamespace(user_data={})))

    reg = registros(tmp_path)[rid]
    assert reg["status"] == "confirmada" and reg["quantidade_final"] == 2
    assert "✅ Confirmada: 2" in query.edit_message_caption.await_args.kwargs["caption"]

    # Segundo clique não muda nada.
    cb, query = fake_callback(f"ok:{rid}")
    asyncio.run(bot.handle_callback(cb, SimpleNamespace(user_data={})))
    assert query.answer.await_args.kwargs.get("show_alert") is True


def test_corrigir_pede_numero_e_grava_quantidade_final(tmp_path: Path):
    bot = make_bot(tmp_path, debug=False)
    update, _ = fake_update(jpeg_with_markers(2, ("PRAT-2",)))
    asyncio.run(bot.handle_image(update, None))
    rid = next(iter(registros(tmp_path)))
    contexto = SimpleNamespace(user_data={})

    cb, query = fake_callback(f"fix:{rid}")
    asyncio.run(bot.handle_callback(cb, contexto))
    assert query.message.reply_text.await_args.args[0] == MSG_CORRIGIR

    upd, msg = fake_texto("três")
    asyncio.run(bot.handle_other(upd, contexto))
    assert msg.reply_text.await_args.args[0] == MSG_CORRIGIR  # não é número: pergunta de novo

    upd, msg = fake_texto("3")
    asyncio.run(bot.handle_other(upd, contexto))
    reg = registros(tmp_path)[rid]
    assert reg["status"] == "corrigida" and reg["quantidade_final"] == 3 and reg["quantidade_detectada"] == 2
    assert "Corrigido: 3" in msg.reply_text.await_args.args[0]


def test_outro_usuario_nao_confirma_contagem_alheia(tmp_path: Path):
    bot = make_bot(tmp_path, debug=False)
    update, _ = fake_update(jpeg_with_markers(2, ("PRAT-3",)), user_id=111)
    asyncio.run(bot.handle_image(update, None))
    rid = next(iter(registros(tmp_path)))

    cb, query = fake_callback(f"ok:{rid}", user_id=999)
    asyncio.run(bot.handle_callback(cb, SimpleNamespace(user_data={})))
    assert registros(tmp_path)[rid]["status"] == "aguardando_confirmacao"
    assert query.answer.await_args.kwargs.get("show_alert") is True


def test_sem_codigo_registra_sem_produto_e_avisa(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(3))

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert message.reply_text.await_args_list[-1].args[0] == MSG_SEM_CODIGO
    assert "reply_markup" not in message.reply_photo.await_args.kwargs
    (reg,) = registros(tmp_path).values()
    assert reg["codigo"] is None and reg["origem_codigo"] == "sem_produto"
    assert reg["quantidade_detectada"] == 3 and reg["status"] == "aguardando_confirmacao"


def test_sem_codigo_lido_usa_o_sku_da_legenda(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(3), caption="  ab-123 \n obs do operador")

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    (reg,) = registros(tmp_path).values()
    assert reg["codigo"] == "AB-123" and reg["origem_codigo"] == "legenda"
    assert reg["cor"] == "verde" and reg["unidades_por_fardo"] == 5
    assert "reply_markup" not in message.reply_photo.await_args.kwargs


def test_codigo_e_legenda_iguais_registra_com_origem_ambos(tmp_path: Path):
    update, _ = fake_update(jpeg_with_markers(2, ("PRAT-7",)), caption="prat-7")

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    (reg,) = registros(tmp_path).values()
    assert reg["codigo"] == "PRAT-7" and reg["origem_codigo"] == "codigo_e_legenda"


def test_codigo_diferente_da_legenda_nao_registra(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(2, ("PRAT-7",)), caption="PRAT-8")

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert "diferente do SKU da legenda" in message.reply_text.await_args_list[-1].args[0]
    assert registros(tmp_path) == {}


def test_dois_codigos_com_legenda_escolhe_o_da_legenda(tmp_path: Path):
    update, _ = fake_update(jpeg_with_markers(2, ("PRAT-A", "PRAT-B")), caption="PRAT-B")

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    (reg,) = registros(tmp_path).values()
    assert reg["codigo"] == "PRAT-B" and reg["origem_codigo"] == "codigo_e_legenda"


def test_dois_codigos_nao_registra(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(2, ("PRAT-A", "PRAT-B")))

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert "Encontrei 2 códigos" in message.reply_text.await_args_list[-1].args[0]
    assert registros(tmp_path) == {}


def test_foto_pequena_e_recusada_antes_de_contar(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(2, ("PRAT-1",), largura=800, altura=600))

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert "Foto pequena demais" in message.reply_text.await_args_list[-1].args[0]
    message.reply_photo.assert_not_awaited()


def test_arquivo_grande_e_recusado_sem_baixar(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(1), file_size=50 * 1024 * 1024)

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert "grande demais" in message.reply_text.await_args_list[-1].args[0]
    message.photo[0].get_file.assert_not_awaited()


def test_debug_mantem_original_e_processada(tmp_path: Path):
    update, _ = fake_update(jpeg_with_markers(2))

    asyncio.run(make_bot(tmp_path, debug=True).handle_image(update, None))

    names = sorted(p.parent.name for p in temp_files(tmp_path))
    assert names == ["processed", "received"]


def test_sem_marcadores_orienta_nova_foto(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(0))

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert message.reply_text.await_args_list[-1].args[0] == MSG_NOT_FOUND
    message.reply_photo.assert_not_awaited()


def test_erro_tecnico_vai_para_o_log_e_nao_para_o_usuario(tmp_path: Path, caplog):
    update, message = fake_update(b"isto nao e uma imagem")

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    assert message.reply_text.await_args_list[-1].args[0] == MSG_ERROR
    assert "falha ao processar" in caplog.text
    assert "telegram_user_id=111" in caplog.text
    assert all_files(tmp_path) == []


def test_sem_token_nao_inicia():
    with pytest.raises(RuntimeError, match="TELEGRAM_STOCK_BOT_TOKEN"):
        build_application(BotSettings(_env_file=None, TELEGRAM_STOCK_BOT_TOKEN=None), DetectorSettings(_env_file=None))


# ---------------------------------------------------------------------------
# AUT-14: só IDs permitidos (TELEGRAM_ALLOWED_USERS / TELEGRAM_ALLOWED_CHATS)
# ---------------------------------------------------------------------------

def _bot_restrito(tmp_path: Path, users: str = "", chats: str = "") -> StockCounterBot:
    bot_settings = BotSettings(
        _env_file=None, TEMP_DIR=tmp_path, TELEGRAM_ALLOWED_USERS=users, TELEGRAM_ALLOWED_CHATS=chats
    )
    return StockCounterBot(bot_settings, DetectorSettings(_env_file=None, MAX_PROCESSING_WIDTH=1200))


def test_usuario_fora_da_lista_e_ignorado_sem_baixar_foto(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(2))  # user 111, chat 222
    asyncio.run(_bot_restrito(tmp_path, users="999").handle_image(update, None))
    message.reply_text.assert_not_awaited()
    message.photo[0].get_file.assert_not_awaited()
    assert all_files(tmp_path) == []


def test_usuario_permitido_e_atendido(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(2))
    asyncio.run(_bot_restrito(tmp_path, users="999, 111").handle_image(update, None))
    message.reply_photo.assert_awaited_once()


def test_chat_permitido_libera_qualquer_usuario_do_grupo(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(1))
    asyncio.run(_bot_restrito(tmp_path, chats="222").start(update, None))
    message.reply_text.assert_awaited_once()


def test_listas_vazias_mantem_comportamento_antigo(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(1))
    asyncio.run(_bot_restrito(tmp_path).handle_other(update, None))
    message.reply_text.assert_awaited_once()


def test_ids_invalidos_sao_ignorados():
    s = BotSettings(_env_file=None, TELEGRAM_ALLOWED_USERS="12, abc, -100500 ;7", TELEGRAM_ALLOWED_CHATS="")
    assert s.allowed_users == frozenset({12, -100500, 7})
    assert s.allowed_chats == frozenset()


def test_registro_dir_vazio_no_env_usa_temp_registro(tmp_path: Path):
    s = BotSettings(_env_file=None, TEMP_DIR=tmp_path, REGISTRO_DIR="  ")
    assert s.registro_dir == tmp_path / "registro"


def test_prendedor_rosa_registra_fardo_de_10(tmp_path: Path):
    update, message = fake_update(jpeg_with_markers(3, rosa=True), caption="AB-123")

    asyncio.run(make_bot(tmp_path, debug=False).handle_image(update, None))

    (reg,) = registros(tmp_path).values()
    assert reg["cor"] == "rosa" and reg["unidades_por_fardo"] == 10 and reg["quantidade_detectada"] == 3
    assert "rosa choque: 10 un. por fardo = 30 un." in message.reply_photo.await_args.kwargs["caption"]
