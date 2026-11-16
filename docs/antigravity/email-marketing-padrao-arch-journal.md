# Tarefa para o Antigravity: correções da revisão + novo padrão de e-mail ("Arch Journal")

Continuação de `docs/antigravity/email-marketing-ia-e-carrossel.md`; as regras da seção 3 e as
verificações da seção 4 daquele documento **continuam valendo**. Faça a **Parte A antes da
Parte B**. Não faça commit nem push: entregue para revisão com a lista de arquivos e o resultado
de cada verificação.

---

## Parte A — Correções da revisão (12/11/2026)

A entrega anterior passou em todas as verificações (pytest 19, ruff, gateway 221, frontend 193,
oxlint, tsc, `execucoes.py` idêntico), mas a revisão encontrou estes defeitos:

### A1. Troca de produto trava a automação (ALTA) — `app/rotina.py`, `_executar_troca`

Dentro do `try`, `if not r or r.get("status") == "aprovado": return` sai da função **antes** de
`_geracao.update(em_andamento=False, …)`. Se a edição for aprovada (ou sumir) entre o POST e o
início da thread, `em_andamento` fica `True` para sempre e toda geração/troca responde 409 até
reiniciar o container.
**Corrigir:** liberar o estado num `finally` (vale também para `_executar_em_segundo_plano`).
**Teste:** aprovar o rascunho logo depois do 202 da troca → depois disso a geração volta a
responder 202.

### A2. Aprovação desfeita pela geração/troca (ALTA) — `app/rotina.py`

A troca e o lote leem `rascunhos.json`, esperam a IA (com 429 pode levar minutos) e gravam a
**lista inteira** no fim. Uma aprovação feita nesse meio-tempo, na outra edição ou na mesma, é
sobrescrita e volta a "pendente".
**Corrigir:** gravar por mesclagem: reler o arquivo no momento de salvar (sob um lock de
gravação de rascunhos usado também por `aprovar_rascunho`) e substituir **só** o rascunho
refeito. Se ele virou `aprovado` durante o trabalho, descartar o resultado e registrar isso na
execução.
**Teste:** com a IA em mock lento (monkeypatch), aprovar a segunda enquanto a quinta é refeita →
a segunda continua aprovada.

### A3. Carrossel corta texto em silêncio (MÉDIA) — `app/instagram/carrossel.py`

`linhas_sub[:3]` na capa, `linhas_tit[:2]` e `linhas_corpo[:5]` no slide de produto,
`linhas_tit[:3]` e `linhas_corpo[:5]` no CTA descartam o resto do texto. O slide `texto` não tem
limite e pode invadir o rodapé (y = 1260).
**Corrigir:** uma função única "caber na caixa" (largura e altura da área): reduz a fonte até um
mínimo (título 32, corpo 24) e, se ainda não couber, **levanta erro** (vira `carrossel_erro`),
nunca descarta linhas.
**Teste:** um texto de 240 caracteres em cada tipo de slide → todas as palavras desenhadas
(conferir pelas linhas calculadas) e nada abaixo de y = 1240.

### A4. `frases_completas` inventa frase (MÉDIA) — `app/config.py`

Hoje, `"…Fabricado em alumínio. Este rodapé oferece um acabamento de..."` vira
`"… Este rodapé oferece um acabamento de."`: o pedaço cortado ganha ponto e passa por frase.
**Corrigir:** o trecho que terminava em `...`/`…` é **descartado**, não pontuado. Colapsar `\n`
e espaços antes de dividir (hoje o `redutor_piso` sai com `"Medidas:\n46mm x 12mm."`).
**Teste:** com o exemplo acima, o resultado é `"Fabricado em alumínio."`.

### A5. Falha da IA na seleção vira "guia técnico" em silêncio (MÉDIA) — `finops_router.py`

`selecionar_melhores_pautas_da_semana` captura `IAIndisponivel` e devolve as duas edições como
guia técnico. Falha de IA tem de **falhar a geração** (o `ultimo_erro` no painel, o
`logger.error` e o incidente Qwen); só a reprovação da pauta (nota < 6 ou trecho que não está na
matéria) vira guia técnico.
No mesmo prompt, o modelo de JSON vem pré-preenchido com `"{slugs_segunda[0]}"` e
`"{slugs_quinta[0]}"`, o que puxa a escolha sempre para `rodape_invertido`/`perfil_t`. Usar
`"um dos slugs permitidos"`.

### A6. Crédito da matéria inventado e checagens que não rodam (MÉDIA)

