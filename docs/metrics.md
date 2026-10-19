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
| **Horas Economizadas (Baixas)** | `(total de baixas com sucesso × 5) / 60` | Horas | Estimativa conservadora de 5 minutos economizados por fatura conciliada e baixada |
| **Economia Financeira (Baixas)** | `horas economizadas × R$ 11,00` | BRL | Conversão da capacidade produtiva de trabalho poupada |
| **Falhas de Liquidação** | `COUNT(*) WHERE status = 'erro'` | Registros | Títulos rejeitados pelo ERP (ex.: saldo insuficiente, duplicidade de liquidação) |
| **Taxa de Sucesso na Baixa** | `(sucessos / total enviado) × 100` | % | Eficiência da esteira de conciliação |

### 2.2. Esteira Fiscal (NF-e & DANFE)
Calculadas sobre o pipeline de notas fiscais:

| Indicador | Regra / Fonte | Unidade | Significado |
|---|---|---|---|
| **Notas Processadas** | Arquivos em `./processed` ou status no banco | Documentos | NF-es capturadas na SEFAZ e lançadas em Contas a Pagar no Tiny |
| **Horas Economizadas (NF-e)** | `(notas processadas × 8) / 60` | Horas | Estimativa de 8 minutos para digitação manual de itens e parcelas de NF-e |
| **Economia Financeira (NF-e)** | `horas economizadas × R$ 11,00` | BRL | Retorno estimado sobre a esteira fiscal automatizada |
| **Pendências de Revisão** | Arquivos em `./pending_review` | Documentos | Notas que aguardam validação de duplicatas/categoria pelo operador |

---

## 3. Métricas da Área de Marketplace

Calculadas sobre o catálogo e as tabelas `dimensoes_produtos` (banco `marketplace`):

| Indicador | Regra / Fonte | Unidade | Significado |
|---|---|---|---|
| **SKUs Padronizados** | `COUNT(*) FROM dimensoes_produtos` | SKUs | Produtos com medidas validadas (comprimento, largura, altura e peso) |
| **Confiabilidade das Medidas** | `ALTA`, `MEDIA`, `BAIXA` | Categoria | Grau de convergência entre as medidas cadastradas no Tiny e no Mercado Livre |
| **Fretes Convertidos** | Anúncios migrados de "a combinar" para ME1 ou ME2 | Anúncios | Anúncios que passaram a usufruir da logística oficial do Mercado Envios |
| **Divergências Pós-Padrão** | Fichas técnicas alteradas após homologação | Alertas | Anúncios cuja ficha no ML divergiu do padrão gravado no banco |

---

## 4. Métricas da Logística e Produção

- **Contagem de Estoque**: Volume de pacotes identificados por detecção visual de prendedores verdes (OpenCV) via bot Telegram.
- **Etiquetas de Produção**: Total de ordens de produção impressas na fábrica via servidor térmico local (**Elgin L42-DT** / **Zebra**).

---

## 5. Regras de Apresentação e Tipagem

1. **Valores Monetários**: Transportados como strings decimais exatas (`"1234.56"`), sem perda de precisão em ponto flutuante.
2. **Formatação Regional**: Sempre exibidos com separador de milhar por ponto e decimais por vírgula (`R$ 1.234,56`).
3. **Datas**: Formato estrito `YYYY-MM-DD` para datas de vencimento; ISO 8601 em UTC para instantes de execução e auditoria, convertidos para `America/Sao_Paulo` na exibição da interface.
