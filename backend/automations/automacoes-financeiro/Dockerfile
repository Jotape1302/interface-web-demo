# Imagem base fixada por tag de patch + digest (índice multi-arquitetura). Para atualizar,
# troque os dois juntos (docs/seguranca-deploy.md, "Imagens base fixadas").
FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89

# Metadados
LABEL maintainer="Engenharia de Software"
LABEL description="Automação de extração de DANFEs e lançamento de contas a pagar no ERP Tiny"

# Configurações do Python para container
ENV TZ=America/Sao_Paulo \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

# Instalação de dependências do sistema necessárias para Pyzbar, OpenCV, Tesseract OCR e Poppler (PDF)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    tesseract-ocr \
    tesseract-ocr-por \
    tesseract-ocr-eng \
    libzbar0 \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalação prévia de dependências Python para aproveitamento de cache de camadas Docker
# requirements.lock: versões exatas + hashes geradas do requirements.txt (que guarda só os
# mínimos e o motivo de cada um). Para atualizar, ver scripts/README.md ("Lock das dependências").
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# Criação de usuário de sistema sem privilégios (non-root) e diretórios operacionais
RUN groupadd -r -g 1000 appuser && \
    useradd -r -u 1000 -g appuser -d /app -s /sbin/nologin appuser && \
    mkdir -p /app/input_danfes /app/processed /app/failed /app/logs /app/data && \
    chown -R appuser:appuser /app

# Cópia do código fonte da aplicação e scripts operacionais
COPY --chown=appuser:appuser app/ /app/app/
COPY --chown=appuser:appuser scripts/ /app/scripts/

USER appuser

# Modo API: GET /health na porta da API; modo daemon: só o processo vivo (app/healthcheck.py).
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-m", "app.healthcheck"]

# Execução padrão em modo daemon
CMD ["python", "-m", "app.main"]