- O prompt da redação manda "cite a fonte editorial e arquiteto", mas **não recebe** o nome da
  fonte, o título original nem o link: a IA inventa o crédito. Passar `fonte_nome`, título
  original e link; proibir citar escritório/arquiteto que não esteja no texto recebido.
- `validar_copy_edicao(..., titulo_original_materia=...)` nunca recebe o título: a checagem de
  tradução não roda. Passar o título.
- `extrair_texto_limpo_artigo` continua sem uso (pedido no 2.2 do roteiro anterior): usar na
  triagem (até 3000 caracteres).
- A triagem não tem validador: exigir `titulo_traduzido_ptbr` e `resumo_executivo` não vazios e
  sem reticências.
- Reticências não são conferidas dentro de `paragrafos_corpo` nem de `motivos_destaque`:
  conferir toda string, em qualquer nível.

### A7. Motivo da falha genérico (BAIXA)

`_executar_com_provedores` registra `"Groq: sem resposta ou erro HTTP"`. As funções de chamada
devem devolver o motivo (`"HTTP 429 após 3 tentativas"`, `"HTTP 404: modelo X indisponível —
ajuste GEMINI_FREE_MODEL"`, `"HTTP 413"`, `"timeout"`, `"JSON inválido"`); provedor **sem chave**
fica fora da lista (não conta como falha). Esse texto é o que aparece no painel.

### A8. Limpeza (BAIXA)

- Remover `trocar_produto_rascunho` síncrono (duplicata de `_executar_troca`, "compatibilidade"
  sem uso fora dos testes); ajustar o teste para o fluxo 202.
- Fontes: procurar por glob (`/usr/share/fonts/**/Inter*.{otf,ttf}`) em vez de caminhos fixos,
  e conferir no container (`docker compose exec automacoes-marketing fc-list | grep -i inter`;
  se não houver `fc-list`, listar a pasta) que a Inter foi achada. Escrever no README o caminho
  real.
- `marketing-service.ts`: retirar o fallback `sessionStorage.getItem('token')` (a chave não
  existe; o token vem do `useAuth`).

---

## Parte B — Novo padrão do e-mail: "Arch Journal"

Modelo aprovado pelo usuário: `~/Downloads/email_marketing_norvia.html`. O
`app/templates/email_builder.py` passa a gerar **esse** layout (blocos, cores, tipografia,
cantos arredondados, botões em pílula). Os dois modos, prévia no painel e HTML para o RD Station,
continuam existindo.

### B1. Estrutura (na ordem do modelo)

1. **Cabeçalho:** logo Norvia (PNG) à esquerda; selo à direita
   `ARCH JOURNAL // ED. #NN`, com o número real da edição.
2. **Hero:**
   - foto de ambiente (B3), arredondada;
   - selo da pauta (ex.: `PAUTA DA SEMANA • TENDÊNCIAS DE ACABAMENTO`);
   - manchete `h1`;
   - texto do hero com **um** termo em `<strong>`;
   - botão pílula marinho → B2.
   - Com matéria, uma linha pequena de crédito abaixo do texto:
     `Referência: <título traduzido> — <fonte>`, com link para a matéria.
3. **Caderno de especificação:**
   - o cabeçalho da seção com o selo `ED. <data da edição>`;
   - **3 cards**:
     - card 01 = produto da edição; cards 02 e 03 = duas linhas complementares (a IA escolhe
       entre as que têm imagem aprovada, ver B3);
     - cada card tem foto de ambiente, `PASTA 0N // <TEMA>`, número dourado `#B8976C`, frase
       entre aspas (até 120 caracteres), etiqueta técnica (até 30 caracteres, **só fato do
       catálogo**) e link `VER DETALHE →` (B2).
4. **Bloco B2B** (fundo `#091322`):
   - selo `PORTFÓLIO EXECUTIVO • B2B`, logo em negativo, título, texto e botão branco
     `ACESSAR CATÁLOGO NORVIA →` (B2).
   - O texto é **fixo**, em `config.py`, e não gerado pela IA. É o mesmo do modelo, com
     "pintura eletrostática e anodizada", que o usuário confirmou em 12/11/2026.
5. **Rodapé:** logo, links (B2), texto institucional e descadastro com a macro
   **`{{unsubscribe_url}}`**. O modelo usa `href="#"`, que no RD Station não descadastra
   ninguém.

### B2. Botões e links: todos com destino real

