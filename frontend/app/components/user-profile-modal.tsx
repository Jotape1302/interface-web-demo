'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ROLE_LABEL } from '@/lib/permissions';
import { useAuth, StatusPreset } from '@/lib/auth-context';
import {
  X,
  Camera,
  Trash2,
  Check,
  User as UserIcon,
  Briefcase,
  Mail,
  Link as LinkIcon,
} from 'lucide-react';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const STATUS_PRESETS: {
  key: StatusPreset;
  label: string;
  badgeClass: string;
  dotClass: string;
}[] = [
  {
    key: 'disponivel',
    label: 'Disponível',
    badgeClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
    dotClass: 'bg-emerald-500',
  },
  {
    key: 'ocupado',
    label: 'Ocupado',
    badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25',
    dotClass: 'bg-rose-500',
  },
  {
    key: 'reuniao',
    label: 'Em reunião',
    badgeClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25',
    dotClass: 'bg-amber-500',
  },
  {
    key: 'focado',
    label: 'Focado / Não perturbe',
    badgeClass: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/25',
    dotClass: 'bg-purple-500',
  },
  {
    key: 'almoco',
    label: 'Almoço / Pausa',
    badgeClass: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25',
    dotClass: 'bg-orange-500',
  },
  {
    key: 'ausente',
    label: 'Ausente',
    badgeClass: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/25',
    dotClass: 'bg-slate-400',
  },
];

export function getStatusPreset(key?: string | null) {
  return STATUS_PRESETS.find((p) => p.key === key) || STATUS_PRESETS[0];
}

/**
 * Redimensiona a imagem para no máximo 256x256 e gera Base64 JPEG otimizado
 */
function resizeImageToBase64(file: File, maxSize = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Falha ao processar imagem'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
    reader.readAsDataURL(file);
  });
}

