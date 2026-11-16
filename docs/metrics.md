# Contrato Analítico e Métricas de Produtividade — Norvia Automações

## 1. Princípios e Método

O sistema consolida a produtividade e a saúde operacional de todas as esteiras automatizadas da empresa. Para assegurar total transparência e precisão analítica:
1. **Registros de Negócio vs. Telemetria Técnica**: Uma execução técnica bem-sucedida (status `success` no n8n ou HTTP 200 no motor Python) não é confundida com uma transação financeira concluída. Transações só são contabilizadas mediante confirmação persistida em banco de dados (`conciliacao_baixas_historico`, `dimensoes_produtos`, notas processadas).
2. **Denominadores Explícitos**: Taxas percentuais exigem denominadores estritamente positivos. Caso a fila esteja vazia (0 registros), a taxa é representada como `null` ("Sem base"), nunca como `0%`.
3. **Fuso Horário Canônico**: Todas as janelas de cálculo diário e agrupamentos temporais utilizam o fuso de referência de Brasília (`America/Sao_Paulo`, UTC−03).

---

## 2. Métricas da Área Financeira

### 2.1. Conciliação Bancária & Baixas de Contas a Pagar
Calculadas sobre a tabela `conciliacao_baixas_historico` no MariaDB:

| Indicador | Regra / Fórmula | Unidade | Significado |
|---|---|---|---|
| **Total de Contas Baixadas** | `COUNT(*) WHERE status = 'sucesso'` | Registros | Quantidade de títulos liquidados com sucesso no Tiny ERP v3 após matching bancário no Inter |
| **Horas Economizadas (Baixas)** | `(total de baixas com sucesso × (5 − 0,5)) / 60` | Horas | 5 min por conta no processo manual menos 0,5 min que o usuário ainda gasta revisando a prévia e confirmando o lote (`backend/gateway/src/roi.ts`) |
| **Economia Financeira (Baixas)** | `horas economizadas × R$ 11,00` | BRL | Conversão da capacidade produtiva de trabalho poupada |
| **Falhas de Liquidação** | `COUNT(*) WHERE status = 'erro'` | Registros | Títulos rejeitados pelo ERP (ex.: saldo insuficiente, duplicidade de liquidação) |
| **Taxa de Sucesso na Baixa** | `(sucessos / total enviado) × 100` | % | Eficiência da esteira de conciliação |

### 2.2. Esteira Fiscal (NF-e & DANFE)
Calculadas sobre o pipeline de notas fiscais:

| Indicador | Regra / Fonte | Unidade | Significado |
|---|---|---|---|
| **Notas Processadas** | Arquivos em `./processed` ou status no banco | Documentos | NF-es capturadas na SEFAZ e lançadas em Contas a Pagar no Tiny |
| **Horas Economizadas (NF-e)** | `(notas lançadas com sucesso × (3 − 1)) / 60` | Horas | 3 min por nota no lançamento manual menos 1 min de revisão e confirmação no painel (`backend/gateway/src/roi.ts`) |
| **Economia Financeira (NF-e)** | `horas economizadas × R$ 11,00` | BRL | Retorno estimado sobre a esteira fiscal automatizada |
| **Pendências de Revisão** | Arquivos em `./pending_review` | Documentos | Notas que aguardam validação de duplicatas/categoria pelo operador |

---

### 2.3. ROI das automações (`GET /api/roi`, tela `/admin/roi`, permissão `roi:ver`)
Uma conta só, em `backend/gateway/src/roi.ts` (`ROI_TAREFAS`): economia por item = minutos manuais − minutos que o usuário ainda gasta na interface; horas × R$ 11,00. Sem `roi:ver`, o gateway remove `hoursSaved`/`estimatedSavings` de `/api/overview` e `/api/accounts-payable/dashboard`.

| Automação | Item contado (fonte) | Manual | Atual | Economia/item |
|---|---|---|---|---|
| Contas a Pagar | baixa com sucesso (`conciliacao_baixas_historico`) | 5 min | 0,5 min | 4,5 min |
| NF-e / DANFE | nota lançada com sucesso | 3 min | 1 min | 2 min |
| Conciliação ML | recebimento baixado (`auditoria_acoes`, `baixa_conciliacao_ml_executada`, soma de `sucessos`) | 3 min | 0,5 min | 2,5 min |
| Padronização de dimensões | produto padronizado (`/api/v1/dimensoes/status`) | 5 min | 1 min | 4 min |
| Fretes a combinar | anúncio trocado, status `ok` (`/api/v1/fretes/historico`; teto de 2000 trocas) | 2 min | 0,25 min | 1,75 min |
| Contagem de estoque | contagem lançada no Tiny (`contagem_estoque_tiny`, `lancado`) | 4 min | 1 min | 3 min |

Etiquetas de produção não entram: rodam no PC do encarregado e o servidor não vê as impressões.

---

## 3. Métricas da Área de Marketplace

Calculadas sobre a última coleta da Padronização (`/api/v1/dimensoes/status`) e o histórico de fretes:

| Indicador | Regra / Fonte | Unidade | Significado |
|---|---|---|---|
| **SKUs Padronizados** | `por_status.padronizado` | SKUs | Produtos cujos anúncios estão iguais ao Tiny da mesma empresa (ficha e embalagem com o peso bruto) |
| **Sem medida no Tiny** | `por_status.sem_medida` | SKUs | SKU sem lado ou peso bruto no Tiny (ou fora dele): não vai ao ML nem ao Tipo de frete |
| **Fretes Convertidos** | Anúncios migrados de "a combinar" para ME1 ou ME2 | Anúncios | Anúncios que passaram a usufruir da logística oficial do Mercado Envios |
| **Anúncios a enviar** | `anuncios_a_enviar` | Anúncios | Ficha ou embalagem do ML diferente do Tiny, esperando confirmação |
| **Tipo de frete corrigido** | `resumo.corrigidos` da varredura | Anúncios | Anúncios em ME1/ME2 trocados pela embalagem (1 m/2 m ME2, 3 m ME1) |

---

## 4. Métricas da Logística e Produção

- **Contagem de Estoque**: Volume de pacotes identificados por detecção visual de prendedores verdes (OpenCV) via bot Telegram.
- **Etiquetas de Produção**: Total de ordens de produção impressas na fábrica via servidor térmico local (**Elgin L42-DT** / **Zebra**).

---

## 5. Regras de Apresentação e Tipagem

1. **Valores Monetários**: Transportados como strings decimais exatas (`"1234.56"`), sem perda de precisão em ponto flutuante.
2. **Formatação Regional**: Sempre exibidos com separador de milhar por ponto e decimais por vírgula (`R$ 1.234,56`).
3. **Datas**: Formato estrito `YYYY-MM-DD` para datas de vencimento; ISO 8601 em UTC para instantes de execução e auditoria, convertidos para `America/Sao_Paulo` na exibição da interface.
