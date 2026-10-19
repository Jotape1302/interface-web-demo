# Contrato Analítico da Visão Geral — Norvia Automações

## 1. Objetivo e Escopo da Visão Geral

A tela de **Visão Geral** (`/api/overview` no gateway e rota `/` ou `/financeiro` no frontend) agrega a produtividade e a saúde operacional de todas as esteiras automatizadas ativas do grupo Norvia.

O contrato de dados transporta simultaneamente:
1. **Métricas de Negócio Acumuladas**: Volume consolidado de transações, horas poupadas e ROI financeiro estimado;
2. **Evolução Técnica em 14 Dias**: Série temporal de execuções (sucessos, falhas, durações médias) com granularidade diária;
3. **Diagnóstico dos Serviços de Apoio**: Conectividade e latência dos componentes de infraestrutura (MariaDB, n8n, automacao-nfe, marketplace);
4. **Feed de Ações Pendentes**: Lista priorizada de itens que demandam intervenção humana imediata (notas a revisar, fretes desfeitos, certificados a vencer).

---

## 2. Consolidação de Negócio e ROI

| Indicador Consolidado | Regra de Agregação | Interpretação |
|---|---|---|
| **Volume Total Concluído** | $\sum (\text{Baixas de Contas a Pagar} + \text{NF-es Lançadas} + \text{Anúncios Padronizados})$ | Itens operacionais processados e liquidados com sucesso |
| **Horas Totais Economizadas** | $\sum (\text{Horas Contas a Pagar} + \text{Horas NF-e} + \text{Horas Marketplace})$ | Tempo estimado de trabalho braçal poupado em todas as frentes |
| **ROI Financeiro Estimado** | $\text{Horas Totais Economizadas} \times \text{R\$\,11,00/h}$ | Retorno financeiro estimado gerado pelas automações |
| **Participação por Esteira** | $(\text{Volume da Esteira} / \text{Volume Total}) \times 100$ | Distribuição proporcional da carga de trabalho entre os setores |

---

## 3. Série Temporal e Saúde das Execuções (Janela de 14 Dias)

A série temporal das execuções atende às seguintes premissas matemáticas e de fuso horário:

1. **Janela de 14 Dias**:
   - Início: Meia-noite (00:00:00) no fuso `America/Sao_Paulo` (UTC−03) treze dias antes da data local atual;
   - Fim: Instante da consulta (data e hora corrente), capturando o dia atual parcial;
   - Total: Exatamente 14 colunas de calendário.

2. **Cálculo da Taxa de Saúde**:
   $$\text{Saúde (\%)} = \frac{\text{Sucessos}}{\text{Sucessos} + \text{Erros}} \times 100$$
   - Execuções em status `waiting`, `running` ou `unknown` ficam fora do denominador para não distorcer a taxa de conclusão;
   - Se em determinado dia ou período não houver execuções concluídas ($\text{Sucessos} + \text{Erros} = 0$), a taxa é expressa como `null` ("Sem base").

3. **Consolidação Multirrotina**:
   - Para calcular a saúde global do dia, primeiro somam-se todos os sucessos de todas as rotinas e todos os erros de todas as rotinas, aplicando a divisão sobre os totais agregados (nunca calculando média simples das taxas).

---

## 4. Diagnóstico de Infraestrutura e Serviços
 
 O payload da Visão Geral monitora os seguintes serviços fundamentais:
 
 | Serviço | Identificador | Critério de Conectividade |
 |---|---|---|
 | **MariaDB** | `mariadb` | Conexão TCP estabelecida, consulta de teste `SELECT 1` executada e medição de latência em milissegundos |
 | **n8n** | `n8n` | Resposta HTTP 200 via API REST oficial com `X-N8N-API-KEY` válida |
 | **Motor Fiscal/Financeiro** | `automacao-nfe` | Resposta HTTP 200 no endpoint `/health` da automacao-nfe (porta 8000) |
 | **Motor Marketplace** | `automacoes-marketplace` | Resposta HTTP 200 no endpoint `/health` de marketplace (porta 8001) |

No modo demonstrativo (`DATA_MODE=demo`), todos os serviços assumem o estado `status: demo`. No modo real (`DATA_MODE=live`), qualquer falha de conectividade ou timeout (padrão de 8s) é reportada com a mensagem de erro tratada, sem vazar credenciais ou detalhes sensíveis de infraestrutura.

Além da Visão Geral consolidada, o painel administrativo de **Saúde do Sistema** (`GET /api/admin/system-health`, tela `/admin/saude`) realiza amostragem a cada 5 minutos com retenção de 24 horas, adicionando:
- **Telemetria de Circuit Breakers** (`circuitBreakersCheck`): monitoramento em tempo real do estado de isolamento (`closed`, `open`, `half_open`) de cada upstream;
- **Descoberta Multi-Database**: verificação dos 3 esquemas MariaDB (`financeiro`, `marketplace`, `producao`);
- **Conectores e Rotinas**: status de certificados A1 (validade em dias), sincronização do Dashboard Financeiro, integridade de backups e bot de contagem de estoque.

