'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { formatDate } from '@/lib/format';
import { mergeById } from '@/lib/merge-pages';
import { useT, type TKey } from '@/lib/i18n';
import { MessageSquare } from 'lucide-react';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { usePollInterval } from '@/lib/use-poll-interval';

interface CommentRow {
  id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string;
  author_role: string;
  body: string;
  deleted: boolean;
  created_at: string;
}

export interface CommentsPage {
  items: CommentRow[];
  has_more: boolean;
}

/**
 * The API answers `{ items, has_more }` when asked (`paged=1`) and a bare array
 * otherwise: an API that predates paging, or a response the service worker
 * cached, still renders.
 */
export function normalizeComments(data: CommentRow[] | CommentsPage): CommentsPage {
  return Array.isArray(data) ? { items: data, has_more: false } : data;
}

interface CommentNode extends CommentRow {
  children: CommentNode[];
}

const ROLE_BADGES: Record<string, TKey> = {
  educator: 'role_instructor',
  institution_admin: 'institution',
  quality_officer: 'role_quality',
  platform_admin: 'admin',
};

function buildTree(rows: CommentRow[]): CommentNode[] {
  const byId = new Map<string, CommentNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: CommentNode[] = [];
  for (const node of Array.from(byId.values())) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Newest top-level threads first; replies stay oldest-first (conversation order).
  roots.reverse();
  return roots;
}

