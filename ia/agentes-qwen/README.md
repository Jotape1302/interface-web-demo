# agentes-qwen

Agentes Qwen que tratam os erros de produção do **interface-web** (painel Norvia). O modelo
roda no PC do TI (Ollama + RTX 3060), nunca na VPS: a VPS só coleta os logs e manda cada erro
para cá por um túnel SSH reverso aberto pelo PC.

```
VPS (produção)                                PC do TI
scripts/coletor-incidentes  ── túnel SSH ──►  receptor 127.0.0.1:8790 → fila SQLite
 (interface-web)                              trabalhador (1 incidente por vez):
                                                1 diagnóstico  → RAG agente_diagnostico
                                                2 resolução    → RAG agente_resolucao
                                                  └ não é código automatizável → aguardando_ti
                                                3 executor     → RAG agente_executor (clone + branch)
                                                4 qualidade    → testes na sandbox + RAG agente_qualidade
                                                  ├ reprovou → volta ao 1 (máx. 3 voltas → escalado)
                                                  └ aprovou  → PR no GitHub (pr_aberto)
                                                5 monitor: PR mergeado → commit em produção →
                                                  5 execuções ok da rota (ou janela sem o erro)
                                                  ├ erro voltou → reabre na volta seguinte
                                                  └ confirmado  → resolvido + RAG da resolução
```

Cada agente recebe o incidente e a **saída completa** dos anteriores, consulta a própria RAG e
devolve um JSON validado (Pydantic, `format` do Ollama). O próximo só começa depois que essa
saída está gravada. Se o Ollama cair no meio, o incidente espera e a retomada pula os agentes
já concluídos na volta.

## Fases

| Fase | O que faz | Estado |
|---|---|---|
| 1 | coletor + túnel + fila + diagnóstico + resolução; relatório em `dados/relatorios/` e notificação na área de trabalho | **no ar** |
| 2 | executor (`qwen2.5-coder:14b`, clone próprio + branch) + qualidade (testes na sandbox + revisão; reprovou → nova volta) + PR no GitHub | **pronta** |
| 3 | contagem de execuções por rota no gateway + monitor das próximas 5 execuções depois do deploy | **pronta** |

Limites: no máximo `MAX_VOLTAS` (3) voltas por incidente; depois vai para o TI (`escalado`).

Estados finais: `aguardando_ti` (relatório; a correção não é de código automatizável ou o
diagnóstico pediu humano), `pr_aberto`, `pronto_para_pr` (com `PR_ABRIR=0`), `escalado`,
`resolvido` (o TI confirmou com `resolver`).

## Executor, qualidade e segurança (fase 2)

O executor é um LLM e o que ele lê vem, em parte, dos logs de produção (texto que um usuário pode
influenciar). Por isso as travas são de código, não de prompt:

- **Clone próprio** em `dados/interface-web` (nunca a sua pasta de trabalho), em `origin/main`,
  branch `agente/inc-<id>-v<volta>`.
- **Edição por troca exata** (`procurar` → `substituir`, o trecho tem que aparecer 1 vez), tudo
  ou nada. Só `backend/` e `frontend/`; recusados: `.env*`, certificados, migrações,
  `docker-compose`, `Dockerfile`, `.github/`, `package*.json`, `requirements*`, `scripts/`.
- **Testes na sandbox** (bubblewrap): sem rede, home trocada por um tmpfs (sem `~/.ssh`, sem o
  token do `gh`), só o clone e o cache do uv graváveis. As dependências são baixadas antes, com
  rede, a partir dos lockfiles da `main` sem nenhuma edição do agente.
- Suítes pelas pastas tocadas (scripts do `package.json` da raiz): gateway → `test:gateway` +
  `tsc`; frontend → `test:frontend` + `typecheck`; automações → `test:nfe`/`marketplace`/
  `estoque`/`producao`; `.py` → `ruff`.
- **Aprovação** = todos os testes passaram **e** a qualidade diz que resolve a causa raiz, sem
  regra de ouro violada. Teste falhando reprova mesmo que o LLM aprove.
- **Sempre PR**, com a identidade do TI (`GIT_EMAIL`), corpo com o relatório inteiro. Merge e
  deploy continuam manuais.

## Monitor (fase 3)

