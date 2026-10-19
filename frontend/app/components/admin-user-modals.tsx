'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, RefreshCw, UserCheck, UserPlus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { SETORES } from '@/lib/contracts';
import type {
  AdminResult,
  AdminUserView,
  ApprovePayload,
  ApproveResult,
  NewUserPayload,
} from '@/lib/admin-users-contracts';
import {
  MIN_PASSWORD_LENGTH,
  ROLE_LABEL,
  addedRiskActions,
  ceilingFor,
  cleanUsername,
  creatableRoles,
  fieldFromApiError,
  firstInvalidField,
  grantsForRole,
  permissionLabel,
  validateNewUser,
  type FieldErrors,
  type NewUserField,
  type PermissionCatalog,
  type PolicyActor,
  type Role,
} from '@/lib/permissions';
import { PermissionMatrix } from './permission-matrix';
import { ConfirmImpactDialog } from './confirm-impact-dialog';
import { Notice } from './admin-notice';

// Estado de formulário isolado em componente próprio: digitar aqui re-renderiza só o modal,
// não a página inteira (tabelas de usuários/sessões).

const DIALOG_CLASS =
  'flex max-h-[calc(100dvh-2rem)] flex-col gap-0 rounded-[4px] p-0 sm:max-w-3xl max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none';

const SETOR_HELP = 'Só identifica a equipe. Não libera nenhuma aba.';

const fieldClass = (invalid: boolean) =>
  `rounded-[4px] ${invalid ? 'border-[var(--status-error-fg)]' : ''}`;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-[11px] font-medium text-[var(--status-error-fg)]">
      {message}
    </p>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">{children}</h3>;
}

/** Seção "Permissões" (matriz desmarcada por padrão) com seus estados. */
function PermissionsSection({
  catalog,
  catalogError,
  onRetryCatalog,
  role,
  value,
  onChange,
  actor,
  busy,
  nome,
  error,
}: {
  catalog: PermissionCatalog | null;
  catalogError: string | null;
  onRetryCatalog: () => void;
  role: Role;
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  actor: PolicyActor;
  busy: boolean;
  nome: string;
  error?: string;
}) {
  const ceiling = useMemo(() => ceilingFor(actor), [actor]);
  return (
    <section className="space-y-2" aria-labelledby="perm-section-title">
      <h3 id="perm-section-title" className="text-xs font-bold uppercase tracking-wider text-foreground">
        Permissões
      </h3>
      {role === 'admin' ? (
        <Notice tone="info">
          <strong className="font-semibold">Acesso total.</strong> Administradores acessam todas as abas e ações. As
          permissões individuais não são usadas.
        </Notice>
      ) : catalogError ? (
        <Notice
          tone="error"
          role="alert"
          action={
            <Button size="sm" variant="outline" onClick={onRetryCatalog} type="button">
              <RefreshCw aria-hidden="true" />
              Tentar de novo
            </Button>
          }
        >
          Não foi possível carregar o catálogo de permissões. {catalogError}
        </Notice>
      ) : !catalog ? (
        <div className="space-y-1.5" aria-busy="true" aria-label="Carregando permissões">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-[4px]" />
          ))}
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-[11px] font-medium text-[var(--status-error-fg)]">
              {error}
            </p>
          )}
          {value.size === 0 && (
            <Notice tone="pending" live>
              Ninguém marcado: {nome || 'o usuário'} vai entrar e ver só Início e Chat até você liberar abas.
            </Notice>
          )}
          <PermissionMatrix
            catalog={catalog}
            value={value}
            onChange={onChange}
            targetRole={role}
            ceiling={ceiling}
            busy={busy}
            invalid={Boolean(error)}
          />
        </>
      )}
    </section>
  );
}

function mapApiError(
  error: { code: string | null; field: string | null; message: string },
  known: readonly NewUserField[],
): { field: NewUserField | null; message: string } {
  const field = fieldFromApiError({ code: error.code, field: error.field, error: error.message });
  return { field: field && known.includes(field) ? field : null, message: error.message };
}

// ---------------------------------------------------------------------------------------------
// Novo usuário
// ---------------------------------------------------------------------------------------------

