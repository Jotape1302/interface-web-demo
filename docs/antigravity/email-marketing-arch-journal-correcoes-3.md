# Tarefa para o Antigravity: 3ª rodada do "Arch Journal" — teste real no Gemini e comprovações

Continuação de `docs/antigravity/email-marketing-arch-journal-correcoes-2.md`. A revisão de
13/11/2026 aprovou o código de D1, D3, D4, D5 e D6 (pytest 32, ruff, gateway 222, frontend 194,
rodízio simulado alternando o hero). **Não refaça nem refatore nada disso.** Faltam só as
comprovações que não foram entregues e três ajustes pequenos.

Não faça commit nem push. Entregue um relatório com **cada item abaixo e a evidência pedida**
(saída de comando colada, caminho dos arquivos, print). Item sem evidência conta como não feito.

---

## E1. Geração real no Gemini (OBRIGATÓRIO — pedido pela 2ª vez)

Na rodada anterior não foi gerada nenhuma imagem real: `data/ambientes/` só tem as 4 do estoque
inicial e as 58 candidatas em `/tmp/marketing-*` são todas de cor sólida (mock).

1. Conferir o modelo com a chave do `.env` do serviço:
   `curl -s -H "x-goog-api-key: $GEMINI_API_KEY" "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200" | grep -A3 '"models/gemini-3.1-flash-image"'`
   → colar a saída.
2. Rodar **fora do `MOCK_MODE`**, com `DATA_DIR` e `PUBLICO_DIR` apontando para as pastas reais do
   serviço (`backend/automations/automacoes-marketing/data` e `.../publico`), **uma** geração de
   `perfil_t` com `quantidade=1`. Pode ser um script avulso (fora de `tests/`):
   ```bash
   cd backend/automations/automacoes-marketing
   MOCK_MODE=false GERAR_SEXTA_AUTOMATICO=false .venv/bin/python -c "
   import time; t=time.time()
   from app.ambientes.gerenciador import _executar_geracao_tarefa
   _executar_geracao_tarefa('perfil_t', 'teste real Antigravity', 1)
   print('ok em', round(time.time()-t,1), 's')"
   ```
3. Se a API recusar algum campo (HTTP 400, por exemplo `imageConfig`/`aspectRatio`): ler a
   mensagem, conferir a documentação atual da API Gemini, corrigir `_chamar_gemini_imagem` e
   repetir. Anotar no README o formato que funcionou.
4. Se vier **429 de cota** (modelo sem cota grátis) ou erro de faturamento: **parar**, colar a
   mensagem exata da API e não tentar outro modelo nem outro provedor.
5. **Não aprovar** a candidata (a aprovação é do usuário no painel).

**Entregar:**
- o registro novo do `data/ambientes/indice.json` (colado);
- os caminhos de `cand-perfil_t-…jpg` e `…_4x5.jpg`, com dimensões e tamanho em KB;
- se `formato_4x5` saiu `"gerado"` ou `"recorte"` (e, se recorte, o motivo do log);
- o tempo total e o `finishReason`;
- sua avaliação honesta da imagem: o perfil T está **na junta entre dois pisos no mesmo nível**,
  com a forma do render? Há texto, logotipo, pessoas ou deformação? Não esconder problema.

## E2. `docker build` e conferência no container (pendente desde a 1ª rodada)

```bash
docker build -t automacoes-marketing-teste backend/automations/automacoes-marketing
docker run --rm --entrypoint sh automacoes-marketing-teste -c \
  "ls /app/referencias/renders /app/referencias/exemplos /app/referencias/estoque_inicial /app/referencias/marca; fc-list | grep -i inter || ls /usr/share/fonts -R | grep -i inter"
```
Colar a saída dos dois comandos (se o `docker` local for rootless/podman, use o que houver e diga
qual foi).

## E3. Print da prévia do e-mail no painel (D5)

Com o gateway e o serviço rodando local (ou o modo demo, se ele mostrar imagens de ambiente), abrir
E-mail Marketing → um rascunho → prévia. Anexar **um print** em que as fotos do hero e dos 3 cards
aparecem dentro do `iframe`, e um print da aba "Banco de ambientes" com a candidata da E1 (3:2 e
4:5 lado a lado). Informar o navegador e a versão.

## E4. Ajustes pequenos

1. **Painel baixa imagens demais** (`frontend/app/components/marketing-view.tsx`, efeito que
   monta `idsNecessarios`): hoje baixa 3:2 **e** 4:5 de **todas** as imagens do índice, inclusive
   recusadas, a cada carregamento. Baixar só as da linha/filtro visível na aba "Banco de
   ambientes", pular as `recusada`, e na prévia só os ids do rascunho ativo. Ids que falharam não
   são buscados de novo a cada renderização (guardar a falha).
2. **Pastas temporárias dos testes**: `tests/test_marketing.py` cria `DATA_DIR`/`PUBLICO_DIR` com
   `mkdtemp` e não apaga (já são 72 em `/tmp`). Apagar no fim da sessão (`atexit` ou fixture de
   sessão com `shutil.rmtree`).
3. **`email_builder.py`**: remover o padrão `fonte_link = "https://www.norvia.example"` (assinatura
   de `construir_html_arch_journal` e `renderizar_email_marketing`); sem link, sem crédito.
   Teste: pauta `artigo_rss` sem `fonte_link` → nenhum "Referência:" no HTML.

## E5. Verificações finais (colar a saída)

1. `cd backend/automations/automacoes-marketing && .venv/bin/python -m pytest -q && uvx ruff check .`
2. `cd backend/gateway && npm test && npx tsc --noEmit`
3. `cd frontend && npm run lint && npx tsc --noEmit && npm test`
4. `git status --porcelain -- backend/automations/automacoes-marketing/publico frontend/public`
   → nada novo (as imagens reais da E1 ficam em `data/` e não são versionadas).
5. `ls -d /tmp/marketing-* 2>/dev/null | wc -l` antes e depois do pytest → não aumenta.

## Regras de sempre

- Sem dado inventado; não esconder erro da API nem imagem ruim.
- Não editar `execucoes.py` nem `docker-compose.yml`.
- Não aprovar imagem, não mudar `GEMINI_IMAGE_MODEL` sem a lista de modelos provar que o atual não
  existe.
- Painel com cantos retos e âmbar só em ação.
