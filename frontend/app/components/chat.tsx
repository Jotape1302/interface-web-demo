'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Plus, Search, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import type { DashboardConfig } from '@/lib/contracts';
import { formatDateTimeBR } from '@/lib/formatters';
import { makeDemoChatContacts, makeDemoChatConversations, makeDemoChatMessages } from '@/lib/demo';
import { setIfChanged } from '@/lib/deep-equal';
import { useDataPolling } from '@/lib/use-data-polling';

interface ChatContact {
  id: number;
  nome: string;
  username: string;
  foto_perfil?: string | null;
  setor: string;
  role: string;
}

interface ConversationSummary {
  outroUsuarioId: number;
  ultimaMensagem: string;
  enviadoEm: string;
  naoLidas: number;
}

interface DirectMessage {
  id: number;
  remetente_id: number;
  destinatario_id: number;
  conteudo: string;
  enviado_em: string;
  lida: boolean;
}

const MESSAGE_POLL_MS = 5_000;
const CONVERSATIONS_POLL_MS = 20_000;

function initials(nome: string) {
  return nome.trim().charAt(0).toUpperCase() || '?';
}

export default function Chat({ config }: { config: DashboardConfig }) {
  const { user, token, apiBaseUrl, isDemoMode } = useAuth();

  const [contacts, setContacts] = useState<ChatContact[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const authHeaders = useCallback((): Record<string, string> => ({ Authorization: `Bearer ${token}` }), [token]);

  const loadContacts = useCallback(async () => {
    if (isDemoMode) {
      setContacts(makeDemoChatContacts());
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/chat/contacts`, { headers: authHeaders() });
      if (res.ok) setContacts((await res.json()) as ChatContact[]);
    } catch {
      // silencioso — a lista de conversas já existentes ainda funciona
    }
  }, [isDemoMode, apiBaseUrl, authHeaders]);

  const loadConversations = useCallback(async (signal?: AbortSignal) => {
    if (isDemoMode) {
      setConversations(makeDemoChatConversations());
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/chat/conversations`, {
        headers: authHeaders(),
        signal,
      });
      if (res.ok) setIfChanged(setConversations, (await res.json()) as ConversationSummary[]);
    } catch {
      // idem
    }
  }, [isDemoMode, apiBaseUrl, authHeaders]);

  useEffect(() => {
    void loadContacts();
    if (isDemoMode) {
      void loadConversations();
    }
  }, [loadContacts, loadConversations, isDemoMode]);

  useDataPolling(
    (signal) => loadConversations(signal),
    {
      intervalMs: CONVERSATIONS_POLL_MS,
      enabled: !isDemoMode,
      pauseOnHidden: true,
      refetchOnVisible: true,
      realtimeEvents: ['chat', 'reconnected'],
      skipWhenRealtimeConnected: true,
    },
  );

  const loadMessages = useCallback(async (signal?: AbortSignal) => {
    if (selectedUserId === null) return;
    if (isDemoMode) {
      setMessages(makeDemoChatMessages(selectedUserId));
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/chat/messages/${selectedUserId}`, {
        headers: authHeaders(),
        signal,
      });
      if (res.ok) setIfChanged(setMessages, (await res.json()) as DirectMessage[]);
    } catch {
      // mantém a última lista carregada em caso de falha pontual
    }
  }, [selectedUserId, isDemoMode, apiBaseUrl, authHeaders]);

  // Sem contato selecionado, `loadMessages` não faz nada; a troca de contato busca na hora via refresh.
  const { refresh: refreshMessages } = useDataPolling(
    (signal) => loadMessages(signal),
    {
      intervalMs: MESSAGE_POLL_MS,
      enabled: !isDemoMode,
      pauseOnHidden: true,
      refetchOnVisible: true,
      realtimeEvents: ['chat', 'reconnected'],
      skipWhenRealtimeConnected: true,
    },
  );

  useEffect(() => {
    if (selectedUserId === null) return;
    if (isDemoMode) {
      void loadMessages();
    } else {
      void refreshMessages();
      void fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/chat/messages/${selectedUserId}/read`, {
        method: 'POST',
        headers: authHeaders(),
      }).catch(() => {});
    }
    setConversations((prev) => prev.map((c) => (c.outroUsuarioId === selectedUserId ? { ...c, naoLidas: 0 } : c)));
  }, [selectedUserId, loadMessages, refreshMessages, isDemoMode, apiBaseUrl, authHeaders]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const texto = draft.trim();
    if (!texto || selectedUserId === null || !user) return;
    setSending(true);
    setDraft('');
    const optimistic: DirectMessage = {
      id: Date.now(),
      remetente_id: user.id,
      destinatario_id: selectedUserId,
      conteudo: texto,
      enviado_em: new Date().toISOString(),
      lida: false,
    };
    setMessages((prev) => [...prev, optimistic]);
    setConversations((prev) => {
      const exists = prev.find((c) => c.outroUsuarioId === selectedUserId);
      const updated = { outroUsuarioId: selectedUserId, ultimaMensagem: texto, enviadoEm: optimistic.enviado_em, naoLidas: 0 };
      return exists
        ? prev.map((c) => (c.outroUsuarioId === selectedUserId ? updated : c))
        : [updated, ...prev];
    });

    if (!isDemoMode) {
      try {
        await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/chat/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ destinatarioId: selectedUserId, conteudo: texto }),
        });
        void loadMessages();
      } catch {
        // a mensagem otimista permanece na tela mesmo se o envio falhar em segundo plano
      }
    }
    setSending(false);
  };

  const contactsNotInConversation = contacts.filter(
    (c) => !conversations.some((conv) => conv.outroUsuarioId === c.id),
  );
  const filteredNewContacts = contactSearch.trim()
    ? contactsNotInConversation.filter((c) => c.nome.toLowerCase().includes(contactSearch.trim().toLowerCase()))
    : contactsNotInConversation;

  const contactById = (id: number) => contacts.find((c) => c.id === id);
  const selectedContact = selectedUserId !== null ? contactById(selectedUserId) : null;

  return (
    <>
      <div className="space-y-1 mb-4">
        <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
          <MessageCircle size={20} className="text-primary" />
          Chat
        </h1>
        <p className="text-xs text-muted-foreground">
          Mensagens diretas entre qualquer colaborador, independente de setor ou nível.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4 h-[calc(100vh-220px)] min-h-[420px]">
        {/* Lista de conversas */}
        <div className="rounded-xl border border-border bg-card flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/60">
            <span className="text-xs font-bold text-foreground uppercase tracking-wider">Conversas</span>
            <button
              type="button"
              onClick={() => setShowContactPicker((v) => !v)}
              className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-primary transition cursor-pointer"
              title="Nova conversa"
            >
              {showContactPicker ? <X size={15} /> : <Plus size={15} />}
            </button>
          </div>

          {showContactPicker ? (
            <div className="flex-1 overflow-y-auto">
              <div className="p-2 sticky top-0 bg-card border-b border-border/40">
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Buscar colaborador..."
                    className="w-full rounded-lg border border-border bg-background pl-7 pr-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring/60"
                  />
                </div>
              </div>
              {filteredNewContacts.length === 0 ? (
                <p className="p-3.5 text-xs text-muted-foreground text-center">Nenhum colaborador encontrado.</p>
              ) : (
                filteredNewContacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelectedUserId(c.id);
                      setShowContactPicker(false);
                      setContactSearch('');
                    }}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-muted/40 transition cursor-pointer border-b border-border/30 last:border-0"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold bg-[var(--marca-ambar-suave)] text-[var(--accent-text)] border border-[var(--marca-ambar)]/30">
                      {initials(c.nome)}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{c.nome}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{c.setor}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {conversations.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  Nenhuma conversa ainda.
                  <br />
                  Clique em <Plus size={11} className="inline" /> para começar.
                </div>
              ) : (
                conversations
                  .slice()
                  .sort((a, b) => (a.enviadoEm < b.enviadoEm ? 1 : -1))
                  .map((conv) => {
                    const contact = contactById(conv.outroUsuarioId);
                    const isActive = selectedUserId === conv.outroUsuarioId;
                    return (
                      <button
                        key={conv.outroUsuarioId}
                        type="button"
                        onClick={() => setSelectedUserId(conv.outroUsuarioId)}
                        className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition cursor-pointer border-b border-border/30 last:border-0 ${
                          isActive ? 'bg-[var(--marca-ambar-suave)]' : 'hover:bg-muted/40'
                        }`}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold bg-[var(--marca-ambar-suave)] text-[var(--accent-text)] border border-[var(--marca-ambar)]/30">
                          {initials(contact?.nome || `Usuário #${conv.outroUsuarioId}`)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-1">
                            <p className="text-xs font-semibold text-foreground truncate">
                              {contact?.nome || `Usuário #${conv.outroUsuarioId}`}
                            </p>
                            {conv.naoLidas > 0 && (
                              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white shrink-0">
                                {conv.naoLidas}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate">{conv.ultimaMensagem}</p>
                        </div>
                      </button>
                    );
                  })
              )}
            </div>
          )}
        </div>

        {/* Thread de mensagens */}
        <div className="rounded-xl border border-border bg-card flex flex-col overflow-hidden">
          {!selectedContact ? (
            <div className="flex-1 flex items-center justify-center text-center text-xs text-muted-foreground p-6">
              Selecione uma conversa ou inicie uma nova pra começar a conversar.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/60">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold bg-[var(--marca-ambar-suave)] text-[var(--accent-text)] border border-[var(--marca-ambar)]/30">
                  {initials(selectedContact.nome)}
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{selectedContact.nome}</p>
                  <p className="text-[10px] text-muted-foreground">{selectedContact.setor}</p>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                {messages.map((m) => {
                  const mine = m.remetente_id === user?.id;
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] rounded-xl px-3 py-2 text-xs ${
                          mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.conteudo}</p>
                        <p className={`text-[9px] mt-1 font-mono ${mine ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                          {formatDateTimeBR(m.enviado_em)}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2.5 border-t border-border/60">
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Escreva uma mensagem..."
                  className="flex-1 rounded-xl border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                />
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={sending || !draft.trim()}
                  className="bg-primary hover:bg-[var(--brand-primary-hover)] text-primary-foreground shrink-0"
                >
                  <Send size={14} />
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
