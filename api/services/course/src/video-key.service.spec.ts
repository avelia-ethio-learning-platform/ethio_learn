import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { VideoKeyService } from './video-key.service';

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const course = { created_by: AUTHOR, owner_id: AUTHOR };
const ownKey = `videos/${AUTHOR}/${UUID}-lecture_1.mp4`;

describe('VideoKeyService.assertOwnVideoKey', () => {
  let headObject: jest.Mock;
  let service: VideoKeyService;

  beforeEach(() => {
    headObject = jest.fn().mockResolvedValue({ size: 1024, content_type: 'video/mp4' });
    service = new VideoKeyService({ headObject } as any);
  });

  it.each([null, undefined, ''])('allows clearing the video (%p) without touching storage', async (key) => {
    await expect(service.assertOwnVideoKey(course, key, [])).resolves.toBeUndefined();
    expect(headObject).not.toHaveBeenCalled();
  });

  it('allows an unchanged key (live or staged) without re-validating it', async () => {
    // A legacy key outside the upload prefix must not block unrelated lesson edits.
    const legacy = 'videos/legacy-seed/intro.mp4';
    await expect(service.assertOwnVideoKey(course, legacy, [null, legacy])).resolves.toBeUndefined();
    await expect(service.assertOwnVideoKey(course, ownKey, [undefined, ownKey])).resolves.toBeUndefined();
    expect(headObject).not.toHaveBeenCalled();
  });

  it("accepts a new key under the author's prefix that exists in storage", async () => {
    await expect(service.assertOwnVideoKey(course, ownKey, [null])).resolves.toBeUndefined();
    expect(headObject).toHaveBeenCalledWith(ownKey);
  });

  it("accepts the owning account's prefix when owner and author differ", async () => {
    const key = `videos/${OTHER}/${UUID}-a.mp4`;
    await expect(service.assertOwnVideoKey({ created_by: AUTHOR, owner_id: OTHER }, key, [])).resolves.toBeUndefined();
  });

  it.each([
    [`videos/${OTHER}/${UUID}-stolen.mp4`, "another educator's upload"],
    [`projects/${AUTHOR}/${UUID}-work.mp4`, 'a learner project prefix'],
    [`thumbnails/${AUTHOR}/${UUID}-cover.png`, 'a thumbnail'],
    [`videos/${AUTHOR}/not-a-uuid-name.mp4`, 'a hand-made name'],
    [`videos/${AUTHOR}/${UUID}-../../x.mp4`, 'path traversal'],
    [`videos/${AUTHOR}/${UUID}-a.mp4/extra`, 'trailing path'],
  ])('rejects %s (%s) before asking storage', async (key) => {
    await expect(service.assertOwnVideoKey(course, key, [ownKey])).rejects.toThrow(
      new BadRequestException("That video was not uploaded by this course's instructor. Upload the file with this lesson's video button instead."),
    );
    expect(headObject).not.toHaveBeenCalled();
  });

  it('rejects a well-formed key whose object does not exist', async () => {
    headObject.mockResolvedValueOnce(null);
    await expect(service.assertOwnVideoKey(course, ownKey, [])).rejects.toThrow('Upload the video before attaching it');
  });

  it('rejects an empty object', async () => {
    headObject.mockResolvedValueOnce({ size: 0, content_type: 'video/mp4' });
    await expect(service.assertOwnVideoKey(course, ownKey, [])).rejects.toThrow(BadRequestException);
  });

  it('reports a storage outage as retryable rather than as a missing file', async () => {
    headObject.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(service.assertOwnVideoKey(course, ownKey, [])).rejects.toThrow(ServiceUnavailableException);
  });
});
