// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUP_COLORS } from './categories';

/**
 * Recomputes docs/COLOR_SYSTEM.md's contrast table from globals.css on every run, so a token
 * change that breaks a pair fails here with the pair, the ratio and the threshold.
 * Text needs 4.5:1; boundaries, focus and graphics need 3:1 (WCAG 2.2 AA).
 */
const TEXT = 4.5;
const GRAPHIC = 3;
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `selector { … }` rule that starts a line. */
function rule(selector: string): string {
  const m = css.match(new RegExp(`(?:^|\\n)[ \\t]*${selector.replace(/[.()]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`globals.css has no "${selector}" rule`);
  return m[1];
}
const tokens = (body: string) => Object.fromEntries(Array.from(body.matchAll(/--([\w-]+):\s*([^;]+);/g)).map((m) => [m[1], m[2].trim()]));
const property = (body: string, name: string) => body.match(new RegExp(`(?:^|;|\\n)\\s*${name}:\\s*([^;]+);`))?.[1].trim() ?? '';

type Rgba = { r: number; g: number; b: number; a: number };
type Theme = 'light' | 'dark';
const THEME_TOKENS: Record<Theme, Record<string, string>> = { light: tokens(rule(':root')), dark: tokens(rule('.dark')) };

/** A hex, rgb()/rgba() or "r g b" channel value, with var(--x) resolved for the theme. */
function color(value: string, theme: Theme): Rgba {
  const v = value.trim().replace(/var\(--([\w-]+)\)/g, (_, name: string) => THEME_TOKENS[theme][name] ?? `<missing --${name}>`);
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const nums = v.match(/^(?:rgba?\()?\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)?$/);
  if (!nums) throw new Error(`not a colour: "${value}" (${theme})`);
  return { r: +nums[1], g: +nums[2], b: +nums[3], a: nums[4] === undefined ? 1 : +nums[4] };
}
/** Every colour stop of a plain colour or a linear-gradient(). */
const stops = (value: string, theme: Theme): Rgba[] => (value.match(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/gi) ?? [value]).map((s) => color(s, theme));

const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});
const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) => 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
const contrast = (fg: Rgba, bg: Rgba) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};
const ratio = (fg: Rgba, bg: Rgba) => Math.round(contrast(fg, bg) * 100) / 100;

/** A surface named by the table, composited over the page where it is translucent. */
function surface(name: string, theme: Theme): Rgba {
  const page = color('var(--background)', theme);
  if (name === 'page') return page;
  if (name === 'secondary') return color('var(--background-secondary)', theme);
  if (name === 'card') return over(color('var(--card)', theme), page);
  if (name === 'track') return over(color(property(rule('.progress-track'), 'background'), theme), page);
  if (name.endsWith('-soft')) return over(color(`var(--${name})`, theme), page);
  return color(`var(--${name})`, theme);
}

const token = (name: string, theme: Theme) => color(`var(--${name})`, theme);
const ALL_SURFACES = ['page', 'secondary', 'card', 'gray-100', 'gray-200', 'brand-50', 'brand-100'];
const PAIRS: { pair: string; color: (theme: Theme) => Rgba; on: string[]; needs: number }[] = [
  { pair: 'foreground', color: (t) => token('foreground', t), on: ALL_SURFACES, needs: TEXT },
  { pair: 'secondary text (gray-600)', color: (t) => token('gray-600', t), on: ALL_SURFACES, needs: TEXT },
  { pair: 'muted text (muted-foreground)', color: (t) => token('muted-foreground', t), on: ['page', 'secondary', 'card', 'gray-100'], needs: TEXT },
  { pair: 'link / brand text (brand-600)', color: (t) => token('brand-600', t), on: ['page', 'secondary', 'card'], needs: TEXT },
  { pair: 'brand text on tints (brand-700)', color: (t) => token('brand-700', t), on: ['page', 'card', 'gray-100', 'brand-50', 'brand-100'], needs: TEXT },
  { pair: 'input border', color: (t) => token('input-border', t), on: ['page', 'secondary', 'card'], needs: GRAPHIC },
  { pair: 'focus ring (brand-600)', color: (t) => token('brand-600', t), on: ['page', 'secondary', 'card'], needs: GRAPHIC },
  { pair: 'chart bar (brand-600)', color: (t) => token('brand-600', t), on: ['page', 'secondary', 'card'], needs: GRAPHIC },
  { pair: 'progress fill (.progress-fill)', color: (t) => color(property(rule('.progress-fill'), 'background'), t), on: ['track', 'gray-200'], needs: GRAPHIC },
  { pair: 'rating star fill', color: (t) => token('rating', t), on: ['page', 'secondary', 'card'], needs: GRAPHIC },
  ...['success', 'warning', 'danger', 'info'].flatMap((s) => [
    { pair: `${s} text`, color: (t: Theme) => token(s, t), on: ['page', 'card', `${s}-soft`], needs: TEXT },
    { pair: `${s} solid`, color: (t: Theme) => token(`${s}-solid`, t), on: ['page', 'secondary'], needs: GRAPHIC },
  ]),
];

for (const theme of ['light', 'dark'] as const) {
  describe(`${theme} theme`, () => {
    it('gray-500 is the muted text colour', () => {
      expect(token('gray-500', theme)).toEqual(token('muted-foreground', theme));
    });
    for (const { pair, color: fg, on, needs } of PAIRS) {
      it(`${pair} is ${needs}:1 on ${on.join(', ')}`, () => {
        for (const name of on) {
          const r = ratio(fg(theme), surface(name, theme));
          expect(r, `${pair} on ${name} (${theme}): ${r} < ${needs}`).toBeGreaterThanOrEqual(needs);
        }
      });
    }
  });
}

describe('fixed fills with white text, in both themes', () => {
  const fills = [
    ['.btn', '.btn'],
    ['.btn-danger', '.btn-danger'],
    ['.badge-count', '.badge-count'],
    ['.brand-fill', '.brand-fill'],
    ['.brand-panel (light)', '.brand-panel'],
    ['.brand-panel (dark)', '.dark .brand-panel'],
  ];
  for (const [name, selector] of fills) {
    it(`white on ${name} is ${TEXT}:1 along the whole fill`, () => {
      const value = property(rule(selector), 'background');
      expect(value, `${selector} has a background`).not.toBe('');
      for (const stop of stops(value, 'light')) {
        const r = ratio(WHITE, stop);
        expect(r, `white on ${name} stop rgb(${stop.r} ${stop.g} ${stop.b}): ${r} < ${TEXT}`).toBeGreaterThanOrEqual(TEXT);
      }
    });
  }
  for (const [group, hex] of Object.entries(GROUP_COLORS)) {
    it(`white on the ${group} cover is ${TEXT}:1`, () => {
      const r = ratio(WHITE, color(hex, 'light'));
      expect(r, `white on ${group} ${hex}: ${r} < ${TEXT}`).toBeGreaterThanOrEqual(TEXT);
    });
  }
  it('.input draws its edge with --input-border', () => {
    expect(property(rule('.input'), 'border')).toContain('var(--input-border)');
  });
});
