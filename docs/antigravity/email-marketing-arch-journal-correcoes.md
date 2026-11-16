# Tarefa para o Antigravity: correções da entrega do "Arch Journal" (revisão de 13/11/2026)

Continuação de `docs/antigravity/email-marketing-padrao-arch-journal.md`. Aquele roteiro e as regras
da seção 3 / verificações da seção 4 de `docs/antigravity/email-marketing-ia-e-carrossel.md`
**continuam valendo**. Trabalhe sobre a árvore atual (a entrega anterior ainda não foi commitada):
não desfaça o que já está certo (A1–A8, rotas do gateway, links B2).

Ordem: **C0 → C1 → C2 → C3 → C4 → C5 → C6**. Não faça commit nem push: entregue para revisão com
a lista de arquivos e o resultado de cada verificação da seção C7.

A entrega anterior passou nos testes (pytest 23, ruff, gateway 222, frontend 193), mas **os testes
não exercitavam o caminho real**. Cada item abaixo diz o defeito, onde está, o que fazer e o teste
que prova a correção.

---

## C0. Lixo de teste no repositório e isolamento dos testes (BLOQUEANTE)

**Defeito:** `PUBLICO_DIR = BASE_DIR / "publico"` (`app/config.py`) não é configurável. Cada
`pytest` aprova uma candidata e grava um retângulo cinza em
`publico/ambientes/rodape_invertido/cand-*.jpg` **do repositório**. O teste também reescreve
`publico/ambientes/*/amb-*.jpg` e `frontend/public/marketing/ambientes/exemplos/*.jpg`.

**Fazer:**
1. Apagar `backend/automations/automacoes-marketing/publico/ambientes/rodape_invertido/cand-*.jpg`
   (são retângulos de cor sólida gerados pelo teste, não imagens reais).
2. `PUBLICO_DIR` vira setting (`PUBLICO_DIR: Path = BASE_DIR / "publico"`), como o `DATA_DIR`.
   `PASTA_AMBIENTES_PUBLICO` deriva dele.
3. Em `tests/test_marketing.py`, antes de importar o app, `os.environ["PUBLICO_DIR"] =
   tempfile.mkdtemp(prefix="marketing-publico-")`.
4. O serviço **nunca** escreve fora de `DATA_DIR` e `PUBLICO_DIR` (nada em `frontend/`, ver C2).

**Teste:** depois de `pytest`, `git status --porcelain -- backend/automations/automacoes-marketing/publico frontend/public`
não mostra nada novo nem modificado. Escreva no README essa conferência.

---

## C1. Geração de imagem de ambiente de verdade (BLOQUEANTE)

**Defeito:** `_executar_geracao_tarefa` (`app/ambientes/gerenciador.py`) sempre cria
`Image.new("RGB", (1200, 800), cor)`, também fora do `MOCK_MODE`. Não chama Gemini nem OpenAI,
não envia render nem exemplo de referência, não gera 4:5 e não trata 429. O painel mostraria
"candidatas" que são retângulos.

**Fazer:** criar `app/ambientes/provedores.py` com a geração real, chamada pelo gerenciador.

- **Modelos (conferidos na API em 13/11/2026 com `GET /v1beta/models`):**
  - padrão `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image` (aceita `generateContent`); alternativa
    `gemini-2.5-flash-image`;
  - **`imagen-3.0-generate-002` não aparece na lista**: tirar do README;
  - `OPENAI_IMAGE_MODEL`: confira na lista da OpenAI (`GET https://api.openai.com/v1/models`) o
    modelo atual de edição de imagem com referências e anote no README a data e o resultado.
    `dall-e-3` **não** aceita imagem de referência: não serve como padrão.
- **Gemini:** `POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent`,
  chave no header `x-goog-api-key`, `generationConfig.responseModalities: ["IMAGE"]` e a proporção
  pedida (`imageConfig.aspectRatio` "3:2" ou "4:5"; confira o nome do campo na documentação atual
  e anote no README). Partes do `contents`: o texto do prompt + as imagens em `inline_data`
  (`mime_type`, `data` base64). A imagem volta em `candidates[0].content.parts[*].inline_data`.
