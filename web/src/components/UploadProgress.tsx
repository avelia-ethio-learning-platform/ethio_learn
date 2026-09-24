'use client';

import { Pause, Play, X } from 'lucide-react';
import { formatBytes, formatEta, type UploadState } from '@/lib/upload';

function phaseText(state: UploadState): string {
  switch (state.phase) {
    case 'preparing':
      // The API runs on a free tier that sleeps; the first request can take ~20 s.
      return 'Preparing (server waking up…)';
    case 'uploading':
      return 'Uploading';
    case 'paused':
      return state.error ? `Paused — ${state.error}` : 'Paused';
    case 'reconnecting':
      return `Reconnecting in ${state.retryInSeconds ?? 0}s`;
    case 'finalizing':
      return state.retryInSeconds !== undefined ? `Finalizing — retrying in ${state.retryInSeconds}s` : 'Finalizing';
    case 'done':
      return 'Done';
    case 'failed':
      return `Failed: ${state.error ?? 'unknown error — try again.'}`;
  }
}

/** Progress for one file upload: bar, bytes, speed/ETA and optional Pause / Resume / Cancel. */
export function UploadProgress({
  fileName,
  state,
  onPause,
  onResume,
  onCancel,
}: {
  fileName: string;
  state: UploadState;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(state.percent)));
  const moving = state.phase === 'uploading' || state.phase === 'reconnecting';
  const canPause = onPause && (state.phase === 'preparing' || moving);
  const canResume = onResume && state.phase === 'paused';
  // Once the server has been asked to finish (finalizing, or paused after that), it may already have
  // attached the file; a Cancel there would say "cancelled" while the lesson has the new video.
  const canCancel = onCancel && !state.committed && state.phase !== 'finalizing' && state.phase !== 'done' && state.phase !== 'failed';
  const tone = state.phase === 'failed' ? 'text-red-500' : state.phase === 'done' ? 'text-green-600' : 'text-gray-500';

  return (
    <div className="glass-secondary mt-2 rounded-xl px-3.5 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-medium text-foreground" title={fileName}>
          {fileName}
        </span>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-gray-600">{percent}%</span>
      </div>
      <div
        className="progress-track mt-2"
        role="progressbar"
        aria-label={`Upload progress for ${fileName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={`progress-fill ${state.phase === 'failed' ? '!bg-red-500' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className={`font-medium ${tone}`} aria-live="polite">
          {phaseText(state)}
        </span>
        <span className="tabular-nums text-gray-500">
          {formatBytes(state.loaded)} of {formatBytes(state.total)}
          {moving && state.speedBps !== null && (
            <>
              {' · '}
              {formatBytes(state.speedBps)}/s · {formatEta(state.etaSeconds)}
            </>
          )}
        </span>
      </div>
      {(canPause || canResume || canCancel) && (
        <div className="mt-2 flex gap-2">
          {canPause && (
            <button type="button" className="btn-secondary !px-3 !py-1 !text-xs" onClick={onPause}>
              <Pause className="h-3 w-3" /> Pause
            </button>
          )}
          {canResume && (
            <button type="button" className="btn-secondary !px-3 !py-1 !text-xs" onClick={onResume}>
              <Play className="h-3 w-3" /> Resume
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn-ghost !px-3 !py-1 !text-xs" onClick={onCancel}>
              <X className="h-3 w-3" /> Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
