'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  Workflow,
  Play,
  RefreshCw,
  Clock,
  KeyRound,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
  Database,
  ExternalLink,
  ShieldCheck,
  GitBranch,
  Timer,
  Info,
  Layers,
  ChevronRight,
  Edit3,
  SlidersHorizontal,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTimeBR } from '@/lib/formatters';
import { TinyLogo, MariaDbLogo, N8nLogo } from '@/components/ui/brand-logos';
import { apiErrorMessage } from '@/lib/api-errors';
import { isValidWorkflowId } from '@/lib/token-workflow';

export interface TokenExecution {
  id: string;
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
  status: 'success' | 'error' | 'running';
  stoppedNode: string;
  tokensProcessed: number;
  message: string;
  details?: {
    accountsChecked: string[];
    renewedAccounts?: string[];
    errorDetail?: string;
  };
}

const WORKFLOW_NODES = [
  { id: 'trigger', name: 'Schedule Trigger', type: 'cron', icon: Clock, desc: 'A cada 1 hora' },
  { id: 'definir', name: 'DEFINIR_CONTAS', type: 'code', icon: Layers, desc: 'Mapeamento filiais' },
  { id: 'buscar', name: 'BUSCAR_TOKENS_PARA_RENOVAR', type: 'db', icon: Database, desc: 'MariaDB executeQuery' },
  { id: 'condicao', name: 'PRECISA_RENOVAR?', type: 'if', icon: GitBranch, desc: 'Validade < 4h' },
  { id: 'refresh', name: 'REFRESH_TOKEN_TINY', type: 'http', icon: KeyRound, desc: 'POST accounts.tiny.com.br' },
  { id: 'salvar', name: 'SALVAR_NOVO_TOKEN', type: 'db', icon: Database, desc: 'MariaDB executeQuery' },
];

export const DEMO_TOKEN_EXECUTIONS: TokenExecution[] = [
  {
    id: 'TOKEN-4105',
    startedAt: '2026-09-14T14:00:00Z',
    stoppedAt: '2026-09-14T14:00:01.420Z',
    durationMs: 1420,
    status: 'success',
    stoppedNode: 'SALVAR_NOVO_TOKEN',
    tokensProcessed: 2,
    message: 'Tokens renovados com sucesso e gravados no MariaDB (api_tokens).',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
      renewedAccounts: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02'],
    },
  },
  {
    id: 'TOKEN-4104',
    startedAt: '2026-09-14T13:00:00Z',
    stoppedAt: '2026-09-14T13:00:00.610Z',
    durationMs: 610,
    status: 'success',
    stoppedNode: 'PRECISA_RENOVAR?',
    tokensProcessed: 0,
    message: 'Nenhum token com expiração iminente (< 4h). Ciclo concluído sem necessidade de renovação.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
      renewedAccounts: [],
    },
  },
  {
    id: 'TOKEN-4103',
    startedAt: '2026-09-14T12:00:00Z',
    stoppedAt: '2026-09-14T12:00:01.150Z',
    durationMs: 1150,
    status: 'success',
    stoppedNode: 'SALVAR_NOVO_TOKEN',
    tokensProcessed: 1,
    message: 'Token da filial renovado com sucesso e persistido no banco.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
      renewedAccounts: ['NORVIA-DISTRIB-03'],
    },
  },
  {
    id: 'TOKEN-4102',
    startedAt: '2026-09-14T11:00:00Z',
    stoppedAt: '2026-09-14T11:00:02.300Z',
    durationMs: 2300,
    status: 'error',
    stoppedNode: 'REFRESH_TOKEN_TINY',
    tokensProcessed: 0,
    message: 'Erro HTTP 401 no nó REFRESH_TOKEN_TINY: refresh_token inválido ou expirado.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
      errorDetail: 'Tiny OAuth retornou status 401 Unauthorized para a conta NORVIA-MATRIZ-01.',
    },
  },
  {
    id: 'TOKEN-4101',
    startedAt: '2026-09-14T10:00:00Z',
    stoppedAt: '2026-09-14T10:00:00.580Z',
    durationMs: 580,
    status: 'success',
    stoppedNode: 'PRECISA_RENOVAR?',
    tokensProcessed: 0,
    message: 'Tokens válidos. Nenhuma ação requerida no ciclo.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
      renewedAccounts: [],
    },
  },
  {
    id: 'TOKEN-4100',
    startedAt: '2026-09-14T09:00:00Z',
    stoppedAt: '2026-09-14T09:00:01.380Z',
    durationMs: 1380,
    status: 'success',
    stoppedNode: 'SALVAR_NOVO_TOKEN',
    tokensProcessed: 2,
    message: 'Tokens renovados com sucesso e gravados no MariaDB.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
      renewedAccounts: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02'],
    },
  },
  {
    id: 'TOKEN-4099',
    startedAt: '2026-09-13T20:00:00Z',
    stoppedAt: '2026-09-13T20:00:01.200Z',
    durationMs: 1200,
    status: 'success',
    stoppedNode: 'SALVAR_NOVO_TOKEN',
    tokensProcessed: 1,
    message: 'Rotação noturna de credenciais efetuada.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02'],
      renewedAccounts: ['NORVIA-MATRIZ-01'],
    },
  },
  {
    id: 'TOKEN-4098',
    startedAt: '2026-09-12T15:00:00Z',
    stoppedAt: '2026-09-12T15:00:01.100Z',
    durationMs: 1100,
    status: 'success',
    stoppedNode: 'SALVAR_NOVO_TOKEN',
    tokensProcessed: 1,
    message: 'Token de integração do ERP rotacionado.',
    details: {
      accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02'],
      renewedAccounts: ['NORVIA-FILIAL-02'],
    },
  },
];

