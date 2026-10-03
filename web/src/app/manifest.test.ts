import { describe, expect, it } from 'vitest';
import manifest from './manifest';
import { generateImageMetadata } from './icon';

describe('web app manifest', () => {
  const m = manifest();

  it('starts at the home page with the brand colour', () => {
    expect(m.start_url).toBe('/');
    expect(m.theme_color).toBe('#2563eb');
  });

  it('only references icon routes that app/icon.tsx generates', () => {
    const ids = generateImageMetadata().map((i) => i.id);
    for (const icon of m.icons ?? []) {
      expect(icon.src).toMatch(/^\/icon\//);
      expect(ids).toContain(icon.src.replace('/icon/', ''));
      expect(icon.type).toBe('image/png');
    }
  });

  it('has 192 and 512 icons plus a padded maskable 512', () => {
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.find((i) => i.purpose === 'maskable')?.src).toBe('/icon/maskable-512');
  });
});
