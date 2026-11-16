# Registros do ROI das automações

Fotografias da aba **ROI das automações** (`/admin/roi`) em momentos que mudam a forma de contar,
para comparar depois. Valores a R$ 11,00/h.

## 27/10/2026, 16:43 — antes de refazer a padronização de dimensões

Estado com a padronização ainda na versão que perdia o envio na coleta (correções `c9f1916`,
`1b80945` e `84622ef` entrando em seguida) e com os tempos do Tipo de frete antigos (2 min → 15 s).
Totais desde o início: **R$ 739,22 · 67,2 h**.

| Automação | Itens | À mão | Hoje | Horas | R$ |
|---|---:|---|---|---:|---:|
| Contas a Pagar (Inter × Tiny) | 159 | 5 min | 30 s | 11,93 | 131,18 |
| NF-e / DANFE | 69 | 3 min | 1 min | 2,30 | 25,30 |
| Conciliação Mercado Livre | 1 | 3 min | 30 s | 0,04 | 0,46 |
| Padronização de dimensões | 554 | 5 min | 5 s | 45,40 | 499,37 |
| Tipo de frete | 71 | 2 min | 15 s | 2,07 | 22,78 |
| Contagem de estoque | 1 | 4 min | 1 min | 0,05 | 0,55 |
| Etiquetas de produção (estimativa) | 65 | 5 min | 0 | 5,42 | 59,58 |
| **Total** | | | | **67,2** | **739,22** |

Tela da padronização no mesmo momento (última coleta 27/10/2026 16:07): a enviar ao ML 769
(2.030 anúncios), sem medida no Tiny 38, iguais ao Tiny 601, erro no envio 434.

A partir deste registro: padronização de dimensões 1 min à mão → 1 s por produto; Tipo de frete
1 min à mão → 0 s por anúncio.
