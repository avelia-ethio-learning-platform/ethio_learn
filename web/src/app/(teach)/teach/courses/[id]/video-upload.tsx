'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ImagePlus, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import {
  discardResumableUpload,
  fingerprintKey,
  listResumableUploads,
  ResumableUpload,
  resolveContentType,
  UploadCancelledError,
  usesMultipart,
  VIDEO_ACCEPT,
  type ResumableUploadInfo,
  type UploadState,
} from '@/lib/upload';
import { UploadProgress } from '@/components/UploadProgress';
import { groupUploadHints } from './working';

export const UNSUPPORTED_VIDEO =
  "This video format isn't supported. Upload an MP4 (H.264), WebM or MOV file — convert other formats to MP4 (H.264) first.";

/** Why submitting is blocked while a lesson video is still uploading. */
export const WAIT_FOR_UPLOAD = 'Wait for the video upload to finish before submitting — a video still uploading would be left out of the review.';

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
/** How long a finished upload's "Done" bar stays on the lesson row. */
const DONE_LINGER_MS = 4000;

interface LessonUpload {
  courseId: string;
  fileName: string;
  multipart: boolean;
  state: UploadState;
  upload: ResumableUpload;
}

interface UploadsApi {
  uploads: Record<string, LessonUpload>;
  hints: Record<string, ResumableUploadInfo[]>;
  orphanHints: ResumableUploadInfo[];
  /** Upload a video into an existing lesson. Returns an error message when the file is rejected up front. */
  start: (lessonId: string, file: File) => string | null;
  dismiss: (lessonId: string) => void;
  discardHint: (storageKey: string) => Promise<void>;
}

const UploadsContext = createContext<UploadsApi | null>(null);

function useUploads(): UploadsApi {
  const ctx = useContext(UploadsContext);
  if (!ctx) throw new Error('useUploads must be used inside <LessonUploadsProvider>');
  return ctx;
}

export function useStartLessonUpload() {
  return useUploads().start;
}

const initialState = (file: File): UploadState => ({ phase: 'preparing', loaded: 0, total: file.size, percent: 0, speedBps: null, etaSeconds: null });
const doneState = (file: File): UploadState => ({ phase: 'done', loaded: file.size, total: file.size, percent: 100, speedBps: null, etaSeconds: null });

// ---------------------------------------------------------------------------
// Lesson uploads live in module scope, not in React state. The engine keeps
// running when the course page unmounts (in-app navigation does not stop it),
// so a page mounted later must show that same upload's live progress. Before,
// it showed the upload as "Unfinished" with Resume/Discard, and either one
// fought the engine that was still running.
// ---------------------------------------------------------------------------

interface StoreSnapshot {
  /** By lesson id (unique across courses). */
  entries: Readonly<Record<string, LessonUpload>>;
  /** Bumped when an upload starts or settles, i.e. whenever resume records may have changed. */
  version: number;
}

let snapshot: StoreSnapshot = { entries: {}, version: 0 };
const listeners = new Set<() => void>();
/** Mounted pages to tell when a lesson of their course changed (so they refetch it). */
const courseListeners = new Map<string, Set<() => void>>();
/** Courses whose lessons changed while no page for them was mounted. */
const staleCourses = new Set<string>();