- **Referências de cada geração:**
  - **forma:** 1 render 3D da linha em `frontend/public/marketing/produtos/` → **essas imagens
    precisam ir para dentro da imagem Docker**. Copie os renders usados para
    `backend/automations/automacoes-marketing/referencias/renders/` e os exemplos de ambiente
    (as 4 fotos do modelo + as 3 `frontend/public/marketing/produto-*.jpg`) para
    `referencias/exemplos/`, e acrescente `COPY --chown=appuser:appuser referencias/ /app/referencias/`
    no Dockerfile. Nada de ler `frontend/` em tempo de execução;
  - **estilo:** 1 ou 2 exemplos de ambiente;
  - mapa explícito `RENDER_POR_LINHA = {slug: "arquivo"}` para as 8 linhas editoriais
    (`rodape_invertido` → `rodape-invertido-veles-led.png`, `rodape_invertido_aquila` →
    `rodape-invertido-aquila-led.png`, `rodape_orion_led` → `rodape-orion-autocolante-led.png`,
    `perfil_t` → `perfil-t-45mm-aluminio.png`, `redutor_piso` → `perfil-redutor-flex-aluminio.png`,
    `cantoneira` → `cantoneira-aluminio-parede-25x25.jpg`, `listelo_velino` →
    `listelo-fino-velino-aluminio.png`, `perfil_led_embutir` → `perfil-led-embutir-22mm.jpg`).
    Teste: todo slug de `PRODUTOS_NORVIA` tem render e o arquivo existe.
- **Prompt** (completar o atual, que só tem a regra de aplicação):
  - "interior residencial brasileiro de alto padrão, fotorrealista, luz natural, paleta neutra,
    enquadramento editorial, sem distorção";
  - "o perfil deve ter exatamente a forma, a aba, o encaixe e a cor do render de referência";
  - proibido: texto, logotipo, marca d'água, pessoas, mudar forma ou cor do perfil, produto de
    outra categoria no lugar;
  - regra de aplicação da linha (`REGRAS_APLICACAO_LINHA`, já existe).
- **Saída:** cada pedido gera, por opção, **duas** imagens a partir da mesma composição: 3:2
  (e-mail) e 4:5 (carrossel). Se o provedor não aceitar a proporção, recortar ao centro (cover).
  Gravar JPEG, 1200 px no lado maior, qualidade 82; se passar de 250 KB, reduzir a qualidade em
  passos de 4 até caber (mínimo 60) e, se ainda não couber, recusar com erro. Metadados:
  `arquivo_3x2`, `arquivo_4x5`, tamanhos e dimensões reais.
- **Falhas:** 429 com espera (reaproveitar `_obter_segundos_espera_429`, até 3 tentativas); 404 →
  `"HTTP 404: modelo X indisponível — ajuste GEMINI_IMAGE_MODEL"`; resposta sem imagem (bloqueio
  de segurança, `finishReason`) → erro com o motivo. Erro vai para `ultimo_erro` da geração de
  imagens e `logger.error` (o coletor de incidentes Qwen pega).
- **Sem chave do provedor configurado:** `POST /ambientes/gerar` responde 400 "Provedor de imagem
  X sem chave configurada", sem disparar thread.
- **`MOCK_MODE`:** só no mock o gerador devolve imagem sintética (pode manter a atual), e o
  registro grava `provedor: "mock"`. Fora do mock, nunca.
- **Limite diário:** contar **imagens geradas** (opções), não registros; checar o limite **dentro**
  do lock da geração (hoje é antes do lock: dois cliques passam juntos). `quantidade` validada
  entre 1 e 4 no `GerarAmbientesRequest` (pydantic `Field(ge=1, le=4)`).
- **Lock:** a geração de imagens fica fora do lock de `_ambientes_lock` enquanto espera o
  provedor; só pega o lock para gravar o índice (mesmo padrão da A2: reler e acrescentar).

**Testes:**
- com `requests.post` em monkeypatch devolvendo uma resposta Gemini com `inline_data`: o payload
  enviado tem o header `x-goog-api-key`, `responseModalities ["IMAGE"]`, 1 render + ≥1 exemplo em
  `inline_data` e o prompt com a regra da linha e as proibições; gravam-se candidatas 3:2 e 4:5
  ≤ 250 KB, nada em `PUBLICO_DIR`;
- 429 seguido de 200 → espera e grava; 404 → `ultimo_erro` com "ajuste GEMINI_IMAGE_MODEL";
- sem `GEMINI_API_KEY` fora do mock → 400;
- dois `POST /gerar` simultâneos com limite 4 e quantidade 4 → um 202 e um 409/429.