export default function UserProfileModal({ isOpen, onClose }: UserProfileModalProps) {
  const { user, updateProfile } = useAuth();

  const [nome, setNome] = useState('');
  const [fotoPerfil, setFotoPerfil] = useState<string | null>(null);
  const [statusPresenca, setStatusPresenca] = useState('');
  const [statusPreset, setStatusPreset] = useState<StatusPreset>('disponivel');
  const [isUrlInputOpen, setIsUrlInputOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sincroniza estado com dados atuais do usuário ao abrir
  useEffect(() => {
    if (user && isOpen) {
      setNome(user.nome || '');
      setFotoPerfil(user.foto_perfil || null);
      setStatusPresenca(user.status_presenca || 'Disponível');
      setStatusPreset((user.status_preset as StatusPreset) || 'disponivel');
      setIsUrlInputOpen(false);
      setUrlInput('');
      setSaveFeedback(false);
    }
  }, [user, isOpen]);

  // Fecha modal com Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !user) return null;

  const currentPreset = getStatusPreset(statusPreset);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const resizedBase64 = await resizeImageToBase64(file, 256);
      setFotoPerfil(resizedBase64);
    } catch {
      alert('Não foi possível carregar a imagem selecionada.');
    }
  };

  const handleApplyUrl = () => {
    if (urlInput.trim()) {
      setFotoPerfil(urlInput.trim());
      setIsUrlInputOpen(false);
      setUrlInput('');
    }
  };

  const handleSelectPreset = (preset: typeof STATUS_PRESETS[number]) => {
    setStatusPreset(preset.key);
    setStatusPresenca(preset.label);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await updateProfile({
        nome: nome.trim() || user.nome,
        foto_perfil: fotoPerfil,
        status_presenca: statusPresenca.trim() || currentPreset.label,
        status_preset: statusPreset,
      });
      setSaveFeedback(true);
      setTimeout(() => {
        setSaveFeedback(false);
        onClose();
      }, 700);
    } catch {
      alert('Erro ao salvar alterações do perfil.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-in fade-in duration-150">
      <div
        className="relative w-full max-w-lg rounded-xl border border-border bg-card text-card-foreground shadow-lg overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-profile-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-muted/40">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--marca-ambar-suave)] text-[var(--accent-text)] border border-[var(--marca-ambar)]/30">
              <UserIcon size={16} />
            </span>
            <div>
              <h2 id="modal-profile-title" className="text-base font-bold text-foreground">
                Meu Perfil & Presença
              </h2>
              <p className="text-xs text-muted-foreground">
                Personalize sua foto, nome e status de atividade na plataforma
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-6">
          {/* Seção 1: Avatar & Foto */}
          <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-xl border border-border bg-muted/20">
            {/* Avatar Preview */}
            <div className="relative shrink-0">
              <div className="relative h-20 w-20 rounded-full overflow-hidden border border-border bg-muted flex items-center justify-center">
                {fotoPerfil ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={fotoPerfil}
                    alt={nome || 'Avatar'}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-2xl font-semibold text-[var(--accent-text)]">
                    {nome ? nome.charAt(0).toUpperCase() : user.nome.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              {/* Status Dot no Avatar */}
              <span
                className={`absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-2 border-card ${currentPreset.dotClass} shadow-sm flex items-center justify-center`}
                title={statusPresenca || currentPreset.label}
              />
            </div>

            {/* Ações de Foto */}
            <div className="flex-1 text-center sm:text-left space-y-2">
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-muted text-xs font-semibold text-foreground transition shadow-sm cursor-pointer"
                >
                  <Camera size={13} className="text-primary" />
                  <span>Alterar foto</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsUrlInputOpen((prev) => !prev)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium text-muted-foreground hover:text-foreground transition cursor-pointer"
                  title="Definir por URL externa"
                >
                  <LinkIcon size={12} />
                  <span>URL</span>
                </button>

                {fotoPerfil && (
                  <button
                    type="button"
                    onClick={() => setFotoPerfil(null)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 text-xs font-medium transition cursor-pointer"
                    title="Remover foto e restaurar iniciais"
                  >
                    <Trash2 size={12} />
                    <span>Remover</span>
                  </button>
                )}
              </div>

              {isUrlInputOpen && (
                <div className="flex items-center gap-2 pt-1 animate-in slide-in-from-top-1">
                  <input
                    type="url"
                    placeholder="https://exemplo.com/minha-foto.jpg"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    className="flex-1 px-2.5 py-1 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring/60"
                  />
                  <button
                    type="button"
                    onClick={handleApplyUrl}
                    className="px-2.5 py-1 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-[var(--brand-primary-hover)] transition cursor-pointer"
                  >
                    OK
                  </button>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                Formatos aceitos: JPG, PNG, WebP (máx. 2 MB). Ajustado automaticamente.
              </p>
            </div>
          </div>

          {/* Seção 2: Status de Atividade (Manual + Sugestões Rápidas) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-foreground uppercase tracking-wider">
                Status de Atividade
              </label>
              <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded border ${currentPreset.badgeClass}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${currentPreset.dotClass}`} />
                {currentPreset.label}
              </span>
            </div>

            {/* Campo Livre para Escrita Manual */}
            <div className="relative">
              <input
                type="text"
                value={statusPresenca}
                onChange={(e) => setStatusPresenca(e.target.value)}
                placeholder="Escreva seu status atual (ex: Focado no fechamento de pagamentos...)"
                maxLength={60}
                className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 shadow-inner focus:outline-none focus:ring-2 focus:ring-ring/60 transition"
              />
              <span className="absolute right-3 top-2.5 text-[10px] font-mono text-muted-foreground">
                {statusPresenca.length}/60
              </span>
            </div>

            {/* Sugestões Rápidas (Pills Clicáveis) */}
            <div>
              <span className="block text-[11px] font-medium text-muted-foreground mb-1.5">
                Sugestões rápidas:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_PRESETS.map((preset) => {
                  const isSelected = statusPreset === preset.key;
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      onClick={() => handleSelectPreset(preset)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition cursor-pointer ${
                        isSelected
                          ? `${preset.badgeClass} ring-2 ring-ring/50 font-semibold shadow-sm`
                          : 'border-border/60 bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${preset.dotClass}`} />
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Seção 3: Dados Cadastrais Básicos */}
          <div className="space-y-3 pt-2 border-t border-border/50">
            <div>
              <label className="block text-xs font-bold text-foreground mb-1">Nome Completo</label>
              <input
                type="text"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                required
                className="w-full rounded-xl border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 rounded-lg border border-border bg-muted/30">
                <span className="text-muted-foreground text-[11px] flex items-center gap-1">
                  <Mail size={12} />
                  E-mail institucional
                </span>
                <strong className="block truncate text-foreground text-xs mt-0.5">{user.email}</strong>
              </div>

              <div className="p-2.5 rounded-lg border border-border bg-muted/30">
                <span className="text-muted-foreground text-[11px] flex items-center gap-1">
                  <Briefcase size={12} />
                  Setor & Perfil
                </span>
                <strong className="block truncate text-foreground text-xs mt-0.5">
                  {user.setor} · {ROLE_LABEL[user.role] ?? user.role}
                </strong>
              </div>
            </div>
          </div>

          {/* Footer com Ações */}
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-lg border border-border bg-background hover:bg-muted text-foreground transition cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-primary hover:bg-[var(--brand-primary-hover)] text-primary-foreground transition shadow-sm cursor-pointer disabled:opacity-50"
            >
              {saveFeedback ? (
                <>
                  <Check size={14} className="text-white" />
                  <span>Salvo</span>
                </>
              ) : (
                <span>{isSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
