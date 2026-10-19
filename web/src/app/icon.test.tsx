// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Icon, { generateImageMetadata } from './icon';

/** Width and height from the PNG's IHDR chunk. */
async function pngSize(res: Response) {
  const bytes = Buffer.from(await res.arrayBuffer());
  expect(bytes.subarray(0, 8).toString('hex'), 'a PNG').toBe('89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('app icons', () => {
  it.each([
    ['32', 32],
    ['192', 192],
    ['512', 512],
    ['maskable-512', 512],
  ])('/icon/%s renders %ipx square', async (id, size) => {
    expect(await pngSize(await Icon({ id: Promise.resolve(id) }))).toEqual([size, size]);
  });

  it('renders every id it advertises at the advertised size', async () => {
    for (const meta of generateImageMetadata()) {
      expect(await pngSize(await Icon({ id: Promise.resolve(meta.id) })), meta.id).toEqual([meta.size.width, meta.size.height]);
    }
  });
});
