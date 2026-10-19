import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as dto from './dto';

type DtoModule = typeof dto;

/** The DTO module as loaded under a given NODE_ENV (the URL rule is fixed at load time). */
async function loadUnder(nodeEnv: string): Promise<DtoModule> {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    let mod!: DtoModule;
    await jest.isolateModulesAsync(async () => {
      mod = await import('./dto');
    });
    return mod;
  } finally {
    process.env.NODE_ENV = before;
  }
}

const photoErrors = async (Dto: new () => object, photo_url: unknown, rest: Record<string, unknown> = {}) =>
  (await validate(plainToInstance(Dto, { ...rest, photo_url }))).map((e) => e.property);

describe('photo_url validation', () => {
  const profile = { bio: 'Teaches maths', expertise_area: 'Mathematics' };

  it('in production accepts only an https URL of at most 500 characters', async () => {
    const m = await loadUnder('production');
    for (const [Dto, rest] of [
      [m.UpdateProfileDto, {}],
      [m.CreateEducatorProfileDto, profile],
    ] as const) {
      expect(await photoErrors(Dto, 'https://pub-abc.r2.dev/photos/u1.jpg', rest)).toEqual([]);
      for (const bad of ['http://example.et/p.jpg', 'javascript:alert(1)', 'not a url', `https://pub-abc.r2.dev/${'a'.repeat(500)}.jpg`]) {
        expect(await photoErrors(Dto, bad, rest)).toEqual(['photo_url']);
      }
    }
  });

  it('outside production also accepts a local http URL, but no other scheme', async () => {
    const m = await loadUnder('development');
    expect(await photoErrors(m.UpdateProfileDto, 'http://localhost:9000/ethiopialearn/p.jpg')).toEqual([]);
    expect(await photoErrors(m.UpdateProfileDto, 'javascript:alert(1)')).toEqual(['photo_url']);
  });

  it('leaves the field optional', async () => {
    expect(await photoErrors(dto.UpdateProfileDto, undefined)).toEqual([]);
  });
});
