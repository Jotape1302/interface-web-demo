'use client';

import {
  Camera, FileImage, 
  MessageSquare, PackageSearch, 
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';


import {
  
  
  type StockCountItem,
  type StockCountStatus,
} from '@/lib/stock-count-contracts';
import type { ColumnFilterDef } from '@/lib/column-filters';

export const PAGINA_API = 100;

export const SITUACAO_ROTULOS: Record<StockCountStatus, string> = {
  aguardando_confirmacao: 'Aguardando Confirmação',
  confirmada: 'Confirmada',
  corrigida: 'Corrigida',
};

export const ABAS_STATUS: Array<{ situacao: string | null; rotulo: string }> = [
  { situacao: null, rotulo: 'Todas' },
  { situacao: SITUACAO_ROTULOS.aguardando_confirmacao, rotulo: 'Aguardando conferência' },
  { situacao: SITUACAO_ROTULOS.confirmada, rotulo: 'Confirmadas' },
  { situacao: SITUACAO_ROTULOS.corrigida, rotulo: 'Corrigidas' },
];

export const STOCK_COUNT_DEFS: Record<string, ColumnFilterDef<StockCountItem>> = {
  sku: {
    id: 'sku',
    label: 'SKU / Código',
    tipo: 'texto',
    accessor: (i) => `${i.codigo || ''} ${i.sku_manual?.sku || ''}`,
  },
  situacao: {
    id: 'situacao',
    label: 'Situação',
    tipo: 'lista',
    accessor: (i) => SITUACAO_ROTULOS[i.status] ?? i.status,
    opcoes: Object.values(SITUACAO_ROTULOS),
  },
  data: {
    id: 'data',
    label: 'Data',
    tipo: 'data',
    accessor: (i) => i.criado_em,
  },
  quantidade: {
    id: 'quantidade',
    label: 'Fardos',
    tipo: 'numero',
    accessor: (i) => i.quantidade_final ?? i.quantidade_detectada,
  },
  usuario_origem: {
    id: 'usuario_origem',
    label: 'Usuário / Origem',
    tipo: 'texto',
    accessor: (i) => `${i.conferencia?.usuario_nome || ''} ${i.telegram_user || ''} ${i.telegram_chat_id || ''}`,
  },
};

export const BOT_USERNAME = process.env.NEXT_PUBLIC_STOCK_BOT_USERNAME?.replace(/^@/, '').trim() || '';

export const STEPS = [
  {
    icon: MessageSquare,
    title: 'Abra o bot no Telegram',
    text: 'Procure o bot da contagem de estoque e envie /start na primeira vez.',
  },
  {
    icon: Camera,
    title: 'Fotografe a prateleira',
    text: 'Cada pacote tem um prendedor verde. Enquadre a prateleira inteira, com todos os prendedores e a etiqueta de código de barras da prateleira à vista.',
  },
  {
    icon: FileImage,
    title: 'Envie como arquivo, com o SKU',
    text: 'Use clipe → Arquivo e escreva o SKU do produto na legenda. Como “foto”, o Telegram comprime a imagem e prendedores ou o código de barras podem não ser lidos.',
  },
  {
    icon: PackageSearch,
    title: 'Confirme ou corrija',
    text: 'O bot devolve a foto com cada prendedor numerado (em amarelo os que pedem conferência) e a envia para esta tela. A quantidade é confirmada ou corrigida aqui no painel: só a contagem conferida vale.',
  },
] as const;

export const PHOTO_TIPS = [
  'Boa iluminação, sem sombra forte sobre os prendedores.',
  'Distância em que todos os prendedores fiquem nítidos.',
  'Foto sem tremer e com foco na prateleira.',
  'Nenhum prendedor escondido atrás de caixas ou etiquetas.',
];

export function statusBadge(status: StockCountStatus) {
  switch (status) {
    case 'confirmada':
      return <Badge variant="success" className="text-[10px] rounded-none">Confirmada</Badge>;
    case 'corrigida':
      return <Badge variant="info" className="text-[10px] rounded-none">Corrigida</Badge>;
    case 'aguardando_confirmacao':
      return <Badge variant="warning" className="text-[10px] rounded-none">Aguardando Confirmação</Badge>;
    default:
      return <Badge variant="secondary" className="text-[10px] rounded-none">{status}</Badge>;
  }
}

export function formatDataBR(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return iso;
  }
}

export function skuDoItem(item: StockCountItem): string {
  return item.codigo || item.sku_manual?.sku || '';
}

/** Número da contagem como vai ao Tiny ("lançamento 000001"); sem número (bot ainda não numerou), o id do registro. */
export const numeroContagem = (item: StockCountItem) => (item.numero ? String(item.numero).padStart(6, '0') : item.id);

export const NOME_COR: Record<'verde' | 'rosa', string> = { verde: 'verde', rosa: 'rosa choque' };
export const COR_BOLINHA: Record<'verde' | 'rosa', string> = { verde: 'bg-green-500', rosa: 'bg-pink-500' };

export const fmtUn = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** Inteiro >= mínimo digitado num campo; null se vazio ou inválido. */
export function inteiroCampo(valor: string, minimo: number): number | null {
  const n = Number(valor);
  return valor.trim() !== '' && Number.isInteger(n) && n >= minimo ? n : null;
}

// Conferência da quantidade: só no painel (o bot não pergunta mais nada no Telegram). Cada
// marcador é um fardo; o total em unidades (fardos × unidades por fardo + soltas) vai ao Tiny,

export const POR_PAGINA = 12;
