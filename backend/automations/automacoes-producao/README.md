# Produção — servidor de impressão de etiquetas

Roda no **PC do encarregado da Produção**, que tem a impressora de etiquetas (**Elgin L42-DT**, 203 dpi,
etiqueta 60 × 40 mm) ligada na USB. O botão do sistema de Ordens de Produção manda um JSON com os dados da
etiqueta; o PC monta o comando (EPL por padrão, ou ZPL) e imprime na hora, sem janela de impressão. Fica exposto na internet por um
**Cloudflare Tunnel** (`cloudflared` no próprio PC), então toda requisição exige chave de API.

```
Sistema de OP ──HTTPS + X-Api-Key──► Cloudflare ──tunnel──► PC do encarregado :8003 ──EPL RAW──► Elgin L42-DT (USB)
```

## Linguagem da impressora (EPL ou ZPL)

A **Elgin L42-DT vem em PPLB/EPL**. Testado em campo (driver "4BARCODE 4B-2074B", envio RAW): em ZPL ela
aceita o pedido e solta as etiquetas, mas **em branco**; em EPL imprime texto, Code 128 e EAN-13.
Por isso o padrão é `LINGUAGEM=epl`. **Se um dia trocar por Zebra ou ativar o PPLZ na Elgin, use
`LINGUAGEM=zpl`.**

| Variável    | Padrão | Uso |
|-------------|--------|-----|
| `LINGUAGEM` | `epl`  | `epl` (`app/etiquetas_epl.py`) ou `zpl` (`app/etiquetas_zpl.py`); valor inválido impede o servidor de subir |
| `DENSIDADE` | `10`   | só EPL: escuridão da impressão, 0 a 15 (comando `D`) |
| `GAP_DOTS`  | `24`   | só EPL: espaço entre etiquetas em pontos (comando `Q`; 24 = 3 mm a 203 dpi) |

As duas linguagens geram o mesmo layout. No EPL a quebra do nome é feita pelo servidor (o EPL não quebra
linha sozinho), por palavras, até 4 linhas com reticências; o texto vai em Windows-1252 (`I8,A,055`), então
os acentos saem certos (`REMOVER_ACENTOS=true` continua valendo). O ZPL vai em UTF-8 (`^CI28`).

## Autenticação

Todas as rotas (inclusive `/status`) exigem a chave `CHAVE_API` do `.env`, enviada em
`X-Api-Key: <chave>` ou `Authorization: Bearer <chave>`. Sem header ou com chave errada → `401`.

- A chave é definida por quem instala, no `.env`. Vazia ou com menos de 32 caracteres, o servidor
  não sobe (o `iniciar.bat` mostra o erro).
- Se por algum motivo o servidor rodar sem chave, ele responde `503` em tudo — nunca fica aberto.
- Comparação em tempo constante; `/docs` e `/openapi.json` ficam desligados (ligue com `DOCS=true` só
  para teste local — o Swagger não passa pela chave).
- Trocar a chave: apague o valor de `CHAVE_API` (ou cole outra com 32+ caracteres), reinicie o
  `iniciar.bat` e atualize no sistema de OP.

Não consulta o Tiny nem o servidor da Norvia: tudo que vai na etiqueta vem no JSON.

## Limites, CORS e rede

- **Limite por minuto** (memória, por cliente): `LIMITE_REQUISICOES_MINUTO` (30) pedidos em
  `/etiquetas/*` e `LIMITE_COPIAS_MINUTO` (2000) etiquetas impressas. Cada pedido continua aceitando
  de **1 a 1000** cópias (regra da Produção); o teto por minuto precisa ser >= 1000. Passou: `429`
  com `Retry-After`. `0` desliga. Cliente = IP; pelo Cloudflare Tunnel (conexão do loopback), o IP real
  do header `CF-Connecting-IP`. Pedidos recusados pela chave não contam.
- **CORS**: `CORS_ORIGINS` (lista separada por vírgula). Vazio = `*`, aceitável porque toda rota exige
  a chave e não há cookie (sem `allow_credentials`). Com o hostname do sistema de OP definido, preencha.
- **Rede**: `HOST=0.0.0.0` (padrão) mantém o acesso direto do tablet pela rede local
  (`http://IP-DO-PC:8003`). Se só o Cloudflare Tunnel for usado, `HOST=127.0.0.1`. O
  `liberar_firewall.bat` libera a 8003 só no perfil **privado** e só para a **sub-rede local**.
- Erro ao imprimir volta com um id; o detalhe fica na janela do servidor.
- O `iniciar.bat` só roda `pip install` quando o `requirements.txt` muda (hash em `.venv\requirements.sha256`).

## API

### `POST /etiquetas/imprimir`