function publish(next: StoreSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

function isActive(entry: LessonUpload | undefined): boolean {
  return !!entry && entry.state.phase !== 'done' && entry.state.phase !== 'failed';
}

function patchEntry(lessonId: string, upload: ResumableUpload, change: Partial<LessonUpload>): void {
  const current = snapshot.entries[lessonId];
  if (current?.upload !== upload) return;
  publish({ ...snapshot, entries: { ...snapshot.entries, [lessonId]: { ...current, ...change } } });
}

function removeEntry(lessonId: string, upload: ResumableUpload): void {
  if (snapshot.entries[lessonId]?.upload !== upload) return;
  const entries = { ...snapshot.entries };
  delete entries[lessonId];
  publish({ entries, version: snapshot.version + 1 });
}

function courseChanged(courseId: string): void {
  const handlers = courseListeners.get(courseId);
  if (handlers?.size) handlers.forEach((handler) => handler());
  else staleCourses.add(courseId);
}

/** Forget every tracked upload. For tests: the store outlives a test's render. */
export function resetLessonUploadsForTests(): void {
  staleCourses.clear();
  publish({ entries: {}, version: 0 });
}

/** Number of this course's lesson uploads still running or paused in this tab. */
export function useActiveLessonUploads(courseId: string): number {
  // A number snapshot: callers re-render when the count changes, not on every progress tick.
  const count = () => Object.values(snapshot.entries).filter((e) => e.courseId === courseId && isActive(e)).length;
  return useSyncExternalStore(subscribe, count, count);
}

/** Start uploading a video into a lesson. Returns an error message when it cannot start. */
function startLessonUpload({ userId, courseId, lessonId, file }: { userId: string; courseId: string; lessonId: string; file: File }): string | null {
  if (!resolveContentType(file, 'video')) return UNSUPPORTED_VIDEO;
  if (isActive(snapshot.entries[lessonId])) return 'This lesson already has an upload running — wait for it to finish or cancel it first.';
  const multipart = usesMultipart(file, 'video');
  const upload = new ResumableUpload({
    file,
    kind: 'video',
    userId,
    lessonId,
    courseId,
    // A single PUT is not on the lesson until its key is saved below; until then it is still finalizing.
    onState: (state) => patchEntry(lessonId, upload, { state: !multipart && state.phase === 'done' ? { ...state, phase: 'finalizing' } : state }),
  });
  publish({
    entries: { ...snapshot.entries, [lessonId]: { courseId, fileName: file.name, multipart, state: initialState(file), upload } },
    version: snapshot.version + 1,
  });
  upload
    .start()
    .then(async (result) => {
      // Multipart uploads are attached by the server on complete; the
      // single-PUT path (videos under 16 MiB) leaves that to us.
      if (!result.lesson_updated) {
        try {
          await api(`/lessons/${lessonId}`, { method: 'PUT', body: { video_s3_key: result.key } });
        } catch (err) {
          patchEntry(lessonId, upload, {
            state: {
              ...initialState(file),
              phase: 'failed',
              loaded: file.size,
              error: `the video uploaded but could not be attached to the lesson: ${(err as Error).message} Then choose the file again.`,
            },
          });
          return;
        }
      }
      patchEntry(lessonId, upload, { state: doneState(file) });
      // The lesson now has this video, so other unfinished uploads into it are obsolete:
      // abort them so they stop counting against the open-upload limit.
      const keep = fingerprintKey(userId, 'video', lessonId, file);
      await Promise.all(
        listResumableUploads(userId, { lessonId })
          .filter((r) => r.storageKey !== keep)
          .map((r) => discardResumableUpload(r.storageKey)),
      );
      courseChanged(courseId);
      setTimeout(() => removeEntry(lessonId, upload), DONE_LINGER_MS);
    })
    .catch((err) => {
      // A failure already reached onState as phase 'failed' and stays on the row.
      if (err instanceof UploadCancelledError) removeEntry(lessonId, upload);
    })
    .finally(() => publish({ ...snapshot, version: snapshot.version + 1 }));
  return null;
}

/**
 * Gives the course page access to its lesson uploads. The uploads themselves
 * live in the module-level store above, so leaving the page and coming back
 * shows a still-running upload with its live progress; it also warns before a
 * tab close (see upload.ts).
 */
export function LessonUploadsProvider({
  courseId,
  userId,
  lessonIds,
  onChanged,
  children,
}: {
  courseId: string;
  userId: string | null;
  lessonIds: string[];
  onChanged: () => void;
  children: ReactNode;
}) {
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [records, setRecords] = useState<ResumableUploadInfo[]>([]);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Refetch when an upload attaches, including one that finished while this page was not mounted.
  useEffect(() => {
    const handler = () => onChangedRef.current();
    let handlers = courseListeners.get(courseId);
    if (!handlers) courseListeners.set(courseId, (handlers = new Set()));
    handlers.add(handler);
    if (staleCourses.delete(courseId)) handler();
    return () => {
      handlers!.delete(handler);
      if (!handlers!.size) courseListeners.delete(courseId);
    };
  }, [courseId]);

  // Resume records live in this browser's localStorage (see upload.ts); ones still uploading in this tab are left out.
  useEffect(() => {
    setRecords(userId ? listResumableUploads(userId, { courseId }) : []);
  }, [userId, courseId, recordsVersion, store.version]);
  const refreshRecords = useCallback(() => setRecordsVersion((v) => v + 1), []);

  const uploads = useMemo(() => {
    const mine: Record<string, LessonUpload> = {};
    for (const [lessonId, entry] of Object.entries(store.entries)) if (entry.courseId === courseId) mine[lessonId] = entry;
    return mine;
  }, [store.entries, courseId]);

  const start = useCallback(
    (lessonId: string, file: File): string | null =>
      userId ? startLessonUpload({ userId, courseId, lessonId, file }) : 'Sign in again to upload videos.',
    [userId, courseId],
  );

  const dismiss = useCallback((lessonId: string) => {
    const entry = snapshot.entries[lessonId];
    if (entry && !isActive(entry)) removeEntry(lessonId, entry.upload);
  }, []);

  const discardHint = useCallback(
    async (storageKey: string) => {
      await discardResumableUpload(storageKey);
      refreshRecords();
    },
    [refreshRecords],
  );

  const lessonKey = lessonIds.join(',');
  const { byLesson, orphans } = useMemo(() => {
    const grouped = groupUploadHints(records, new Set(lessonKey ? lessonKey.split(',') : []));
    // A lesson created a moment ago may not be in the outline yet while its
    // upload runs; offering "Discard" there would abort a live upload.
    return { ...grouped, orphans: grouped.orphans.filter((h) => !h.lessonId || !uploads[h.lessonId]) };
  }, [records, lessonKey, uploads]);

  const value = useMemo<UploadsApi>(
    () => ({ uploads, hints: byLesson, orphanHints: orphans, start, dismiss, discardHint }),
    [uploads, byLesson, orphans, start, dismiss, discardHint],
  );
  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

/** Progress bar for a lesson's running (or just finished / failed) upload. */
export function LessonUploadStatus({ lessonId }: { lessonId: string }) {
  const { uploads, dismiss } = useUploads();
  const entry = uploads[lessonId];
  if (!entry) return null;
  const { upload, multipart, state } = entry;
  return (
    <div>
      <UploadProgress
        fileName={entry.fileName}
        state={state}
        // Pausing only means something for multipart: a paused single PUT restarts from zero.
        // Resume is still offered, since a single PUT pauses itself while the device is offline.
        onPause={multipart ? () => upload.pause() : undefined}
        onResume={() => upload.resume()}
        onCancel={() => void upload.cancel()}
      />
      {state.phase === 'failed' && (
        <button type="button" className="mt-1 text-xs font-medium text-gray-500 hover:underline" onClick={() => dismiss(lessonId)}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** "Unfinished upload: lecture3.mp4 · 62% · Resume (choose the same file) · Discard" */
export function ResumeHints({ lessonId, disabled }: { lessonId: string; disabled: boolean }) {
  const { hints, uploads, start, discardHint } = useUploads();
  const [error, setError] = useState('');
  const active = uploads[lessonId];
  const list = hints[lessonId] ?? [];
  // A running upload of the same lesson already shows its own progress.
  if (!list.length || (active && active.state.phase !== 'failed')) return null;
  return (
    <div className="mt-1 space-y-1">
      {list.map((hint) => (
        <p key={hint.storageKey} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          <span className="min-w-0 break-all">
            Unfinished upload: <b>{hint.fileName}</b>
            {hint.percent != null ? ` · ${hint.percent}%` : ''}
          </span>
          <label className={`font-semibold text-brand-600 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:underline'}`}>
            Resume (choose the same file)
            <input
              type="file"
              accept={VIDEO_ACCEPT}
              className="hidden"
              disabled={disabled}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.currentTarget.value = '';
                if (!file) return;
                if (
                  (file.name !== hint.fileName || file.size !== hint.size) &&
                  !confirm(`That is not ${hint.fileName}, so it will upload from the start. Continue?`)
                ) {
                  return;
                }
                setError(start(lessonId, file) ?? '');
              }}
            />
          </label>
          <button type="button" className="font-semibold text-red-500 hover:underline" onClick={() => void discardHint(hint.storageKey)}>
            Discard
          </button>
        </p>
      ))}
      {error && <p className="text-xs font-medium text-red-500">{error}</p>}
    </div>
  );
}

/** Unfinished uploads whose lesson was deleted: they can only be discarded. */
export function OrphanUploadHints() {
  const { orphanHints, discardHint } = useUploads();
  if (!orphanHints.length) return null;
  return (
    <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
      <p className="font-semibold">Unfinished uploads for lessons that no longer exist</p>
      <ul className="mt-1 space-y-1">
        {orphanHints.map((hint) => (
          <li key={hint.storageKey} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">
              {hint.fileName}
              {hint.percent != null ? ` · ${hint.percent}%` : ''}
            </span>
            <button type="button" className="font-semibold text-red-500 hover:underline" onClick={() => void discardHint(hint.storageKey)}>
              Discard
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "upload video" / "replace" on a lesson row. */
export function UploadVideoButton({ lessonId, hasVideo, disabled }: { lessonId: string; hasVideo: boolean; disabled: boolean }) {
  const { uploads, start } = useUploads();
  const [error, setError] = useState('');
  const phase = uploads[lessonId]?.state.phase;
  const busy = !!phase && phase !== 'done' && phase !== 'failed';
  if (busy) return null;
  return (
    <span className="inline-flex flex-col items-end">
      <label
        className={`rounded-lg px-2 py-0.5 text-xs font-medium text-brand-600 transition-all ${
          disabled ? 'cursor-not-allowed opacity-40' : `cursor-pointer hover:bg-brand-500/10 hover:opacity-100 ${hasVideo ? 'opacity-70' : 'opacity-90'}`
        }`}
      >
        <span className="inline-flex items-center gap-1">
          <Upload className="h-3 w-3" /> {hasVideo ? 'replace' : 'upload video'}
        </span>
        <input
          type="file"
          accept={VIDEO_ACCEPT}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clear so choosing the same file again (e.g. after a failure) fires onChange.
            e.currentTarget.value = '';
            if (file) setError(start(lessonId, file) ?? '');
          }}
        />
      </label>
      {error && <span className="max-w-[16rem] text-right text-[11px] font-medium text-red-500">{error}</span>}
    </span>
  );
}

/** Course thumbnail: one presigned PUT with progress, then saved on the course (staged on a live course). */
export function ThumbnailUploader({
  courseId,
  publicBaseUrl,
  hasThumbnail,
  disabled,
  onSaved,
}: {
  courseId: string;
  publicBaseUrl: string;
  hasThumbnail: boolean;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [progress, setProgress] = useState<{ fileName: string; state: UploadState } | null>(null);
  const [error, setError] = useState('');
  // Kept so the card can offer Resume (after an offline pause) and Cancel.
  const uploadRef = useRef<ResumableUpload | null>(null);
  const busy = !!progress && progress.state.phase !== 'done' && progress.state.phase !== 'failed';

  const onFile = async (file: File) => {
    setError('');
    if (!resolveContentType(file, 'thumbnail')) {
      setError('Use a JPEG, PNG or WebP image for the thumbnail.');
      return;
    }
    // The user id only keys multipart resume records, which a thumbnail never writes.
    const upload = new ResumableUpload({
      file,
      kind: 'thumbnail',
      userId: '',
      onState: (state) => {
        if (uploadRef.current === upload) setProgress({ fileName: file.name, state });
      },
    });
    uploadRef.current = upload;
    setProgress({ fileName: file.name, state: initialState(file) });
    try {
      const { key } = await upload.start();
      await api(`/courses/${courseId}`, { method: 'PUT', body: { thumbnail_url: `${publicBaseUrl}/${key}` } });
      setProgress(null);
      onSaved();
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        setProgress(null);
        return;
      }
      // Upload failures are already shown by the progress bar; saving failures are not.
      setProgress((p) => (p && p.state.phase === 'failed' ? p : null));
      setError((err as Error).message);
    } finally {
      if (uploadRef.current === upload) uploadRef.current = null;
    }
  };

  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <label className={`btn-secondary !text-xs ${disabled || busy ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
        <ImagePlus className="h-3.5 w-3.5" /> {busy ? 'Uploading…' : hasThumbnail ? 'Replace image' : 'Upload image'}
        <input
          type="file"
          accept={IMAGE_ACCEPT}
          className="hidden"
          disabled={disabled || busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.currentTarget.value = '';
            if (file) void onFile(file);
          }}
        />
      </label>
      {progress && progress.state.phase !== 'done' && (
        <div className="w-full sm:w-72">
          <UploadProgress
            fileName={progress.fileName}
            state={progress.state}
            onResume={() => uploadRef.current?.resume()}
            onCancel={() => void uploadRef.current?.cancel()}
          />
        </div>
      )}
      {error && progress?.state.phase !== 'failed' && <p className="text-xs font-medium text-red-500">{error}</p>}
    </div>
  );
}
