# Tarefa para o Antigravity: e-mail marketing com IA de verdade + carrossel do Instagram

Serviço: `backend/automations/automacoes-marketing` (FastAPI, porta 8004), proxy no gateway
(`backend/gateway/src/routes/marketing.ts`) e tela `frontend/app/components/marketing-view.tsx`
(área **Marketing** do menu). Leia este documento inteiro antes de mudar qualquer arquivo.

---

## 1. O problema (diagnóstico já feito, não precisa refazer)

Em produção (12/11/2026) as duas edições geradas saíram assim:

- título = título original da matéria, sem tradução ("Casa na Floresta / Tom Lontine Architect");
- a matéria não tem relação com o produto (casa na floresta com Perfil T de piso);
- subtítulo/preheader terminam cortados em "…";
- o corpo despeja a descrição inteira do produto (o Perfil T tem **8.322 caracteres** de descrição);
- os slides são as frases fixas "CAPA: …", "DETALHAMENTO NA OBRA: …", "SOLUÇÃO NORVIA: …".

Tudo isso é o **texto de reserva** (fallback) do `app/ai/finops_router.py`, usado em silêncio
quando as chamadas de IA falham. Log do servidor na geração de 12/11 16:17 (só Groq e Gemini têm
chave lá):

```
Groq (openai/gpt-oss-120b) HTTP 429   ← limite de requisições/tokens por minuto do plano grátis
Groq (openai/gpt-oss-20b)  HTTP 429
Groq (openai/gpt-oss-120b) HTTP 413   ← requisição grande demais para o limite do modelo
Groq (openai/gpt-oss-20b)  HTTP 413
Gemini HTTP 404: "This model models/gemini-2.5-flash is no longer available to new users.
                  Please update your code to use models/gemini-3.8-flash ..."
```

As causas:

1. **Modelo do Gemini aposentado**: o padrão `GEMINI_FREE_MODEL = "gemini-2.5-flash"`
   (`app/config.py` e `.env.example`) não existe mais para contas novas → 404 em toda chamada.
   Trocar o padrão para `gemini-3.8-flash` (o que a própria API indica) e tratar 404 de modelo
   como erro de configuração com mensagem clara ("modelo X indisponível no Gemini; ajuste
   GEMINI_FREE_MODEL").
2. **Prompts grandes demais (HTTP 413 e parte dos 429)**: `_resumo_factual_catalogo()` vai em
   **todos** os prompts com a `descricao` inteira das 8 linhas (só Perfil T + Cantoneira somam
   ~11 mil caracteres), e o redator ainda repete a descrição do produto 3 vezes (bloco do produto,
   `chamada_produto_texto` no modelo de JSON e especificações). O plano grátis do Groq limita
   tokens por minuto e por requisição. O prompt tem de caber com folga: no resumo do catálogo usar
   `descricao_curta` (2.1); a descrição completa só do produto da edição, limitada a 1.500
   caracteres; o modelo de JSON **sem** a descrição pré-preenchida (o
   `"chamada_produto_texto": "{produto['descricao']}"` manda a IA reescrever 8 mil caracteres
   dentro do JSON). Meta: cada prompt (sistema + usuário) abaixo de **12.000 caracteres** —
   colocar um teste que monta os 3 prompts com o maior produto (Perfil T) e confere isso.
3. **429 sem espera**: o código troca de modelo na hora e, em 3 s, gasta todas as tentativas. A
   geração roda em segundo plano (não há limite do NGINX), então pode esperar: em 429, ler
   `Retry-After` (ou `x-ratelimit-reset-*` do Groq) e esperar até **60 s** antes de tentar de
   novo, no máximo 3 vezes por provedor; espaçar as chamadas da mesma geração.
4. **Timeouts curtos** (precaução, não foi o que derrubou desta vez): Groq `(5, 15)`, Gemini
   `(5, 18)`, Anthropic/OpenAI `(5, 25)`; os modelos que raciocinam antes de responder passam
   disso. E a Anthropic com `max_tokens: 1600` corta a resposta no meio → JSON inválido.
5. **Fallback silencioso em 3 etapas**: `selecionar_melhores_pautas_da_semana` cai em
   `artigos[0]`/`artigos[1]` (por isso a matéria não tem nexo), `triar_e_conectar_produto_norvia`
   devolve o título original, `gerar_copy_edicao_norvia` devolve o texto fixo. O painel mostra
   isso como se fosse uma edição pronta.
6. **Dados do catálogo cortados**: em `catalogo/catalogo_produtos_norvia.json`,
   `linhas_editoriais.*.resumo_card` termina em "..." em 7 das 8 linhas, e `descricao` do
   `perfil_t` (8.322) e da `cantoneira` (3.093) são a página inteira do site. O e-mail usa
   `produto_principal.get("descricao")` no card do produto (`app/templates/email_builder.py`,
   linha ~177).
7. **O redator inventa que o projeto usa produto Norvia** ("O estúdio Raddar apresenta… enquanto
   o rodapé invertido Veles garante…"). Não sabemos que materiais o projeto usou: isso é falso.
8. **Trocar o produto não refaz o texto**: `trocar_produto_rascunho` só troca título/chamada do
   produto; os parágrafos e os slides continuam falando do produto antigo.

---

## 2. O que fazer

### 2.1 Textos do catálogo (em `app/config.py`, ao carregar — NÃO edite o JSON à mão)

- Função `frases_completas(texto, limite)`: devolve as primeiras **frases inteiras** (separadas
  por `.`, `!` ou `?`) que cabem no limite; nunca corta no meio e nunca devolve texto terminado em
  `...` ou `…`. Se a primeira frase sozinha passar do limite, devolve só ela.
- Para cada linha de `PRODUTOS_NORVIA`:
  - `descricao_curta = frases_completas(descricao, 420)`;
  - `resumo_card`: se terminar em `...`/`…`, refazer com `frases_completas(descricao, 220)`.
- O e-mail (card do produto) e a API `/api/v1/produtos` usam `descricao_curta`/`resumo_card`,
  nunca a `descricao` inteira. A `descricao` inteira continua disponível só como contexto factual
  para a IA.

### 2.2 IA (`app/ai/finops_router.py`)

**Sem fallback silencioso.** Em modo real (`MOCK_MODE=false`):

- Uma função única tenta os provedores configurados em ordem e, para cada um, **valida** o JSON
  (ver 2.4). Resposta inválida → tenta de novo no mesmo provedor uma vez, mandando no prompt a
  lista do que foi recusado; depois passa ao próximo provedor.
- Se nenhum provedor entregar um JSON válido, levanta uma exceção própria (ex.:
  `IAIndisponivel`) com o motivo de cada provedor resumido (`"Groq: timeout; Gemini: HTTP 429;
  Anthropic: sem chave"`). **Nunca** devolver texto fixo de reserva no modo real. A rotina já
  transforma exceção em `ultimo_erro` no painel e em `logger.error` (que vira incidente nos
  agentes Qwen) — mantenha isso.
- Em `MOCK_MODE=true` (testes), devolver respostas fixas **completas e válidas** (que passem na
  mesma validação), sem rede.
- 429: esperar e repetir (causa 3 da seção 1). 404 de modelo e 413: não adianta repetir — 413 indica
  prompt grande (corrigir o tamanho, não o provedor); 404 vira mensagem de configuração.
- `GEMINI_FREE_MODEL` padrão `gemini-3.8-flash` em `app/config.py` e `.env.example`.
- Timeouts: leitura de **90 s** para Groq e Gemini, **120 s** para Anthropic/OpenAI. Anthropic com
  `max_tokens` ≥ **4000** e lendo o primeiro bloco `type == "text"` (não `content[0]` às cegas).
- Ordem: seleção e triagem → Groq, Gemini, Anthropic, OpenAI. Redação → Anthropic, OpenAI, Groq,
  Gemini (a paga primeiro se tiver chave, como hoje).
- Chave do Gemini continua no header `x-goog-api-key` (nunca na URL). Não logar o texto das
  respostas inteiro (no máximo 200 caracteres do erro HTTP).
- Remover os campos `_custo_usd` inventados.

**Seleção das pautas (`selecionar_melhores_pautas_da_semana`)**

- Mandar para a IA até 18 matérias (índice, fonte, título, resumo de até 400 caracteres) e, do
  catálogo, só nome/slug/função curta de cada linha (sem as descrições) — é o prompt mais longo.
- Para cada dia a IA devolve `indice_artigo`, `produto_slug`, `nota_aderencia` (0–10) e
  `trecho_da_materia`: **uma frase copiada literalmente do título ou do resumo** que mostra o
  elemento ligado ao produto (piso, rodapé, parede, iluminação linear, quina, degrau, transição
  entre revestimentos…).
- Segunda: `rodape_invertido`, `rodape_invertido_aquila`, `rodape_orion_led` ou
  `perfil_led_embutir`. Quinta: `perfil_t`, `redutor_piso`, `cantoneira` ou `listelo_velino`.
  As duas matérias têm de ser diferentes.
- **Conferência no código** (não confiar na IA): o `trecho_da_materia` normalizado (minúsculas,
  sem acento, espaços colapsados) tem de aparecer no título+resumo normalizado da matéria
  escolhida, e `nota_aderencia >= 6`. Se falhar, aquele dia fica **sem matéria**.
- Dia sem matéria vira **edição técnica** do produto (sem citar fonte nenhuma): o rascunho grava
  `pauta = "guia_tecnico"` e `artigo_* = None`; o e-mail não mostra "Referência editorial". Nunca
  pegar `artigos[0]` como reserva.
- O coletor pode buscar mais matérias (`limite_por_fonte=12`) para ter de onde escolher.

**Triagem (`triar_e_conectar_produto_norvia`)**

- Passar o texto da matéria: `extrair_texto_limpo_artigo(link, resumo)` já existe no coletor e
  hoje não é usado. Limitar a 3000 caracteres.
- `titulo_traduzido_ptbr` sempre em português (Dezeen vem em inglês).

**Redação (`gerar_copy_edicao_norvia`)**

- No modelo de JSON do prompt, **nenhum** campo pode vir pré-preenchido com a descrição do
  produto. `chamada_produto_texto` é escrito pela IA: 2–3 frases, até 320 caracteres.
- Regras no prompt (e conferidas na validação quando possível):
  - **Nunca afirmar que o projeto da matéria usa produto Norvia.** Estrutura: o que a matéria
    mostra (crédito ao escritório e à fonte) → o desafio de acabamento que aparece nesse tipo de
    projeto → como o produto Norvia resolve um detalhe parecido.
  - Só fatos do catálogo (medidas, cores, função); nada de medida/cor/uso inventado.
  - Todas as frases completas; nenhum campo termina em "..." ou "…".
  - Português do Brasil, sem emoji no assunto.
  - Edição técnica (sem matéria): mesmo formato, sem citar projeto nem fonte.
- Novo campo **`carrossel`** (substitui `slides_instagram`): lista de **6 a 8** slides
  `{"tipo": "capa"|"texto"|"produto"|"cta", "titulo": str, "texto": str}`. O carrossel conta a
  **mesma história do e-mail**, dividida: capa (manchete) → a matéria/projeto → o desafio → a
  solução Norvia → especificações reais → CTA (norvia.example). Primeiro slide `capa`, último
  `cta`, pelo menos um `produto`.
- `legenda_instagram`: até 1.500 caracteres, crédito da matéria quando houver
  ("Projeto: X — via ArchDaily Brasil"), hashtags no fim.

### 2.3 Rotina (`app/rotina.py`)

- Guardar no rascunho o que a matéria tinha (`artigo_fonte`, `artigo_titulo`, `artigo_url`,
  `artigo_resumo`, `pauta`), para poder refazer o texto depois.
- **Trocar o produto refaz a edição**: triagem + redação + carrossel + HTML com o produto novo, em
  segundo plano (mesmo mecanismo e mesmo lock da geração do lote: `iniciar_geracao`/`_geracao`).
  O POST responde **202** (iniciado), **409** (já há geração rodando) ou **400** (produto
  inválido, rascunho inexistente ou já aprovado — conferido ANTES de disparar a thread).
- Edição aprovada continua intocável (nem geração nem troca de produto mexem nela).
- Depois de gerar o texto, gerar as imagens do carrossel (2.5). Falha nas imagens não derruba a
  edição: o rascunho fica com `carrossel_erro` e o painel mostra o aviso.

### 2.4 Validação do JSON (função pura, testável)

Recusar (lista de problemas em texto) quando:

- falta campo obrigatório ou vem vazio: `assunto`, `assunto_alt`, `preheader`, `titulo_principal`,
  `subtitulo`, `legenda_foto`, `paragrafos_corpo`, `motivos_destaque`, `chamada_produto_titulo`,
  `chamada_produto_texto`, `carrossel`, `legenda_instagram`;
- `assunto` > 70 caracteres, `preheader` > 140, `titulo_principal` > 110,
  `chamada_produto_texto` > 400, `legenda_instagram` > 2200;
- qualquer texto termina em `...` ou `…`;
- `paragrafos_corpo` fora de 2–4 itens ou parágrafo com menos de 120 caracteres;
- `motivos_destaque` diferente de 3 itens `{titulo, texto}`;
- `carrossel` fora de 6–8 slides, slide sem `titulo`/`texto`, `titulo` > 60, `texto` > 240,
  primeiro não é `capa`, último não é `cta`, nenhum `produto`;
- nenhum parágrafo cita a referência (`NRV…`) ou o `nome_curto` do produto;
- com matéria: o `titulo_principal` é igual ao título original em inglês (sem tradução).

### 2.5 Imagens do carrossel (novo módulo, ex.: `app/instagram/carrossel.py`)

- **Pillow** (adicionar em `requirements.txt` e regerar o lock com hashes — ver 4). Fonte:
  instalar `fonts-inter` no Dockerfile (`apt-get install -y --no-install-recommends tzdata
  fonts-inter`); no código, procurar `Inter-*` em `/usr/share/fonts` e cair para DejaVu e por fim
  `ImageFont.load_default(size=…)` (os testes rodam sem a fonte).
- JPEG **1080×1350** (4:5), qualidade 90, um arquivo por slide em
  `DATA_DIR/carrossel/<rascunho_id>/slide-01.jpg…` (apagar a pasta antiga ao refazer). O volume
  `data/` já tem a ACL do rootless; escrever com tmp + `os.replace`, arquivos 0644.
- Visual da marca, igual ao e-mail: fundo marinho `#0f1b2d`, texto branco/`#D6DFEB`, chapéu e
  filete em âmbar `#f59e0b`, cabeçalho "NORVIA / SOLUÇÕES EM ACABAMENTOS", contador `2/7` no
  canto, rodapé `norvia.example`. Cantos retos, sem degradês chamativos, sem emoji, sem
  ícones genéricos.
- `capa` e `produto` levam a **foto do produto** (`imagem_cdn_oficial` do catálogo, baixada com
  timeout de 20 s e guardada em `DATA_DIR/imagens/<slug>.<ext>`), recortada em "cover". Sem foto
  (download falhou) → bloco marinho, sem quebrar. **Não usar a foto da matéria** (direito autoral
  do ArchDaily/Dezeen).
- Texto com quebra de linha medida pela fonte (`ImageDraw.textbbox`) e redução automática do
  tamanho até caber na área; nunca cortar texto. Se nem no tamanho mínimo couber, isso é erro de
  validação (o 2.4 já limita os tamanhos).

### 2.6 API do serviço (`app/api.py`)

- `GET /api/v1/rascunhos/{id}/carrossel/{n}` → `image/jpeg` (n de 1 a N; id validado com
  `^[A-Za-z0-9-]{1,64}$`; 404 se não existir; caminho resolvido e conferido dentro da pasta, sem
  path traversal).
- `GET /api/v1/rascunhos/{id}/carrossel.zip` → `application/zip` com os slides e um
  `legenda.txt`.
- `POST /api/v1/rascunhos/{id}/produto` passa a responder 202/409/400 (2.3).
- Continua tudo atrás de `exigir_chave_interna`; nada de CORS; docs desligados.

### 2.7 Gateway (`backend/gateway/src/routes/marketing.ts` + `permissions.ts`)

- Hoje o proxy só aceita JSON. Acrescentar as duas leituras binárias acima: `GET
  /api/marketing/rascunhos/<id>/carrossel/<n>` e `.../carrossel.zip`, repassando o corpo como
  bytes com o `Content-Type` da automação (padrão já usado em `routes/stock-count.ts`, que
  devolve JPEG com `ctx.response.writeHead(200)` + `end(buf)`), `Cache-Control: private`.
- Permissão `email_marketing:ver` para as duas (em `ROUTE_RULES` de `permissions.ts`, com
  `sample`), e acrescentar as rotas dinâmicas na lista `DYNAMIC` de
  `test/permissions-coverage.test.ts`.
- POST de produto: tratar o 202 e o 409 como hoje se trata a geração do lote.
- Testes em `test/marketing.test.ts`: binário repassado intacto, 404 para rota fora da lista,
  `X-Usuario` só nos POST.

### 2.8 Frontend

- `lib/marketing-contracts.ts`: `carrossel: Array<{tipo, titulo, texto}>`; rascunho com
  `pauta`, `carrossel_slides` (quantidade) e `carrossel_erro`. Rascunhos antigos podem vir com
  `slides_instagram: string[]` — tratar os dois formatos sem quebrar.
- Painel "Carrossel Instagram" no lugar do "Kit Carrossel" atual: miniaturas dos slides, botão
  **Baixar todos (.zip)**, baixar slide a slide e **Copiar legenda**.
- As imagens precisam do token: `<img src>` direto **não** leva o header de autenticação. Buscar
  com o `fetch` da sessão (base `apiBaseUrl` do `useAuth`, nunca URL fixa), converter em
  `URL.createObjectURL(blob)` e revogar ao desmontar/trocar de edição. O download do zip do
  mesmo jeito.
- Trocar o produto: mostrar "refazendo a edição…" e acompanhar pelo `useDataPolling` já usado na
  geração do lote; o seletor fica desabilitado enquanto roda.
- Edição técnica (sem matéria): mostrar "Sem matéria da semana ligada ao produto — edição
  técnica" no lugar de "Pauta de arquitetura de referência".
- Modo demo (`createMarketingService(…, 'demo')`): carrossel de exemplo sem imagens (mostra os
  textos dos slides) — nada de número ou execução inventada aparecendo como real.
- Visual do painel: sem "cara de IA", cantos retos, fundo `#e4e8ee`, âmbar **só em ação**
  (botão), tema claro e escuro.

---

## 3. Regras do projeto que já foram quebradas antes — NÃO repetir

1. **Nada de dado inventado aparecendo como real** (números, execuções, matérias de exemplo,
   custos). Em modo real, falha vira erro visível, não texto de reserva.
2. **Testar o caminho de verdade**: a primeira versão chamava `coletar_todas_noticias` com um
   argumento que não existe e nunca rodou; os testes não pegaram. Todo caminho novo precisa de
   teste que o execute (MOCK_MODE para a IA, `monkeypatch` para rede e falhas).
3. **Escapar todo texto** de RSS/IA/catálogo no HTML (`_e()` do `email_builder.py`); manter a
   macro `{{unsubscribe_url}}` intacta.
4. Quem gera/aprova/troca vem do `X-Usuario` (gateway), **nunca** do corpo da requisição.
5. `app/execucoes.py` é cópia idêntica do marketplace/financeiro/contagem (há teste que confere):
   **não editar**.
6. **Não editar** `docker-compose.yml` (é do servidor, fora do repo). Se precisar de algo no
   compose, escrever o trecho no `README.md` do serviço.
7. Não usar CORS, não ligar `/docs`, não pôr chave em URL, não desligar `INTERNAL_AUTH`.
8. Dependência Python nova = `requirements.txt` + `requirements.lock` regerado com hashes;
   Dockerfile continua com `pip install --require-hashes -r requirements.lock`.
9. Frontend: base da API sempre por `apiBaseUrl` (basePath `/automacoes`), nunca `fetch('/api/…')`
   solto; sem cair em dados demo quando o modo é live.
10. Sem chave/segredo em teste com cara de segredo real (o gitleaks varre o histórico todo; a
    chave de teste atual já está liberada no `.gitleaks.toml`, reutilize-a).
11. Commits só depois de tudo verde (seção 4); mensagens em português; **não** faça commit nem
    push — entregue para revisão.

---

## 4. Verificações obrigatórias antes de entregar

Na raiz do repositório:

```bash
# Lock do Python (depois de mexer no requirements.txt)
cd backend/automations/automacoes-marketing
uv pip compile requirements.txt --universal --python-version 3.11 --generate-hashes -o requirements.lock
cd -

npm run test:marketing          # pytest do serviço
npm run lint:python             # ruff
npm run test:gateway
npm --prefix frontend test
npm --prefix frontend run lint  # oxlint (react-compiler incluso)
(cd frontend && npx tsc --noEmit -p .)
(cd backend/gateway && npx tsc --noEmit -p .)
```

Testes novos que precisam existir no `tests/test_marketing.py` (no mínimo):

- `frases_completas` nunca termina em "…" e não corta no meio; todas as linhas do catálogo
  carregado têm `resumo_card` e `descricao_curta` sem "..." no fim.
- Validação (2.4): copy válido passa; cada regra recusa o caso correspondente.
- Seleção: `trecho_da_materia` que não está na matéria → dia vira `guia_tecnico`;
  nota < 6 → `guia_tecnico`; nunca usa `artigos[0]` como reserva.
- Tamanho: os 3 prompts (seleção com 18 matérias, triagem, redação) montados com o Perfil T ficam
  abaixo de 12.000 caracteres cada.
- 429 com `Retry-After: 2` → espera e repete (monkeypatch em `time.sleep`, sem esperar de
  verdade no teste); 404 de modelo do Gemini → erro citando `GEMINI_FREE_MODEL`.
- Modo real com todos os provedores falhando (monkeypatch em `requests.post` levantando
  `Timeout`) → geração termina com `ultimo_erro` citando os provedores e **nenhum** rascunho
  novo gravado.
- Carrossel: gera de 6 a 8 JPEG 1080×1350; sem foto (download falhando) ainda gera; rotas
  `/carrossel/{n}` e `.zip` respondem com o tipo certo; id com `..` → 404/422.
- Trocar produto: 202, a edição refeita cita o produto novo nos parágrafos e no carrossel;
  aprovada → 400; com geração rodando → 409.
- E-mail não contém a `descricao` inteira do produto (ex.: Perfil T) e usa
  `chamada_produto_texto`.

Ao terminar, liste os arquivos alterados e o resultado de cada comando acima.
