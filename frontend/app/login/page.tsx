'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { destinoAposLogin, useAuth } from '@/lib/auth-context';
import { SETORES } from '@/lib/contracts';
import {
  ShieldCheck,
  Lock,
  Mail,
  User as UserIcon,
  Building2,
  KeyRound,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { NorviaLogo } from '@/components/ui/norvia-logo';
import { DEMO_LOGIN_PROFILES } from '@/lib/demo-permissions';
import { isDemoLoginAllowed } from '@/lib/session-guard';

export default function LoginPage() {
  const { user, login, loginDemo, isDemoMode, register, isLoading } = useAuth();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');

  // Form states - Login
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isSubmittingLogin, setIsSubmittingLogin] = useState(false);

  // Form states - Register
  const [regNome, setRegNome] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regSetor, setRegSetor] = useState('Financeiro');
  const [regPassword, setRegPassword] = useState('');
  const [regError, setRegError] = useState('');
  const [regSuccess, setRegSuccess] = useState('');
  const [isSubmittingReg, setIsSubmittingReg] = useState(false);

  const [isLocalDemo, setIsLocalDemo] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Mesma regra do login demo (session-guard.ts): build demo (ex.: GitHub Pages) ou
      // localhost/127.0.0.1, mesmo sem NEXT_PUBLIC_DATA_MODE. Na VPS (build live, acessada
      // por domínio/IP de rede) nunca aparece.
      setIsLocalDemo(isDemoLoginAllowed(process.env.NEXT_PUBLIC_DATA_MODE, window.location.hostname));
    }
  }, []);

  useEffect(() => {
    if (!isLoading && user) {
      router.push(destinoAposLogin());
    }
  }, [user, isLoading, router]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setIsSubmittingLogin(true);
    try {
      await login(loginIdentifier, loginPassword);
    } catch (err: any) {
      setLoginError(err.message || 'Falha ao autenticar.');
    } finally {
      setIsSubmittingLogin(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError('');
    setRegSuccess('');
    setIsSubmittingReg(true);
    try {
      const res = await register({
        nome: regNome,
        email: regEmail,
        setor: regSetor,
        senha: regPassword,
      });
      setRegSuccess(res.message);
      setRegNome('');
      setRegEmail('');
      setRegPassword('');
    } catch (err: any) {
      setRegError(err.message || 'Falha ao solicitar cadastro.');
    } finally {
      setIsSubmittingReg(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-sm text-muted-foreground">Carregando…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4 text-foreground antialiased">
      <div className="w-full max-w-[420px]">
        {/* Header da Marca */}
        <div className="mb-6 flex flex-col items-center text-center">
          <NorviaLogo size={48} className="mb-3" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Norvia Automações</h1>
          <p className="mt-1 text-sm text-muted-foreground">Acesse com sua conta corporativa</p>
        </div>

        {/* Card Principal */}
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {/* Card de Acesso Rápido - build demo ou desenvolvimento local */}
          {isLocalDemo && (
            <>
              <div className="mb-5 rounded-md border border-[var(--info-border)] bg-[var(--info-bg)] p-3.5 text-left">
                <p className="mb-1 text-xs font-semibold text-[var(--info-strong)]">Ambiente de demonstração</p>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Dados fictícios, sem banco de dados nem APIs externas.
                </p>
                <button
                  type="button"
                  onClick={() => loginDemo()}
                  className="w-full flex items-center justify-center gap-2 rounded-md border border-border bg-card hover:bg-muted text-foreground py-2 text-sm font-medium transition cursor-pointer"
                >
                  <span>Entrar como administrador (demonstração)</span>
                  <ArrowRight size={14} />
                </button>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Entrar com outro perfil de demonstração
                  </summary>
                  <ul className="mt-2 grid gap-1.5">
                    {DEMO_LOGIN_PROFILES.filter((p) => p.role !== 'admin').map((p) => (
                      <li key={p.username}>
                        <button
                          type="button"
                          onClick={() => loginDemo(p.username)}
                          className="flex w-full items-center justify-between gap-2 rounded-[4px] border border-border bg-card px-2.5 py-2 text-left hover:bg-muted cursor-pointer"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground">{p.nome}</span>
                            <span className="block truncate text-muted-foreground">{p.resumo}</span>
                          </span>
                          <ArrowRight size={13} className="shrink-0" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">ou entre com sua conta</span>
                </div>
              </div>
            </>
          )}

          {/* Navegação entre Abas */}
          <div className="mb-5 flex rounded-md bg-muted p-1 border border-border">
            <button
              type="button"
              onClick={() => {
                setActiveTab('login');
                setLoginError('');
                setRegSuccess('');
              }}
              className={`flex-1 py-1.5 text-sm font-medium rounded transition-colors cursor-pointer ${
                activeTab === 'login'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('register');
                setRegError('');
                setLoginError('');
              }}
              className={`flex-1 py-1.5 text-sm font-medium rounded transition-colors cursor-pointer ${
                activeTab === 'register'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Solicitar cadastro
            </button>
          </div>

          {/* TAB 1: LOGIN */}
          {activeTab === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              {loginError && (
                <div className="flex items-start gap-2.5 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 text-xs text-[var(--status-error-fg)]">
                  <AlertCircle size={15} className="shrink-0 mt-0.5" />
                  <span>{loginError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Usuário ou E-mail
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                    <Mail size={14} />
                  </div>
                  <input
                    type="text"
                    required
                    value={loginIdentifier}
                    onChange={(e) => setLoginIdentifier(e.target.value)}
                    placeholder="Username/E-mail"
                    className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Senha
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                    <Lock size={14} />
                  </div>
                  <input
                    type="password"
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmittingLogin}
                aria-busy={isSubmittingLogin}
                className="w-full rounded-md bg-[var(--cta)] hover:bg-[var(--cta-hover)] py-2 text-sm font-semibold text-[var(--cta-foreground)] transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 cursor-pointer"
              >
                {isSubmittingLogin ? 'Entrando…' : 'Entrar'}
              </button>
              {/* O gateway atrasa a resposta (até ~8 s) quando há muitas tentativas seguidas:
                  sem timeout no cliente, só avisamos que a espera é normal. */}
              {isSubmittingLogin && (
                <p className="text-center text-xs text-muted-foreground" role="status">
                  A verificação pode levar alguns segundos. Aguarde sem recarregar a página.
                </p>
              )}
            </form>
          )}

          {/* TAB 2: REGISTRO / SOLICITAÇÃO */}
          {activeTab === 'register' && (
            <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
              {regError && (
                <div className="flex items-start gap-2.5 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 text-xs text-[var(--status-error-fg)]">
                  <AlertCircle size={15} className="shrink-0 mt-0.5" />
                  <span>{regError}</span>
                </div>
              )}

              {regSuccess && (
                <div className="flex items-start gap-2.5 rounded-md border border-[var(--status-success-border)] bg-[var(--status-success-bg)] p-3 text-xs text-[var(--status-success-fg)]">
                  <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
                  <span>{regSuccess}</span>
                </div>
              )}

              <div className="rounded-md border border-border bg-muted p-2.5 text-xs leading-relaxed text-muted-foreground">
                <strong className="text-foreground">Aprovação necessária:</strong> a conta só fica ativa depois que um administrador aprovar.
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Nome completo
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                    <UserIcon size={14} />
                  </div>
                  <input
                    type="text"
                    required
                    value={regNome}
                    onChange={(e) => setRegNome(e.target.value)}
                    placeholder="Ex: Carlos Silva"
                    className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  E-mail corporativo
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                    <Mail size={14} />
                  </div>
                  <input
                    type="email"
                    required
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="carlos.silva@norvia.example"
                    className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Setor
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                    <Building2 size={14} />
                  </div>
                  <select
                    value={regSetor}
                    onChange={(e) => setRegSetor(e.target.value)}
                    className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    {SETORES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Senha (mínimo 10 caracteres)
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                    <KeyRound size={14} />
                  </div>
                  <input
                    type="password"
                    required
                    minLength={10}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmittingReg}
                className="w-full rounded-md bg-[var(--cta)] hover:bg-[var(--cta-hover)] py-2 text-sm font-semibold text-[var(--cta-foreground)] transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 cursor-pointer"
              >
                {isSubmittingReg ? 'Enviando…' : 'Solicitar cadastro'}
              </button>
            </form>
          )}
        </div>

        {/* Rodapé Seguro */}
        <div className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
          <ShieldCheck size={13} />
          <span>Acesso restrito a colaboradores Norvia</span>
        </div>
      </div>
    </div>
  );
}
