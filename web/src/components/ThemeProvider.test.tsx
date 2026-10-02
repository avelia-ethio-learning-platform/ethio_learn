import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ThemeProvider, useTheme, type Theme } from './ThemeProvider';

let setThemeRef: (t: Theme) => void = () => undefined;
function Probe() {
  setThemeRef = useTheme().setTheme;
  return null;
}

function addMeta(media: string, content: string) {
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.media = media;
  m.content = content;
  document.head.appendChild(m);
}
const colors = () => Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((m) => m.content);

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  addMeta('(prefers-color-scheme: light)', '#2563eb');
  addMeta('(prefers-color-scheme: dark)', '#0f172a');
});
afterEach(() => {
  cleanup();
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
});

describe('ThemeProvider theme-color sync', () => {
  it('keeps each scheme colour in system mode', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(colors()).toEqual(['#2563eb', '#0f172a']);
  });

  it('sets every meta to the chosen colour for an explicit theme, then restores on system', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => setThemeRef('dark'));
    expect(colors()).toEqual(['#0f172a', '#0f172a']);
    act(() => setThemeRef('light'));
    expect(colors()).toEqual(['#2563eb', '#2563eb']);
    act(() => setThemeRef('system'));
    expect(colors()).toEqual(['#2563eb', '#0f172a']);
  });
});
