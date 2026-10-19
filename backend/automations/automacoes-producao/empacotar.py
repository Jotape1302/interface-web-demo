"""
Gera o zip de instalação para o PC do encarregado (baixado na Visão Geral da Produção):
    python backend/automations/automacoes-producao/empacotar.py
Rode de novo sempre que mudar algo em app/, requirements.txt ou nos .bat.
"""
import zipfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
DESTINO = AQUI.parents[2] / "frontend" / "public" / "downloads" / "norvia-etiquetas-producao.zip"
ARQUIVOS = ["LEIA-ME.txt", "iniciar.bat", "liberar_firewall.bat", "requirements.txt", ".env.example"]

DESTINO.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(DESTINO, "w", zipfile.ZIP_DEFLATED) as z:
    for nome in ARQUIVOS:
        z.write(AQUI / nome, f"norvia-etiquetas/{nome}")
    for py in sorted((AQUI / "app").glob("*.py")):
        z.write(py, f"norvia-etiquetas/app/{py.name}")
print(f"Gerado {DESTINO.relative_to(AQUI.parents[2])}")