---

## C2. Estoque inicial sem `~/Downloads` (BLOQUEANTE)

**Defeito:** `inicializar_estoque_inicial` lê `~/Downloads/email_marketing_norvia.html`
e escreve em `frontend/public/`. No container nenhum dos dois existe: o índice fica vazio, nenhuma
linha é elegível e todo o resto cai nos fallbacks do C3.

**Fazer:**
1. As 4 fotos do modelo (já extraídas, em `data/ambientes/amb-*.jpg` na sua máquina) vão para
   `referencias/estoque_inicial/` (dentro da imagem Docker, ver C1) junto com um
   `referencias/estoque_inicial/indice.json` com os 4 registros (`aprovada_por = "modelo aprovado
   pelo usuário em 12/11/2026"`, slugs do roteiro anterior).
2. `inicializar_estoque_inicial` passa a: copiar de `referencias/estoque_inicial/` para
   `DATA_DIR/ambientes/` e publicar em `PUBLICO_DIR/ambientes/<slug>/` os registros que ainda não
   estão no índice. Idempotente, sem reescrever arquivo que já existe, sem ler `Downloads`, sem
   escrever em `frontend/`.
3. Chamar **uma vez** no startup (lifespan do FastAPI), não em toda listagem/validação.
4. As fotos de `publico/ambientes/*/amb-*.jpg` **não** vão para o git (publico é volume): acrescentar
   `publico/ambientes/` ao `.gitignore` do serviço, mantendo um `.gitkeep`.
5. `frontend/public/marketing/ambientes/exemplos/` pode ficar (é referência para o painel), mas é
   arquivo estático do repositório, não gerado pelo serviço.

**Teste:** com `DATA_DIR` e `PUBLICO_DIR` vazios, subir o app → `GET /api/v1/ambientes` lista as 4
aprovadas e `listar_produtos_elegiveis()` == `["rodape_invertido", "listelo_velino",
"perfil_led_embutir"]` (na ordem de `PRODUTOS_NORVIA`); os 4 arquivos existem em `PUBLICO_DIR`
com 0644.

---

## C3. Nada de fallback para foto da CDN, linha não elegível ou texto inventado (BLOQUEANTE)

**Defeitos:**
- `selecionar_melhores_pautas_da_semana` e `gerar_copy_edicao_norvia` (`finops_router.py`):
  `if not elegiveis: elegiveis = list(PRODUTOS_NORVIA.keys())`;
- `validar_copy_edicao`: `elif elegiveis and c_slug not in elegiveis` pula a checagem quando a
  lista está vazia;
- `email_builder.py`, `_resolver_url_ambiente`: sem imagem aprovada, usa `imagem_cdn_oficial` ou
  `/marketing/produto-rodape-invertido-led.jpg`;
- `email_builder.py`: sem `cards` válidos, monta 3 cards fixos com slugs quaisquer e etiquetas
  inventadas ("ALUMÍNIO ANODIZADO", "ALTA DURABILIDADE"), e textos-padrão para `titulo_principal`,
  `texto_hero` e `selo_pauta`;
- `carrossel.py`, `gerar_slides_carrossel`: sem pasta pública, baixa a foto da CDN.

**Fazer:**
- Sem linha elegível suficiente, a geração **falha** com mensagem clara: "Nenhuma linha com imagem
  de ambiente aprovada" (segunda e quinta precisam de 1 cada; cada edição precisa de 3 linhas
  distintas para os cards). Se houver menos de 3 elegíveis, falhar com "São precisas 3 linhas com
  imagem aprovada para os cards; aprovadas: X" — o erro vai para `ultimo_erro`.
- O validador sempre checa elegibilidade (sem o `elegiveis and`).
- `email_builder` recebe as imagens já escolhidas (ver C4) e, se faltar alguma, **levanta erro**;
  não monta cards nem textos por conta própria. Rascunhos antigos (layout anterior, sem `cards`):
  o painel mostra "Rascunho no layout antigo: gere de novo" no lugar da prévia, sem quebrar a
  listagem.
- Carrossel usa só a imagem 4:5 aprovada escolhida para o rascunho; sem ela, `carrossel_erro`.
  Remover `_baixar_foto_produto` se ficar sem uso.
- O mock de `gerar_copy_edicao_norvia` também não inventa fato: `etiqueta_tecnica` sai de
  `referencia` ou de `especificacoes_site` da linha (ex.: `REF. NRVRPI02`), sem "ANODIZADO" ou
  "ESCOVADO".