```json
{
  "sku": "HNYRPI11-3M-01",
  "descricao": "Rodapé Orion Autocolante com Friso para Difusor LED em Aluminio 70mm x 17mm - Norvia - Branco - 3m",
  "gtin": "7908737101294",
  "localizacao": "A1-RA-P2-N1-AP1 / CASA06",
  "op": "1234",
  "copias": 10
}
```

`copias` é sempre obrigatório: é exatamente a quantidade de etiquetas que sai.

| Campo         | Obrigatório | Na etiqueta                                                    |
|---------------|-------------|----------------------------------------------------------------|
| `sku`         | sim         | texto + código de barras Code 128 na base                      |
| `descricao`   | sim         | nome do produto, até 4 linhas                                  |
| `gtin`        | não         | EAN-13 (12 ou 13 dígitos, com dígito verificador correto)      |
| `localizacao` | não         | texto acima do SKU (`-` se vier vazio)                          |
| `op`          | não         | só aparece no log do PC                                        |
| `copias`      | sim         | quantidade de etiquetas a imprimir (1 a 1000)                  |

Respostas:

- `200` `{"sucesso": true, "impressora": "ELGIN L42DT", "sku": "...", "copias": 10, "op": "1234", "avisos": []}`
  — `avisos` lista o que saiu faltando (ex.: GTIN inválido → etiqueta sem EAN).
- `422` `{"sucesso": false, "erro": "JSON inválido — descricao: Field required"}`
- `503` `{"sucesso": false, "erro": "Impressora ... não encontrada neste PC. Impressoras instaladas: ..."}`
- `500` falha ao mandar para a impressora (mensagem com id; detalhe na janela do servidor); `401` chave ausente/errada;
  `503` também se o servidor estiver sem `CHAVE_API`; `429` limite por minuto (ver abaixo).

Exemplo no botão do sistema de OP (JavaScript no navegador do tablet):

```js
const r = await fetch("https://etiquetas.exemplo.com.br/etiquetas/imprimir", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Api-Key": CHAVE_API },
  body: JSON.stringify({ sku, descricao, gtin, localizacao, op, copias }),
});
const resultado = await r.json(); // resultado.sucesso / resultado.erro
```

### Outras rotas

- `POST /etiquetas/comandos` — mesmo JSON, devolve só o comando sem imprimir, **na `LINGUAGEM`
  configurada** (header `X-Linguagem`). Com `LINGUAGEM=zpl`, dá para conferir em labelary.com.
- `POST /etiquetas/zpl` — nome antigo da rota acima, mantido por compatibilidade: também devolve o
  comando na `LINGUAGEM` configurada (EPL por padrão, apesar do nome).
- `GET /status` — se o PC está no ar, qual impressora encontrou e a `linguagem` em uso.

**Atenção:** a chave vai no JavaScript do navegador do tablet, então quem abrir o sistema de OP consegue
vê-la. Se o sistema de OP tiver backend, prefira que **o backend** chame este serviço e guarde a chave.

## Instalação no PC do encarregado (Windows)

1. Instale o Python 3.10+ (python.org) marcando **Add Python to PATH**.
2. Instale o driver da Elgin L42-DT e confira o nome da impressora em *Configurações → Impressoras*.
3. Baixe o instalador na interface (Produção → Visão Geral → **Impressão de etiquetas**) e
   descompacte no PC. O zip é gerado por `python empacotar.py` — rode de novo após mudar `app/` ou os `.bat`.
4. Dê dois cliques em `iniciar.bat`. Na primeira vez ele prepara o ambiente, cria o `.env` e para
   com erro pedindo a chave: preencha `CHAVE_API` no `.env` (32+ caracteres) e rode de novo.
5. Instale o `cloudflared` como serviço do Windows e crie um *Public Hostname* no tunnel
   (Zero Trust → Networks → Tunnels) com Service `HTTP` → `localhost:8003`. O cloudflared só faz
   conexão de saída: não precisa abrir porta no roteador nem no firewall.
6. Para subir junto com o Windows: atalho do `iniciar.bat` em `shell:startup`.

`liberar_firewall.bat` só é necessário se o tablet for chamar direto pela rede local (`http://IP:8003`);
libera só o perfil privado e a sub-rede local.

Ajustes no `.env` (veja `.env.example`): `LINGUAGEM`/`DENSIDADE`/`GAP_DOTS` (ver acima), `IMPRESSORA` (nome exato, se não achar sozinho),
`REMOVER_ACENTOS=true` (se os acentos saírem errados), `CHAVE_API`, `SIMULACAO=true` (teste sem imprimir),
`DOCS=true` (Swagger, só para teste local).

## Desenvolvimento

```bash
uv run --with-requirements requirements-dev.txt pytest tests/ -v
SIMULACAO=true uv run --with-requirements requirements.txt python -m app.main
```
