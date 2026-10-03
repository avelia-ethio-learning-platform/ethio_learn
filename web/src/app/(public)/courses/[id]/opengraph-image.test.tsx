// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverApi = vi.fn();
vi.mock('@/lib/server-api', () => ({ serverApi: (...args: unknown[]) => serverApi(...args) }));

import Image from './opengraph-image';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Where the controller looks at the renders; skipped when the folder isn't there (CI).
const PROOF_DIR = process.env.OG_PROOF_DIR ?? '/home/kal/Documents/code/ethi0-web/.superpowers/sdd/plan';

async function render(result: unknown, file: string) {
  serverApi.mockResolvedValue(result);
  const res = await Image({ params: { id: 'c1' } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    await mkdir(PROOF_DIR, { recursive: true });
    await writeFile(`${PROOF_DIR}/${file}`, bytes);
  } catch {
    /* proof copy is optional */
  }
  return { res, bytes };
}

describe('course OG image', () => {
  beforeEach(() => serverApi.mockReset());

  it('renders a PNG for an Amharic course (fonts load)', async () => {
    const { res, bytes } = await render(
      {
        ok: true,
        data: {
          title: 'ኤክሴል ለጀማሪዎች',
          category: 'business',
          instructor_name: 'ሰላም በቀለ',
          pricing_type: 'paid',
          price_etb: 1500,
        },
      },
      'og-amharic.png',
    );
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG);
    expect(bytes.length).toBeGreaterThan(5000);
  }, 30000);

  it.each([
    ['unavailable', { ok: false, status: 'unavailable' }],
    ['not found', { ok: false, status: 404 }],
  ])('renders the generic site card when the API says %s', async (_n, result) => {
    const { res, bytes } = await render(result, 'og-generic.png');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG);
  }, 30000);
});
