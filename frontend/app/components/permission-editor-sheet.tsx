'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, RefreshCw } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { formatDateTimeBR } from '@/lib/formatters';
import type { AdminUserView } from '@/lib/admin-users-contracts';
import type { AdminUsersService } from '@/lib/admin-users-service';
import {
  READ_ONLY_REASON,
  addedRiskActions,
  ceilingFor,
  diffGrants,
  permissionLabel,
  targetPolicy,
  type PermissionCatalog,
  type PermissionStateView,
  type PolicyActor,
} from '@/lib/permissions';
import { PermissionMatrix } from './permission-matrix';
import { ConfirmImpactDialog } from './confirm-impact-dialog';
import { Notice } from './admin-notice';
import { RoleBadge } from './admin-user-badges';

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; state: PermissionStateView };

type SaveProblem =
  | { kind: 'conflict'; when: string; who: string; lost: { added: string[]; removed: string[] } }
  | { kind: 'ceiling'; labels: string[] }
  | { kind: 'error'; message: string };

/** Editor de permissões (Sheet lateral, spec C.1.4b). */
export function PermissionEditorSheet({
  target,
  actor,
  catalog,
  catalogError,
  onRetryCatalog,
  service,
  onClose,
  onSaved,
}: {
  target: AdminUserView | null;
  actor: PolicyActor;
  catalog: PermissionCatalog | null;
  catalogError: string | null;
  onRetryCatalog: () => void;
  service: AdminUsersService;
  onClose: () => void;
  onSaved: (userId: number, state: PermissionStateView) => void;
}) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [value, setValue] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [lostAfterReload, setLostAfterReload] = useState<{ added: string[]; removed: string[] } | null>(null);
  const [confirm, setConfirm] = useState<'risk' | 'revoke' | 'discard' | null>(null);

  const targetId = target?.id ?? null;

  // Carga das permissões do alvo. O componente é remontado por `key` a cada alvo, então o estado
  // já nasce "loading" e não há dado de outro usuário para limpar.
  const fetchState = useCallback(async () => (targetId === null ? null : service.getPermissions(targetId)), [service, targetId]);
  const applyState = useCallback((res: Awaited<ReturnType<typeof fetchState>>) => {
    if (!res) return;
    if (!res.ok) {
      setLoad({ kind: 'error', message: res.error.message });
      return;
    }
    setLoad({ kind: 'ready', state: res.data });
    setInitial(new Set(res.data.grants));
    setValue(new Set(res.data.grants));
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchState().then((r) => alive && applyState(r));
    return () => {
      alive = false;
    };
  }, [fetchState, applyState]);

  const reload = useCallback(async () => {
    setLoad({ kind: 'loading' });
    applyState(await fetchState());
  }, [fetchState, applyState]);

  const policy = target ? targetPolicy(actor, target) : null;
  const isAdminTarget = target?.role === 'admin';
  const readOnlyReason = !target
    ? null
    : target.is_root
      ? READ_ONLY_REASON.root
      : isAdminTarget
        ? null
        : policy && !policy.canEditPermissions
          ? (policy.permissionsReadOnlyReason ?? READ_ONLY_REASON.managerTarget)
          : null;
  const editable = Boolean(target && !isAdminTarget && !target.is_root && policy?.canEditPermissions);
  const ceiling = useMemo(() => ceilingFor(actor), [actor]);

  const diff = useMemo(
    () => (catalog ? diffGrants(catalog, initial, value) : { added: [], removed: [] }),
    [catalog, initial, value],
  );
  const changes = diff.added.length + diff.removed.length;

  const requestClose = () => {
    if (saving) return;
    if (editable && changes > 0) setConfirm('discard');
    else onClose();
  };

  const doSave = async () => {
    if (!target || load.kind !== 'ready' || !catalog) return;
    setSaving(true);
    setProblem(null);
    const res = await service.putPermissions(target.id, [...value], load.state.version);
    setSaving(false);
    setConfirm(null);
    if (res.ok) {
      toast.add({
        title: `Permissões de ${target.nome} salvas.`,
        description: 'Valem a partir do próximo carregamento de página dela.',
        type: 'success',
      });
      onSaved(target.id, res.data);
      onClose();
      return;
    }
    const e = res.error;
    if (e.code === 'version_conflict') {
      setProblem({
        kind: 'conflict',
        when: e.current?.updatedAt ? formatDateTimeBR(e.current.updatedAt) : 'agora há pouco',
        who: e.current?.updatedByName ?? 'outra pessoa',
        lost: diff,
      });
    } else if (e.code === 'outside_ceiling') {
      setProblem({ kind: 'ceiling', labels: e.labels.length ? e.labels : e.items.map((k) => permissionLabel(catalog, k)) });
    } else {
      setProblem({ kind: 'error', message: e.message });
    }
  };

  const handleSave = () => {
    if (!catalog) return;
    if (addedRiskActions(catalog, initial, value).length > 0) setConfirm('risk');
    else if (diff.removed.length > 0) setConfirm('revoke');
    else void doSave();
  };

  const reloadAfterConflict = async () => {
    if (problem?.kind === 'conflict') setLostAfterReload(problem.lost);
    setProblem(null);
    await reload();
  };

  const riskAdded = catalog ? addedRiskActions(catalog, initial, value) : [];
  const updatedAt = load.kind === 'ready' ? load.state.updatedAt : null;
  const updatedBy = load.kind === 'ready' ? load.state.updatedByName : null;
  const nome = target?.nome ?? '';

  return (
    <>
      <Sheet open={target !== null} onOpenChange={(next) => !next && requestClose()}>
        <SheetContent
          side="right"
          className="w-full gap-0 rounded-none data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        >
          {target && (
            <>
              <SheetHeader className="border-b border-border pr-12">
                <SheetTitle className="text-base font-semibold">{target.nome}</SheetTitle>
                <SheetDescription render={<div />} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-mono">@{target.username}</span>
                  <span aria-hidden="true">·</span>
                  <span>{target.setor || 'sem setor'}</span>
                  <span aria-hidden="true">·</span>
                  <RoleBadge role={target.role} />
                </SheetDescription>
                {updatedAt && (
                  <p className="text-[11px] text-muted-foreground">
                    Alterado por {updatedBy ?? 'alguém'} em {formatDateTimeBR(updatedAt)}
                  </p>
                )}
              </SheetHeader>

              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {isAdminTarget ? (
                  <Notice tone="info">
                    <strong className="font-semibold">Acesso total.</strong> Administradores acessam todas as abas e ações.
                    Para limitar o acesso, altere o perfil para Gestor ou User.
                  </Notice>
                ) : catalogError || load.kind === 'error' ? (
                  <Notice
                    tone="error"
                    role="alert"
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (catalogError) onRetryCatalog();
                          void reload();
                        }}
                      >
                        <RefreshCw aria-hidden="true" />
                        Tentar de novo
                      </Button>
                    }
                  >
                    Não foi possível carregar as permissões.{' '}
                    {catalogError ?? (load.kind === 'error' ? load.message : '')}
                  </Notice>
                ) : !catalog || load.kind === 'loading' ? (
                  <div className="space-y-3" aria-busy="true" aria-label="Carregando permissões">
                    {Array.from({ length: 5 }, (_, i) => (
                      <div key={i} className="space-y-1.5 rounded-[4px] border border-border p-3">
                        <Skeleton className="h-4 w-32 rounded-[4px]" />
                        {Array.from({ length: 3 }, (_, j) => (
                          <Skeleton key={j} className="h-9 w-full rounded-[4px]" />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    {readOnlyReason && (
                      <Notice tone="muted" icon={<Lock size={14} aria-hidden="true" />}>
                        Somente leitura: {readOnlyReason}
                      </Notice>
                    )}
                    {problem?.kind === 'conflict' && (
                      <Notice
                        tone="pending"
                        role="alert"
                        action={
                          <Button size="sm" variant="outline" onClick={() => void reloadAfterConflict()}>
                            Recarregar e refazer
                          </Button>
                        }
                      >
                        Outra pessoa alterou estas permissões em {problem.when} ({problem.who}). Suas {changes} alteraç
                        {changes === 1 ? 'ão não foi salva' : 'ões não foram salvas'}.
                      </Notice>
                    )}
                    {lostAfterReload && (
                      <Notice tone="muted">
                        <p className="font-semibold text-foreground">Alterações que não foram salvas (refaça se ainda valerem):</p>
                        <ul className="mt-1 list-disc pl-4">
                          {lostAfterReload.added.map((k) => (
                            <li key={`+${k}`}>Conceder {permissionLabel(catalog, k)}</li>
                          ))}
                          {lostAfterReload.removed.map((k) => (
                            <li key={`-${k}`}>Revogar {permissionLabel(catalog, k)}</li>
                          ))}
                        </ul>
                      </Notice>
                    )}
                    {problem?.kind === 'ceiling' && (
                      <Notice tone="error" role="alert">
                        Você tentou conceder ou revogar algo fora das suas permissões: {problem.labels.join(', ')}. Peça ao
                        administrador.
                      </Notice>
                    )}
                    {problem?.kind === 'error' && (
                      <Notice tone="error" role="alert">
                        {problem.message}
                      </Notice>
                    )}
                    {value.size === 0 && (
                      <Notice tone="pending" live>
                        Nenhuma permissão marcada. {nome} só vê Início e Chat.
                      </Notice>
                    )}
                    <PermissionMatrix
                      key={target.id}
                      catalog={catalog}
                      value={value}
                      onChange={(next) => {
                        setValue(next);
                        if (problem?.kind !== 'conflict') setProblem(null);
                      }}
                      targetRole={target.role}
                      ceiling={ceiling}
                      readOnly={!editable}
                      busy={saving}
                    />
                  </>
                )}
              </div>

              <footer className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-popover p-4 sm:flex-row sm:items-center sm:justify-between">
                {editable && load.kind === 'ready' ? (
                  <>
                    <p className="text-xs text-muted-foreground" aria-live="polite">
                      {changes === 0 ? (
                        'Nenhuma alteração'
                      ) : (
                        <>
                          {changes} alteraç{changes === 1 ? 'ão' : 'ões'}:{' '}
                          <span className="font-semibold text-[var(--status-success-fg)]">+{diff.added.length} concedidas</span>,{' '}
                          <span className="font-semibold text-[var(--status-error-fg)]">−{diff.removed.length} revogadas</span>
                        </>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={changes === 0 || saving}
                        onClick={() => {
                          setValue(new Set(initial));
                          setProblem(null);
                        }}
                      >
                        Descartar
                      </Button>
                      <Button
                        variant="cta"
                        disabled={changes === 0 || saving || problem?.kind === 'conflict'}
                        onClick={handleSave}
                        aria-busy={saving}
                      >
                        {saving && <Spinner aria-hidden="true" />}
                        {saving ? 'Salvando…' : 'Salvar permissões'}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex w-full justify-end">
                    <Button variant="outline" onClick={onClose}>
                      Fechar
                    </Button>
                  </div>
                )}
              </footer>
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmImpactDialog
        open={confirm === 'risk'}
        title={`Conceder ação de risco a ${nome}?`}
        confirmLabel="Conceder e salvar"
        requireCheck="Entendo o risco"
        busy={saving}
        onConfirm={() => void doSave()}
        onCancel={() => setConfirm(null)}
      >
        {riskAdded.map((a) => (
          <p key={a.key}>
            <strong className="text-foreground">{permissionLabel(catalog, a.key)}:</strong> {a.help}
          </p>
        ))}
        {diff.removed.length > 0 && catalog && (
          <div>
            <p>Também revoga {diff.removed.length} acesso(s):</p>
            <ul className="list-disc pl-4">
              {diff.removed.map((k) => (
                <li key={k}>{permissionLabel(catalog, k)}</li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmImpactDialog>

      <ConfirmImpactDialog
        open={confirm === 'revoke'}
        title={`Revogar ${diff.removed.length} acesso${diff.removed.length === 1 ? '' : 's'} de ${nome}?`}
        confirmLabel="Revogar e salvar"
        tone="destructive"
        busy={saving}
        onConfirm={() => void doSave()}
        onCancel={() => setConfirm(null)}
      >
        <ul className="list-disc pl-4">
          {diff.removed.map((k) => (
            <li key={k}>{permissionLabel(catalog, k)}</li>
          ))}
        </ul>
        <p>Deixa de ver/executar isso no próximo carregamento de página.</p>
      </ConfirmImpactDialog>

      <ConfirmImpactDialog
        open={confirm === 'discard'}
        title={`Descartar ${changes} alteraç${changes === 1 ? 'ão' : 'ões'} não salva${changes === 1 ? '' : 's'}?`}
        confirmLabel="Descartar"
        tone="destructive"
        onConfirm={() => {
          setConfirm(null);
          onClose();
        }}
        onCancel={() => setConfirm(null)}
      >
        <p>As marcações feitas neste editor serão perdidas.</p>
      </ConfirmImpactDialog>
    </>
  );
}