**Testes:** índice só com aprovadas de `rodape_invertido` → a geração falha com a mensagem dos 3
cards; `perfil_t` sem aprovada no card → recusado pelo validador mesmo com índice vazio; o HTML do
RD nunca contém `cdn.vnda.com.br`; renderizar copy sem `cards` → exceção, não HTML.

---

## C4. Imagem escolhida uma vez por rascunho (rodízio estável) (MÉDIA)

**Defeito:** `obter_imagem_aprovada_para_edicao` grava no `estado.json` a cada chamada. O HTML é
montado duas vezes (prévia e RD) e chama a função para o hero e para cada card: a prévia pode
mostrar uma foto e o HTML do RD outra, e cada re-renderização muda as fotos.

**Fazer:**
- Ao montar a edição (`_montar_edicao`) e na troca de produto, escolher as imagens **uma vez** e
  gravar no rascunho: `imagens = {"hero": id, "cards": [id1, id2, id3], "carrossel": id_4x5}`.
  Hero e card 01 são da mesma linha: usar fotos diferentes quando houver 2+ aprovadas.
- O rodízio (`estado.json`) avança só nessa escolha; `email_builder` e o carrossel só leem
  `rascunho["imagens"]`.
- Se uma imagem escolhida for recusada depois, a prévia mostra o aviso "imagem recusada: troque o
  produto ou gere de novo" e o "Copiar HTML (RD)" fica desabilitado para esse rascunho.

**Testes:** prévia e RD do mesmo rascunho usam os mesmos ids; renderizar 3 vezes não muda ids nem
o `estado.json`; duas edições seguidas da mesma linha com 2 fotos → hero diferente.

---

## C5. HTML do e-mail (MÉDIA/BAIXA) — `app/templates/email_builder.py`

1. **Logo:**
   - publicar `logo-norvia.png` e uma versão **negativa** (branca, para o bloco `#091322`) em
     `PUBLICO_DIR/marca/` no startup (fonte: `referencias/marca/`, dentro da imagem Docker; a logo
     negativa pode ser gerada com Pillow a partir da logo, desde que fique legível no fundo escuro);
   - o `location` do NGINX no README passa a aceitar `\.(jpg|png)$`;
   - teste: toda `src` do modo RD aponta para um arquivo que existe em `PUBLICO_DIR` (mapear a URL
     para o caminho e conferir).
2. **Crédito da matéria:** `Referência: <titulo_traduzido_ptbr da triagem> — <fonte>`, link para a
   matéria. Gravar `titulo_traduzido_ptbr` no rascunho (vem da triagem) e passar ao builder. Nunca
   usar `titulo_principal` como título da matéria. Teste com artigo de título conhecido.
3. **Atendimento:** com `MARKETING_LINK_ATENDIMENTO` vazio, o link e o separador `•` antes dele
   não aparecem (hoje sai `href=""`). Teste já pedido no B6.
4. **Selo do caderno:** passar `data_prevista` do rascunho e mostrar `ED. 17/11/2026` (formato
   dd/mm/aaaa). Hoje sai `ED. #NN` porque o valor nunca é passado.
5. **`cta_hero_texto` padrão:** tirar o `&nbsp;` (é escapado e aparece `&amp;nbsp;`). Como a IA
   sempre manda o campo (validador), o padrão só existe para rascunhos antigos.
6. **Remover parâmetros sem uso** de `construir_html_arch_journal` (`dia_publicacao`) e o
   `fonte_link = "https://www.norvia.example"` padrão de `_renderizar`/`renderizar_email_marketing`:
   sem matéria, não há link de crédito.

---

## C6. IA da redação, painel e documentação (MÉDIA/BAIXA)

1. **Cards pré-preenchidos (`gerar_copy_edicao_norvia`):** o modelo de JSON traz
   `"produto_slug": "{slug_card2}"` e `"{slug_card3}"` (as duas primeiras elegíveis): é o mesmo
   viés corrigido na A5. Usar `"uma das linhas complementares permitidas"` nos cards 2 e 3.
2. **Lote (`gerar_lote_semanal`):** quando a edição virou `aprovado` durante o trabalho e o
   resultado é descartado, registrar a execução `marketing_lote_descartado_ja_aprovado` com o id
   (como a troca já faz).