export function NewUserModal({
  actor,
  catalog,
  catalogError,
  onRetryCatalog,
  onClose,
  onSubmit,
}: {
  actor: PolicyActor;
  catalog: PermissionCatalog | null;
  catalogError: string | null;
  onRetryCatalog: () => void;
  onClose: () => void;
  onSubmit: (payload: NewUserPayload) => Promise<AdminResult<AdminUserView>>;
}) {
  const roles = creatableRoles(actor);
  const [nome, setNome] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [setor, setSetor] = useState('');
  const [senha, setSenha] = useState('');
  const [showSenha, setShowSenha] = useState(false);
  const [role, setRole] = useState<Role>('user');
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState<'admin' | 'risk' | null>(null);
  const uid = useId();
  const nomeRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const setorRef = useRef<HTMLSelectElement>(null);
  const senhaRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const known: NewUserField[] = ['nome', 'username', 'email', 'setor', 'senha', 'role', 'grants'];

  const focusField = (field: NewUserField | null) => {
    if (!field || field === 'grants') {
      if (field === 'grants') document.getElementById('perm-section-title')?.scrollIntoView({ block: 'center' });
      return;
    }
    const target = { nome: nomeRef, username: usernameRef, email: emailRef, setor: setorRef, senha: senhaRef, role: roleRef }[field];
    target.current?.focus();
  };

  const login = cleanUsername(username);
  const effectiveGrants = role === 'admin' || !catalog ? [] : grantsForRole(catalog, grants, role);
  const riskAdded = catalog && role !== 'admin' ? addedRiskActions(catalog, [], effectiveGrants) : [];

  const send = async () => {
    setConfirm(null);
    setSubmitting(true);
    setGeneral('');
    const result = await onSubmit({ nome: nome.trim(), username: login, email: email.trim(), setor, senha, role, grants: effectiveGrants });
    setSubmitting(false);
    if (result.ok) return;
    const { field, message } = mapApiError(result.error, known);
    if (field) {
      setErrors((prev) => ({ ...prev, [field]: message }));
      focusField(field);
    } else {
      setGeneral(message);
    }
  };

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const found = validateNewUser({ nome, username, email, setor, senha });
    setErrors(found);
    setGeneral('');
    const first = firstInvalidField(found);
    if (first) {
      focusField(first);
      return;
    }
    if (riskAdded.length > 0) {
      setConfirm('risk');
      return;
    }
    void send();
  };

  const clearError = (field: NewUserField) => setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  const describe = (field: NewUserField, help?: string) =>
    [errors[field] ? `${uid}-${field}-err` : null, help ? `${uid}-${field}-help` : null].filter(Boolean).join(' ') || undefined;

  const empty = role !== 'admin' && effectiveGrants.length === 0;

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className={DIALOG_CLASS} showCloseButton={!submitting}>
        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-b border-border p-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <UserPlus size={18} aria-hidden="true" />
              Novo usuário
            </DialogTitle>
            <DialogDescription>A conta já nasce ativa. Defina abaixo o que ela pode acessar.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            {general && (
              <Notice tone="error" role="alert">
                {general}
              </Notice>
            )}

            <section className="space-y-3">
              <SectionTitle>Dados</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor={`${uid}-nome`} className="mb-1 block text-xs font-medium text-foreground">
                    Nome completo
                  </label>
                  <Input
                    ref={nomeRef}
                    id={`${uid}-nome`}
                    value={nome}
                    onChange={(e) => {
                      setNome(e.target.value);
                      clearError('nome');
                    }}
                    aria-invalid={Boolean(errors.nome) || undefined}
                    aria-describedby={describe('nome')}
                    className={fieldClass(Boolean(errors.nome))}
                    autoComplete="off"
                  />
                  <FieldError id={`${uid}-nome-err`} message={errors.nome} />
                </div>

                <div>
                  <label htmlFor={`${uid}-username`} className="mb-1 block text-xs font-medium text-foreground">
                    Login (username)
                  </label>
                  <Input
                    ref={usernameRef}
                    id={`${uid}-username`}
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      clearError('username');
                    }}
                    aria-invalid={Boolean(errors.username) || undefined}
                    aria-describedby={describe('username', 'help')}
                    className={`${fieldClass(Boolean(errors.username))} font-mono`}
                    placeholder="joao.pedro"
                    autoComplete="off"
                  />
                  <p id={`${uid}-username-help`} className="mt-1 text-[11px] text-muted-foreground">
                    {login ? (
                      <>
                        Login: <strong className="font-mono text-foreground">{login}</strong>.{' '}
                      </>
                    ) : null}
                    Só letras minúsculas sem acento, números, ponto e sublinhado.
                  </p>
                  <FieldError id={`${uid}-username-err`} message={errors.username} />
                </div>

                <div>
                  <label htmlFor={`${uid}-email`} className="mb-1 block text-xs font-medium text-foreground">
                    E-mail corporativo
                  </label>
                  <Input
                    ref={emailRef}
                    id={`${uid}-email`}
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearError('email');
                    }}
                    aria-invalid={Boolean(errors.email) || undefined}
                    aria-describedby={describe('email')}
                    className={fieldClass(Boolean(errors.email))}
                    placeholder="email@norvia.example"
                    autoComplete="off"
                  />
                  <FieldError id={`${uid}-email-err`} message={errors.email} />
                </div>

                <div>
                  <label htmlFor={`${uid}-setor`} className="mb-1 block text-xs font-medium text-foreground">
                    Setor
                  </label>
                  <NativeSelect
                    ref={setorRef}
                    id={`${uid}-setor`}
                    value={setor}
                    onChange={(e) => {
                      setSetor(e.target.value);
                      clearError('setor');
                    }}
                    aria-invalid={Boolean(errors.setor) || undefined}
                    aria-describedby={describe('setor', 'help')}
                    className="w-full [&_select]:rounded-[4px]"
                  >
                    <NativeSelectOption value="">Escolha o setor…</NativeSelectOption>
                    {SETORES.map((s) => (
                      <NativeSelectOption key={s} value={s}>
                        {s}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <p id={`${uid}-setor-help`} className="mt-1 text-[11px] text-muted-foreground">
                    {SETOR_HELP}
                  </p>
                  <FieldError id={`${uid}-setor-err`} message={errors.setor} />
                </div>

                <div>
                  <label htmlFor={`${uid}-senha`} className="mb-1 block text-xs font-medium text-foreground">
                    Senha inicial
                  </label>
                  <div className="relative">
                    <Input
                      ref={senhaRef}
                      id={`${uid}-senha`}
                      type={showSenha ? 'text' : 'password'}
                      value={senha}
                      onChange={(e) => {
                        setSenha(e.target.value);
                        clearError('senha');
                      }}
                      aria-invalid={Boolean(errors.senha) || undefined}
                      aria-describedby={describe('senha', 'help')}
                      className={`${fieldClass(Boolean(errors.senha))} pr-9`}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSenha((v) => !v)}
                      className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground"
                      aria-label={showSenha ? 'Ocultar senha' : 'Mostrar senha'}
                      aria-pressed={showSenha}
                    >
                      {showSenha ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                    </button>
                  </div>
                  <p
                    id={`${uid}-senha-help`}
                    className={`mt-1 font-mono text-[11px] ${
                      senha.length >= MIN_PASSWORD_LENGTH ? 'text-[var(--status-success-fg)]' : 'text-muted-foreground'
                    }`}
                  >
                    Mínimo {MIN_PASSWORD_LENGTH} caracteres · {Math.min(senha.length, 999)}/{MIN_PASSWORD_LENGTH}
                  </p>
                  <FieldError id={`${uid}-senha-err`} message={errors.senha} />
                </div>

                <div className="sm:col-span-2">
                  {roles.length > 1 ? (
                    <>
                      <label htmlFor={`${uid}-role`} className="mb-1 block text-xs font-medium text-foreground">
                        Perfil
                      </label>
                      <NativeSelect
                        ref={roleRef}
                        id={`${uid}-role`}
                        value={role}
                        onChange={(e) => {
                          const next = e.target.value as Role;
                          clearError('role');
                          if (next === 'admin') {
                            setConfirm('admin');
                            return;
                          }
                          setRole(next);
                          if (catalog) setGrants(new Set(grantsForRole(catalog, grants, next)));
                        }}
                        aria-invalid={Boolean(errors.role) || undefined}
                        aria-describedby={describe('role')}
                        className="w-full sm:w-56 [&_select]:rounded-[4px]"
                      >
                        {roles.map((r) => (
                          <NativeSelectOption key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldError id={`${uid}-role-err`} message={errors.role} />
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Perfil: <strong className="text-foreground">User</strong> (Gestores só criam usuários do perfil User)
                    </p>
                  )}
                </div>
              </div>
            </section>

            <PermissionsSection
              catalog={catalog}
              catalogError={catalogError}
              onRetryCatalog={onRetryCatalog}
              role={role}
              value={grants}
              onChange={(next) => {
                setGrants(next);
                clearError('grants');
              }}
              actor={actor}
              busy={submitting}
              nome={nome.trim()}
              error={errors.grants}
            />
          </div>

          <footer className="flex flex-col-reverse gap-2 border-t border-border bg-muted/50 p-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" variant={empty ? 'outline' : 'cta'} disabled={submitting} aria-busy={submitting}>
              {submitting && <Spinner aria-hidden="true" />}
              {submitting ? 'Criando…' : empty ? 'Criar sem permissões' : 'Criar usuário'}
            </Button>
          </footer>
        </form>

        <ConfirmImpactDialog
          open={confirm === 'admin'}
          title={`Criar ${nome.trim() || 'este usuário'} como Administrador(a)?`}
          confirmLabel="Usar perfil Admin"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            setRole('admin');
          }}
        >
          <p>
            Administradores têm acesso total: todas as abas, todas as ações (inclusive forçar varredura SEFAZ e
            sincronização) e a gestão de qualquer usuário, exceto o ROOT. As permissões individuais deixam de ser usadas.
          </p>
        </ConfirmImpactDialog>
        <ConfirmImpactDialog
          open={confirm === 'risk'}
          title={`Conceder ação de risco a ${nome.trim() || 'este usuário'}?`}
          confirmLabel="Conceder e criar"
          requireCheck="Entendo o risco"
          busy={submitting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void send()}
        >
          {riskAdded.map((a) => (
            <p key={a.key}>
              <strong className="text-foreground">{permissionLabel(catalog, a.key)}:</strong> {a.help}
            </p>
          ))}
        </ConfirmImpactDialog>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Aprovação de cadastro
// ---------------------------------------------------------------------------------------------

function suggestUsername(targetUser: Pick<AdminUserView, 'username' | 'email'>): string {
  return cleanUsername(
    targetUser.username && targetUser.username !== 'user' ? targetUser.username : targetUser.email.split('@')[0] || 'colaborador',
  );
}

export function ApproveUserModal({
  targetUser,
  actor,
  catalog,
  catalogError,
  onRetryCatalog,
  onClose,
  onSubmit,
}: {
  targetUser: AdminUserView;
  actor: PolicyActor;
  catalog: PermissionCatalog | null;
  catalogError: string | null;
  onRetryCatalog: () => void;
  onClose: () => void;
  onSubmit: (userId: number, payload: ApprovePayload) => Promise<AdminResult<ApproveResult>>;
}) {
  const [username, setUsername] = useState(() => suggestUsername(targetUser));
  const setorSugerido = (targetUser.setor ?? '').trim();
  const [setor, setSetor] = useState('');
  const setorOptions: string[] = [...SETORES];
  if (setorSugerido && !setorOptions.includes(setorSugerido)) setorOptions.push(setorSugerido);
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmRisk, setConfirmRisk] = useState(false);
  const uid = useId();
  const usernameRef = useRef<HTMLInputElement>(null);
  const setorRef = useRef<HTMLSelectElement>(null);
  const known: NewUserField[] = ['username', 'setor', 'grants'];
  const login = cleanUsername(username);
  const effectiveGrants = catalog ? grantsForRole(catalog, grants, targetUser.role) : [];
  const riskAdded = catalog ? addedRiskActions(catalog, [], effectiveGrants) : [];
  const empty = effectiveGrants.length === 0;

  const focusField = (field: NewUserField | null) => {
    if (field === 'username') usernameRef.current?.focus();
    else if (field === 'setor') setorRef.current?.focus();
  };

  const send = async () => {
    setConfirmRisk(false);
    setSubmitting(true);
    setGeneral('');
    const result = await onSubmit(targetUser.id, { username: login, setor, grants: effectiveGrants });
    setSubmitting(false);
    if (result.ok) return;
    const { field, message } = mapApiError(result.error, known);
    if (field) {
      setErrors((prev) => ({ ...prev, [field]: message }));
      focusField(field);
    } else {
      setGeneral(message);
    }
  };

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const found: FieldErrors = {};
    if (!setor) found.setor = 'Escolha o setor.';
    if (!login) found.username = 'Informe o login (letras, números, ponto ou sublinhado).';
    setErrors(found);
    const first = firstInvalidField(found);
    if (first) {
      focusField(first);
      return;
    }
    if (riskAdded.length > 0) setConfirmRisk(true);
    else void send();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className={DIALOG_CLASS} showCloseButton={!submitting} initialFocus={setorRef}>
        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-b border-border p-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <UserCheck size={18} aria-hidden="true" />
              Aprovar cadastro
            </DialogTitle>
            <DialogDescription>Confira os dados, escolha o setor e defina o que {targetUser.nome} pode acessar.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            {general && (
              <Notice tone="error" role="alert">
                {general}
              </Notice>
            )}
            <section className="space-y-3">
              <SectionTitle>Dados</SectionTitle>
              <dl className="grid gap-1.5 rounded-[4px] border border-border bg-muted/40 p-3 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-4">
                <dt className="text-muted-foreground">Nome</dt>
                <dd className="font-semibold text-foreground">{targetUser.nome}</dd>
                <dt className="text-muted-foreground">E-mail</dt>
                <dd className="break-all font-mono text-foreground">{targetUser.email}</dd>
                <dt className="text-muted-foreground">Setor indicado no cadastro</dt>
                <dd className="text-foreground">{setorSugerido || '—'}</dd>
              </dl>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${uid}-setor`} className="mb-1 block text-xs font-medium text-foreground">
                    Setor
                  </label>
                  <NativeSelect
                    ref={setorRef}
                    id={`${uid}-setor`}
                    value={setor}
                    onChange={(e) => {
                      setSetor(e.target.value);
                      setErrors((p) => ({ ...p, setor: undefined }));
                    }}
                    aria-invalid={Boolean(errors.setor) || undefined}
                    aria-describedby={[`${uid}-setor-help`, errors.setor ? `${uid}-setor-err` : ''].join(' ').trim()}
                    className="w-full [&_select]:rounded-[4px]"
                  >
                    <NativeSelectOption value="">Escolha o setor…</NativeSelectOption>
                    {setorOptions.map((s) => (
                      <NativeSelectOption key={s} value={s}>
                        {s}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <p id={`${uid}-setor-help`} className="mt-1 text-[11px] text-muted-foreground">
                    {SETOR_HELP}
                  </p>
                  <FieldError id={`${uid}-setor-err`} message={errors.setor} />
                </div>
                <div>
                  <label htmlFor={`${uid}-username`} className="mb-1 block text-xs font-medium text-foreground">
                    Login (username)
                  </label>
                  <Input
                    ref={usernameRef}
                    id={`${uid}-username`}
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setErrors((p) => ({ ...p, username: undefined }));
                    }}
                    aria-invalid={Boolean(errors.username) || undefined}
                    aria-describedby={[`${uid}-username-help`, errors.username ? `${uid}-username-err` : ''].join(' ').trim()}
                    className={`${fieldClass(Boolean(errors.username))} font-mono`}
                    autoComplete="off"
                  />
                  <p id={`${uid}-username-help`} className="mt-1 text-[11px] text-muted-foreground">
                    {login ? (
                      <>
                        Login: <strong className="font-mono text-foreground">{login}</strong>.{' '}
                      </>
                    ) : null}
                    Entra com este login ou com o e-mail.
                  </p>
                  <FieldError id={`${uid}-username-err`} message={errors.username} />
                </div>
              </div>
            </section>

            <PermissionsSection
              catalog={catalog}
              catalogError={catalogError}
              onRetryCatalog={onRetryCatalog}
              role={targetUser.role}
              value={grants}
              onChange={(next) => {
                setGrants(next);
                setErrors((p) => ({ ...p, grants: undefined }));
              }}
              actor={actor}
              busy={submitting}
              nome={targetUser.nome}
              error={errors.grants}
            />
          </div>

          <footer className="flex flex-col-reverse gap-2 border-t border-border bg-muted/50 p-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" variant={empty ? 'outline' : 'cta'} disabled={submitting} aria-busy={submitting}>
              {submitting && <Spinner aria-hidden="true" />}
              {submitting ? 'Aprovando…' : empty ? 'Aprovar sem permissões' : 'Aprovar'}
            </Button>
          </footer>
        </form>

        <ConfirmImpactDialog
          open={confirmRisk}
          title={`Conceder ação de risco a ${targetUser.nome}?`}
          confirmLabel="Conceder e aprovar"
          requireCheck="Entendo o risco"
          busy={submitting}
          onCancel={() => setConfirmRisk(false)}
          onConfirm={() => void send()}
        >
          {riskAdded.map((a) => (
            <p key={a.key}>
              <strong className="text-foreground">{permissionLabel(catalog, a.key)}:</strong> {a.help}
            </p>
          ))}
        </ConfirmImpactDialog>
      </DialogContent>
    </Dialog>
  );
}