**Contagem de execuções:** vem do gateway (`execucoes.ts`) e, desde 30/10, das automações Python
(`app/execucoes.py` em automacao-nfe, automacoes-marketplace e contagem-estoque): rotas HTTP e rotinas
agendadas (`rotina SEFAZ_SCAN`, `rotina FRETES`, ...). Erro Python dentro de uma execução sai com
` [execucao=<chave>]` no log, e o coletor usa como rota. A contagem é filtrada pelo serviço do incidente.
Rotina diária precisa de 5 dias para somar 5 execuções.

**Deploy:** o relatório e o corpo do PR terminam com "Depois do merge: deploy", com os comandos da VPS
tirados das pastas que o PR muda (`repo.comandos_deploy`), não do LLM. Quando o PR é mergeado, chega
o aviso para rodar o deploy.

**Aprovar um PR dos agentes:** adicione o rótulo `aprovado` no PR (barra lateral → Labels). Na próxima
passada (até 5 min) o monitor confere que o rótulo foi posto por alguém de `PR_APROVADORES` (padrão
`Jotape1302`) e que o CI passou, e faz o merge (`gh pr merge --squash --admin --delete-branch`): o GitHub
não deixa a conta que abriu o PR aprová-lo, e o gh dos agentes usa a conta do TI. CI vermelho ou ainda
rodando: não faz merge e tenta de novo depois. Para recusar de vez, feche o PR.

**Ensinar o jeito certo (`/refazer`):** comente no PR `/refazer <o que está errado e como deve ficar>`
(ex.: `/refazer recusa esperada da SEFAZ: logue em WARNING, não ERROR; mensagem com o que fazer; teste do 656`).
Só vale comentário de alguém de `PR_APROVADORES` e com texto. Na próxima passada o monitor fecha o PR
(apagando a branch), grava o desfecho `ti_pediu_ajuste` e devolve o incidente à fila na volta seguinte
com o pedido em `pedido_ti`. O pedido vai para o diagnóstico, a resolução, o executor (junto com o diff
recusado, para não repetir) e a qualidade, que reprova o diff que não o cumprir. As `MAX_VOLTAS` contam
de novo a partir do pedido. Ele também entra como "lição do TI" na RAG da resolução e da qualidade, para
os próximos incidentes parecidos. No export de treino, a volta recusada fica `errado` e a refeita que
for confirmada fica `certo`: é o par de preferência para o fine-tuning.

Conferências feitas pelo código, não pela palavra da qualidade: se o pedido do TI fala em teste, o
executor recebe um arquivo de teste da mesma suíte (o citado no pedido ou o que mais cita o módulo
editado) e a volta só é aprovada se o diff alterar algum arquivo de teste (desfecho `faltou_teste`).
A qualidade recebe a lista conferida dos arquivos alterados, marcando os de teste. No #16 (volta 4) ela
aprovou dizendo que havia teste num diff que só mexia em `danfe.py`.

Roda no mesmo trabalhador, a cada `MONITOR_INTERVALO` (300 s), entre um incidente e outro:

1. `pr_aberto` → `gh pr view`: mergeado vira `aguardando_deploy` (guarda o sha do merge); fechado
   sem merge vira `pr_fechado`.
2. `aguardando_deploy` → quando o commit da produção (git HEAD da VPS, que o coletor manda em todo
   envio) contém o merge, vira `monitorando` (`deploy_em`). O commit é o do `git pull`: se o
   rebuild dos containers demorar, o monitor começa a contar um pouco antes.
3. `monitorando`:
   - **erro com rota** (`request_error` do gateway): o gateway emite por minuto a contagem ok/erro
     por rota (`backend/gateway/src/execucoes.ts`); o monitor acompanha **as 5 próximas execuções**
     da rota depois do deploy: 5/5 ok → `resolvido`; alguma falhou → `escalado` (desfecho
     `falhou_no_acompanhamento`, "5/5 execuções acompanhadas com 4/5 sucessos"): a correção não
     segurou e vai para o TI. Sem tráfego em 14 dias → `resolvido` com essa observação.
   - **erro sem rota** (rotinas, serviços internos): janela sem recorrência de 5× o intervalo
     médio entre as ocorrências anteriores (mín. 1 h, máx. 7 dias; 1 ocorrência só: 24 h).
   - a mesma assinatura chegando de novo **reabre o incidente na volta seguinte** (o
     diagnóstico recebe a volta anterior, com o diff que não resolveu).
