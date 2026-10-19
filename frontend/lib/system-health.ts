// Contrato de GET /api/admin/system-health — espelho de backend/gateway/src/system-health.ts.

export type HealthState = 'ok' | 'warning' | 'error' | 'unknown';
export type HealthGroup = 'Infraestrutura' | 'Integrações' | 'Rotinas';

export interface HealthDetail {
  label: string;
  value: string;
  state?: HealthState;
}

export interface HealthCheckResult {
  id: string;
  title: string;
  group: HealthGroup;
  state: HealthState;
  message: string;
  details?: HealthDetail[];
  latencyMs: number;
  checkedAt: string;
  uptimePct: number | null;
  history: { at: string; state: HealthState }[];
}

export interface SystemHealthReport {
  generatedAt: string;
  overall: HealthState;
  historyHours: number;
  sampleIntervalMinutes: number;
  checks: HealthCheckResult[];
}

export const HEALTH_GROUPS: HealthGroup[] = ['Infraestrutura', 'Integrações', 'Rotinas'];

export const HEALTH_STATE_LABEL: Record<HealthState, string> = {
  ok: 'Operacional',
  warning: 'Atenção',
  error: 'Falha',
  unknown: 'Sem verificação',
};

export const OVERALL_MESSAGE: Record<HealthState, string> = {
  ok: 'Todos os serviços verificados estão operacionais.',
  warning: 'Há serviços que precisam de atenção.',
  error: 'Há serviços com falha.',
  unknown: 'Nenhum serviço pôde ser verificado.',
};

/**
 * Agrupa o histórico em `buckets` faixas iguais da janela, do mais antigo ao mais recente;
 * cada faixa fica com o pior estado das amostras dela (null = sem amostra).
 */
export function bucketHistory(
  history: { at: string; state: HealthState }[],
  hours: number,
  buckets: number,
  now: number,
): (HealthState | null)[] {
  const rank: Record<HealthState, number> = { unknown: 0, ok: 1, warning: 2, error: 3 };
  const start = now - hours * 3600_000;
  const size = (hours * 3600_000) / buckets;
  const out: (HealthState | null)[] = Array.from({ length: buckets }, () => null);
  for (const sample of history) {
    const t = Date.parse(sample.at);
    if (!Number.isFinite(t) || t < start || t > now) continue;
    const i = Math.min(buckets - 1, Math.floor((t - start) / size));
    const current = out[i];
    if (current === null || current === undefined || rank[sample.state] > rank[current]) out[i] = sample.state;
  }
  return out;
}

