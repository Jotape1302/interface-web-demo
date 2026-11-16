'use client';

import { ModalShell } from './modal-shell';
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ThemeToggle } from './theme-provider';
import {
  X,
  Settings as SettingsIcon,
  Palette,
  UserCog,
  Mail,
  KeyRound,
  Check,
  Clock3,
  AlertCircle,
} from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Availability = 'idle' | 'checking' | 'available' | 'unavailable';

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const {
    user,
    pendingChangeRequests,
    checkUsernameAvailable,
    checkEmailAvailable,
    requestUsernameChange,
    requestEmailChange,
    changePassword,
  } = useAuth();

  const [novoUsername, setNovoUsername] = useState('');
  const [usernameAvailability, setUsernameAvailability] = useState<Availability>('idle');
  const [usernameSubmitting, setUsernameSubmitting] = useState(false);
  const [usernameFeedback, setUsernameFeedback] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const [novoEmail, setNovoEmail] = useState('');
  const [emailAvailability, setEmailAvailability] = useState<Availability>('idle');
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [senhaAtual, setSenhaAtual] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmarSenha, setConfirmarSenha] = useState('');
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    setNovoUsername('');
    setUsernameAvailability('idle');
    setUsernameFeedback(null);
    setUsernameError(null);
    setNovoEmail('');
    setEmailAvailability('idle');
    setEmailFeedback(null);
    setEmailError(null);
    setSenhaAtual('');
    setNovaSenha('');
    setConfirmarSenha('');
    setPasswordFeedback(null);
    setPasswordError(null);
  }, [isOpen]);


  // Checagem de disponibilidade com debounce, mesma lógica pros dois campos.
  useEffect(() => {
    const value = novoUsername.trim();
    if (!value || value === user?.username) {
      // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
      setUsernameAvailability('idle');
      return;
    }
    setUsernameAvailability('checking');
    const timeout = setTimeout(async () => {
      const available = await checkUsernameAvailable(value);
      setUsernameAvailability(available ? 'available' : 'unavailable');
    }, 500);
    return () => clearTimeout(timeout);
  }, [novoUsername, user?.username, checkUsernameAvailable]);

  useEffect(() => {
    const value = novoEmail.trim();
    if (!value || value === user?.email) {
      // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
      setEmailAvailability('idle');
      return;
    }
    setEmailAvailability('checking');
    const timeout = setTimeout(async () => {
      const available = await checkEmailAvailable(value);
      setEmailAvailability(available ? 'available' : 'unavailable');
    }, 500);
    return () => clearTimeout(timeout);
  }, [novoEmail, user?.email, checkEmailAvailable]);

  if (!isOpen || !user) return null;

  const pendingUsername = pendingChangeRequests.find((r) => r.tipo === 'username' && r.status === 'pending');
  const pendingEmail = pendingChangeRequests.find((r) => r.tipo === 'email' && r.status === 'pending');

  const handleSubmitUsername = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setUsernameError(null);
    setUsernameSubmitting(true);
    try {
      await requestUsernameChange(novoUsername.trim());
      setUsernameFeedback('Solicitação enviada! Aguardando aprovação do administrador.');
      setNovoUsername('');
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : 'Falha ao solicitar alteração.');
    } finally {
      setUsernameSubmitting(false);
    }
  };

  const handleSubmitEmail = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setEmailError(null);
    setEmailSubmitting(true);
    try {
      await requestEmailChange(novoEmail.trim());
      setEmailFeedback('Solicitação enviada! Aguardando aprovação do administrador.');
      setNovoEmail('');
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Falha ao solicitar alteração.');
    } finally {
      setEmailSubmitting(false);
    }
  };

  const handleSubmitPassword = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPasswordError(null);
    if (novaSenha.length < 10) {
      setPasswordError('A nova senha deve ter no mínimo 10 caracteres.');
      return;
    }
    if (novaSenha !== confirmarSenha) {
      setPasswordError('A confirmação não coincide com a nova senha.');
      return;
    }
    setPasswordSubmitting(true);
    try {
      await changePassword(senhaAtual, novaSenha);
      setPasswordFeedback('Senha alterada com sucesso!');
      setSenhaAtual('');
      setNovaSenha('');
      setConfirmarSenha('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Falha ao trocar senha.');
    } finally {
      setPasswordSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={onClose} labelledBy="modal-settings-title" className="relative w-full max-w-lg rounded-none border border-border bg-card text-card-foreground shadow-lg overflow-hidden animate-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-muted/40 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-none bg-[var(--marca-ambar-suave)] text-[var(--accent-text)] border border-[var(--marca-ambar)]/30">
              <SettingsIcon size={16} />
            </span>
            <div>
              <h2 id="modal-settings-title" className="text-base font-bold text-foreground">
                Configurações
              </h2>
              <p className="text-xs text-muted-foreground">Aparência, usuário, e-mail e senha</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-none p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Aparência */}
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Palette size={13} className="text-primary" />
              Aparência
            </h3>
            <div className="flex items-center justify-between p-3 rounded-none border border-border bg-muted/20">
              <span className="text-xs text-muted-foreground">Tema da interface</span>
              <ThemeToggle />
            </div>
          </section>

          {/* Nome de usuário */}
          <section className="space-y-2 pt-2 border-t border-border/50">
            <label htmlFor="settings-modal-campo-203" className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-1.5">
              <UserCog size={13} className="text-primary" />
              Nome de Usuário
            </label>
            <p className="text-[11px] text-muted-foreground">
              Atual: <strong className="text-foreground font-mono">{user.username}</strong>
            </p>

            {pendingUsername ? (
              <div className="flex items-start gap-2 p-3 rounded-none bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-400 text-xs">
                <Clock3 size={14} className="shrink-0 mt-0.5" />
                <span>
                  Solicitação de troca para <strong className="font-mono">{pendingUsername.valor_novo}</strong> aguardando
                  aprovação do administrador.
                </span>
              </div>
            ) : (
              <form onSubmit={handleSubmitUsername} className="space-y-1.5">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <input id="settings-modal-campo-203"
                      type="text"
                      value={novoUsername}
                      onChange={(e) => setNovoUsername(e.target.value)}
                      placeholder="novo_usuario"
                      className="w-full rounded-none border border-border bg-background px-3.5 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                    />
                    {novoUsername.trim() && novoUsername.trim() !== user.username && (
                      <span
                        className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold ${
                          usernameAvailability === 'available'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : usernameAvailability === 'unavailable'
                              ? 'text-rose-500'
                              : 'text-muted-foreground'
                        }`}
                      >
                        {usernameAvailability === 'checking'
                          ? 'Verificando...'
                          : usernameAvailability === 'available'
                            ? 'Disponível'
                            : usernameAvailability === 'unavailable'
                              ? 'Em uso'
                              : ''}
                      </span>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={
                      usernameSubmitting ||
                      !novoUsername.trim() ||
                      novoUsername.trim() === user.username ||
                      usernameAvailability !== 'available'
                    }
                    className="px-3.5 py-2 text-xs font-semibold rounded-none bg-primary hover:bg-[var(--brand-primary-hover)] text-primary-foreground transition shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    {usernameSubmitting ? 'Enviando...' : 'Solicitar'}
                  </button>
                </div>
                {usernameFeedback && (
                  <p className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                    <Check size={12} /> {usernameFeedback}
                  </p>
                )}
                {usernameError && (
                  <p className="flex items-center gap-1 text-[11px] text-rose-500">
                    <AlertCircle size={12} /> {usernameError}
                  </p>
                )}
              </form>
            )}
          </section>

          {/* E-mail */}
          <section className="space-y-2 pt-2 border-t border-border/50">
            <label htmlFor="settings-modal-campo-279" className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Mail size={13} className="text-primary" />
              E-mail
            </label>
            <p className="text-[11px] text-muted-foreground">
              Atual: <strong className="text-foreground">{user.email}</strong>
            </p>

            {pendingEmail ? (
              <div className="flex items-start gap-2 p-3 rounded-none bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-400 text-xs">
                <Clock3 size={14} className="shrink-0 mt-0.5" />
                <span>
                  Solicitação de troca para <strong>{pendingEmail.valor_novo}</strong> aguardando aprovação do
                  administrador.
                </span>
              </div>
            ) : (
              <form onSubmit={handleSubmitEmail} className="space-y-1.5">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <input id="settings-modal-campo-279"
                      type="email"
                      value={novoEmail}
                      onChange={(e) => setNovoEmail(e.target.value)}
                      placeholder="novo@norvia.example"
                      className="w-full rounded-none border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                    />
                    {novoEmail.trim() && novoEmail.trim() !== user.email && (
                      <span
                        className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold ${
                          emailAvailability === 'available'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : emailAvailability === 'unavailable'
                              ? 'text-rose-500'
                              : 'text-muted-foreground'
                        }`}
                      >
                        {emailAvailability === 'checking'
                          ? 'Verificando...'
                          : emailAvailability === 'available'
                            ? 'Disponível'
                            : emailAvailability === 'unavailable'
                              ? 'Em uso'
                              : ''}
                      </span>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={
                      emailSubmitting ||
                      !novoEmail.trim() ||
                      novoEmail.trim() === user.email ||
                      emailAvailability !== 'available'
                    }
                    className="px-3.5 py-2 text-xs font-semibold rounded-none bg-primary hover:bg-[var(--brand-primary-hover)] text-primary-foreground transition shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    {emailSubmitting ? 'Enviando...' : 'Solicitar'}
                  </button>
                </div>
                {emailFeedback && (
                  <p className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                    <Check size={12} /> {emailFeedback}
                  </p>
                )}
                {emailError && (
                  <p className="flex items-center gap-1 text-[11px] text-rose-500">
                    <AlertCircle size={12} /> {emailError}
                  </p>
                )}
              </form>
            )}
          </section>

          {/* Senha */}
          <section className="space-y-2 pt-2 border-t border-border/50">
            <label htmlFor="settings-modal-campo-355" className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-1.5">
              <KeyRound size={13} className="text-primary" />
              Senha
            </label>
            <p className="text-[11px] text-muted-foreground">
              A troca de senha é imediata, sem aprovação do administrador.
            </p>
            <form onSubmit={handleSubmitPassword} className="space-y-2">
              <input id="settings-modal-campo-355"
                type="password"
                value={senhaAtual}
                onChange={(e) => setSenhaAtual(e.target.value)}
                placeholder="Senha atual"
                required
                className="w-full rounded-none border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="password"
                  value={novaSenha}
                  onChange={(e) => setNovaSenha(e.target.value)}
                  placeholder="Nova senha"
                  minLength={10}
                  required
                  className="w-full rounded-none border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                />
                <input
                  type="password"
                  value={confirmarSenha}
                  onChange={(e) => setConfirmarSenha(e.target.value)}
                  placeholder="Confirmar nova senha"
                  minLength={10}
                  required
                  className="w-full rounded-none border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={passwordSubmitting}
                  className="px-3.5 py-2 text-xs font-semibold rounded-none bg-primary hover:bg-[var(--brand-primary-hover)] text-primary-foreground transition shadow-sm cursor-pointer disabled:opacity-50"
                >
                  {passwordSubmitting ? 'Salvando...' : 'Trocar Senha'}
                </button>
              </div>
              {passwordFeedback && (
                <p className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                  <Check size={12} /> {passwordFeedback}
                </p>
              )}
              {passwordError && (
                <p className="flex items-center gap-1 text-[11px] text-rose-500">
                  <AlertCircle size={12} /> {passwordError}
                </p>
              )}
            </form>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-none border border-border bg-background hover:bg-muted text-foreground transition cursor-pointer"
          >
            Fechar
          </button>
        </div>
    </ModalShell>
  );
}