4. `resolvido` pelo monitor entra na RAG da resolução (sem reindexar tudo).

## Aba "Agentes Qwen" no painel

`GET /painel` do receptor (com o token) devolve o estado dos 60 incidentes mexidos por último
(`agentes/painel.py`): estado e grupo (precisa de você, PR pendente, aguardando deploy, monitorando,
em análise, resolvido), PR com quem aprovou pelo rótulo, comandos de deploy, acompanhamento das 5
execuções e os desfechos. Sem a amostra do log e sem prompts. O coletor da VPS lê a cada minuto e
repassa ao gateway, que mostra em `/admin/agentes-qwen` e avisa só quem tem `agentes_qwen:ver`.
O botão "Marcar como resolvido" da aba (`agentes_qwen:resolver`) volta pelo mesmo caminho: o gateway devolve
o pedido na resposta do repasse e o coletor entrega em `POST /comandos` do receptor, que faz o mesmo que o
`resolver` da linha de comando (nota na RAG da resolução).

### "Reportar erro" (botão das abas do painel)

As abas com automação (Contas a Pagar, conciliações Inter e ML, NF-e, Dashboard Financeiro, Contagem de
estoque, Dimensões, Fretes) têm o botão "Reportar erro". O gateway guarda o reporte e o manda pelo mesmo
caminho, como comando `{"acao": "reportar", "reporte": {...}}` (texto com CPF/e-mail mascarados).
`banco.receber_reporte` evita duplicar:

- o mesmo reporte entregue de novo devolve o incidente já ligado (tabela `reportes`, id = id do gateway);
- erro igual a um incidente ainda não resolvido do mesmo serviço (uma mensagem normalizada contém a outra,
  ou a referência do reporte aparece no log do incidente) só se junta a ele (`operador_reportou` no
  histórico, +1 ocorrência); em `monitorando`, reabre como o log repetido;
- senão abre um incidente `reporte_operador` com assinatura serviço + mensagem, então reportes iguais em
  execuções diferentes caem nele; o log do mesmo erro que chegar depois completa a amostra, a rota e a função.

`GET /painel` traz `reportes` em cada incidente; o gateway liga o reporte ao incidente, mostra o andamento
no lugar do botão e fecha o reporte quando o incidente fica resolvido.

## Classificador de NF-e (revisão de Contas a Pagar)

Runbook de operação (VPS + PC, treino, promoção, rollback e sintomas): `RAGs/knowledge/runbooks/classificador-qwen-nfe.md`.

O coletor da VPS chama `POST /financeiro/sincronizar` (com o token, até 4 MB) a cada minuto, e
`agentes/financeiro_fila.py` guarda:
- `notas_financeiro`: uma linha por nota da revisão (`pendente → classificada → entregue | descartada`,
  `erro` depois de 3 falhas). Uma versão nova da nota (`staged_at` diferente) volta a `pendente` do zero.
- `historico_itens_financeiro`: os itens confirmados por uma pessoa (categoria final, forma de pagamento,
  o palpite do Qwen que chegou à tela e o que este PC classificou, mesmo se não chegou): exemplos do
  few-shot e gabarito do fine-tuning.
- `financeiro_estado`: o catálogo fechado de categorias que vem da VPS (o schema do Qwen sai dele).

A resposta traz as `prontas` (até 20). Elas só saem da lista quando o coletor devolve o resultado no
ciclo seguinte (`aplicado`, ou `descartado` quando a VPS recusou com 404/409/422): VPS fora do ar não
perde classificação.

**Classificação** (`agentes/financeiro.py`, linha própria dentro do `servir`: uma nota não espera um
incidente inteiro). Por nota, os itens com `classificar` vão ao `MODELO_FINANCEIRO` (padrão `qwen2.5:14b`,
o mesmo dos agentes, com o mesmo `NUM_CTX`: não troca nem recarrega modelo na VRAM) em lotes de até 25.
- O schema é montado por chamada: `item_id` só aceita os itens do lote e `categoria` só os rótulos
  "grupo → nome" do catálogo; o código troca o rótulo pelo ID. Com os IDs numéricos no enum, a geração
  restrita escolhia pelo prefixo do número (teste de 03/11: quase tudo virou "Impostos").
