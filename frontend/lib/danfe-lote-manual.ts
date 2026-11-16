// Lote manual de DANFE/NFC-e enviado um arquivo por requisição (12/11/2026): o motor processa cada
// arquivo em sequência (OCR/código de barras + consulta fiscal) e 7 PDFs numa requisição só
// passavam dos 60 s do proxy (HTTP 504 com o motor ainda trabalhando). Aqui só a soma dos
// resultados e o item de erro de um arquivo que não voltou — o envio fica no painel.
import type { DanfeBatchResponse, DanfeItemResult } from './contracts';

export function itemDeErroDoEnvio(filename: string, mensagem: string, agora: Date = new Date()): DanfeItemResult {
  return {
    filename,
    status: 'error',
    step: 'upload',
    key: null,
    scan_method: null,
    page_number: null,
    nfe_data: null,
    tiny_results: [],
    error_message: mensagem,
    processed_at: agora.toISOString(),
  };
}

/** Junta as respostas de cada arquivo num resultado só (total em centavos, sem erro de ponto flutuante). */
export function juntarLotes(partes: DanfeBatchResponse[]): DanfeBatchResponse {
  const items = partes.flatMap((p) => p.items);
  const centavos = partes.reduce((s, p) => s + Math.round((p.total_amount || 0) * 100), 0);
  return {
    total: items.length,
    success_count: items.filter((i) => i.status === 'success').length,
    failed_count: items.filter((i) => i.status === 'error').length,
    total_amount: centavos / 100,
    items,
  };
}
