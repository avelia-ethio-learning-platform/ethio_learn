import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompleteLessonDto, EnrollmentController, VideoProgressDto } from './enrollment.controller';

const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true })).map((e) => e.property);

describe('VideoProgressDto', () => {
  it('caps the client-reported duration at 86,400 s', async () => {
    expect(await errorsFor(VideoProgressDto, { position_seconds: 10, duration_seconds: 86_400 })).toEqual([]);
    expect(await errorsFor(VideoProgressDto, { position_seconds: 10, duration_seconds: 86_401 })).toEqual(['duration_seconds']);
  });
});

describe('CompleteLessonDto', () => {
  it.each([{}, { position_seconds: 0 }, { position_seconds: 118.5 }])('accepts %p', async (body) => {
    expect(await errorsFor(CompleteLessonDto, body)).toEqual([]);
  });

  it.each([-1, 'abc'])('rejects position_seconds %p', async (position_seconds) => {
    expect(await errorsFor(CompleteLessonDto, { position_seconds })).toEqual(['position_seconds']);
  });
});

describe('EnrollmentController /complete', () => {
  it('passes the optional final position to the service', async () => {
    const service = { completeLesson: jest.fn().mockResolvedValue({}) };
    const controller = new EnrollmentController(service as never);
    const ctx = { id: 'u1' } as never;
    await controller.complete(ctx, 'l1', { position_seconds: 118 });
    expect(service.completeLesson).toHaveBeenLastCalledWith(ctx, 'l1', 118);
    await controller.complete(ctx, 'l1', {});
    expect(service.completeLesson).toHaveBeenLastCalledWith(ctx, 'l1', undefined);
  });
});
