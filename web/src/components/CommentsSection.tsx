'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

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

interface CommentNode extends CommentRow {
  children: CommentNode[];
}

const ROLE_BADGES: Record<string, string> = {
  educator: 'Instructor',
  institution_admin: 'Institution',
  quality_officer: 'Quality',
  platform_admin: 'Admin',
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
  const queryClient = useQueryClient();
  const { data: rows } = useQuery({
    queryKey: ['comments', courseId],
    queryFn: () => api<CommentRow[]>(`/courses/${courseId}/comments`, { auth: false }),
    refetchInterval: 15_000,
  });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tree = useMemo(() => buildTree(rows ?? []), [rows]);
  const count = rows?.filter((r) => !r.deleted).length ?? 0;

  const post = async (body: string, parentId?: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`/courses/${courseId}/comments`, { method: 'POST', body: { body, ...(parentId ? { parent_id: parentId } : {}) } });
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['comments', courseId] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/comments/${id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['comments', courseId] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card" id="comments">
      <h2 className="font-semibold">💬 Discussion {count > 0 && <span className="text-sm font-normal text-gray-500">({count})</span>}</h2>

      {ready && user ? (
        <div className="mt-3">
          <textarea
            className="input"
            rows={2}
            placeholder="Ask a question or share something with the class…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-1 flex items-center justify-between">
            {error ? <p className="text-xs text-red-600">{error}</p> : <span />}
            <button className="btn text-sm" disabled={busy || draft.trim().length === 0} onClick={() => void post(draft)}>
              Post comment
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-gray-500">
          <Link className="text-brand-700 underline" href="/login">Sign in</Link> to join the discussion.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {tree.length === 0 && <p className="text-sm text-gray-400">No comments yet — start the conversation.</p>}
        {tree.map((node) => (
          <CommentItem key={node.id} node={node} me={user?.id} myRole={user?.role} onReply={post} onDelete={remove} depth={0} />
        ))}
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
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const canDelete = me && !node.deleted && (node.author_id === me || myRole === 'platform_admin' || myRole === 'quality_officer');
  const badge = ROLE_BADGES[node.author_role];

  return (
    <div className={depth > 0 ? 'ml-4 border-l-2 border-gray-100 pl-3 sm:ml-6 sm:pl-4' : ''}>
      <div className="text-sm">
        {node.deleted ? (
          <p className="italic text-gray-400">[comment removed]</p>
        ) : (
          <>
            <p>
              <span className="font-medium">{node.author_name}</span>
              {badge && <span className="ml-1.5 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">{badge}</span>}
              <span className="ml-2 text-xs text-gray-400">{new Date(node.created_at).toLocaleString()}</span>
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-gray-800">{node.body}</p>
          </>
        )}
        <div className="mt-1 flex gap-3 text-xs">
          {me && !node.deleted && (
            <button className="text-brand-700 hover:underline" onClick={() => setReplying((r) => !r)}>
              {replying ? 'Cancel' : 'Reply'}
            </button>
          )}
          {me && !node.deleted && node.author_id !== me && (
            <Link className="text-gray-500 hover:text-brand-700 hover:underline" href={`/messages?to=${node.author_id}`}>
              Message
            </Link>
          )}
          {canDelete && (
            <button className="text-red-500 hover:underline" onClick={() => onDelete(node.id)}>
              Delete
            </button>
          )}
        </div>
        {replying && (
          <div className="mt-2">
            <textarea className="input" rows={2} autoFocus placeholder={`Reply to ${node.author_name}…`} value={reply} onChange={(e) => setReply(e.target.value)} />
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
              Post reply
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