- `motivo` vem antes de `categoria`: o modelo justifica antes de escolher.
- Até 5 exemplos por item, sempre da mesma empresa e confirmados por uma pessoa: mesmo fornecedor com
  descrição parecida → mesmo NCM de outros fornecedores → semelhança semântica (bge-m3 na CPU; o vetor
  fica em `historico_itens_financeiro.vetor`, calculado uma vez por item). Sem reranker.
- Textos do XML vão em `<dados_nfe>` (sem `<`/`>`), tratados como dados.
- Cada conversa vai para `chamadas_financeiro` (auditoria e fine-tuning). Falha conta tentativa (3 → `erro`)
  e a nota fica para a passada seguinte; Ollama fora não conta tentativa.

Teste no terminal, sem gravar na fila: `python -m agentes classificar-nota <arquivo.review.json>` (usa o
catálogo que veio da VPS ou, sem ele, o `tiny_categories.py` do interface-web). Medido em 03/11 na RTX
3060: nota de 5 itens em ~12 s com o modelo já carregado.

### Dataset e métricas do classificador (`agentes/treino_financeiro.py`)

```bash
# na VPS (~/norvia/interface-web): o que a tela sugeria em cada confirmação
scripts/exportar-atividades.sh --permissao revisao_nfe:lancar > nfe.jsonl
# aqui
../RAGs/.venv/bin/python -m agentes importar-atividades nfe.jsonl   # → sugestoes_financeiro
../RAGs/.venv/bin/python -m agentes treino-financeiro               # → dados/treino/financeiro_*.jsonl
../RAGs/.venv/bin/python -m agentes avaliar-financeiro              # concordância e onde a pessoa corrige
```

- A resposta-alvo é sempre a categoria que a pessoa confirmou, no mesmo JSON do schema do Ollama
  (`item_id, motivo, categoria, confianca`). O `motivo` sai da pista que está no prompt (exemplo do
  mesmo fornecedor, histórico por NCM etc.) ou do próprio Qwen quando ele acertou.
- O prompt é o da fila (`financeiro.montar_prompt`): só os itens sem histórico pelo código, lotes de
  25, pista de histórico e exemplos tirados **só de notas estagiadas antes** da nota.
- Validação: as 10% notas mais recentes, mais a mais recente de cada categoria com 5+ itens que não
  tivesse caído nelas. Notas da validação nunca aparecem como exemplo nem pista no treino.
- `corrigido_pelo_humano` (a tela, o Qwen na tela ou o palpite deste PC diferia da escolha): a nota
  entra 2× em `financeiro_sft.jsonl` e gera um par em `financeiro_dpo.jsonl`
  (`{prompt: [system, user], chosen: [assistant], rejected: [assistant]}`, formato conversacional do TRL).
- `financeiro_validacao.jsonl` traz em `contexto.itens` o gabarito (categoria, valor, rótulo) para a etapa 5.
- `notas_confirmadas_financeiro` guarda o cabeçalho das confirmadas (destinatário, valor, tPag) que
  chegam desde 04/11; as anteriores aparecem com `-` no prompt até a VPS reenviar o histórico.

### Fine-tuning QLoRA e promoção (`agentes/finetune_financeiro.py`)

Venv próprio (o Unsloth não suporta o Python 3.14 do RAGs), uma vez só:

```bash
uv venv .venv-treino --python 3.12 && uv pip install -p .venv-treino -r requirements-train.txt
```

Ciclo:

```bash
../RAGs/.venv/bin/python -m agentes treino-financeiro            # datasets atualizados
../RAGs/.venv/bin/python -m agentes finetune-financeiro          # mínimo 100 exemplos (--force para testar)
../RAGs/.venv/bin/python -m agentes comparar-financeiro          # candidato × modelo atual na validação
../RAGs/.venv/bin/python -m agentes comparar-financeiro --promover
```

