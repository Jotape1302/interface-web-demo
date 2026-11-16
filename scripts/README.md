# Scripts do host

Scripts que rodam no host do servidor (fora dos containers). O backup tem seu próprio
README em [backup/README.md](backup/README.md).

## `sync_ml_tokens.py`: tokens do Mercado Livre pelo TMS

Busca os tokens do Mercado Livre (Revesta e Norvia Campinas) no TMS e grava o
`ml_tokens.json` das automações. Ele é a fonte dos tokens do `automacoes-marketplace` e do
`automacoes-financeiro`, a não ser que o financeiro tenha `TMS_USER`/`TMS_PASSWORD` próprios.

Fluxo:
1. `POST /tms_api/auth/login` com o usuário e a senha do TMS, para obter o Bearer token.
2. Lê os tokens das filiais (`GET /tms_api/tokens?id=3` Revesta e `?id=4` Campinas).
3. Testa cada `access_token` no Mercado Livre com `GET /users/me` (ver validação abaixo).
4. Grava o JSON de forma atômica, com modo `0640`, em cada destino.

**Credenciais.** `TMS_USER` e `TMS_PASSWORD` vêm do ambiente ou de `--env-file` (o `.env` da raiz,
que está no `.gitignore`). `TMS_BASE_URL` é opcional (padrão `https://servidor.norvia.example/tms_api`).
Não coloque as credenciais na linha de comando nem no cron.

**Destinos.** Com `--output` (pode repetir), grava nos caminhos informados. Sem ele, usa
`ML_TOKENS_FILE` se existir; senão grava em `backend/automations/automacoes-marketplace/data/ml_tokens.json`
e em `backend/automations/automacoes-financeiro/data/ml_tokens.json` (os que tiverem a pasta `data/`).

**Modo 0640, e não 0600.** No Docker rootless o container lê o arquivo por ACL. O chmod define a
máscara da ACL pelos bits de grupo, e com 0600 o container perde a leitura. Por isso o arquivo
fica em 0640 e a pasta `data/` precisa da ACL do appuser (ver `docs/seguranca-deploy.md` §4).

**Validação.** Cada token é testado em `GET https://api.mercadolibre.com/users/me`:
- Aceito: o campo `valido` fica `true`.
- Recusado (HTTP 401 ou 403): `valido` fica `false`, o log mostra `TOKEN INVÁLIDO` e o arquivo
  **é gravado mesmo assim**. O script sai com código `3`.
- Não deu para testar (rede ou 5xx): `valido` fica `null`.
- Cada entrada também traz `validado_em`.
- `--sem-validar` pula esse teste.

**Códigos de saída:** `0` gravou e todos os tokens são válidos ou não testados; `1` falta de credenciais
do TMS; `2` erro na sincronização (login, TMS, gravação); `3` gravou, mas o Mercado Livre recusou algum token.

**Opções:**

| Opção | Efeito |
|---|---|
| `--env-file <caminho>` | lê `TMS_USER`/`TMS_PASSWORD` de um `.env` explícito |
| `--output <caminho>` | destino do `ml_tokens.json` (repetível) |
| `--dry-run` | busca e mostra os tokens, sem gravar |
| `--sem-validar` | não testa os tokens no Mercado Livre |
| `--base-url`, `--user`, `--timeout`, `--insecure` | URL do TMS, usuário, timeout e TLS (`--insecure` só em loopback) |
| `--loop --interval <s>` | repete no intervalo (padrão 7200 s) |

**Cron do host (recomendado a cada 30 min):**

```bash
*/30 * * * * cd /home/<usuario>/norvia/interface-web && /usr/bin/python3 scripts/sync_ml_tokens.py --env-file .env >> /home/<usuario>/norvia/logs/sync_ml_tokens.log 2>&1
```

Troque `<usuario>` pelo usuário do servidor e crie a pasta de log antes. O cron registra o código
de saída; o código `3` é a falha a acompanhar no log.

**Testar sem gravar:**

```bash
cd ~/norvia/interface-web && python3 scripts/sync_ml_tokens.py --env-file .env --dry-run
```

## `migrate.sh`: migrações do MariaDB

As migrações de `database/migrations/` têm pré-condições no cabeçalho (ordem de deploy, parte
destrutiva), então nada é aplicado em lote. O script registra o que já rodou na tabela
`schema_migrations` (criada por ele mesmo, ou pelo `database/init/07` numa instalação nova),
com o sha256 do arquivo:

```bash
scripts/migrate.sh                      # status: aplicada / PENDENTE / ALTERADA
scripts/migrate.sh apply <arquivo.sql>  # mostra o cabeçalho, pede "s", aplica e registra
scripts/migrate.sh mark <arquivo.sql>   # só registra (já aplicada à mão antes do script)
```

- O registro vai no mesmo stdin da migração, depois dela: se o SQL falhar, o cliente para e
  nada é registrado.
- **Primeira vez no servidor:** rode `scripts/migrate.sh`, e para cada migração que você já
  aplicou à mão use `mark`. As demais seguem pendentes até um `apply`.
