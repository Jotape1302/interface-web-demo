# Tarefa para o Antigravity: 2ª rodada de correções do "Arch Journal" (revisão de 13/11/2026)

Continuação de `docs/antigravity/email-marketing-arch-journal-correcoes.md` (C0–C8). A entrega
anterior acertou quase tudo (pytest 28, ruff, gateway 222, frontend 194, testes isolados): **não
desfaça nada que já está certo**. O provedor de imagem continua sendo o **Gemini**
(`MARKETING_IMAGEM_PROVEDOR=gemini`, `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image`).

Ordem: **D1 → D2 → D3 → D4 → D5 → D6**, depois as verificações da D7. Não faça commit nem push:
entregue a lista de arquivos e o resultado de cada verificação.

---

## D1. Rodízio prende o hero na mesma foto (ALTA) — `app/rotina.py`, `app/ambientes/gerenciador.py`

**Defeito (reproduzido na revisão):** com as 2 fotos aprovadas de `rodape_invertido`, 4 chamadas
seguidas de `_selecionar_imagens_rascunho("rodape_invertido", copy)` devolvem **sempre**
`hero = amb-rodape-close`. Causa: cada rascunho chama `escolher_imagem_aprovada_com_rodizio` três
vezes para a mesma linha (hero, card 01 e carrossel) e cada chamada grava
`ultimas_imagens_por_linha[slug]`. A última gravação é a foto do card 01/carrossel, então a próxima
edição volta para a mesma foto de hero.

**Fazer:**
- Separar **escolher** de **registrar**: `escolher_imagem_aprovada(slug, evitar_ids)` só escolhe
  (sem gravar nada) e `registrar_hero_usado(slug, img_id)` grava o estado.
- O estado guarda **só o hero** por linha (`ultimo_hero_por_linha`). O hero é a aprovada seguinte
  à última usada, em ordem estável (por `aprovada_em`, depois `id`), voltando ao início no fim da
  lista (rodízio circular, não "qualquer uma diferente da última").
- Card 01 e carrossel: preferem uma foto diferente do hero da mesma edição; não mexem no estado.
- Cards 02 e 03: também sem gravar estado (podem seguir o mesmo rodízio por linha num campo
  próprio, `ultimo_card_por_linha`, se quiser variar).
- `registrar_hero_usado` só é chamado **depois** que o rascunho foi gravado com sucesso (dentro do
  bloco que salva em `_rascunhos_lock`). Se a geração falhar, o rodízio não avança.

**Testes:**
- 2 fotos aprovadas na linha: 4 seleções seguidas → hero `A, B, A, B`;
- 3 fotos: hero `A, B, C, A`;
- na mesma edição, card 01 ≠ hero quando houver 2+ fotos;
- geração que falha depois da seleção (monkeypatch levantando exceção no carrossel ou no
  salvamento) → `estado.json` inalterado.

---

## D2. Geração real no Gemini, de verdade, uma vez (ALTA)

O C7.8 da rodada anterior não foi feito: não existe nenhuma candidata real em `data/ambientes/`.
Os testes só cobrem respostas simuladas.

**Fazer**, com a `GEMINI_API_KEY` do `.env` do serviço, fora do `MOCK_MODE`:
1. Antes de gerar, conferir o modelo:
   `curl -s -H "x-goog-api-key: $GEMINI_API_KEY" "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"`
   e confirmar que `models/gemini-3.1-flash-image` aparece com `generateContent`. Anotar no
   README a data e o resultado.
2. Rodar **uma** geração de `perfil_t` com `quantidade=1` (pelo endpoint
   `POST /api/v1/ambientes/gerar`, com o serviço rodando local, ou chamando
   `_executar_geracao_tarefa` num script fora dos testes).
3. Se a API recusar `imageConfig.aspectRatio` (HTTP 400 com o nome do campo), consultar a
   documentação atual do Gemini, corrigir o nome/formato do campo e repetir. Anotar no README o
   formato que funcionou.
