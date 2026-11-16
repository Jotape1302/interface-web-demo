# Imagem base fixada por tag de patch + digest (índice multi-arquitetura). Para atualizar,
# troque os dois juntos (docs/seguranca-deploy.md, "Imagens base fixadas").
FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89

LABEL maintainer="Engenharia de Software"
LABEL description="Bot do Telegram para contagem de pacotes por prendedores verdes (OpenCV)"

ENV TZ=America/Sao_Paulo \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

# Bibliotecas de sistema usadas pelo OpenCV headless e pela leitura do código de barras (pyzbar).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    libglib2.0-0 \
    libzbar0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements.lock: versões exatas + hashes geradas do requirements.txt (que guarda só os
# mínimos e o motivo de cada um). Para atualizar, ver scripts/README.md ("Lock das dependências").
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

RUN groupadd -r -g 1000 appuser && \
    useradd -r -u 1000 -g appuser -d /app -s /sbin/nologin appuser && \
    mkdir -p /app/temp/received /app/temp/processed /app/temp/registro /app/logs && \
    chown -R appuser:appuser /app

COPY --chown=appuser:appuser app/ /app/app/
COPY --chown=appuser:appuser scripts/ /app/scripts/

USER appuser

# A API interna (thread) responde enquanto o processo do bot estiver de pé.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('API_PORT', '8002'), timeout=4)"

# Long polling do bot + API interna (API_PORT, 8002) só na rede do docker: sem porta publicada
# no host nem rota no NGINX; quem chama é o gateway.
CMD ["python", "-m", "app.main"]