- `finetune-financeiro` roda no `.venv-treino`. Ele para o serviço `agentes-qwen` e descarrega o Ollama
  (o coletor da VPS guarda a fila), treina o LoRA (r=16, 3 épocas, loss só na resposta) sobre
  `unsloth/Qwen2.5-14B-Instruct-bnb-4bit` e converte o adaptador para GGUF (llama.cpp clonado raso em
  `dados/llama.cpp`): o candidato é `dados/modelos/qwen-financeiro-lora/adapter.gguf` (~140 MB). O serviço
  volta no fim, mesmo se o treino falhar. Na primeira vez baixa ~10 GB da base 4-bit do HuggingFace.
  `--max-passos N` encurta, `--dpo` faz uma passada de DPO depois (pode faltar VRAM), `--sem-gguf` só salva o adaptador.
- O Ollama 0.40 não aceita mais `ADAPTER`: o adaptador roda no **llama-server** (llama.cpp) sobre o
  mesmo GGUF do `qwen2.5:14b` que o Ollama já tem (sem cópia). Por lote, dentro da trava da GPU (os
  agentes de incidentes esperam): descarrega o Ollama, sobe o servidor em `127.0.0.1:8791`, classifica e
  encerra. Cada requisição escolhe o adaptador, então vários (um por atividade) podem conviver.
- `comparar-financeiro` para o serviço, sobe um llama-server com o promovido e o candidato e classifica a
  validação com cada um (mesmo prompt e schema da fila): acurácia por item, ponderada por R$, segundos por
  nota e respostas inválidas. Sem promovido, compara com a base pura. Retorna 1 se o candidato piorar.
  Com `--promover` (só se não cair), copia o candidato para `dados/modelos/financeiro/promovido.gguf`
  (o anterior fica em `anterior.gguf`). A fila passa a usar o promovido no lote seguinte, sem reiniciar,
  e a VPS recebe o modelo como `qwen2.5:14b+lora-<8 dígitos do sha256>`.
- Sem promovido, ou se o llama-server não subir, a fila segue no Ollama sem adaptador (um aviso no log).
  Para voltar atrás: `mv dados/modelos/financeiro/anterior.gguf dados/modelos/financeiro/promovido.gguf`
  (ou apague o promovido para voltar à base).

Pré-requisitos do llama-server, uma vez:

```bash
scripts/instalar-llama-server.sh     # b12110 CUDA 13.4 em dados/llama-server/, sha256 conferido
# leitura do GGUF do Ollama (dono ollama, 0700/0600) pelo seu usuário, sem mudar o dono:
B=$(ollama show --modelfile qwen2.5:14b | awk '/^FROM \//{print $2}')
sudo setfacl -m u:$USER:x /usr/share/ollama /usr/share/ollama/.ollama /usr/share/ollama/.ollama/models /usr/share/ollama/.ollama/models/blobs
sudo setfacl -m u:$USER:r "$B"
```

O blob muda de nome se o `qwen2.5:14b` for atualizado (`ollama pull`): repita o último `setfacl`.
O log do servidor fica em `dados/llama-server.log`.

## Registro de treino (fine-tuning)

Toda conversa de um agente com o modelo fica na tabela `chamadas` (system, user, resposta crua, se o JSON
veio válido), inclusive as respostas recusadas. O que aconteceu depois fica em `desfechos`: edição que
não aplicou, testes, parecer da qualidade, volta reprovada, PR aberto/mergeado/fechado, confirmação
em produção, erro que reapareceu, `resolver` e `reprocessar` do TI.

```bash
../RAGs/.venv/bin/python -m agentes treino                         # dados/treino/agentes.jsonl
../RAGs/.venv/bin/python -m agentes treino --agente executor --rotulo certo,errado --saida exec.jsonl
```

Cada linha é `{"messages": [...], "rotulo", "motivo", "agente", "modelo", "contexto": {incidente, volta, desfechos, nota_ti}}`.
Rótulos (regras em `agentes/treino.py`):

| Rótulo | Quando |
|---|---|
| `certo` | a correção da volta foi confirmada em produção (ou o TI resolveu depois do merge); qualidade que reprovou junto com os testes |
| `errado` | JSON fora do esquema; tentativa do executor recusada; edição que não aplicou; testes falharam; qualidade que aprovou com teste vermelho; PR fechado; o erro reapareceu; falhou no acompanhamento das 5 execuções |
| `incerto` | a volta parou sem dizer quem errou (qualidade reprovou com testes verdes, sem arquivo editável, escalado) |
| `pendente` | ainda sem desfecho final |
| `descartado` | a volta foi refeita pelo `reprocessar` (fora do export por padrão) |