3. **`/status`:** incluir `geracao_imagens = {em_andamento, iniciada_em, ultimo_erro}`. O painel
   (aba "Banco de ambientes") faz polling enquanto `em_andamento`, mostra `ultimo_erro` e libera o
   botão "Gerar 4 opções" ao terminar.
4. **Imagens no painel com o token (BLOQUEANTE para o uso):**
   - a aba "Banco de ambientes" usa `<img src={foto.url_preview}>` direto: sem `Authorization` e
     sem `apiBaseUrl`, a imagem não carrega. Usar `service.ambienteImagemBlob(id)` +
     `URL.createObjectURL` (padrão dos slides do carrossel, com `revokeObjectURL` ao desmontar);
   - a **prévia do e-mail** no `iframe` tem `<img src="/api/marketing/ambientes/…">`: antes de pôr
     no `srcDoc`, trocar cada uma dessas `src` pela blob URL correspondente (buscar pelo service).
     O `iframe` continua com `sandbox=""`;
   - teste no `frontend/lib/*.test.ts`: função pura que reescreve as `src` do HTML com um mapa
     id → blob URL, sem tocar em outras imagens.
5. **Render 3D de referência no painel:** hoje mostra `imagem_path` (foto do site) ou
   `/marketing/produtos/${slug}.png` (não existe). O `GET /produtos` passa a devolver `render_3d`
   com o arquivo de `RENDER_POR_LINHA` (C1), e o painel mostra
   `${BASE_PATH}/marketing/produtos/<arquivo>`.
6. **README do serviço:**
   - ACL do rootless: `appuser` é uid 1000 **dentro** do container, então o ACL tem de ser aplicado
     pelo namespace do rootless (`nsenter`/`rootlesskit` com `u:1000`), não com `u:1003` no host.
     Siga o padrão das outras automações do repositório (procure "nsenter" nos READMEs) e
     **nunca** `chown 1000`;
   - trecho do compose com os volumes `data` e `publico`;
   - NGINX: `location /marketing-imagens/` com `\.(jpg|png)$`;
   - modelos de imagem conferidos (C1) com data;
   - a conferência do C0.
7. **Teste da A3:** conferir que todas as palavras do texto de 240 caracteres foram desenhadas
   (juntar as linhas calculadas e comparar com o texto), como pedia o roteiro anterior.

---

## C7. Verificações para a entrega

Rodar e colar o resultado de cada uma:

1. `cd backend/automations/automacoes-marketing && .venv/bin/python -m pytest -q` e `uvx ruff check .`
2. `cd backend/gateway && npm test && npx tsc --noEmit`
3. `cd frontend && npm run lint && npx tsc --noEmit && npm test`
4. `git status --porcelain` depois dos testes: nenhum arquivo novo em `publico/` ou
   `frontend/public/` (C0).
5. `git diff --stat -- backend/automations/automacoes-marketing/app/execucoes.py docker-compose.yml`
   vazio.
6. `grep -rn "Downloads\|cdn.vnda\|imagem_cdn_oficial" backend/automations/automacoes-marketing/app`
   sem uso em caminho de produção (só no catálogo/listagem, se for o caso — justificar cada linha).
7. `docker build` do serviço e, no container,
   `ls /app/referencias/renders /app/referencias/estoque_inicial` e
   `fc-list | grep -i inter` (ou listar `/usr/share/fonts`).
8. **Uma geração real de imagem** com a chave Gemini do `.env` (1 opção, `perfil_t`): anexar as
   duas imagens geradas (3:2 e 4:5), o tamanho em KB e o registro do `indice.json`. Não aprovar:
   a aprovação é do usuário no painel.
9. HTML do RD de um rascunho gerado: tamanho em KB, lista de todos os `href` e de todas as `src`.

## C8. Regras de sempre

- Sem dado inventado: nada de texto, etiqueta, foto ou crédito que não venha do catálogo, da matéria
  ou de uma imagem aprovada.
- Testar o caminho real (provedor em monkeypatch de `requests`, não da função inteira).
- Escapar todo texto; nunca aceitar HTML da IA.
- `X-Usuario` vindo do gateway.
- Não editar `execucoes.py` nem `docker-compose.yml` (documentar no README).
- Dependência nova = `requirements.lock` com hashes.
- Frontend com `apiBaseUrl`; visual do **painel** com cantos retos e âmbar só em ação.
