# Automação de E-mail Marketing & Banco de Ambientes

Serviço Python (FastAPI, porta 8004) da tela **Marketing › E-mail Marketing**
(`/email-marketing`, permissões `email_marketing:ver/gerar/aprovar`).

Toda **sexta às `HORA_GERACAO_SEXTA` (8h, fuso de SP)** gera as duas edições da semana seguinte
(**segunda** e **quinta**). Cada edição liga uma matéria de arquitetura (RSS do ArchDaily Brasil e
do Dezeen Interiors) a um produto **da marca Norvia** (`catalogo/`, extraído de norvia.example; a
revenda fica de fora). Também dá para gerar pelo botão da tela.

---

## Padrão Editorial "Arch Journal"

Layout aprovado em 12/11/2026 (`~/Downloads/email_marketing_norvia.html`). O gerador de
e-mail (`app/templates/email_builder.py`) segue a estrutura:
1. **Cabeçalho**: Logo Norvia + selo `ARCH JOURNAL // ED. #NN`.
2. **Hero**: Foto de ambiente arredondada, selo da pauta, título, texto hero com destaque literal em `<strong>`, botão pill marinho e crédito da matéria (com link).
3. **Caderno de Especificação**: 3 cards técnicos (card 1 = produto da edição, cards 2 e 3 = linhas complementares com imagem aprovada) com tema, foto de ambiente, frase entre aspas e etiqueta técnica com especificações do catálogo.
4. **Bloco B2B** (fundo escuro `#091322`): Texto institucional fixo em `config.py` e botão branco para o catálogo no Canva.
5. **Rodapé**: Links oficiais, atendimento para especificadores via WhatsApp e descadastro com `{{unsubscribe_url}}`.

### Destinos dos Links (Todos Reais, Zero `#`)

| Elemento | Destino | Configuração |
|---|---|---|
| Botão Hero | Categoria do produto em norvia.example (com UTM) | `cta_url` do produto |
| Botões `VER DETALHE →` nos cards | Categoria da linha correspondente (com UTM) | `cta_url` de cada linha |
| **`ACESSAR CATÁLOGO NORVIA →`** | Link fixo no Canva com utlId e anchor `#1` | `MARKETING_URL_CATALOGO` |
| `norvia.example` (rodapé) | `https://www.norvia.example` (com UTM) | Automático |
| `@norvia.acabamentos` | `https://www.instagram.com/norvia.acabamentos/` | Fixo |
| **Atendimento para Especificadores** | WhatsApp `(43) 99187-5825` com mensagem pronta URL-encoded | `MARKETING_LINK_ATENDIMENTO` |
| Descadastro | Tag macro do RD Station | `{{unsubscribe_url}}` |

- Todos os links para `norvia.example` levam UTMs:
  `utm_source=rdstation&utm_medium=email&utm_campaign=arch-journal-<NN>&utm_content=<bloco>`.
- O HTML exportado para o RD Station fica rigorosamente abaixo de **100 KB** (sem `data:` base64).

---

## Banco de Ambientes & Geração de Imagens

Hero, cards e carrossel utilizam fotos de ambiente geradas por IA a partir dos renders 3D do catálogo e exemplos arquitetônicos de referência.

- **Aprovação obrigatória**: Imagens geradas entram como `candidata` e **só** podem ser usadas após aprovação humana na aba "Banco de ambientes" do painel (`email_marketing:aprovar`, com registro do aprovador via `X-Usuario`).
- **Elegibilidade estrita**: Linhas sem imagem aprovada não podem ser destacadas em edições nem usadas em cards.
- **Formato**: JPEG 3:2 (1200x800) e 4:5 para carrossel, qualidade ~82, **≤ 250 KB**.
- **Provedores suportados** (`MARKETING_IMAGEM_PROVEDOR`):
  - `gemini`: Google Gemini API (`GEMINI_IMAGE_MODEL`, padrão `gemini-3.1-flash-image`, verificado em 13/11/2026 em `v1beta/models?pageSize=200` com `supportedGenerationMethods` contendo `generateContent`, usando `generationConfig.responseModalities: ["IMAGE"]` e `imageConfig.aspectRatio`).
  - `openai`: OpenAI Images API (`OPENAI_IMAGE_MODEL`, padrão `gpt-image-1` via `/v1/images/edits` enviando as referências visuais).