- Pede a senha do MariaDB uma vez (ou leia de `MYSQL_PWD`) e conecta com
  `docker compose exec -T -e MYSQL_PWD mariadb mariadb -uroot financeiro`. Ajustes:
  `MIGRATE_DB_SERVICE` (serviço do compose), `MIGRATE_DB_USER` (usuário) ou `MIGRATE_DB_CMD`
  (cliente inteiro, lê SQL do stdin).
- `npm run db:migrate` é o mesmo que `scripts/migrate.sh`.

## `exportar-atividades.sh`: ações dos usuários para fine-tuning

O gateway grava em `atividades_treino` cada ação que altera algo no painel (`backend/gateway/src/atividades.ts`):
o que a pessoa enviou, a resposta, a permissão usada e, nas ações instrumentadas, o que estava na tela
(`contexto`) e o que a automação sugeriu (`sugestao`). Instrumentadas: categorização e arquivamento
de NF-e, baixa da conciliação Inter e da ML, validação e reenvio de dimensões (a automação devolve `treino`
na resposta e o gateway tira o campo antes de responder ao painel). Ficam fora login e senha, contagem de estoque, chat e leitura de avisos. Segredos saem
como `<oculto>`; CPF, e-mail e telefone de pessoa física, como `<pf>`. Não há prazo de retenção.

```bash
scripts/exportar-atividades.sh > atividades.jsonl                       # tudo
scripts/exportar-atividades.sh --desde 2026-11-01 --permissao revisao_nfe:lancar > nfe.jsonl
```

Pede a senha do root do MariaDB (ou `MYSQL_PWD`). Uma linha JSON por ação.

## Lock das dependências Python

Cada automação tem `requirements.txt` (mínimos com `>=` e o motivo, como as CVEs) e
`requirements.lock` (gerado: versões exatas + hashes, universal). Dockerfile, CI e `pip-audit`
usam o lock. Depois de mudar um `requirements.txt`, ou para pegar versões novas:

```bash
npm run lock:python    # uv pip compile em cada automação
npm run test:all       # os testes rodam com o lock (uv run --with-requirements)
```

Commite o `requirements.txt` e o `requirements.lock` juntos.

## `diagnostico-leitura-danfe.py`: onde a leitura de DANFE falha

Somente leitura, roda dentro do container do financeiro:

```bash
docker compose exec -T automacao-nfe python - --dias 90 < scripts/diagnostico-leitura-danfe.py
```

Conta as falhas por etapa (e lista as de `scan`, chave não localizada: o arquivo original delas não
fica guardado, só o `.error.json`) e as notas que passaram por tipo de arquivo, modelo (55/65) e origem
dos itens (XML do arquivo, XML da SEFAZ, OCR, item único de reserva). Base da prova de leitura por
modelo de visão (2026-11).

## `diagnostico-conciliacoes.py`: o que as conciliações deixam para a mão

Somente leitura, dentro do container do financeiro:

```bash
docker compose exec -T automacao-nfe python - --listar 40 < scripts/diagnostico-conciliacoes.py
```

Contas a Pagar (Inter × Tiny): casamentos por método e confiança, débitos do Inter sem conta no Tiny
(por empresa e idade, com favorecido e descrição), contas do Tiny sem pagamento e como as contas saíram
das pendências. Mercado Livre: última análise de cada empresa por situação. Base para decidir se vale um
LLM sugerindo pares nos casos ambíguos (2026-11).

## `coletor-incidentes/`: erros de produção para os agentes Qwen

Segue os logs dos containers (`docker compose logs -f -t`) e envia cada erro ao orquestrador
dos agentes Qwen, que roda no PC do TI (repositório privado `norvia-ti/agentes-qwen`). O modelo
não fica no servidor: o PC abre um **túnel SSH reverso** até a VPS
(`-R 127.0.0.1:8790:127.0.0.1:8790`) e o coletor faz `POST` em `http://127.0.0.1:8790/incidentes`.
Nenhuma porta é aberta no PC e o Ollama nunca fica exposto.

**O que é erro.** Linha JSON do gateway com `event` terminado em `_error`/`_failed`,
`uncaught_exception` ou `unhandled_rejection` (menos `login_locked` e os avisos de seed);
linha dos serviços internos do gateway com prefixo e falha (`[ReconciliationHistory] Falha ao gravar ...`);
nas automações, nível `ERROR`/`CRITICAL`, traceback ou `Erro não tratado`. As linhas do
traceback são juntadas ao registro que o abriu.

**Execuções.** O gateway emite, por minuto, `{"event":"execucoes","rotas":{"POST /api/x":{"ok":3,"erro":0}}}`
com as rotas que tiveram tráfego (`backend/gateway/src/execucoes.ts`). Essas linhas não são erro:
vão sem agrupamento para `/execucoes`, e o monitor dos agentes usa para confirmar que a rota que
falhava voltou a responder depois do deploy da correção. Incidente de `request_error` leva a
`rota` com a mesma normalização (`:id` no lugar de ids, UUIDs e códigos MLB).

