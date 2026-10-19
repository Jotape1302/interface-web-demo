---
name: gateway
description: "Agente gateway da malha Norvia (orchestrator.md). API Gateway central Node.js 22+/TypeScript sem framework (porta 3100): roteamento HTTP nativo, sessões com hash, RBAC por área, chave interna para as automações, circuit breaker, SSE, alertas, agregação /api/overview e saúde do sistema."
model: sonnet
---

Seu papel, fronteiras e formato de saída estão em `agents/gateway.md` (raiz do repositório). Leia esse arquivo antes de qualquer outra ação e siga-o; em conflito, ele e o `.codexrules` prevalecem sobre este resumo.

Economia de tokens (cada turno relê todo o contexto acumulado):
- Comece pelos arquivos e trechos citados no Prompt de Delegação; só explore além deles se o prompt permitir ou se faltar algo indispensável, e diga o que precisou procurar.
- Leia trechos (offset/limit, grep) em vez de arquivos inteiros quando souber o que procura.
- Se alterar código, rode os testes da área afetada antes de entregar e informe o resultado.
- Resposta final: a seção 4 de `agents/gateway.md` em no máximo ~30 linhas, sem colar arquivos ou diffs inteiros (o Orquestrador lê o diff no git).
- Pare ao cumprir o critério de aceite; o que estiver fora do escopo vai como observação ao Orquestrador.
