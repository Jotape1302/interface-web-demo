FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89

LABEL description="Automação de Marketing Norvia (Jornal de Arquitetura RD Station & Kit Instagram)"

ENV TZ=America/Sao_Paulo \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends tzdata fonts-inter fonts-dejavu-core \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements.lock: versões exatas + hashes (scripts/README.md, "Lock das dependências").
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

RUN groupadd -r -g 1000 appuser && \
    useradd -r -u 1000 -g appuser -d /app -s /sbin/nologin appuser && \
    mkdir -p /app/data /app/publico && chown -R appuser:appuser /app

# data/ e publico/ são volumes: não vão na imagem. O catálogo e referências vão.
COPY --chown=appuser:appuser catalogo/ /app/catalogo/
COPY --chown=appuser:appuser referencias/ /app/referencias/
COPY --chown=appuser:appuser app/ /app/app/

USER appuser
EXPOSE 8004

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('API_PORT', '8004'), timeout=4)"

CMD ["python", "-m", "app.main"]