4. Se vier 429 de cota (sem cota grátis para o modelo de imagem), **parar** e relatar a mensagem
   exata da API: não trocar de modelo nem de provedor por conta própria.
5. **Não aprovar** a candidata: a aprovação é do usuário no painel.

**Entregar:** os dois arquivos gerados (3:2 e 4:5) com dimensões e tamanho em KB, o registro do
`indice.json`, o tempo da chamada e o `finishReason`. Se a imagem vier deformada (perfil diferente
do render, texto na imagem, pessoas), dizer isso no relatório; não esconder.

---

## D3. Formato 4:5 do carrossel gerado no Gemini, não recortado (MÉDIA)

**Defeito:** a 4:5 sai do recorte central da 3:2 (de 1200×800 sobra 640×800, ampliado 1,5× para
960×1200). Perde mais da metade da cena, pode cortar o produto e quem aprova só vê a 3:2.

**Fazer:**
- Cada opção faz **duas chamadas** ao Gemini: a 3:2 normal e, em seguida, a 4:5 com
  `aspectRatio: "4:5"`, enviando a **imagem 3:2 gerada** como primeira referência e o prompt
  "Recomponha esta mesma cena no formato vertical 4:5, mantendo o ambiente, a luz e o perfil
  exatamente como estão; não acrescente nem remova elementos" + as mesmas proibições.
- O recorte central fica **só** como recurso quando a chamada 4:5 falhar; nesse caso o registro
  grava `formato_4x5: "recorte"` (senão `"gerado"`), e o painel mostra esse rótulo.
- `processar_e_recortar_jpeg` não amplia imagem pequena: se o lado menor do recorte for menor que o
  do alvo, grava no tamanho que der (sem upscale) e registra as dimensões reais.
- Contagem do limite diário: **cada opção** conta 1 (as duas chamadas são da mesma opção), mas o
  README diz que cada opção custa 2 chamadas de imagem.
- **Painel (Banco de ambientes):** o card da candidata mostra a 3:2 **e** a 4:5 lado a lado (a
  4:5 por `GET /api/marketing/ambientes/<id>_4x5.jpg`; confira que o regex do gateway e do serviço
  aceitam o sufixo `_4x5`). Aprovar aprova as duas. Se a 4:5 ficar ruim, a pessoa recusa a opção
  inteira.

**Testes:** o mock de `requests.post` recebe 2 chamadas por opção, a 2ª com `aspectRatio "4:5"` e
a imagem 3:2 em `inline_data`; 4:5 com falha → `formato_4x5 == "recorte"`; imagem de 600×400 não é
ampliada; `GET /api/v1/ambientes/<id>_4x5.jpg` devolve 200.

---

## D4. Falha no meio das opções não perde as já geradas (MÉDIA) — `_executar_geracao_tarefa`

**Defeito:** os registros só entram no `indice.json` no fim do laço. Se a 3ª de 4 opções falhar, a
1ª e a 2ª (já geradas e possivelmente pagas) ficam como arquivos órfãos em `data/ambientes/`, não
aparecem no painel e não contam no limite diário.

**Fazer:**
- Gravar cada opção no índice **logo depois** de gravar os arquivos dela (pegar `_ambientes_lock`,
  reler, acrescentar, gravar), dentro do laço.
- Na falha de uma opção: parar o laço, levantar o erro com o texto
  `"Opção N de M falhou: <motivo>; X opção(ões) gerada(s) e salva(s)"` (vai para `ultimo_erro`).
- Se a chamada da 3:2 deu certo e a gravação falhar, apagar os arquivos daquela opção (nada de
  órfão).

**Teste:** mock que responde imagem na 1ª e 2ª chamada e HTTP 500 na 3ª, com `quantidade=3` → 2
candidatas no índice, `ultimo_erro` com "Opção 3 de 3", nenhum `.jpg` em `data/ambientes/` sem
registro.

---

## D5. Prévia do e-mail no `iframe` com `sandbox=""` (MÉDIA) — `frontend/`