**Antes de sair da VPS**, token, senha, `Bearer`, e-mail, CPF, CNPJ e textos longos (chaves)
são mascarados.

**Agrupamento.** Cada erro tem uma assinatura (serviço + evento + mensagem sem números/ids +
função do próprio código mais perto do erro). A 1ª ocorrência sai na hora; as repetições em
6 h só somam e vão na próxima remessa (`ocorrencias`). O payload leva o commit em produção
(`git rev-parse` no momento do envio).

**Aba Agentes Qwen.** A cada minuto o coletor lê `GET /painel` do orquestrador (pelo mesmo túnel)
e repassa ao gateway em `POST http://127.0.0.1:3100/api/agentes-qwen/estado` (`GATEWAY_ESTADO_URL`),
com o mesmo `INCIDENTES_TOKEN`. O gateway confere esse valor em `AGENTES_QWEN_TOKEN` (no `environment`
do serviço `gateway` no compose), guarda o último estado e avisa quem tem `agentes_qwen:ver`. Sem o
token no gateway o repasse recebe 401 e a aba diz que nenhum estado chegou.

**Classificador Qwen da revisão de NF-e.** A cada minuto o coletor lê pelo gateway
(`GATEWAY_FINANCEIRO_URL`, padrão `http://127.0.0.1:3100/api/agentes-qwen/financeiro`, com o mesmo
`INCIDENTES_TOKEN` do repasse) até 10 notas sem classificação (`GET .../pendentes`) e uma página de 100
confirmadas (`GET .../confirmadas-recentes`, cursor na tabela `cursor_financeiro` do SQLite do coletor),
entrega tudo em `POST /financeiro/sincronizar` do orquestrador e aplica as classificações prontas da
resposta (`POST .../sugestoes`). O gateway repassa cada chamada ao `automacao-nfe`
(`/api/v1/danfe/qwen/*`, com a `X-Internal-Key`) porque a porta 8000 só existe na rede do compose: o
host, com Docker rootless, não a alcança. Como o `/estado`, essas rotas recusam requisição que passou
pelo NGINX. O resultado de cada sugestão (aplicado, ou descartado com 404/409/422) vai no ciclo
seguinte; sem ele o orquestrador manda de novo. O cursor só anda depois de o orquestrador gravar a
página; com mais páginas (carga do histórico), o ciclo seguinte sai em 2 s. Com
`GATEWAY_FINANCEIRO_URL=` vazio a ponte fica desligada; gateway, automação ou PC fora do ar só adiam o
ciclo, sem afetar os incidentes.

**PC desligado.** Os incidentes ficam numa fila SQLite (`~/.local/state/coletor-incidentes/`)
e são reenviados com espera crescente (até 5 min). O cursor dos logs também fica lá: se o
`docker compose logs` cair (container recriado no deploy), ele retoma de onde parou.

Instalação (usuário do Docker rootless):

```bash
cp scripts/coletor-incidentes/coletor.env.example scripts/coletor-incidentes/coletor.env
chmod 600 scripts/coletor-incidentes/coletor.env      # INCIDENTES_TOKEN = o mesmo do orquestrador
cp scripts/coletor-incidentes/systemd/norvia-coletor-incidentes.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now norvia-coletor-incidentes.service
loginctl enable-linger "$USER"
journalctl --user -u norvia-coletor-incidentes.service -f
```

Teste sem enviar nada: `docker compose logs -t --no-color --tail 500 | python3 scripts/coletor-incidentes/coletor.py --testar`.
Testes: `cd scripts/coletor-incidentes && python3 -m unittest test_coletor`.

## `diagnostico-pagamento-ml.py`: o pagamento do Mercado Pago de uma venda da conciliação ML

Somente leitura, dentro do container do financeiro, com as vendas como `empresa:id_venda`:

```bash
docker compose exec -T automacao-nfe python - norvia_campinas:2000027262486935 < scripts/diagnostico-pagamento-ml.py
```

Mostra o grupo da análise salva mais recente (recebido × conta do Tiny), as linhas da liberação e os
valores de `GET /v1/payments/{id}` (transaction_details, fee_details, charges_details), sem dados do
comprador. Usado para os divergentes com diferença menor que o custo de parcelamento (2026-11).

## `auditoria-regras-conciliacao-ml.py`: as regras de valor da conciliação ML conferidas com o Mercado Pago

Somente leitura, dentro do container do financeiro:

```bash
docker compose exec -T automacao-nfe python - < scripts/auditoria-regras-conciliacao-ml.py
```

Para cada venda de todas as análises salvas em que uma regra mexeu na baixa (parcelamento ou cupom
descontado, frete no caixa) e para os VALOR DIVERGENTE da última análise, busca o pagamento no MP e
confere: parcelamento descontado = acréscimo pago pelo comprador, cupom = coupon_fee do vendedor,
frete, valor da baixa = transação − frete − cupom e data da venda = aprovação (fuso SP). Mostra
quantas batem e lista as que não batem (2026-11-06).