| Elemento | Destino |
|---|---|
| Botão do hero ("Explorar …") | `cta_url` do produto da edição (página da categoria em norvia.example) |
| `VER DETALHE →` de cada card | `cta_url` da linha daquele card |
| **`ACESSAR CATÁLOGO NORVIA →`** | **exatamente** `https://www.canva.com/design/DAG_ErVS6gc/0eOY1pTRuMsk6BI1ZshLPg/view?utm_content=DAG_ErVS6gc&utm_campaign=designshare&utm_medium=link2&utm_source=uniquelinks&utlId=h1ee67a76ae#1` (config `MARKETING_URL_CATALOGO`, este valor como padrão; não alterar nem acrescentar parâmetros) |
| `norvia.example` (rodapé) | `https://www.norvia.example` |
| `@norvia.acabamentos` | `https://www.instagram.com/norvia.acabamentos/` |
| "Atendimento para Especificadores" | WhatsApp **(43) 99187-5825**: `https://wa.me/5543991875825?text=` + mensagem pronta URL-encoded ("Olá! Sou especificador e vim pelo Arch Journal da Norvia."); config `MARKETING_LINK_ATENDIMENTO` com esse padrão |
| Crédito da matéria | link da matéria (só com matéria) |
| Descadastro | `{{unsubscribe_url}}` |

- Links para `norvia.example` levam UTM:
  `utm_source=rdstation&utm_medium=email&utm_campaign=arch-journal-<NN>&utm_content=<bloco>`.
- **Nenhum `href="#"`** e nenhum link vazio no HTML final (teste).
- Na prévia do painel, os links continuam abrindo em nova aba. O `iframe` com `sandbox=""` não
  navega; isso está certo.

### B3. Imagens de ambiente geradas por IA, aprovadas por uma pessoa (decisão do usuário, 12/11)

As fotos de produto do site não servem para o e-mail. Hero, cards e carrossel usam **fotos de
ambiente com o produto aplicado**, **geradas por IA** a partir do material que já está no
projeto, e só entram em uso **depois de aprovadas no painel**.

**Material de referência (já no repositório):**
- Renders 3D dos perfis, fundo branco: `frontend/public/marketing/produtos/*.png|jpg`
  (23 arquivos: rodapés invertidos Veles, Aquila, Arkas, Atria, Sirius, Tauri, Vytis, Curvo
  Lete, Capri, Orion, Gama; perfis T 18/45 mm e mesmo nível; redutores flex e vinílico;
  cantoneiras de parede e de degrau; listelo Velino, filete Arda; perfis de LED de embutir e de
  sobrepor). O render da linha é a referência **de forma**: perfil, aba, encaixe, cor.
- Exemplos de ambiente:
  - as 4 fotos do modelo aprovado (B1): sala com rodapé iluminado, close do rodapé com LED na
    pedra, corredor com linha de LED, pedra com ripado e filete. Extraia do base64 do HTML para
    `frontend/public/marketing/ambientes/exemplos/`;
  - as 3 fotos de ambiente do site em `frontend/public/marketing/produto-*.jpg`.
  São a referência **de estilo**: luz natural, interiores de alto padrão, paleta neutra,
  enquadramento editorial.

**Geração:**
- **Provedor configurável**, `MARKETING_IMAGEM_PROVEDOR`:
  - `gemini`: `generateContent` com `responseModalities: ["IMAGE"]`, imagens de referência em
    `inline_data`, chave no header `x-goog-api-key`;
  - `openai`: edição de imagem com referências.
- **Modelo em config** (`GEMINI_IMAGE_MODEL` / `OPENAI_IMAGE_MODEL`). **Não chute o nome do
  modelo**: confira o atual com `GET https://generativelanguage.googleapis.com/v1beta/models`
  (ou a lista da OpenAI) e anote no README. O 404 do `gemini-2.5-flash` desta semana veio de
  nome aposentado.
- **Entrada de cada geração:** 1 render 3D da linha + 1 ou 2 exemplos de ambiente + prompt com a
  **aplicação correta** da linha:
  - rodapé invertido: na base da parede, recuado, com ou sem LED conforme o modelo;
  - perfil T: na junta entre dois pisos **no mesmo nível**;
  - redutor: entre pisos **de alturas diferentes**;
  - cantoneira: na quina de parede ou no bocel do degrau;
  - listelo/filete: faixa embutida em porcelanato, parede ou móvel;
  - perfil de LED: linha de luz embutida no teto, na parede ou no móvel.