const DEFAULT_WORKFLOW_ID = '8AtrRCYPsIyFv6s6';
const STORAGE_KEY = 'norvia_token_workflow_id';

export default function TokenAutomationPanel() {
  const { token, apiBaseUrl, can } = useAuth();
  const canRun = can('tokens_n8n:executar');

  const [workflowId, setWorkflowId] = useState<string>(DEFAULT_WORKFLOW_ID);
  const [inputWorkflowId, setInputWorkflowId] = useState<string>(DEFAULT_WORKFLOW_ID);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);

  const [executions, setExecutions] = useState<TokenExecution[]>(DEMO_TOKEN_EXECUTIONS);
  const [filter, setFilter] = useState<'all' | 'success' | 'error'>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<TokenExecution | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';

  // Carrega ID customizado salvo no localStorage pelo administrador
  useEffect(() => {
    if (typeof window !== 'undefined') {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(STORAGE_KEY);
      } catch {
        saved = null;
      }
      if (saved && saved.trim()) {
        const trimmed = saved.trim();
        const cleaned = trimmed === '8AtrRCYPslyFv6s6' ? DEFAULT_WORKFLOW_ID : trimmed;
        if (!isValidWorkflowId(cleaned)) {
          // Valor adulterado/antigo: descarta e volta ao padrão.
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // sem localStorage: segue com o padrão em memória
          }
          return;
        }
        setWorkflowId(cleaned);
        setInputWorkflowId(cleaned);
        if (trimmed === '8AtrRCYPslyFv6s6') {
          try {
            localStorage.setItem(STORAGE_KEY, DEFAULT_WORKFLOW_ID);
          } catch {
            // ignora
          }
        }
      }
    }
  }, []);

  const fetchExecutions = useCallback(
    async (targetWfId = workflowId) => {
      setIsLoading(true);
      try {
        if (isDemo) {
          setExecutions(DEMO_TOKEN_EXECUTIONS);
          return;
        }
        const params = new URLSearchParams();
        if (targetWfId && isValidWorkflowId(targetWfId)) params.set('workflowId', targetWfId);
        const query = params.toString() ? `?${params.toString()}` : '';
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/admin/token-automation${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = (await res.json()) as { executions?: TokenExecution[] };
          if (Array.isArray(data?.executions)) {
            setExecutions(data.executions);
          }
        }
      } catch {
        // Mantém execuções atuais
      } finally {
        setIsLoading(false);
      }
    },
    [apiBaseUrl, isDemo, token, workflowId]
  );

  useEffect(() => {
    void fetchExecutions();
  }, [fetchExecutions]);

  const handleRunNow = async () => {
    setIsExecuting(true);
    setActionMessage(null);

    // Animação passo a passo dos nós
    for (let step = 0; step < WORKFLOW_NODES.length; step++) {
      setActiveStep(step);
      await new Promise((r) => setTimeout(r, 350));
    }
    setActiveStep(null);

    try {
      if (!isDemo) {
        if (!token) throw new Error('Sessão não encontrada. Entre novamente para disparar o workflow.');
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/admin/token-automation/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ workflowId }),
        });
        // Em live, falha do n8n volta 502/503 com { success: false, error }.
        const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string } | null;
        if (!res.ok || body?.success === false) {
          throw new Error(apiErrorMessage(body, res.status, 'Falha ao disparar workflow no n8n'));
        }
        // Execução real: o histórico vem do n8n (sem execução fictícia na lista).
        setActionMessage({
          type: 'success',
          text: body?.message || `Workflow "${workflowId}" disparado no n8n. Atualizando o histórico...`,
        });
        setTimeout(() => {
          void fetchExecutions(workflowId);
        }, 1500);
        return;
      }

      // Modo demonstração: adiciona uma execução simulada ao topo
      const newExec: TokenExecution = {
        id: `TOKEN-${Math.floor(4106 + Math.random() * 50)}`,
        startedAt: new Date().toISOString(),
        stoppedAt: new Date(Date.now() + 1250).toISOString(),
        durationMs: 1250,
        status: 'success',
        stoppedNode: 'SALVAR_NOVO_TOKEN',
        tokensProcessed: 1,
        message: `Disparo manual do workflow ${workflowId} concluído: tokens verificados e sincronizados no MariaDB.`,
        details: {
          accountsChecked: ['NORVIA-MATRIZ-01', 'NORVIA-FILIAL-02', 'NORVIA-DISTRIB-03'],
          renewedAccounts: ['NORVIA-MATRIZ-01'],
        },
      };

      setExecutions((prev) => [newExec, ...prev]);
      setActionMessage({
        type: 'success',
        text: `Workflow "${workflowId}" executado com sucesso! Tokens verificados e banco atualizado.`,
      });
    } catch (err: any) {
      setActionMessage({
        type: 'error',
        text: err?.message || 'Erro ao executar rotina de renovação.',
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleSaveWorkflowId = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputWorkflowId.trim() || DEFAULT_WORKFLOW_ID;
    if (!isValidWorkflowId(trimmed)) {
      setActionMessage({
        type: 'error',
        text: 'ID de workflow inválido: use só letras e números (até 32 caracteres).',
      });
      return;
    }
    setWorkflowId(trimmed);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, trimmed);
      } catch {
        // sem localStorage: vale só nesta sessão
      }
    }
    setIsConfigModalOpen(false);
    setActionMessage({
      type: 'success',
      text: `ID do workflow atualizado para "${trimmed}". Sincronizando execuções do n8n...`,
    });
    void fetchExecutions(trimmed);
  };

  const handleResetWorkflowId = () => {
    setInputWorkflowId(DEFAULT_WORKFLOW_ID);
    setWorkflowId(DEFAULT_WORKFLOW_ID);
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignora
      }
    }
    setIsConfigModalOpen(false);
    setActionMessage({
      type: 'success',
      text: `ID do workflow restaurado para o padrão "${DEFAULT_WORKFLOW_ID}".`,
    });
    void fetchExecutions(DEFAULT_WORKFLOW_ID);
  };

  const filtered = useMemo(
    () => executions.filter((exec) => filter === 'all' || exec.status === filter),
    [executions, filter],
  );

  const { totalSuccess, totalErrors, successRate } = useMemo(() => {
    const success = executions.filter((e) => e.status === 'success').length;
    const errors = executions.filter((e) => e.status === 'error').length;
    const rate = executions.length > 0 ? ((success / executions.length) * 100).toFixed(1) : '100';
    return { totalSuccess: success, totalErrors: errors, successRate: rate };
  }, [executions]);

  if (!can('tokens_n8n:ver')) {
    return (
      <section role="alert" className="mx-auto max-w-xl py-16 text-center">
        <h1 className="text-lg font-bold text-foreground">Você não tem acesso a esta aba</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Peça ao administrador para liberar <strong className="text-foreground">Tokens n8n</strong> em Gestão de Usuários.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header do Workflow com Badges */}
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="success" className="text-[11px] font-semibold">
                <span className="inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                Ativo no n8n
              </Badge>
              <span className="text-xs font-mono text-muted-foreground">·</span>

              {/* Badge clicável com botão de edição de ID */}
              <button
                type="button"
                onClick={() => {
                  setInputWorkflowId(workflowId);
                  setIsConfigModalOpen(true);
                }}
                className="group inline-flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded-md bg-muted/60 hover:bg-muted border border-border hover:border-ring/60 text-foreground transition cursor-pointer"
                title="Clique para alterar ou conectar o ID do workflow no n8n"
              >
                <SlidersHorizontal size={11} className="text-muted-foreground group-hover:text-primary transition" />
                <span>ID: <strong className="text-foreground font-semibold">{workflowId}</strong></span>
                <Edit3 size={11} className="text-muted-foreground group-hover:text-foreground transition ml-0.5" />
              </button>

              <span className="text-xs font-mono text-muted-foreground">·</span>
              <span className="text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded border border-border flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
                  <MariaDbLogo size={12} />
                </span>
                <span>OAuth v3 & MariaDB</span>
              </span>
            </div>
            <h3 className="text-lg font-bold text-foreground tracking-tight flex items-center gap-2">
              <KeyRound size={20} className="text-primary" />
              ATUALIZACAO_REFRESH_TOKEN
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-3xl">
              Automação central de infraestrutura no n8n. Monitora a validade dos tokens OAuth v3 do Tiny ERP gravados na tabela <code className="text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">api_tokens</code> e executa rotação automática antes da expiração.
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <Button
              type="button"
              onClick={() => {
                setInputWorkflowId(workflowId);
                setIsConfigModalOpen(true);
              }}
              variant="outline"
              className="h-9 px-3 text-xs font-medium border-border hover:bg-muted text-foreground flex items-center gap-1.5 cursor-pointer"
            >
              <SlidersHorizontal size={13} className="text-muted-foreground" />
              <span>Conectar ID</span>
            </Button>

            <Button
              type="button"
              onClick={() => void fetchExecutions()}
              disabled={isLoading || isExecuting}
              variant="outline"
              className="h-9 px-3 text-xs font-medium border-border hover:bg-muted text-foreground flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              <span>Atualizar</span>
            </Button>

            {canRun && (
              <Button
                type="button"
                variant="cta"
                onClick={() => void handleRunNow()}
                disabled={isExecuting}
                className="h-9 px-4 text-xs flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <Play size={13} className={isExecuting ? 'animate-pulse' : ''} />
                <span>{isExecuting ? 'Executando nós...' : 'Executar Renovação Agora'}</span>
              </Button>
            )}
          </div>
        </div>

        {/* Feedback de Ação */}
        {actionMessage && (
          <div
            className={`mt-4 p-3 rounded-lg text-xs font-medium flex items-center gap-2 animate-in slide-in-from-top-1 ${
              actionMessage.type === 'success'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
            }`}
          >
            {actionMessage.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <span>{actionMessage.text}</span>
          </div>
        )}

        {/* Diagrama Visual dos Nós do Workflow (conforme n8n) */}
        <div className="mt-5 pt-4 border-t border-border/60">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Workflow size={13} className="text-primary" />
              Pipeline de Execução dos Nós (n8n Flow)
            </span>
            <a
              href={`https://servidor.norvia.example/n8n/workflow/${encodeURIComponent(workflowId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground hover:text-primary font-mono flex items-center gap-1 transition"
              title="Abrir este fluxo diretamente no editor do n8n"
            >
              <span>servidor.norvia.example/n8n/workflow/{workflowId}</span>
              <ExternalLink size={11} />
            </a>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {WORKFLOW_NODES.map((node, index) => {
              const Icon = node.icon;
              const isActive = activeStep === index;
              return (
                <div
                  key={node.id}
                  className={`relative p-3 rounded-xl border transition flex flex-col justify-between text-left ${
                    isActive
                      ? 'border-[var(--marca-ambar)] bg-[var(--marca-ambar-suave)] ring-2 ring-[var(--marca-ambar)]/40'
                      : 'border-border bg-muted/30 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white border border-border/80 text-foreground overflow-hidden p-1 shadow-2xs">
                      {node.id === 'refresh' ? (
                        <TinyLogo size={18} />
                      ) : node.id === 'buscar' || node.id === 'salvar' ? (
                        <MariaDbLogo size={18} />
                      ) : node.id === 'trigger' ? (
                        <N8nLogo size={18} />
                      ) : (
                        <Icon size={14} className={isActive ? 'text-[var(--accent-text)] animate-spin' : ''} />
                      )}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">#{index + 1}</span>
                  </div>
                  <div>
                    <strong className="block text-xs font-bold text-foreground leading-tight truncate">
                      {node.name}
                    </strong>
                    <span className="block text-[10px] text-muted-foreground mt-0.5">{node.desc}</span>
                  </div>
                  {index < WORKFLOW_NODES.length - 1 && (
                    <ChevronRight
                      size={14}
                      className="hidden md:block absolute -right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground z-10"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Cards de Métricas Operacionais */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Clock size={13} className="text-primary" />
            Frequência de Checagem
          </span>
          <strong className="block text-xl font-semibold text-foreground mt-1.5">A cada 1 hora</strong>
          <span className="text-[11px] text-muted-foreground mt-0.5 block">Disparo automático via cron</span>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck size={13} className="text-primary" />
            Taxa de Assertividade
          </span>
          <strong className="block text-xl font-semibold text-emerald-700 dark:text-emerald-400 mt-1.5">
            {successRate}%
          </strong>
          <span className="text-[11px] text-muted-foreground mt-0.5 block">
            {totalSuccess} sucessos vs {totalErrors} falhas
          </span>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
              <MariaDbLogo size={12} />
            </span>
            <span>Tabela de Destino</span>
          </span>
          <strong className="block text-base font-bold font-mono text-foreground mt-1.5 truncate">
            api_tokens
          </strong>
          <span className="text-[11px] text-muted-foreground mt-0.5 block">MariaDB (Pool com auto-reconnect)</span>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Timer size={13} />
            Regra de renovação
          </span>
          <strong className="block text-xl font-semibold text-foreground mt-1.5">Validade &lt; 4h</strong>
          <span className="text-[11px] text-muted-foreground mt-0.5 block">Prevenção ativa de expiração</span>
        </div>
      </div>

      {/* Histórico de Execuções com Filtros de Sucesso / Erro */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border p-4 bg-muted/20">
          <div>
            <h4 className="text-sm font-bold text-foreground">Histórico de Telemetria Técnica</h4>
            <p className="text-xs text-muted-foreground">
              Monitoramento direto das execuções do workflow com status de sucesso e falhas
            </p>
          </div>

          <div className="flex items-center gap-1.5 bg-muted/60 p-1 rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded text-xs font-semibold transition cursor-pointer ${
                filter === 'all'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Todos ({executions.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('success')}
              className={`px-3 py-1 rounded text-xs font-semibold transition cursor-pointer ${
                filter === 'success'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Sucessos ({totalSuccess})
            </button>
            <button
              type="button"
              onClick={() => setFilter('error')}
              className={`px-3 py-1 rounded text-xs font-semibold transition cursor-pointer ${
                filter === 'error'
                  ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Falhas ({totalErrors})
            </button>
          </div>
        </div>

        {/* Tabela de Execuções */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">ID Execução</th>
                <th className="px-4 py-3">Início (Brasília)</th>
                <th className="px-4 py-3">Duração</th>
                <th className="px-4 py-3">Nó de Parada</th>
                <th className="px-4 py-3">Resultado / Detalhes</th>
                <th className="px-4 py-3 text-right">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtered.map((exec) => {
                const isSuccess = exec.status === 'success';
                const isError = exec.status === 'error';
                return (
                  <tr key={exec.id} className="hover:bg-muted/30 transition">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {isSuccess ? (
                        <Badge variant="success" className="text-[11px] font-semibold">
                          <CheckCircle2 size={12} />
                          Sucesso
                        </Badge>
                      ) : isError ? (
                        <Badge variant="danger" className="text-[11px] font-semibold">
                          <XCircle size={12} />
                          Erro
                        </Badge>
                      ) : (
                        <Badge variant="info" className="text-[11px] font-semibold">
                          <span className="animate-spin h-2 w-2 rounded-full border border-sky-500 border-t-transparent" />
                          Executando
                        </Badge>
                      )}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap font-mono font-bold text-foreground">
                      #{exec.id}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground font-mono">
                      {formatDateTimeBR(exec.startedAt)}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-foreground font-mono">
                      {exec.durationMs ? `${(exec.durationMs / 1000).toFixed(2)}s` : '—'}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-muted text-foreground border border-border">
                        {exec.stoppedNode}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-muted-foreground max-w-md truncate">
                      {exec.message}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedExecution(exec)}
                        className="px-2.5 py-1 text-xs font-semibold rounded border border-border bg-background hover:bg-muted text-foreground transition cursor-pointer"
                      >
                        Inspecionar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de Detalhes da Execução */}
      {selectedExecution && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-in fade-in duration-150">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-card text-card-foreground shadow-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <KeyRound size={18} className="text-primary" />
                <h4 className="text-base font-bold text-foreground">
                  Execução #{selectedExecution.id}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setSelectedExecution(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border">
                <span className="text-muted-foreground">Status do Ciclo</span>
                <span className="font-bold uppercase text-foreground">
                  {selectedExecution.status}
                </span>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border">
                <span className="text-muted-foreground">Nó Final</span>
                <span className="font-mono font-semibold text-foreground">
                  {selectedExecution.stoppedNode}
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-muted/30 border border-border">
                <span className="text-muted-foreground block mb-1">Diagnóstico / Mensagem</span>
                <p className="text-foreground leading-relaxed">{selectedExecution.message}</p>
              </div>

              {selectedExecution.details?.renewedAccounts && selectedExecution.details.renewedAccounts.length > 0 && (
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
                  <span className="text-emerald-700 dark:text-emerald-400 font-bold block mb-1">
                    Contas com Token Renovado:
                  </span>
                  <ul className="list-disc list-inside space-y-0.5 text-foreground font-mono text-[11px]">
                    {selectedExecution.details.renewedAccounts.map((acc) => (
                      <li key={acc}>{acc}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedExecution.details?.errorDetail && (
                <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25">
                  <span className="text-rose-600 dark:text-rose-400 font-bold block mb-1">
                    Detalhe do Erro:
                  </span>
                  <p className="text-rose-700 dark:text-rose-300 font-mono text-[11px]">
                    {selectedExecution.details.errorDetail}
                  </p>
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-border flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedExecution(null)}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-muted hover:bg-muted/80 text-foreground cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Conexão e Configuração do ID do Workflow n8n */}
      {isConfigModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-in fade-in duration-150">
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-card text-card-foreground shadow-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={18} className="text-primary" />
                <div>
                  <h4 className="text-base font-bold text-foreground">Conectar Workflow do n8n</h4>
                  <p className="text-xs text-muted-foreground">
                    Vincular ID da automação de renovação de tokens
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsConfigModalOpen(false)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveWorkflowId} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground flex items-center justify-between">
                  <span>ID do Workflow no n8n</span>
                  <span className="text-[11px] text-muted-foreground font-normal">
                    Padrão: <code className="font-mono">{DEFAULT_WORKFLOW_ID}</code>
                  </span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={inputWorkflowId}
                    onChange={(e) => setInputWorkflowId(e.target.value)}
                    placeholder="Ex: 8AtrRCYPslyFv6s6"
                    className="w-full px-3.5 py-2 text-sm font-mono rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                    autoFocus
                    required
                  />
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  O ID do workflow é o código alfanumérico que aparece no final da URL ao editar o fluxo no n8n.
                  <br />
                  Exemplo: <span className="font-mono text-foreground">.../workflow/<strong>8AtrRCYPslyFv6s6</strong></span>
                </p>
              </div>

              <div className="p-3 rounded-lg bg-muted/40 border border-border space-y-1.5 text-xs text-muted-foreground">
                <strong className="text-foreground block font-semibold">Como funciona a conexão:</strong>
                <ul className="list-disc list-inside space-y-1 text-[11px] leading-relaxed">
                  <li>
                    <strong>No Painel:</strong> Ao salvar, o ID fica memorizado no seu navegador e as consultas e disparos manuais usam este fluxo imediatamente.
                  </li>
                  <li>
                    <strong>Na VPS permanente:</strong> Você também pode definir a variável <code className="font-mono text-foreground">N8N_TOKEN_WORKFLOW_ID={inputWorkflowId.trim() || DEFAULT_WORKFLOW_ID}</code> no arquivo <code className="font-mono text-foreground">.env</code> do Gateway.
                  </li>
                </ul>
              </div>

              <div className="pt-2 border-t border-border flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={handleResetWorkflowId}
                  className="text-xs text-muted-foreground hover:text-foreground underline transition cursor-pointer"
                >
                  Restaurar Padrão
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsConfigModalOpen(false)}
                    className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-muted hover:bg-muted/80 text-foreground cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <Button
                    type="submit"
                    className="h-8 px-4 text-xs font-semibold bg-primary hover:bg-[var(--brand-primary-hover)] text-primary-foreground cursor-pointer shadow-sm"
                  >
                    Salvar e Conectar
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