**Risco:** o `iframe` sem `allow-same-origin` tem origem opaca, e o Chrome pode bloquear o acesso
dele às `blob:` criadas pela página do painel (`substituirAmbientesPorBlobs`). Os testes de
`lib/*.test.ts` não pegam isso.

**Fazer:** na **prévia** (só nela), trocar as imagens de ambiente por `data:` URL (ler o blob com
`FileReader.readAsDataURL`, ou `arrayBuffer` + base64). A CSP do painel já permite
`img-src 'self' data: blob:`. Manter o `sandbox=""`. O HTML do RD continua com as URLs absolutas
(sem `data:`: teste B6 continua valendo).
- Renomear a função para `substituirAmbientesPorDataUrls` e ajustar o teste.
- Conferir no navegador (`npm run dev` com o gateway local, ou o modo demo) que as fotos aparecem
  na prévia e anexar um print.

---

## D6. Ajustes menores

1. **Exemplos de estilo por linha** (`obter_referencias_linha`): hoje toda geração usa os 2
   primeiros em ordem alfabética (filete e corredor). Criar `EXEMPLOS_POR_LINHA` com 1–2 exemplos
   coerentes por linha (rodapés → `exemplo-rodape-sala.jpg`, `exemplo-rodape-close.jpg`; LED →
   `exemplo-led-corredor.jpg`; listelo/filete → `exemplo-filete-ripado.jpg`; perfil T, redutor e
   cantoneira → `produto-perfil-t.jpg` / `produto-cantoneira.jpg` + `exemplo-rodape-sala.jpg` como
   estilo). Teste: todo slug tem exemplos e os arquivos existem.
2. **MIME das referências:** usar o tipo real do arquivo (`mimetypes`) também no caminho da
   OpenAI (hoje o render vai sempre como `image/png`, mas o da cantoneira é `.jpg`).
3. **`_renderizar`:** tirar o padrão `fonte_link = "https://www.norvia.example"`; sem matéria, o
   link fica vazio e o crédito não aparece. O crédito não usa `titulo_principal` como título da
   matéria: sem `titulo_traduzido_ptbr`, não mostra crédito.
4. **Logo publicada só se não existir** (`_publicar_marca`): comparar tamanho/hash e substituir
   quando o arquivo de `referencias/marca/` mudar.

---

## D7. Verificações para a entrega

1. `cd backend/automations/automacoes-marketing && .venv/bin/python -m pytest -q` e `uvx ruff check .`
2. `cd backend/gateway && npm test && npx tsc --noEmit`
3. `cd frontend && npm run lint && npx tsc --noEmit && npm test`
4. `git status --porcelain -- backend/automations/automacoes-marketing/publico frontend/public`
   depois dos testes: nada novo.
5. `git diff --stat -- backend/automations/automacoes-marketing/app/execucoes.py docker-compose.yml`
   vazio.
6. Script de rodízio (cole a saída):
   `MOCK_MODE=true GERAR_SEXTA_AUTOMATICO=false DATA_DIR=$(mktemp -d) PUBLICO_DIR=$(mktemp -d) .venv/bin/python -c "..."`
   chamando a seleção 4 vezes para `rodape_invertido` → hero alternando.
7. `docker build` do serviço (pendente desde a rodada anterior) e, no container:
   `ls /app/referencias/renders /app/referencias/exemplos /app/referencias/estoque_inicial /app/referencias/marca`
   e `fc-list | grep -i inter` (ou listar `/usr/share/fonts`).
8. Resultado da D2 (geração real) e print da D5.

## D8. Regras de sempre

- Sem dado inventado; não esconder imagem deformada nem erro da API.
- Testar o caminho real (mock em `requests.post`, não na função inteira).
- Escapar todo texto; nunca aceitar HTML da IA.
- `X-Usuario` vindo do gateway; aprovar/recusar só por pessoa no painel.
- Não editar `execucoes.py` nem `docker-compose.yml`.
- Dependência nova = `requirements.lock` com hashes.
- Painel com cantos retos e âmbar só em ação.
