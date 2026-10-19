'use client';

import { useSyncExternalStore } from 'react';

/**
 * A small setting kept in localStorage or sessionStorage (theme, locale, a
 * dismissed notice), read with useSyncExternalStore: `null` in the server HTML
 * and during hydration, then the stored value. Writes go through
 * `writeStoredSetting` so every reader re-renders. When storage is blocked the
 * value is kept in memory for this page load instead.
 */
export type StorageArea = 'localStorage' | 'sessionStorage';

const listeners = new Set<() => void>();
const memory = new Map<string, string>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function readStoredSetting(area: StorageArea, key: string): string | null {
  const memoryKey = `${area}:${key}`;
  if (memory.has(memoryKey)) return memory.get(memoryKey)!;
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredSetting(area: StorageArea, key: string, value: string) {
  const memoryKey = `${area}:${key}`;
  try {
    window[area].setItem(key, value);
    memory.delete(memoryKey);
  } catch {
    memory.set(memoryKey, value);
  }
  listeners.forEach((onChange) => onChange());
}

export function useStoredSetting(area: StorageArea, key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readStoredSetting(area, key),
    () => null,
  );
}