export function makeDemoSystemHealth(now = Date.now()): SystemHealthReport {
  const iso = (ms: number) => new Date(ms).toISOString();
  const history = (pattern: (i: number) => HealthState) =>
    Array.from({ length: 288 }, (_, i) => ({ at: iso(now - (287 - i) * 5 * 60_000), state: pattern(i) }));
  const base = { latencyMs: 40, checkedAt: iso(now) };
  const checks: HealthCheckResult[] = [
    {
      ...base,
      id: 'gateway',
      title: 'API Gateway',
      group: 'Infraestrutura',
      state: 'ok',
      message: 'No ar há 6d 4h.',
      details: [
        { label: 'Modo', value: 'Demonstração' },
        { label: 'Memória', value: '84,2 MB' },
        { label: 'Node.js', value: 'v22.13.0' },
      ],
      latencyMs: 1,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'mariadb',
      title: 'MariaDB',
      group: 'Infraestrutura',
      state: 'ok',
      message: 'Banco respondendo a consultas (3ms).',
      details: [
        { label: 'Latência de consulta', value: '3ms', state: 'ok' },
        { label: 'Bancos operacionais', value: 'financeiro, marketplace, producao', state: 'ok' },
      ],
      latencyMs: 3,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'circuit-breakers',
      title: 'Circuit Breakers (Resiliência)',
      group: 'Infraestrutura',
      state: 'ok',
      message: 'Todos os 4 circuitos de integração fechados (operacionais).',
      details: [
        { label: 'Circuito · sefaz', value: 'Fechado (operacional)', state: 'ok' },
        { label: 'Circuito · tiny', value: 'Fechado (operacional)', state: 'ok' },
        { label: 'Circuito · inter', value: 'Fechado (operacional)', state: 'ok' },
        { label: 'Circuito · marketplace', value: 'Fechado (operacional)', state: 'ok' },
      ],
      latencyMs: 1,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'automacao-nfe',
      title: 'Motor fiscal (automacao-nfe)',
      group: 'Infraestrutura',
      state: 'ok',
      message: 'Serviço de NF-e e Dashboard Financeiro no ar.',
      details: [
        { label: 'Versão', value: '1.4.0' },
        { label: 'Tiny configurado', value: 'Sim', state: 'ok' },
        { label: 'OCR', value: 'Ativo' },
      ],
      uptimePct: 99.3,
      history: history((i) => (i === 140 || i === 141 ? 'error' : 'ok')),
    },
    {
      ...base,
      id: 'automacao-marketplace',
      title: 'Motor de Marketplace (automacoes-marketplace)',
      group: 'Infraestrutura',
      state: 'ok',
      message: 'Serviço de Marketplace operacional.',
      details: [
        { label: 'Serviço', value: 'automacoes-marketplace' },
        { label: 'Status retornado', value: 'ok', state: 'ok' },
      ],
      latencyMs: 12,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'contagem-estoque',
      title: 'Contagem de Estoque (bot Telegram)',
      group: 'Infraestrutura',
      state: 'unknown',
      message: 'Sem verificação automática: o bot usa long polling e não expõe porta. Confira no servidor com docker compose ps contagem-estoque.',
      latencyMs: 0,
      uptimePct: null,
      history: history(() => 'unknown'),
    },
    {
      ...base,
      id: 'tiny',
      title: 'Tiny ERP',
      group: 'Integrações',
      state: 'ok',
      message: 'API v3 e integração fiscal operacional.',
      latencyMs: 212,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'inter',
      title: 'Banco Inter',
      group: 'Integrações',
      state: 'ok',
      message: 'Módulo DDA e conciliação bancária operacional.',
      latencyMs: 18,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'n8n',
      title: 'n8n (Contas a Pagar e tokens)',
      group: 'Integrações',
      state: 'ok',
      message: 'n8n API operacional e conectada com sucesso.',
      latencyMs: 95,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
    {
      ...base,
      id: 'sefaz',
      title: 'Varredura SEFAZ e certificados A1',
      group: 'Rotinas',
      state: 'warning',
      message: 'Certificado perto do vencimento ou CNPJ com erro na última varredura.',
      details: [
        { label: 'Última varredura', value: 'há 42min' },
        { label: 'Certificado · Norvia Acabamentos', value: 'Vence em 212 dia(s)', state: 'ok' },
        { label: 'Certificado · Fabrilux', value: 'Vence em 19 dia(s)', state: 'warning' },
      ],
      uptimePct: 100,
      history: history((i) => (i > 200 ? 'warning' : 'ok')),
    },
    {
      ...base,
      id: 'dashboard-financeiro',
      title: 'Sincronização do Dashboard Financeiro',
      group: 'Rotinas',
      state: 'warning',
      message: '1 empresa(s) com falha na última sincronização.',
      details: [
        { label: 'Última sincronização', value: 'há 6h 12min' },
        { label: 'Fabrilux', value: 'Sincronizada', state: 'ok' },
        { label: 'Revesta', value: 'Sincronizada', state: 'ok' },
        { label: 'Norvia Campinas', value: 'HTTP 403 em /caixa', state: 'warning' },
        { label: 'Norvia Curitiba', value: 'Sincronizada', state: 'ok' },
      ],
      uptimePct: 100,
      history: history(() => 'warning'),
    },
    {
      ...base,
      id: 'backup',
      title: 'Backup do MariaDB e caches',
      group: 'Rotinas',
      state: 'ok',
      message: 'Último backup concluído e conferido.',
      details: [
        { label: 'Último backup', value: 'há 9h 30min' },
        { label: 'Tamanho', value: '48,6 MB' },
        { label: 'Retenção', value: '14 dias' },
        { label: 'Cópia fora do servidor', value: 'Não configurada', state: 'warning' },
      ],
      latencyMs: 1,
      uptimePct: 100,
      history: history(() => 'ok'),
    },
  ];
  return {
    generatedAt: iso(now),
    overall: 'warning',
    historyHours: 24,
    sampleIntervalMinutes: 5,
    checks,
  };
}
