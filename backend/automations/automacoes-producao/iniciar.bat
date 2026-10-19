@echo off
title Norvia Producao - Impressao de Etiquetas
chcp 65001 > nul
cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Python nao encontrado. Instale em https://www.python.org e marque "Add Python to PATH".
    pause
    exit /b 1
)

if not exist .venv (
    echo Primeira execucao: preparando o ambiente...
    python -m venv .venv
)
call .venv\Scripts\activate.bat

:: So instala as dependencias quando o requirements.txt muda (hash guardado em .venv).
set "REQ_HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile requirements.txt SHA256') do if not defined REQ_HASH set "REQ_HASH=%%h"
set "REQ_HASH_ANTIGO="
if exist .venv\requirements.sha256 set /p REQ_HASH_ANTIGO=<.venv\requirements.sha256
if not "%REQ_HASH%"=="%REQ_HASH_ANTIGO%" (
    echo Instalando/atualizando dependencias...
    pip install -r requirements.txt --quiet --disable-pip-version-check
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar as dependencias. Confira a internet e rode de novo.
        pause
        exit /b 1
    )
    >.venv\requirements.sha256 echo %REQ_HASH%
)

if not exist .env copy .env.example .env > nul

echo.
echo Servidor de etiquetas no ar. Deixe esta janela aberta.
echo Acesso pela internet: Cloudflare Tunnel apontando para http://localhost:8003
echo Toda chamada precisa do header X-Api-Key (CHAVE_API no arquivo .env).
echo.
python -m app.main
pause
