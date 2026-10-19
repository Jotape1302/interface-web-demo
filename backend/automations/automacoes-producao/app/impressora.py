"""
Envio do comando (ZPL ou EPL) para a impressora de etiquetas ligada na USB deste PC.

Windows: manda os bytes em modo RAW para o spooler (win32print), sem janela de impressão.
Linux: escreve direto no dispositivo USB (/dev/usb/lp0).
"""
import logging
import os
import threading
from typing import List, Optional

from app.config import Settings, settings

try:
    import win32print
except ImportError:  # fora do Windows
    win32print = None

logger = logging.getLogger("producao.impressora")

# Nomes que o Windows costuma dar para a Elgin L42-DT (ou uma Zebra, se trocarem a impressora).
PALAVRAS_CHAVE = ("elgin", "l42", "zebra", "zdesigner")

# Dois pedidos ao mesmo tempo não podem intercalar os bytes na impressora.
_lock = threading.Lock()


class ImpressoraIndisponivel(RuntimeError):
    """A impressora configurada não foi encontrada neste PC."""


def impressoras_windows() -> List[str]:
    if win32print is None:
        return []
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    return [p[2] for p in win32print.EnumPrinters(flags)]


def encontrar_impressora(cfg: Optional[Settings] = None) -> Optional[str]:
    """Nome da impressora a usar: a do .env, senão a primeira com nome de Elgin/L42/Zebra."""
    cfg = cfg or settings
    if win32print is None:
        return cfg.DISPOSITIVO_USB if os.path.exists(cfg.DISPOSITIVO_USB) else None
    nomes = impressoras_windows()
    if cfg.IMPRESSORA:
        return cfg.IMPRESSORA if cfg.IMPRESSORA in nomes else None
    for nome in nomes:
        if any(p in nome.lower() for p in PALAVRAS_CHAVE):
            return nome
    return None


def _imprimir_windows(nome: str, dados: bytes) -> None:
    h = win32print.OpenPrinter(nome)
    try:
        win32print.StartDocPrinter(h, 1, ("Etiqueta Produção Norvia", None, "RAW"))
        try:
            win32print.StartPagePrinter(h)
            win32print.WritePrinter(h, dados)
            win32print.EndPagePrinter(h)
        finally:
            win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)


def imprimir(comando: str, cfg: Optional[Settings] = None, codificacao: str = "utf-8") -> str:
    """
    Manda o comando (ZPL ou EPL) para a impressora e devolve o nome dela. `codificacao`: utf-8 para
    ZPL (^CI28), cp1252 para EPL (I8,A,055); caractere fora dela vira '?'. Em SIMULACAO só registra no log.
    """
    cfg = cfg or settings
    if cfg.SIMULACAO:
        logger.info("[SIMULAÇÃO] Comando gerado, nada enviado à impressora:\n%s", comando)
        return "simulação"

    nome = encontrar_impressora(cfg)
    if not nome:
        disponiveis = ", ".join(impressoras_windows()) or "nenhuma"
        alvo = f"'{cfg.IMPRESSORA}'" if cfg.IMPRESSORA else "Elgin/L42/Zebra"
        raise ImpressoraIndisponivel(
            f"Impressora {alvo} não encontrada neste PC. Impressoras instaladas: {disponiveis}."
        )

    dados = comando.encode(codificacao, errors="replace")
    with _lock:
        if win32print is not None:
            _imprimir_windows(nome, dados)
        else:
            with open(nome, "wb") as f:
                f.write(dados)
    return nome
