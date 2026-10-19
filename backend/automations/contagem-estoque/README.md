# Contagem de estoque por prendedores verdes (MVP)

Bot do Telegram que conta pacotes numa foto de prateleira. Cada pacote tem um
**prendedor verde** (mini prendedor de roupa, verde-amarelado). O bot encontra os
prendedores com OpenCV, conta 1 pacote por prendedor e devolve a foto com cada
prendedor **circulado em magenta e numerado** (em **amarelo** os que o operador deve
conferir). O produto é identificado pelo código de barras da prateleira na foto e/ou pelo
SKU escrito na legenda. O bot **não pergunta nada no Telegram**: registra a contagem e avisa
que ela foi para o painel, onde é conferida (confirmar ou corrigir) e onde o SKU pode ser
informado depois (ver [Fluxo da contagem](#fluxo-da-contagem) e [Painel e conferência](#painel-e-conferência)).

O verde é mais comum no ambiente que o roxo, que foi a primeira ideia: aparece em
etiquetas, placas de segurança, fitas e plantas. Por isso os filtros de área e de
forma pesam mais na calibração. Veja em [Calibração](#calibração).

```text
Telegram → Python → OpenCV (HSV → máscara verde → morfologia → contornos → filtros)
         → contagem → imagem anotada → Telegram
```

O bot não usa o banco, o n8n nem modelos de IA. A conferência é feita no painel
(área Logística, `/contagem-estoque`) e, desde 2026-10-14, a contagem conferida vai ao
**estoque do Tiny** pela API interna deste serviço (ver [Estoque no Tiny](#estoque-no-tiny)). Para o botão "Abrir no Telegram" aparecer lá, defina
`NEXT_PUBLIC_STOCK_BOT_USERNAME` no `.env` do frontend.

## Estrutura

```text
contagem-estoque/
├── app/
│   ├── config.py     # todos os parâmetros (HSV, área, forma, morfologia, resolução, token, debug)
│   ├── detector.py   # visão computacional pura — não conhece o Telegram
│   ├── codigo.py     # lê o código de barras / QR da prateleira na foto
│   ├── registro.py   # registro das contagens (SKU, quantidade, confirmação, imagem)
│   ├── bot.py        # Telegram: recebe a foto, chama o detector, responde
│   └── main.py       # ponto de entrada do bot (long polling)
├── scripts/
│   ├── detect.py     # CLI: conta uma foto pelo terminal (mesmo detector do bot)
│   ├── calibrate.py  # gera máscara/regiões/anotação para calibrar a cor
│   └── avaliar.py    # taxa de acerto contra a base de fotos reais
├── tests/
│   └── fotos_reais/  # base de validação: fotos reais + contagens.csv
├── temp/             # criado em execução (fora do git): received/, processed/, calibracao/, registro/
└── logs/
```

## Instalação

Python 3.11+ (a imagem Docker usa 3.11, como a `automacoes-financeiro`).

```bash
cd backend/automations/contagem-estoque
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Telegram

1. No Telegram, fale com o **@BotFather**, envie `/newbot` e siga as instruções.
2. Copie o token gerado para o `.env`:

```env
TELEGRAM_STOCK_BOT_TOKEN=123456789:ABC...
```

O token só é lido do ambiente/`.env` (que está no `.gitignore`). Ele não aparece
no log: o log do `httpx`, que incluiria a URL com o token, fica em nível WARNING.

3. Restrinja quem pode usar o bot (qualquer pessoa que achar o @ do bot conseguiria mandar fotos):

```env
TELEGRAM_ALLOWED_USERS=111111111,222222222   # usuários permitidos
TELEGRAM_ALLOWED_CHATS=-1001234567890        # ou um grupo inteiro (ID negativo)
```

O bot responde se o usuário **ou** o chat estiver numa das listas; os demais são ignorados sem
resposta (a foto nem é baixada) e aparecem no log como `mensagem ignorada ... telegram_user_id=...`
— é o jeito mais simples de descobrir o ID de alguém da equipe. Com as duas listas vazias o bot
continua aberto (comportamento antigo) e avisa no log ao subir.

## Fluxo da contagem

1. O operador envia a foto da prateleira (de preferência **como arquivo**) com o **SKU do
   produto na legenda**. A etiqueta de código de barras/QR da prateleira deve aparecer na foto.
2. O bot recusa antes de contar: arquivo acima de `MAX_ARQUIVO_MB`, imagem acima de
   `MAX_MEGAPIXELS` ou com lado maior abaixo de `MIN_LADO_FOTO` (960 px; com 768 px a
   contagem errou 2 de 6 fotos no teste de 2026-10-07).
3. Conta os prendedores e lê o código. Identificação do produto (`resolver_produto` em `app/bot.py`):

   | Código lido | SKU na legenda | Resultado |
   |---|---|---|
   | 1 | igual | registra (origem `codigo_e_legenda`) |
   | 1 | diferente | **não registra**: avisa a divergência |
   | 1 | — | registra (origem `codigo_de_barras`) |
   | nenhum | informado | registra (origem `legenda`) |
   | nenhum | — | **registra sem SKU** (origem `sem_produto`): o SKU é informado depois, pelo painel |
   | 2 ou mais | igual a um deles | registra esse (origem `codigo_e_legenda`) |
   | 2 ou mais | diferente de todos, ou sem legenda | **não registra**: avisa os códigos encontrados |

4. Quando registra, o bot devolve a foto anotada e uma mensagem de status:
   `MSG_ENVIADO_PAINEL` ("Contagem enviada ao painel…") ou, sem SKU, `MSG_SEM_CODIGO`.
   **O bot não pergunta nada no Telegram**: não envia mais os botões **Confirmar N** /
   **Corrigir** nem pede a quantidade. A conferência é feita no painel (ver abaixo).
   Os handlers de `ok:`/`fix:` e a resposta digitada da correção continuam no código só para
   botões de mensagens enviadas antes dessa mudança (2026-10-13).
5. Círculos **amarelos** pedem conferência: prendedor pequeno (parcialmente coberto pelo
   plástico, ou de outra prateleira ao fundo — `ALERTA_AREA_RATIO`) ou prendedor que estava
   encostado em outro e foi separado. A legenda da foto resume quantos.

**Registro** (`REGISTRO_DIR`, padrão `temp/registro/`, escrito por `app/registro.py`): `contagens.json`
com, por contagem, SKU, `sku_legenda` (se digitado na legenda), `codigos_barras` (lidos na imagem),
`origem_codigo`, quantidade detectada, status inicial `aguardando_confirmacao`, alertas, quem enviou,
hash da foto, a imagem anotada (`imagens/<id>.jpg`) e a **foto original** recebida
(`imagens/<id>_original.jpg`). Tudo é mantido por `REGISTRO_RETENCAO_DIAS` dias.
O bot é o único que grava esse diretório; o gateway só lê (ver [Painel e conferência](#painel-e-conferência)).

**Etiqueta da prateleira:** o código precisa ser grande na foto — ~150 px de largura numa
foto de 1280 px. As etiquetas QR atuais dos montantes (~25 px nas fotos de teste) não são
lidas. Code 128 e EAN exigem a `libzbar0` (instalada no Dockerfile); sem ela só QR e EAN/UPC
são lidos (pelo OpenCV).

## Painel e conferência

A tela **Contagem de Estoque** (`/contagem-estoque`, área Logística) lê as contagens pelo gateway
e faz, só no painel, o que o bot não faz mais:

- **Conferir** (confirmar ou corrigir a quantidade): `POST /api/stock-count/contagens/:id/conferir`.
  Grava em `contagem_estoque_conferencia` (MariaDB). O status exibido e a `quantidade_final` vêm dessa tabela.
- **Informar SKU** de contagem sem produto (`origem_codigo = sem_produto`):
  `POST /api/stock-count/contagens/:id/sku`. Grava em `contagem_estoque_sku_manual`. Não sobrescreve
  um SKU já identificado pelo bot.
- **Excluir da tela**: `DELETE /api/stock-count/contagens/:id`. É exclusão lógica: grava em
  `contagem_estoque_excluidas` e não apaga o `contagens.json` nem as fotos (que saem pela retenção).

As três tabelas são criadas no boot do gateway (`backend/gateway/src/stock-sku.ts`, `bootstrap()`).
Permissões: `contagem_estoque:ver`, `conferir`, `informar_sku` e `excluir` (`backend/gateway/src/permissions.ts`).
Fotos: `GET /api/stock-count/imagens/:id/anotada` e `.../original`, com o token da sessão.

**Só `confirmada`/`corrigida` alimenta o ERP**; as correções são também dado de calibração.

## Estoque no Tiny

Cada marcador (prendedor) é um **fardo**. Na conferência o painel pede:

- **Fardos** (vem a contagem do bot);
- **Unidades por fardo**: padrão 5. A tela sugere o último valor usado para o mesmo SKU (há fardos de 10);
- **Unidades soltas**: fora de fardo, somadas ao total.

Com o SKU conhecido, o cartão mostra o **nome do produto no Tiny** (para conferir se o SKU está
certo) e o **estoque atual no Tiny** ao lado do contado na foto, com a diferença que vai entrar.
É só leitura (`GET /api/v1/estoque/consultar?sku=`; no gateway `GET /api/stock-count/contagens/:id/tiny`,
permissão `contagem_estoque:ver`, guardada 1 min por SKU). Carrega sozinho nas pendentes; nas
conferidas, pelo botão "Ver produto e estoque no Tiny".

Total = fardos × unidades por fardo + soltas. Desde 2026-10-15 as unidades por fardo vêm da
**cor do prendedor**: verde = fardo de 5, rosa choque = fardo de 10. Cada foto/prateleira usa uma
cor só; o detector procura as duas, fica com a que aparece e guarda `cor` e `unidades_por_fardo`
no registro, e o painel só pede as unidades soltas (contagens antigas, sem cor, ainda pedem o
fardo). Se as duas cores aparecerem na mesma foto, vale a maioria e sai um alerta para conferir.
A faixa do rosa (`ROSA_HUE_MIN`/`ROSA_HUE_MAX`/`ROSA_SATURATION_MIN`/`ROSA_VALUE_MIN`) **ainda não
foi calibrada com fotos reais**: é estimativa para rosa choque (H 145–175). Ao confirmar/corrigir, o gateway chama
`POST /api/v1/estoque/ajustar` deste serviço (porta `API_PORT`, 8002, com `X-Internal-Key`), que:

1. busca o produto no Tiny v3 pelo SKU (correspondência exata);
2. lê o saldo do depósito (`CONTAGEM_TINY_DEPOSITO_ID`, ou o único depósito do produto; com
   mais de um e sem configuração, **não lança** e avisa);
3. se o contado for maior que o saldo, lança uma **entrada** (tipo `E`) só da diferença. Exemplo:
   Tiny 10, contagem 50 → entrada de 40. Se o Tiny já tem o contado ou mais, **nada é lançado**:
   a automação nunca tira estoque.

A observação do lançamento no Tiny começa com
`Auditoria {data} lançamento {número} - Divergência na contagem do SKU ...` (ex.: `Auditoria
14/10/2026 lançamento 000001 - ...`). Número e data são os do cartão no painel: cada contagem
recebe do bot um `numero` sequencial (`contagens.json`; o último fica em `sequencia.json`, na
mesma pasta, e nunca é reutilizado, mesmo após a limpeza por retenção). Contagens anteriores à
numeração são numeradas pela ordem de criação quando o bot sobe.

A diferença é calculada contra o saldo atual, então reenviar a mesma contagem não duplica a
entrada. O POST não é repetido sozinho: sem resposta do Tiny, o saldo é relido para saber se a
entrada entrou. Contagem sem SKU vai ao Tiny quando o SKU for informado no painel. O resultado
(entrada, saldo anterior ou erro) fica em `contagem_estoque_tiny` (gateway) e aparece no cartão,
com **Reenviar ao Tiny** quando falhou (`POST /api/stock-count/contagens/:id/tiny`, permissão
`contagem_estoque:conferir`).

**O estoque é só da Revesta**: a conta `revesta` é fixa no código (`app/tiny_estoque.py`, sem
variável de ambiente) e o token só é usado se o CNPJ cadastrado na `api_tokens` for o da Revesta
(36.592.814/0001-00) ou estiver vazio; outro CNPJ bloqueia o lançamento. Token: tabela `api_tokens`
do banco do financeiro (`TINY_TOKENS_DB`), só leitura, como na automacoes-marketplace.
Variáveis no `.env` deste serviço: `AUTOMATIONS_INTERNAL_KEY` (a mesma das outras automações),
`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`, `TINY_TOKENS_DB` e, se preciso, `CONTAGEM_TINY_DEPOSITO_ID`.
No gateway, `CONTAGEM_API_URL` é opcional (padrão `http://contagem-estoque:8002`).

## Debug

```env
STOCK_COUNTER_DEBUG=false
```

- `false`: a foto recebida e a processada são apagadas logo depois da resposta.
- `true`: as duas ficam em `temp/received/` e `temp/processed/`, com o mesmo
  identificador (UUID) no nome, para investigar falsos positivos e negativos.

## Execução

```bash
python -m app.main
```

O bot usa **long polling** e não precisa de rota no NGINX. No mesmo processo sobe a API
interna (porta `API_PORT`, 8002), que só o gateway chama, pela rede do docker; não publique
a porta no host. Vários
operadores podem enviar fotos ao mesmo tempo. Cada foto recebe um UUID próprio e a
análise roda fora do loop do Telegram, então uma foto não bloqueia a outra.

No Telegram: `/start` e depois envie a foto. Para a melhor precisão, envie a foto
**como arquivo** (clipe → Arquivo): como "foto", o Telegram reduz a resolução e
comprime a imagem, e prendedores pequenos ou distantes podem sumir.

### Docker (servidor)

O `docker-compose.yml` do servidor fica fora do repositório. Para adicionar o bot,
o trecho é:

```yaml
  contagem-estoque:
    build: ./backend/automations/contagem-estoque
    restart: unless-stopped
    env_file: ./backend/automations/contagem-estoque/.env
    volumes:
      - ./backend/automations/contagem-estoque/temp:/app/temp
      - ./backend/automations/contagem-estoque/logs:/app/logs
```

É um serviço separado: se ele parar, as outras automações continuam funcionando.

**Permissão das pastas `temp/` e `logs/`.** O container grava como o usuário 1000
(`appuser`). O Docker do servidor roda **sem root** (rootless): o usuário do
servidor é o root dos containers e o 1000 do container vira outro número no
servidor. Então **não use `chown 1000`**, porque dentro do container a pasta apareceria
com dono "nobody" e o bot receberia `Permission denied`. Para as permissões de `temp/` e
`logs/` (dono 1003 + `setfacl` para o subuid do container, segredos 700/600; o antigo
`chmod 757` não vale mais), siga [docs/seguranca-deploy.md §4](../../../docs/seguranca-deploy.md#4-permissões-dos-volumes-fim-do-chmod-757).
Depois confira a gravação:

```bash
docker compose exec contagem-estoque sh -c 'touch /app/temp/t && rm /app/temp/t && echo GRAVACAO_OK'
```

### Log

Cada foto gera uma linha com data/hora, `telegram_user_id`, `telegram_chat_id`,
`image_id`, `quantidade_detectada` e `tempo_processamento_ms`. Erros ficam no log
com o traceback completo; o operador só recebe a mensagem genérica. Arquivo:
`logs/contagem_estoque.log`.

## CLI

Conta uma foto sem o Telegram, com exatamente o mesmo detector:

```bash
python scripts/detect.py foto_estoque.jpg
# Marcadores detectados: 23
# Imagem processada: /.../temp/processed/<uuid>_processada.jpg
```

## Calibração

Os valores iniciais do `.env.example` **não estão calibrados**. Eles partem do
verde medido numa foto de referência dos prendedores (H 43–54), com folga dos dois
lados. A calibração é feita com fotos reais:

```bash
python scripts/calibrate.py foto_real.jpg
```

Ele grava em `temp/calibracao/<foto>_<id>/`:

| Arquivo | O que mostra |
|---|---|
| `1_original.jpg` | a foto na resolução de processamento |
| `2_mascara.png` | branco = pixels que entraram na faixa de cor do prendedor |
| `3_regioes.jpg` | só o que entrou na máscara; caixa **verde** = contado, **vermelha** = descartado, com o motivo (`area_pequena`, `area_grande`, `forma`) |
| `4_anotada.jpg` | exatamente o que o bot devolve |
| `painel.jpg` | as quatro juntas |

No terminal ele lista cada região com posição, área, proporção e o **HSV mediano**
dos pixels dela. Isso mostra onde o verde real dos prendedores está.

Qualquer parâmetro pode ser testado sem editar o `.env`:

```bash
MARKER_HUE_MIN=40 MIN_MARKER_AREA=300 python scripts/calibrate.py foto_real.jpg
```

### Roteiro sugerido

1. Junte fotos reais em condições diferentes: luz da manhã e da tarde, perto e
   longe, prateleira cheia e vazia, e com o celular que será usado no dia a dia.
2. **Cor (HSV).** Rode a calibração e veja o HSV mediano dos prendedores. A escala
   do OpenCV é H 0–179, S e V 0–255.
   - **Hue (matiz):** amarelo fica por volta de 20–34, o verde-amarelado dos
     prendedores em 35–55, verde puro ~60 e verde-azulado a partir de ~75. Deixe
     uma folga de ~10 em volta do que os prendedores reais mostram. Se fita ou
     etiqueta amarela entrar na máscara, suba o `MARKER_HUE_MIN`.
   - **Saturation:** separa o verde "de verdade" de cinzas e papelão esverdeado.
     Se aparecerem regiões de papelão ou parede na máscara, aumente o mínimo.
   - **Value (brilho):** prendedores na sombra ficam com V baixo. Se eles somem,
     reduza `MARKER_VALUE_MIN`. Se reflexos escuros entram, aumente.
3. **Área.** Veja a área dos prendedores contados na maior e na menor distância
   de uso. `MIN_MARKER_AREA` fica um pouco abaixo da menor, `MAX_MARKER_AREA` um
   pouco acima da maior. As áreas valem para uma imagem de largura
   `MAX_PROCESSING_WIDTH` e são reduzidas na mesma proporção para fotos menores.
   Prendedor atrás do plástico do pacote aparece só em parte e fica pequeno: por isso,
   quando a foto tem prendedores suficientes para medir a área típica, o mínimo cai
   para `MIN_MARKER_AREA_RATIO` × área típica (padrão 0,2), sem passar de
   `MIN_MARKER_AREA` nem ficar abaixo de `MARKER_NOISE_AREA`. A calibração mostra o
   mínimo efetivo usado na foto.
4. **Aspect ratio (proporção).** É o lado maior dividido pelo menor, independente
   da rotação. O prendedor visto de lado fica por volta de 4–6, e visto de frente
   ou em ângulo, menos. Use `MAX_ASPECT_RATIO` para descartar faixas finas e
   compridas (fitas, bordas de etiqueta).
5. **Morfologia.**
   - `MORPH_KERNEL_SIZE` (OPEN) apaga pontinhos. Aumente se houver muito ruído,
     mas sem apagar prendedores pequenos.
   - `MORPH_CLOSE_KERNEL_SIZE` (CLOSE) preenche falhas. Aumente se um prendedor
     aparecer partido na máscara.
   - `MERGE_DISTANCE` e `MERGE_DISTANCE_RATIO` juntam pedaços próximos do mesmo
     prendedor, por exemplo quando sombra, reflexo ou listras cortam o verde. Vale o
     maior entre os px fixos e a fração do tamanho típico dos prendedores da foto
     (0,25 = um quarto do tamanho). A calibração mostra a distância usada. Mantenha
     abaixo do espaço entre prendedores de pacotes vizinhos, senão dois pacotes
     viram um.
   - `WHOLE_MARKER_AREA_RATIO` (padrão 0,6) protege prendedores encostados: região com
     pelo menos essa fração da área típica é um prendedor inteiro. Dois inteiros nunca
     são unidos pela junção de pedaços, e quando o CLOSE fecha o vão entre dois
     prendedores encostados (formando um "H"), a região é separada de novo usando a
     máscara de antes do fechamento. Ajustado em 2026-10-07 com fotos reais da
     prateleira N6 (prendedores encostados e atrás do plástico).
6. **Resolução.** `MAX_PROCESSING_WIDTH` (padrão 1600) equilibra velocidade e
   detalhe. Aumente se prendedores distantes ficarem pequenos demais.

### O que muda a aparência do verde

- **Iluminação:** lâmpadas quentes puxam o verde para o amarelo (H menor), e
  lâmpadas frias para o verde-azulado (H maior). A sombra reduz o brilho (V) e a
  saturação.
- **Câmera:** cada celular aplica balanço de branco e contraste diferentes. O
  modo HDR e os filtros alteram a cor.
- **Distância e foco:** de longe, o prendedor ocupa poucos pixels e a borda se
  mistura com o fundo. Uma foto tremida espalha a cor.
- **Compressão:** a foto enviada como "foto" no Telegram perde detalhe e cor. Envie
  como arquivo durante a calibração.

Por isso, calibre com fotos do mesmo celular e do mesmo local em que o bot será usado.

## Testes

```bash
python -m pytest -q
```

Os testes usam imagens sintéticas (marcadores, ruído, outras cores, formas inválidas,
prendedor partido, encostados, ordem de numeração, QR da prateleira) e cobrem o bot com o
Telegram simulado (registro, confirmação, correção, SKU na legenda, limites da foto).

### Base de validação (fotos reais)

`tests/fotos_reais/` (não publicada nesta cópia de portfólio; os testes que dependem dela são pulados) tem fotos reais com a contagem conhecida em `contagens.csv`
(`arquivo;quantidade;origem`). `tests/test_fotos_reais.py` falha se a contagem de qualquer
uma mudar, e o script mostra a taxa de acerto:

```bash
python scripts/avaliar.py                      # parâmetros do .env
MARKER_HUE_MIN=30 python scripts/avaliar.py    # testa um parâmetro sem editar nada
```

**Antes de integrar com o ERP**, a base precisa crescer de 6 fotos de uma prateleira para
50–100 fotos variadas (prateleiras, horários, distâncias, operadores), cada uma **contada à
mão**. Para incluir uma foto: copie para `tests/fotos_reais/`, acrescente a linha no CSV e
rode `avaliar.py`. Se algo errar, ajuste os parâmetros olhando o `calibrate.py` até a base
inteira acertar — nunca ajuste para uma foto só. As contagens "corrigida" do registro são
boas candidatas para entrar na base. As 6 fotos atuais (prateleira N6) foram contadas
visualmente na própria foto; confirme no físico.

As versões do OpenCV/numpy estão fixadas no `requirements.txt`: atualizar pode mudar a
contagem — rode `avaliar.py` antes de subir a versão.

## Evolução possível: marcador fluorescente + luz UV (não implementado)

O MVP usa só a cor visível do prendedor. Se a cor comum não for suficiente
(iluminação muito variável, reflexos), uma evolução é:

```text
marcador fluorescente
+
iluminação UV controlada
+
detecção da fluorescência visível
```

Sob luz ultravioleta, o pigmento fluorescente **emite** luz visível e fica muito
mais brilhante que o resto da cena. O detector passaria a procurar regiões de
brilho alto (V alto) na cor emitida, em vez da cor refletida, e o contraste
aumentaria muito. Isso exige marcadores fluorescentes e um ponto de foto com luz
UV controlada, então fica para depois da validação com a cor comum.
