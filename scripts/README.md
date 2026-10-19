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
