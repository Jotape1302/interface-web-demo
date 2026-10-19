'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, History, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Badge } from '@/components/ui/badge';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select';
import { formatDateTimeBR } from '@/lib/formatters';
import { downloadCsv } from '@/lib/csv-export';
import {
  AUDIT_ACTION_LABELS,
  auditActionLabel,
  formatAuditDetails,
  makeDemoAuditEntries,
  type AuditEntry,
  type AuditGroup,
} from '@/lib/audit-actions';

const PAGE_SIZE = 100;
const GROUPS: AuditGroup[] = ['Acesso', 'Usuários', 'NF-e', 'Automações', 'Incidentes'];

// Log de auditoria: quem fez o quê na plataforma. Exclusivo do admin (o gateway também
// bloqueia /api/admin/audit para os demais).
export default function AuditLog() {
  const { token, apiBaseUrl, can } = useAuth();
  const canView = can('auditoria:ver');
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [acao, setAcao] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');

  // Busca só depois que a digitação para, para não disparar uma consulta por tecla.
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  const fetchPage = useCallback(
    async (before?: string): Promise<AuditEntry[] | null> => {
      if (isDemo) {
        const needle = query.toLowerCase();
        return makeDemoAuditEntries().filter(
          (e) =>
            (!acao || e.acao === acao) &&
            (!needle || `${e.usuarioNome} ${e.alvo ?? ''} ${formatAuditDetails(e.detalhes)}`.toLowerCase().includes(needle)) &&
            (!before || Number(e.id) < Number(before)),
        );
      }
      if (!token) return null;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (acao) params.set('acao', acao);
      if (query) params.set('q', query);
      if (before) params.set('before', before);
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/admin/audit?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AuditEntry[];
    },
    [acao, apiBaseUrl, isDemo, query, token],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const page = await fetchPage();
      if (page) {
        setEntries(page);
        setHasMore(!isDemo && page.length === PAGE_SIZE);
      }
    } catch {
      setError('Não foi possível carregar o log de auditoria.');
    } finally {
      setLoading(false);
    }
  }, [fetchPage, isDemo]);

  useEffect(() => {
    if (canView) void reload();
  }, [reload, canView]);

  const loadMore = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoading(true);
    try {
      const page = await fetchPage(last.id);
      if (page) {
        setEntries((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      }
    } catch {
      setError('Não foi possível carregar mais registros.');
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    downloadCsv(
      `auditoria-${new Date().toISOString().slice(0, 10)}`,
      ['Data/hora', 'Usuário', 'Ação', 'Alvo', 'Detalhes', 'Resultado', 'IP'],
      entries.map((e) => [
        formatDateTimeBR(e.criadoEm),
        e.usuarioNome,
        auditActionLabel(e.acao),
        e.alvo ?? '',
        formatAuditDetails(e.detalhes),
        e.sucesso ? 'Sucesso' : 'Falha',
        e.ip ?? '',
      ]),
    );
  };

  const actionsByGroup = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        actions: Object.entries(AUDIT_ACTION_LABELS).filter(([, v]) => v.group === group),
      })),
    [],
  );

  if (!canView) {
    return (
      <section role="alert" className="mx-auto max-w-xl py-16 text-center">
        <ShieldAlert size={28} className="mx-auto mb-3 text-muted-foreground" />
        <h1 className="text-lg font-bold text-foreground">Você não tem acesso a esta aba</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Peça ao administrador para liberar <strong className="text-foreground">Log de Auditoria</strong> em Gestão de Usuários.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Administração</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <History size={22} className="text-primary" />
            Log de Auditoria
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Quem fez o quê na plataforma: acessos, gestão de usuários, lançamentos e arquivamentos de NF-e, incidentes e
            disparos de automações. Senhas e conteúdo de notas não são registrados.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={exportCsv}
            disabled={entries.length === 0}
            className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-xl border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} />
            Exportar CSV
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Buscar por usuário, alvo ou detalhe</span>
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por usuário, alvo ou detalhe"
            className="h-8 w-full rounded-lg border border-input bg-transparent pl-8 pr-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </label>
        <NativeSelect value={acao} onChange={(e) => setAcao(e.target.value)} aria-label="Filtrar por ação" className="sm:w-72">
          <NativeSelectOption value="">Todas as ações</NativeSelectOption>
          {actionsByGroup.map(({ group, actions }) => (
            <NativeSelectOptGroup key={group} label={group}>
              {actions.map(([id, { label }]) => (
                <NativeSelectOption key={id} value={id}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          ))}
        </NativeSelect>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-500">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[760px] text-left text-xs text-foreground">
          <thead className="border-b border-border bg-muted/60 font-mono text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="p-3.5">Data/hora</th>
              <th className="p-3.5">Usuário</th>
              <th className="p-3.5">Ação</th>
              <th className="p-3.5">Alvo</th>
              <th className="p-3.5">Detalhes</th>
              <th className="p-3.5">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  {loading ? 'Carregando…' : 'Nenhum registro encontrado com esses filtros.'}
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap p-3.5 font-mono text-[11px] text-muted-foreground">
                    {formatDateTimeBR(e.criadoEm)}
                  </td>
                  <td className="p-3.5 font-medium">{e.usuarioNome}</td>
                  <td className="p-3.5">
                    <span className="flex items-center gap-2">
                      {auditActionLabel(e.acao)}
                      {!e.sucesso && (
                        <Badge variant="danger" className="text-[10px]">
                          Falha
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="max-w-56 break-words p-3.5">{e.alvo ?? '—'}</td>
                  <td className="max-w-72 break-words p-3.5 text-muted-foreground">{formatAuditDetails(e.detalhes) || '—'}</td>
                  <td className="whitespace-nowrap p-3.5 font-mono text-[11px] text-muted-foreground">{e.ip ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="cursor-pointer rounded-xl border border-border bg-muted/60 px-4 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            Carregar mais
          </button>
        </div>
      )}
    </div>
  );
}
