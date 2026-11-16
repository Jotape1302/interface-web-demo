// Período do filtro da aba "ROI das automações": atalhos, query de GET /api/roi e rótulos.
// Datas sempre AAAA-MM-DD no fuso de São Paulo.
import { getSaoPauloParts, toSaoPauloISODate } from './date-range-utils';

export interface RoiPeriodo {
  de: string | null;
  ate: string | null;
}
export type RoiPeriodoPreset = 'inicio' | 'mes' | 'mes-passado' | '30dias' | 'ano' | 'personalizado';
export interface RoiPeriodoEscolha {
  preset: RoiPeriodoPreset;
  de: string;
  ate: string;
}

export const ROI_PRESETS: { key: RoiPeriodoPreset; label: string }[] = [
  { key: 'inicio', label: 'Desde o início' },
  { key: 'mes', label: 'Este mês' },
  { key: 'mes-passado', label: 'Mês passado' },
  { key: '30dias', label: 'Últimos 30 dias' },
  { key: 'ano', label: 'Este ano' },
  { key: 'personalizado', label: 'Personalizado' },
];
export const ROI_ESCOLHA_PADRAO: RoiPeriodoEscolha = { preset: 'inicio', de: '', ate: '' };

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const ultimoDia = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const valida = (v: string) => ISO.test(v) && toSaoPauloISODate(new Date(`${v}T12:00:00-03:00`)) === v;

/** Período (de/até, inclusivos) de um atalho, calculado no calendário de São Paulo. */
export function roiPeriodoDoPreset(preset: RoiPeriodoPreset, now: Date = new Date()): RoiPeriodo {
  const sp = getSaoPauloParts(now);
  const hoje = iso(sp.year, sp.month, sp.day);
  switch (preset) {
    case 'mes':
      return { de: iso(sp.year, sp.month, 1), ate: hoje };
    case 'mes-passado': {
      const m = sp.month === 1 ? 12 : sp.month - 1;
      const y = sp.month === 1 ? sp.year - 1 : sp.year;
      return { de: iso(y, m, 1), ate: iso(y, m, ultimoDia(y, m)) };
    }
    case '30dias': {
      const d = new Date(Date.UTC(sp.year, sp.month - 1, sp.day) - 29 * 86400000);
      return { de: iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), ate: hoje };
    }
    case 'ano':
      return { de: iso(sp.year, 1, 1), ate: hoje };
    default:
      return { de: null, ate: null };
  }
}

/** Período efetivo de uma escolha; personalizado ignora datas inválidas e inverte se de > ate. */
export function roiPeriodoDaEscolha(escolha: RoiPeriodoEscolha, now: Date = new Date()): RoiPeriodo {
  if (escolha.preset !== 'personalizado') return roiPeriodoDoPreset(escolha.preset, now);
  let de = valida(escolha.de) ? escolha.de : null;
  let ate = valida(escolha.ate) ? escolha.ate : null;
  if (de && ate && de > ate) [de, ate] = [ate, de];
  return { de, ate };
}

/** Query string de GET /api/roi ('' sem período; com '?' quando houver). */
export function roiQuery(periodo?: Partial<RoiPeriodo> | null): string {
  const params = new URLSearchParams();
  if (periodo?.de) params.set('de', periodo.de);
  if (periodo?.ate) params.set('ate', periodo.ate);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const br = (v: string) => v.split('-').reverse().join('/');

/** "de 01/10/2026 a 27/10/2026", "desde o início" etc. */
export function roiPeriodoRotulo(periodo: RoiPeriodo): string {
  if (periodo.de && periodo.ate) return `de ${br(periodo.de)} a ${br(periodo.ate)}`;
  if (periodo.de) return `a partir de ${br(periodo.de)}`;
  if (periodo.ate) return `até ${br(periodo.ate)}`;
  return 'desde o início';
}

/** Sufixo do nome do CSV: "", "_2026-10-01_a_2026-10-27", "_desde-2026-10-01"... */
export function roiPeriodoSufixoArquivo(periodo: RoiPeriodo): string {
  if (periodo.de && periodo.ate) return `_${periodo.de}_a_${periodo.ate}`;
  if (periodo.de) return `_desde-${periodo.de}`;
  if (periodo.ate) return `_ate-${periodo.ate}`;
  return '';
}

const CHAVE = 'roi:periodo';
export function lerEscolhaSalva(): RoiPeriodoEscolha {
  try {
    const raw = sessionStorage.getItem(CHAVE);
    if (!raw) return ROI_ESCOLHA_PADRAO;
    const v = JSON.parse(raw) as Partial<RoiPeriodoEscolha>;
    if (!ROI_PRESETS.some((p) => p.key === v.preset)) return ROI_ESCOLHA_PADRAO;
    return { preset: v.preset as RoiPeriodoPreset, de: typeof v.de === 'string' ? v.de : '', ate: typeof v.ate === 'string' ? v.ate : '' };
  } catch {
    return ROI_ESCOLHA_PADRAO;
  }
}
export function salvarEscolha(escolha: RoiPeriodoEscolha): void {
  try {
    sessionStorage.setItem(CHAVE, JSON.stringify(escolha));
  } catch {
    // sem sessionStorage: a escolha só vale nesta tela.
  }
}