O texto dos incidentes já chega mascarado do coletor (tokens, e-mail, CPF/CNPJ).

## Agentes e RAGs

| Agente | Saída | RAG (pastas de `RAGs/knowledge`) |
|---|---|---|
| diagnóstico | resumo, componente, causa raiz, causas contribuintes, evidências, tipo, confiança, `precisa_de_humano` | runbooks, architecture, automations, integrations, database + trecho da função do stack lido do interface-web |
| resolução | passos (ação, arquivo, detalhe), arquivos afetados, riscos, como verificar, `automatizavel`, confiança | runbooks, infrastructure, automations, integrations + **incidentes resolvidos** (nota do TI) |
| executor (`qwen2.5-coder:14b`, contexto 8192) | edições exatas, explicação, título do PR | architecture, database + `agents/{gateway,backend,automation_engineer,frontend}.md` do interface-web; vê os arquivos afetados do clone |
| qualidade | resolve a causa?, problemas, regras violadas, aprovado, motivo (+ resultado dos testes) | `agents/qa_engineer.md`, `.codexrules` (Regras de Ouro), infrastructure |

A RAG da resolução aprende: `python -m agentes resolver <id> "como resolvi"` marca o incidente e
reindexa a coleção com ele. A base de conhecimento continua sendo a do RAGs (fonte da verdade);
depois de atualizá-la, rode `python -m agentes ingerir`.

Busca: vetorial (bge-m3, CPU) nos 16 mais próximos → reranker (bge-reranker-v2-m3, fp16 na GPU)
→ 4 trechos. O log, o código e os documentos entram no prompt como dados delimitados; o prompt
manda ignorar instruções que venham neles.

## Rodar

Usa o venv do RAGs (já tem torch com CUDA, sentence-transformers e chromadb):

```bash
cp .env.example .env && chmod 600 .env       # INCIDENTES_TOKEN (o mesmo do coletor da VPS)
ollama pull qwen2.5:14b && ollama pull qwen2.5-coder:14b
../RAGs/.venv/bin/python -m agentes ingerir  # ~8 min em CPU; com o Qwen parado: EMBEDDING_DEVICE=cuda
../RAGs/.venv/bin/python -m agentes servir
../RAGs/.venv/bin/python -m agentes simular  # noutro terminal: incidente de exemplo
../RAGs/.venv/bin/python -m agentes listar
../RAGs/.venv/bin/python -m agentes mostrar 1
```

Como serviço (usuário):

```bash
cp systemd/agentes-qwen.service systemd/agentes-qwen-tunel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agentes-qwen.service agentes-qwen-tunel.service
loginctl enable-linger "$USER"
journalctl --user -u agentes-qwen -f
```

## Túnel

Chave dedicada, sem senha (o systemd não tem o ssh-agent da sessão), que **só** abre o
encaminhamento reverso de 127.0.0.1:8790 na VPS:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/agentes_qwen_tunel -C agentes-qwen-tunel
```

No `~/.ssh/config` do PC:

```
Host vps-norvia
    HostName <ip ou domínio da VPS>
    User <usuário do Docker rootless>
    IdentityFile ~/.ssh/agentes_qwen_tunel
    IdentitiesOnly yes
```

No `~/.ssh/authorized_keys` da VPS, a chave pública com restrições (sem shell, sem outros
encaminhamentos):

```
restrict,port-forwarding,permitlisten="127.0.0.1:8790",command="/bin/false" ssh-ed25519 AAAA... agentes-qwen-tunel
```

Teste na VPS: `curl -s http://127.0.0.1:8790/saude` → `{"ok": true}`.

## GPU (RTX 3060 12 GB)

Qwen 14B com `num_ctx` 6144 + reranker fp16 passam um pouco dos 12 GB e o Ollama põe ~9% das
camadas na CPU. Para caber 100% na GPU, ligue flash attention e cache KV em 8 bits no serviço do
Ollama (`sudo systemctl edit ollama`):

```
[Service]
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
```

e `sudo systemctl restart ollama`. Confira com `ollama ps` (coluna PROCESSOR = `100% GPU`).

## Testes

```bash
../RAGs/.venv/bin/python -m unittest discover -s tests   # sem GPU nem Ollama
```