- **O prompt proíbe:** texto, logotipo e marca d'água na imagem; pessoas; mudar a forma ou a
  cor do perfil em relação ao render; produto de outra categoria no lugar. Saída fotorrealista,
  interior residencial brasileiro de alto padrão, sem distorção.
- **Formato:** 3:2 para o hero e os cards, 4:5 para o carrossel. Gravar em JPEG com 1200 px no
  lado maior e qualidade em torno de 82, **≤ 250 KB**.
- **Em segundo plano:** 202 e acompanhamento pelo `/status`, mesmo lock e mesmo padrão `finally`
  da A1. Limite diário em config (`MARKETING_IMAGENS_LIMITE_DIA`, padrão 20). 429 com espera,
  como no texto.
- **Custo:** geração de imagem pode não ter cota grátis. Mostre no painel o provedor e quantas
  imagens foram geradas no dia (valor real, contado), e nada de custo estimado inventado.

**Aprovação (obrigatória: a IA pode deformar o perfil):**
- **Nova aba "Banco de ambientes"** na tela de E-mail Marketing:
  - por linha editorial: as aprovadas, as candidatas e um botão "Gerar 4 opções";
  - cada candidata tem "Aprovar" e "Recusar";
  - mostrar o render 3D de referência ao lado, para a pessoa comparar a forma do perfil.
- **Permissões:** aprovar/recusar usa `email_marketing:aprovar`, e o usuário vem do
  `X-Usuario`, com auditoria. Gerar usa `email_marketing:gerar`.
- **Metadados de cada imagem** (`data/ambientes/indice.json`): linha, provedor, modelo, prompt,
  referências usadas, gerada_em, status (`candidata` | `aprovada` | `recusada`), aprovada_por,
  aprovada_em.
- **Estoque inicial:** as 4 fotos do modelo entram como `aprovada` com
  `aprovada_por = "modelo aprovado pelo usuário em 12/11/2026"`:
  - `rodape_invertido`: as 2 fotos do rodapé;
  - `perfil_led_embutir`: a do corredor;
  - `listelo_velino`: a do ripado.
- **Elegibilidade:** **linha sem imagem aprovada não pode ser destaque nem card.** Nunca cair para
  a foto de produto da CDN nem usar candidata não aprovada.
- **Rodízio:** guardar no `estado.json` a última imagem usada por linha e escolher outra quando
  houver.

**Onde as imagens ficam e como o RD Station as enxerga:**
- **Duas pastas:**
  - candidatas e índice no volume `data/` (privado);
  - aprovadas copiadas para `publico/ambientes/<slug>/<id>.jpg`, um **volume separado** que o
    NGINX serve.
- **Permissões do volume `publico`:** pastas 0755 e arquivos 0644, porque o NGINX lê como outro
  usuário. Escreva no README do serviço o trecho do compose
  (`./backend/automations/automacoes-marketing/publico:/app/publico`) e o ACL do rootless para o
  `appuser`.
- **NGINX (o analista aplica):** acrescentar ao README um `location /marketing-imagens/` com:
  - `alias` para essa pasta;
  - só `GET`/`HEAD`;
  - `autoindex off`;
  - só `\.jpg$`;
  - `Cache-Control` longo.
  Esse location **fica fora** da allowlist do painel (seção 6 de `docs/seguranca-deploy.md`),
  porque quem lê o e-mail está fora da rede. Não editar o NGINX nem o compose: só documentar.
- **URL pública:** config `MARKETING_URL_PUBLICA_IMAGENS`, padrão
  `https://servidor.norvia.example/marketing-imagens`. Não usar `/automacoes/...`, que é do
  painel e pode ser fechado para a rede interna.
- **HTML do RD Station:** URL absoluta. **Nada de `data:` base64:** o modelo tem 3,6 MB, o Gmail
  corta mensagens acima de ~102 KB e vários clientes bloqueiam `data:`. O HTML fica abaixo de
  **100 KB**.
- **Prévia do painel:** as imagens vêm pela rota autenticada do gateway, padrão das imagens do
  carrossel, por causa do `img-src 'self'`.
- **Carrossel:** capa e slide de produto usam uma imagem aprovada da linha no formato 4:5, não a
  foto da CDN.

**Rotas novas:**
- **Serviço:**
  - `GET /api/v1/ambientes`;
  - `GET /api/v1/ambientes/{id}.jpg`;
  - `POST /api/v1/ambientes/gerar` (corpo `{produto_slug}`);
  - `POST /api/v1/ambientes/{id}/aprovar` e `.../recusar`.