export function CommentsSection({ courseId }: { courseId: string }) {
  const { user, ready } = useAuth();
  const { t } = useT();
  const queryClient = useQueryClient();
  const pollMs = usePollInterval(15_000);
  const { data: latest } = useQuery({
    queryKey: ['comments', courseId],
    queryFn: async () => normalizeComments(await api<CommentRow[] | CommentsPage>(`/courses/${courseId}/comments?paged=1`, { auth: false })),
    refetchInterval: pollMs,
    refetchOnWindowFocus: 'always',
  });
  // Everything shown when "Load earlier" was last used, plus the older page; the
  // newest page keeps refreshing on its own and its copy of a row wins.
  const [earlier, setEarlier] = useState<CommentsPage | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const rows = useMemo(() => mergeById(earlier?.items ?? [], latest?.items ?? []), [earlier, latest]);
  const hasEarlier = earlier ? earlier.has_more : !!latest?.has_more;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, , setError, clearStatus] = useFormStatus();

  const tree = useMemo(() => buildTree(rows), [rows]);
  const count = rows.filter((r) => !r.deleted).length;

  const post = async (body: string, parentId?: string) => {
    setBusy(true);
    clearStatus();
    try {
      const created = await api<CommentRow>(`/courses/${courseId}/comments`, { method: 'POST', body: { body, ...(parentId ? { parent_id: parentId } : {}) } });
      setDraft('');
      // A reply under an earlier-loaded discussion isn't on the newest page: keep it in view.
      setEarlier((prev) => (prev ? { ...prev, items: [...prev.items, created] } : prev));
      await queryClient.invalidateQueries({ queryKey: ['comments', courseId] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const loadEarlier = async () => {
    const oldest = rows.find((r) => !r.parent_id);
    if (!oldest) return;
    setLoadingEarlier(true);
    clearStatus();
    try {
      const page = normalizeComments(await api<CommentRow[] | CommentsPage>(`/courses/${courseId}/comments?before=${oldest.id}`, { auth: false }));
      setEarlier({ items: [...page.items, ...rows], has_more: page.has_more });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingEarlier(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/comments/${id}`, { method: 'DELETE' });
      setEarlier((prev) =>
        prev ? { ...prev, items: prev.items.map((r) => (r.id === id ? { ...r, deleted: true, body: '', author_name: '' } : r)) } : prev,
      );
      await queryClient.invalidateQueries({ queryKey: ['comments', courseId] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card" id="comments">
      <h2 className="flex items-center gap-2 font-semibold">
        <MessageSquare aria-hidden="true" className="h-4 w-4 text-brand-500" /> {t('discussion')} {count > 0 && <span className="text-sm font-normal text-gray-500">({count}{hasEarlier ? '+' : ''})</span>}
      </h2>

      {ready && user ? (
        <div className="mt-3">
          <Field label={t('add_comment')}>
            {(ids) => (
              <textarea
                {...ids}
                className="input"
                rows={2}
                placeholder={t('comment_placeholder')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </Field>
          <div className="mt-1 flex items-center justify-between">
            <FormStatus status={status} />
            <button className="btn text-sm" disabled={busy || draft.trim().length === 0} onClick={() => void post(draft)}>
              {t('post_comment')}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-gray-500">
          <Link className="text-brand-700 underline" href="/login">{t('signin_to_discuss')}</Link>
        </p>
      )}

      <div className="mt-4 space-y-4">
        {tree.length === 0 && <p className="text-sm text-gray-500">{t('no_comments')}</p>}
        {tree.map((node) => (
          <CommentItem key={node.id} node={node} me={user?.id} myRole={user?.role} onReply={post} onDelete={remove} depth={0} />
        ))}
        {hasEarlier && (
          <button className="btn-secondary text-sm" disabled={loadingEarlier} onClick={() => void loadEarlier()}>
            {loadingEarlier ? t('loading') : t('load_earlier_comments')}
          </button>
        )}
      </div>
    </div>
  );
}

function CommentItem({
  node,
  me,
  myRole,
  onReply,
  onDelete,
  depth,
}: {
  node: CommentNode;
  me?: string;
  myRole?: string;
  onReply: (body: string, parentId: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  depth: number;
}) {
  const { locale, t } = useT();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const canDelete = me && !node.deleted && (node.author_id === me || myRole === 'platform_admin' || myRole === 'quality_officer');
  const badge = ROLE_BADGES[node.author_role];

  return (
    <div className={depth > 0 ? 'ml-4 border-l-2 border-gray-100 pl-3 sm:ml-6 sm:pl-4' : ''}>
      <div className="text-sm">
        {node.deleted ? (
          <p className="italic text-gray-500">{t('comment_removed')}</p>
        ) : (
          <>
            <p>
              <span className="font-medium">{node.author_name}</span>
              {badge && <span className="ml-1.5 rounded bg-brand-50 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-brand-700">{t(badge)}</span>}
              <span className="ml-2 text-xs text-gray-500">{formatDate(node.created_at, locale, 'datetime')}</span>
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-gray-800">{node.body}</p>
          </>
        )}
        <div className="mt-1 flex gap-3 text-xs">
          {me && !node.deleted && (
            <button className="text-brand-700 hover:underline" onClick={() => setReplying((r) => !r)}>
              {replying ? t('cancel') : t('reply')}
            </button>
          )}
          {me && !node.deleted && node.author_id !== me && (
            <Link className="text-gray-500 hover:text-brand-700 hover:underline" href={`/messages?to=${node.author_id}`}>
              {t('message_user')}
            </Link>
          )}
          {canDelete && (
            <button className="text-danger hover:underline" onClick={() => onDelete(node.id)}>
              {t('delete')}
            </button>
          )}
        </div>
        {replying && (
          <div className="mt-2">
            <textarea className="input" rows={2} autoFocus aria-label={t('reply_to', { name: node.author_name })} placeholder={`${t('reply_to', { name: node.author_name })}…`} value={reply} onChange={(e) => setReply(e.target.value)} />
            <button
              className="btn-secondary mt-1 text-xs"
              disabled={busy || reply.trim().length === 0}
              onClick={async () => {
                setBusy(true);
                if (await onReply(reply, node.id)) {
                  setReply('');
                  setReplying(false);
                }
                setBusy(false);
              }}
            >
              {t('post_reply')}
            </button>
          </div>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="mt-3 space-y-3">
          {node.children.map((child) => (
            <CommentItem key={child.id} node={child} me={me} myRole={myRole} onReply={onReply} onDelete={onDelete} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
