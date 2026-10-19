# Imagem base fixada por tag de patch + digest (índice multi-arquitetura). Para atualizar,
# troque os dois juntos (docs/seguranca-deploy.md, "Imagens base fixadas").
FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89

LABEL description="Automações de Marketplace (Padronização de dimensões e Tipo de frete)"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Mesmo usuário (uid 1000) da automacoes-financeiro: no Docker rootless do servidor a pasta
# data/ montada precisa ser gravável por ele (dono 1003 + setfacl, ver docs/seguranca-deploy.md §4).
RUN groupadd -r -g 1000 appuser && \
    useradd -r -u 1000 -g appuser -d /app -s /sbin/nologin appuser && \
    mkdir -p /app/data && chown -R appuser:appuser /app

COPY --chown=appuser:appuser app/ /app/app/

USER appuser
EXPOSE 8001

CMD ["python", "-m", "app.main"]
