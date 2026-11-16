# Imagem base fixada por tag de patch + digest (índice multi-arquitetura). Para atualizar,
# troque os dois juntos (docs/seguranca-deploy.md, "Imagens base fixadas").
FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89

LABEL description="Automações de Marketplace (Padronização de dimensões e Tipo de frete)"

ENV TZ=America/Sao_Paulo \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# tzdata para o TZ valer (a imagem slim não traz /usr/share/zoneinfo).
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements.lock: versões exatas + hashes geradas do requirements.txt (que guarda só os
# mínimos e o motivo de cada um). Para atualizar, ver scripts/README.md ("Lock das dependências").
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# Mesmo usuário (uid 1000) da automacoes-financeiro: no Docker rootless do servidor a pasta
# data/ montada precisa ser gravável por ele (dono 1003 + setfacl, ver docs/seguranca-deploy.md §4).
RUN groupadd -r -g 1000 appuser && \
    useradd -r -u 1000 -g appuser -d /app -s /sbin/nologin appuser && \
    mkdir -p /app/data && chown -R appuser:appuser /app

COPY --chown=appuser:appuser app/ /app/app/

USER appuser
EXPOSE 8001

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('API_PORT', '8001'), timeout=4)"

CMD ["python", "-m", "app.main"]
