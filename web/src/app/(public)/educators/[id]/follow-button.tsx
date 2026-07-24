'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

/**
 * Follow / unfollow an instructor for new-course alerts. Only shown to signed-in
 * users who aren't this instructor. Optimistic feel: the label flips instantly
 * on click and the query refetches to confirm.
 */
export function FollowInstructorButton({ instructorId }: { instructorId: string }) {
  const { user, ready } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['following', instructorId],
    queryFn: () => api<{ following: boolean }>(`/notifications/following/${instructorId}`),
    enabled: ready && !!user && user.id !== instructorId,
  });

  if (!ready || !user || user.id === instructorId) return null;
  const following = !!data?.following;

  const toggle = async () => {
    // optimistic flip
    qc.setQueryData(['following', instructorId], { following: !following });
    try {
      await api(`/notifications/${following ? 'unfollow' : 'follow'}/${instructorId}`, { method: 'POST' });
    } catch {
      qc.setQueryData(['following', instructorId], { following }); // revert
    }
    qc.invalidateQueries({ queryKey: ['following', instructorId] });
  };

  return (
    <button
      onClick={toggle}
      disabled={isLoading}
      aria-pressed={following}
      className={`group shrink-0 rounded-md px-4 py-2 text-sm font-semibold transition active:scale-95 ${
        following
          ? 'bg-brand-100 text-brand-800 hover:bg-red-50 hover:text-red-600'
          : 'bg-brand-700 text-white hover:bg-brand-800'
      }`}
      title={following ? 'You get alerts when this instructor posts a new course' : 'Get alerts when this instructor posts a new course'}
    >
      {following ? (
        <>
          <span className="group-hover:hidden">✓ Following</span>
          <span className="hidden group-hover:inline">Unfollow</span>
        </>
      ) : (
        <>＋ Follow</>
      )}
    </button>
  );
}