- **Gateway:** as mesmas rotas atrás de `/api/marketing/ambientes...`, com:
  - permissões: `ver` nas leituras, `gerar` no gerar, `aprovar` no aprovar e no recusar;
  - entradas na `DYNAMIC` do teste de cobertura;
  - o repasse binário da imagem, igual ao carrossel.

### B4. Campos que a IA passa a gerar (substituem os do layout antigo)

- **Campos do e-mail:**
  - `assunto`, `assunto_alt`, `preheader`;
  - `selo_pauta` (até 50, maiúsculas);
  - `titulo_principal` (até 110);
  - `texto_hero` (2–3 frases, até 380) + `destaque_hero` (o termo que vai em negrito: precisa
    aparecer literalmente no `texto_hero`);
  - `cta_hero_texto` (até 40);
  - `cards`: exatamente 3 itens `{produto_slug, pasta_tema, frase, etiqueta_tecnica}`, cada um
    com:
    - `produto_slug` de uma linha com imagem aprovada, sem repetir slug, e o primeiro = produto da edição;
    - `pasta_tema` até 28 caracteres;
    - `etiqueta_tecnica` tirada das especificações reais da linha (medida, cor ou função).
- **Continuam:** `carrossel`, `legenda_instagram` e os créditos.
- **Ficam sem uso:** os campos antigos que só existiam no layout antigo (`paragrafos_corpo`,
  `motivos_destaque`, `titulo_box_motivos`, `chamada_produto_*`, `legenda_foto`). Ajuste
  `validar_copy_edicao` e os testes; rascunhos antigos no disco só precisam continuar abrindo no
  painel.
- **Montagem do HTML:** escapar tudo com `_e()`, e só depois envolver a primeira ocorrência do
  `destaque_hero` em `<strong>`. Nunca aceitar HTML vindo da IA.

### B5. Painel

- A tela mostra os novos campos no lugar dos antigos.
- A prévia no `iframe` reflete o novo layout.
- O "Copiar HTML (RD)" copia o HTML com as URLs absolutas.
- No seletor de produto da edição, mostrar só as linhas com imagem aprovada; as demais aparecem
  desabilitadas com "sem imagem aprovada".

### B6. Testes novos (além dos da Parte A)

- **Links do HTML:** todo `href` do HTML do RD Station está no conjunto esperado (tabela B2).
  - Nenhum `#` e nenhum vazio.
  - O link do catálogo é idêntico à URL do Canva.
  - `{{unsubscribe_url}}` presente.
  - UTM presente nos links de norvia.example.
- **Imagens:**
  - nenhuma `src` é `data:`;
  - todas começam com `MARKETING_URL_PUBLICA_IMAGENS` no modo RD;
  - toda imagem aprovada tem ≤ 250 KB.
- **Tamanho:** HTML do RD abaixo de 100 KB.
- **Linhas elegíveis:** sem imagem **aprovada**, a linha não pode ser escolhida para destaque nem
  card; candidata não aprovada nunca aparece no HTML. Simular uma resposta da IA com `perfil_t`
  sem aprovada → recusada pelo validador.
- **Imagens de ambiente:**
  - geração com o provedor em mock grava candidata com metadados e não publica nada em `publico/`;
  - aprovar copia para `publico/` com 0644, e recusar não copia;
  - aprovar e recusar exigem `X-Usuario`;
  - o limite diário responde 429 com mensagem clara;
  - o prompt de cada linha contém a regra de aplicação correta (perfil T "mesmo nível", redutor
    "alturas diferentes"…).
- **Escape:** `destaque_hero` com `<script>` → escapado; `destaque_hero` que não está no texto →
  recusado pelo validador.
- **Atendimento:** o link do WhatsApp é `https://wa.me/5543991875825?...`, com o texto
  URL-encoded; config vazia → o link não aparece.
- **Rodízio:** duas gerações seguidas da mesma linha com 2 fotos → fotos diferentes.

### B7. Regras de sempre (resumo)

- Sem dado inventado.
- Testar o caminho real.
- Escapar todo texto.
- `X-Usuario` vindo do gateway.
- Não editar `execucoes.py` nem `docker-compose.yml`.
- Dependência nova = `requirements.lock` com hashes.
- Frontend com `apiBaseUrl`.
- Visual do **painel** com cantos retos e âmbar só em ação. O visual arredondado vale só para o
  **e-mail**, que segue o modelo aprovado.
