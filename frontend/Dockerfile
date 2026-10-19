# ==============================================================================
# SOMENTE DESENVOLVIMENTO. Este container roda o dev server (`npm run dev`, porta 3000).
# Produção NÃO usa esta imagem: o frontend é um export estático (`npm run build`) copiado
# com rsync para /var/www/automacoes e servido pelo NGINX da VPS (ver frontend/README.md e
# docs/seguranca-deploy.md). Não publique a porta 3000 fora de 127.0.0.1.
# ==============================================================================
# Imagem base fixada por tag de patch + digest (índice multi-arquitetura).
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /app
RUN chown node:node /app

# Sem root: o dev server e o npm rodam como o usuário "node" (uid 1000) da imagem oficial.
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .

EXPOSE 3000

CMD ["sh", "-c", "rm -rf .vinext && npm run dev"]
