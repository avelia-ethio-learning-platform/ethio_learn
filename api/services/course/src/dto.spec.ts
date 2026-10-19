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

const thumbnailErrors = async (m: DtoModule, thumbnail_url: unknown) =>
  (await validate(plainToInstance(m.UpdateCourseDto, { thumbnail_url }))).map((e) => e.property);

const create = { title: 'A course title', description: 'A description long enough', category: 'programming', language: 'en', pricing_type: 'free' };

describe('thumbnail_url validation', () => {
  it('in production accepts only an https URL of at most 500 characters', async () => {
    const m = await loadUnder('production');
    expect(await thumbnailErrors(m, 'https://pub-abc.r2.dev/thumbnails/edu1/t.png')).toEqual([]);
    for (const bad of [
      'http://localhost:9000/ethiopialearn/thumbnails/t.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example/t.png',
      'not a url',
      '',
      `https://pub-abc.r2.dev/${'a'.repeat(500)}.png`,
    ]) {
      expect(await thumbnailErrors(m, bad)).toEqual(['thumbnail_url']);
    }
    const errors = await validate(plainToInstance(m.CreateCourseDto, { ...create, thumbnail_url: 'javascript:alert(1)' }));
    expect(errors.map((e) => e.property)).toEqual(['thumbnail_url']);
  });

  it("outside production also accepts local MinIO's http URL, but still no other scheme", async () => {
    const m = await loadUnder('development');
    expect(await thumbnailErrors(m, 'http://localhost:9000/ethiopialearn/thumbnails/edu1/t.png')).toEqual([]);
    expect(await thumbnailErrors(m, 'https://pub-abc.r2.dev/t.png')).toEqual([]);
    expect(await thumbnailErrors(m, 'javascript:alert(1)')).toEqual(['thumbnail_url']);
    expect(await thumbnailErrors(m, 'ftp://files.example/t.png')).toEqual(['thumbnail_url']);
  });

  it('leaves the field optional', async () => {
    expect(await thumbnailErrors(dto, undefined)).toEqual([]);
  });
});
