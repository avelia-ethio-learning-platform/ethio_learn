'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Offline outbox for learning-progress writes.
 *
 * Video heartbeats and "mark complete" calls are queued in localStorage when
 * the network is down (or the request fails with a network error) and replayed
 * in order when connectivity returns. The backend treats both as idempotent —
 * the watch percentage is a high-water mark and completion is a set — so a
 * replay can never corrupt progress no matter how many times it runs.
 */
const KEY = 'el_outbox_v1';
const MAX_ITEMS = 500;

export interface QueuedWrite {
  id: string;
  path: string;
  method: 'POST' | 'PUT';
  body?: unknown;
  queued_at: number;
}

function read(): QueuedWrite[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedWrite[]) : [];
  } catch {
    return [];
  }
}

function write(items: QueuedWrite[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
  } catch {
    /* storage full or blocked — drop silently, progress is still on the server up to the last sync */
  }
}

export function outboxSize(): number {
  return typeof window === 'undefined' ? 0 : read().length;
}

function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = (err as Error)?.message ?? '';
  return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}

/**
 * Fire a progress write. Succeeds immediately when online; otherwise queues it
 * and resolves with `{ queued: true }` so the UI can show an offline hint.
 * Same-path heartbeats collapse to the latest one (only the last position matters).
 */
export async function queuedApi<T = unknown>(path: string, options: { method: 'POST' | 'PUT'; body?: unknown } = { method: 'POST' }): Promise<T | { queued: true }> {
  const enqueue = () => {
    const items = read().filter((i) => !(i.path === path && i.method === options.method));
    items.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, path, method: options.method, body: options.body, queued_at: Date.now() });
    write(items);
    window.dispatchEvent(new Event('el-outbox-changed'));
    return { queued: true as const };
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return enqueue();
  try {
    return await api<T>(path, options);
  } catch (err) {
    if (isNetworkError(err)) return enqueue();
    throw err;
  }
}

let flushing = false;

/** Replay the outbox in order. Stops at the first network failure (still offline). */
export async function flushOutbox(): Promise<{ sent: number; remaining: number }> {
  if (flushing || typeof window === 'undefined') return { sent: 0, remaining: outboxSize() };
  flushing = true;
  let sent = 0;
  try {
    let items = read();
    while (items.length) {
      const next = items[0];
      try {
        await api(next.path, { method: next.method, body: next.body });
        sent += 1;
        items = items.slice(1);
        write(items);
      } catch (err) {
        if (isNetworkError(err)) break; // still offline — try again later
        // A non-network error (e.g. 403 after a refund) can never succeed: drop it.
        items = items.slice(1);
        write(items);
      }
    }
  } finally {
    flushing = false;
    window.dispatchEvent(new Event('el-outbox-changed'));
  }
  return { sent, remaining: outboxSize() };
}

/** Reactive online/offline + pending-outbox state; flushes automatically on reconnect. */
export function useOffline(): { online: boolean; pending: number } {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const sync = () => {
      setOnline(navigator.onLine);
      setPending(outboxSize());
    };
    sync();
    const onOnline = () => {
      sync();
      void flushOutbox().then(sync);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', sync);
    window.addEventListener('el-outbox-changed', sync);
    if (navigator.onLine) void flushOutbox().then(sync);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', sync);
      window.removeEventListener('el-outbox-changed', sync);
    };
  }, []);
  return { online, pending };
}