- **Limite diário**: `MARKETING_IMAGENS_LIMITE_DIA` (padrão: 20 opções/dia). Cada opção conta como 1 no limite diário, e no provedor Gemini consome 2 chamadas à API de imagem (uma em `3:2` e uma recomposição em `4:5`, com fallback para recorte central caso a chamada `4:5` falhe). Exceder o limite responde HTTP 429.
- **Estoque inicial aprovado**: As 4 fotos extraídas do modelo aprovado de 12/11/2026 já vêm pré-cadastradas para `rodape_invertido` (2 fotos), `perfil_led_embutir` (1 foto) e `listelo_velino` (1 foto).

---

## Fontes do Carrossel (Instagram)

O gerador gráfico de carrossel busca a família tipográfica **Inter** dinamicamente no sistema operacional via glob:
- Glob de busca: `/usr/share/fonts/**/Inter*.{otf,ttf}`.
- Caminhos reais instalados no Debian bookworm via `fonts-inter`:
  - Regular: `/usr/share/fonts/opentype/inter/Inter-Regular.otf` (ou `/usr/share/fonts/truetype/inter/Inter-Regular.ttf`).
  - Bold: `/usr/share/fonts/opentype/inter/Inter-Bold.otf` (ou `/usr/share/fonts/truetype/inter/Inter-Bold.ttf`).
- Ajuste dinâmico de caixa: O texto dos slides reduz a tipografia até tamanhos mínimos (título 32px, corpo 24px). Textos que não caibam na área levantam erro (`carrossel_erro`) e nunca cortam linhas silenciosamente nem ultrapassam `y = 1240`.

---

## Deploy & Volumes (Docker Rootless)

```yaml
  automacoes-marketing:
    build: ./backend/automations/automacoes-marketing
    restart: unless-stopped
    env_file: ./backend/automations/automacoes-marketing/.env
    environment:
      AUTOMATIONS_INTERNAL_KEY: ${AUTOMATIONS_INTERNAL_KEY}
    volumes:
      - ./backend/automations/automacoes-marketing/data:/app/data
      - ./backend/automations/automacoes-marketing/publico:/app/publico
```

### Pastas e Permissões

- `data/` (privado): `rascunhos.json`, `execucoes.json`, `estado.json` e candidatas em `data/ambientes/`.
- `publico/` (servido pelo NGINX): imagens aprovadas em `publico/ambientes/<slug>/<id>.jpg` e logos em `publico/marca/`.
  - Permissões no container: pastas `0755` e arquivos `0644`.
- **Ajuste de ACL para Docker Rootless** (conforme `docs/seguranca-deploy.md` §4):
  O container roda como `appuser` (UID `1000` dentro do user namespace do Docker rootless). Para aplicar a ACL correta sem `chown` recursivo, execute entrando no user namespace via `nsenter -U` (ou `rootlesskit`):
  ```bash
  # Exemplo usando nsenter no PID do rootlesskit/dockerd rootless:
  nsenter -U --preserve-credentials -t $(pgrep -f rootlesskit | head -n1) \
    setfacl -R -m u:1000:rwx,d:u:1000:rwx ./backend/automations/automacoes-marketing/data ./backend/automations/automacoes-marketing/publico
  ```

### NGINX Snippet (`/marketing-imagens/`)

O NGINX do servidor deve servir as imagens aprovadas e os logos em `publico/marca/` publicamente para visualização nos clientes de e-mail (fora da allowlist interna do painel):

```nginx
# Fora da allowlist do painel (docs/seguranca-deploy.md §6): clientes de e-mail acessam da internet
location /marketing-imagens/ {
    alias /caminho/absoluto/backend/automations/automacoes-marketing/publico/;
    limit_except GET HEAD {
        deny all;
    }
    autoindex off;

    location ~* \.(jpg|png)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        try_files $uri =404;
    }

    return 404;
}
```

---

## Testes & Qualidade

```bash
# Testes do serviço de marketing
npm run test:marketing

# Linter do código Python (Ruff)
npm run lint:python

# Suíte de testes do Gateway
npm run test:gateway

# Suíte de testes e linter do Frontend
npm --prefix frontend test
npm --prefix frontend run lint

# Conferir que testes não sujaram publico/ ou frontend/public/
git status --porcelain -- backend/automations/automacoes-marketing/publico frontend/public
```
