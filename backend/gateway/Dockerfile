# syntax=docker/dockerfile:1
# Gateway (porta 3100). Multi-stage: o estágio de build tem as devDependencies (tsc, tsx,
# @types); a imagem final leva só dist/ e as dependências de produção (npm prune --omit=dev).
#
# Imagem base fixada por tag de patch + digest (índice multi-arquitetura), obtidos com
#   skopeo inspect --raw docker://docker.io/library/node:22.23.3-alpine3.24 | sha256sum
# Para atualizar (correções de segurança do Node/Alpine), troque tag e digest juntos —
# ver docs/seguranca-deploy.md, "Imagens base fixadas".
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3100

CMD ["node", "dist/index.js"]
