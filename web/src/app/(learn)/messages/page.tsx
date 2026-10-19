'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { roleLabel } from '@/lib/labels';
import { mergeById } from '@/lib/merge-pages';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

interface ThreadView {
  thread_id: string;
  peer: { id: string; name: string; role: string };
  last_preview: string;
  last_message_at: string | null;
  unread: number;
}

interface Message {
  id: string;
  sender_id: string;
  mine: boolean;
  body: string;
  created_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  learner: 'Learner',
  educator: 'Instructor',
  institution_admin: 'Institution',
  quality_officer: 'Quality officer',
  platform_admin: 'Admin',
};

const peerRole = (role: string) => ROLE_LABEL[role] ?? roleLabel(role);

interface Conversation {
  thread: ThreadView;
  messages: Message[];
  has_more?: boolean;
}

function Messenger() {
  const { locale } = useT();
  const { user, ready } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [status, , setError, clearStatus] = useFormStatus();
  const openedTo = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: threads } = useQuery({
    queryKey: ['dm-threads'],
    queryFn: () => api<ThreadView[]>('/messages/threads'),
    enabled: ready && !!user,
    refetchInterval: 8_000,
  });

  const { data: conversation } = useQuery({
    queryKey: ['dm-thread', activeId],
    queryFn: () => api<Conversation>(`/messages/threads/${activeId}`),
    enabled: !!activeId,
    refetchInterval: 4_000,
  });
  // Earlier messages of the open conversation, loaded on request ("Load earlier").
  const [earlier, setEarlier] = useState<{ threadId: string; messages: Message[]; has_more: boolean } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const olderMessages = earlier?.threadId === activeId ? earlier : null;
  const shown = conversation ? mergeById(olderMessages?.messages ?? [], conversation.messages) : [];
  // An API that predates paging sends no has_more: nothing earlier to offer.
  const hasEarlier = olderMessages ? olderMessages.has_more : !!conversation?.has_more;

  const { data: found } = useQuery({
    queryKey: ['directory', search],
    queryFn: () => api<{ id: string; name: string; role: string }[]>(`/profiles/directory?q=${encodeURIComponent(search)}`),
    enabled: ready && !!user && search.trim().length >= 2,
  });

  // ?to=<userId> — open (or create) that conversation once on arrival.
  useEffect(() => {
    const to = params.get('to');
    if (!to || !ready || !user || openedTo.current === to) return;
    openedTo.current = to;
    void (async () => {
      try {
        const t = await api<ThreadView>('/messages/threads', { method: 'POST', body: { recipient_id: to } });
        setActiveId(t.thread_id);
        await queryClient.invalidateQueries({ queryKey: ['dm-threads'] });
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [params, ready, user, queryClient]);

  // Refresh unread badge + thread list whenever a conversation is opened/read.
  useEffect(() => {
    if (!conversation) return;
    void queryClient.invalidateQueries({ queryKey: ['dm-unread'] });
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation, queryClient]);

  if (!ready) return <p className="page-shell text-gray-500">Loading…</p>;
  if (!user) {
    router.push('/login');
    return null;
  }

  const openWith = async (recipientId: string) => {
    clearStatus();
    setSearch('');
    try {
      const t = await api<ThreadView>('/messages/threads', { method: 'POST', body: { recipient_id: recipientId } });
      setActiveId(t.thread_id);
      await queryClient.invalidateQueries({ queryKey: ['dm-threads'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const loadEarlier = async () => {
    if (!activeId || !shown.length) return;
    setLoadingEarlier(true);
    clearStatus();
    try {
      const page = await api<Conversation>(`/messages/threads/${activeId}?before=${shown[0].id}`);
      // Freeze what is shown: the live newest page drops its oldest rows as new messages arrive.
      setEarlier({ threadId: activeId, messages: [...page.messages, ...shown], has_more: !!page.has_more });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingEarlier(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || !activeId) return;
    setDraft('');
    try {
      await api(`/messages/threads/${activeId}`, { method: 'POST', body: { body } });
      await queryClient.invalidateQueries({ queryKey: ['dm-thread', activeId] });
      await queryClient.invalidateQueries({ queryKey: ['dm-threads'] });
    } catch (err) {
      setError((err as Error).message);
      setDraft(body); // don't lose the text
    }
  };

  return (
    <div className="page-shell">
      <h1 className="text-xl font-bold">Messages</h1>
      <p className="text-sm text-gray-500">Talk directly with instructors, learners and platform staff.</p>
      <FormStatus status={status} />

      <div className="mt-4 flex min-h-[60vh] flex-col gap-4 md:flex-row">
        {/* thread list + people search */}
        <div className="w-full shrink-0 md:w-72">
          <div className="relative">
            <input
              className="input w-full"
              aria-label="Find someone by name or email"
              placeholder="Find someone (name or email)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {found && found.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card shadow-lg">
                {found.map((p) => (
                  <button key={p.id} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50" onClick={() => void openWith(p.id)}>
                    <span>{p.name}</span>
                    <span className="text-xs text-gray-500">{peerRole(p.role)}</span>
                  </button>
                ))}
              </div>
            )}
            {search.trim().length >= 2 && found && found.length === 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm text-gray-500 shadow-lg">No one found</div>
            )}
          </div>

          <ul className="mt-3 space-y-1">
            {threads?.map((t) => (
              <li key={t.thread_id}>
                <button
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 ${activeId === t.thread_id ? 'bg-brand-50' : ''}`}
                  onClick={() => setActiveId(t.thread_id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{t.peer.name}</span>
                    {t.unread > 0 && <span aria-label={`${t.unread} unread`} className="badge-count rounded-full px-1.5 text-xs font-bold">{t.unread}</span>}
                  </div>
                  <p className="truncate text-xs text-gray-500">
                    <span className="text-gray-500">{peerRole(t.peer.role)} · </span>
                    {t.last_preview || 'No messages yet'}
                  </p>
                </button>
              </li>
            ))}
            {threads?.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">No conversations yet — search for someone above.</li>}
          </ul>
        </div>

        {/* conversation */}
        <div className="flex min-h-[50vh] flex-1 flex-col rounded-xl border bg-card">
          {!activeId && <p className="m-auto text-sm text-gray-500">Select or start a conversation</p>}
          {activeId && (
            <>
              <div className="border-b px-4 py-2">
                <p className="text-sm font-semibold">{conversation?.thread.peer.name ?? '…'}</p>
                <p className="text-xs text-gray-500">{conversation ? peerRole(conversation.thread.peer.role) : ''}</p>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {hasEarlier && (
                  <div className="text-center">
                    <button className="btn-secondary text-xs" disabled={loadingEarlier} onClick={() => void loadEarlier()}>
                      {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
                    </button>
                  </div>
                )}
                {shown.map((m) => (
                  <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${m.mine ? 'brand-fill' : 'bg-gray-100 text-gray-900'}`}>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      {/* Full white: at 85% it drops under 4.5:1 at the fill's lighter end. */}
                      <p className={`mt-0.5 text-right text-xs ${m.mine ? 'text-white' : 'text-gray-500'}`}>
                        {formatDate(m.created_at, locale, 'datetime')}
                      </p>
                    </div>
                  </div>
                ))}
                {conversation && conversation.messages.length === 0 && (
                  <p className="text-center text-xs text-gray-500">Say hello</p>
                )}
                <div ref={bottomRef} />
              </div>
              <div className="flex gap-2 border-t p-3">
                <textarea
                  className="input flex-1"
                  aria-label="Message"
                  rows={1}
                  placeholder="Write a message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button className="btn" disabled={!draft.trim()} onClick={() => void send()}>
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MessagesPage() {
  return (
    <Suspense fallback={<p className="page-shell text-gray-500">Loading…</p>}>
      <Messenger />
    </Suspense>
  );
}
