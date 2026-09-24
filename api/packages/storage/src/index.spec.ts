import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { isNoSuchUpload, S3StorageProvider } from './index';

function s3Error(name: string, status: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function signedHeaders(url: string): string[] {
  return decodeURIComponent(new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
}

describe('S3StorageProvider', () => {
  let send: jest.SpyInstance;
  let storage: S3StorageProvider;

  beforeEach(() => {
    process.env.S3_ENDPOINT = 'http://storage.test';
    process.env.S3_BUCKET = 'bucket';
    send = jest.spyOn(S3Client.prototype, 'send');
    storage = new S3StorageProvider();
  });

  afterEach(() => {
    send.mockRestore();
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
  });

  describe('presigned URLs', () => {
    it('signs ContentLength into the single-PUT URL when given', async () => {
      const { url } = await storage.getSignedUploadUrl('thumbnails/u/x.png', 'image/png', 900, 1234);
      expect(signedHeaders(url)).toContain('content-length');
      // WHEN_REQUIRED: no empty-body checksum baked into the URL.
      expect(url).not.toContain('x-amz-checksum-crc32');
      expect(url).not.toContain('x-amz-sdk-checksum-algorithm');
    });

    it('leaves the length unsigned when not given (back-compat)', async () => {
      const { url } = await storage.getSignedUploadUrl('thumbnails/u/x.png', 'image/png');
      expect(signedHeaders(url)).not.toContain('content-length');
    });

    // Without this the presigner signs only content-length;host, so a client
    // that declared image/png could PUT text/html and storage would serve it.
    it.each([
      ['with a signed length', 1234],
      ['without a length', undefined],
    ])('signs the declared Content-Type into the single-PUT URL (%s)', async (_label, length) => {
      const { url } = await storage.getSignedUploadUrl('thumbnails/u/x.png', 'image/png', 900, length);
      expect(signedHeaders(url)).toContain('content-type');
      expect(signedHeaders(url)).toContain('host');
      // Signed as a header, not smuggled into the query where the client's own header would still win.
      expect(new URL(url).searchParams.has('Content-Type')).toBe(false);
    });

    it('produces a different signature for a different declared Content-Type', async () => {
      const sig = async (type: string) =>
        new URL((await storage.getSignedUploadUrl('thumbnails/u/x.png', type, 900, 10)).url).searchParams.get('X-Amz-Signature');
      // Freeze only the clock so both URLs share a signing time; the SDK's async plumbing keeps real timers.
      jest.useFakeTimers({
        now: new Date('2026-09-24T10:00:00Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      try {
        expect(await sig('image/png')).not.toBe(await sig('text/html'));
        expect(await sig('image/png')).toBe(await sig('image/png'));
      } finally {
        jest.useRealTimers();
      }
    });

    it('signs part number, upload id and exact length into part URLs', async () => {
      const url = await storage.presignUploadPart('videos/u/k.mp4', 'UPLOAD-1', 7, 8 * 1024 * 1024);
      const q = new URL(url).searchParams;
      expect(q.get('partNumber')).toBe('7');
      expect(q.get('uploadId')).toBe('UPLOAD-1');
      expect(q.get('X-Amz-Expires')).toBe('7200');
      expect(signedHeaders(url)).toContain('content-length');
      expect(url).not.toContain('x-amz-checksum-crc32');
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('creates a multipart upload with the given content type', async () => {
    send.mockResolvedValueOnce({ UploadId: 'UP' });
    await expect(storage.createMultipartUpload('videos/u/k.mp4', 'video/mp4')).resolves.toBe('UP');
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(cmd.input).toEqual({ Bucket: 'bucket', Key: 'videos/u/k.mp4', ContentType: 'video/mp4' });
  });

  it('lists every page of parts until the listing is no longer truncated', async () => {
    send
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextPartNumberMarker: '2',
        Parts: [
          { PartNumber: 2, Size: 10, ETag: '"b"' },
          { PartNumber: 1, Size: 10, ETag: '"a"' },
        ],
      })
      .mockResolvedValueOnce({ IsTruncated: false, Parts: [{ PartNumber: 3, Size: 4, ETag: '"c"' }] });

    const parts = await storage.listAllParts('videos/u/k.mp4', 'UP');

    expect(parts).toEqual([
      { part_number: 1, size: 10, etag: '"a"' },
      { part_number: 2, size: 10, etag: '"b"' },
      { part_number: 3, size: 4, etag: '"c"' },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListPartsCommand);
    expect(send.mock.calls[0][0].input.PartNumberMarker).toBeUndefined();
    expect(send.mock.calls[1][0].input.PartNumberMarker).toBe('2');
  });

  it('stops paging if the backend repeats the same marker', async () => {
    send.mockResolvedValue({ IsTruncated: true, NextPartNumberMarker: '1', Parts: [{ PartNumber: 1, Size: 1, ETag: '"a"' }] });
    await storage.listAllParts('k', 'UP');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('completes with the parts sorted by part number', async () => {
    send.mockResolvedValueOnce({});
    await storage.completeMultipartUpload('k', 'UP', [
      { part_number: 2, etag: '"b"' },
      { part_number: 1, etag: '"a"' },
    ]);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(cmd.input.MultipartUpload.Parts).toEqual([
      { PartNumber: 1, ETag: '"a"' },
      { PartNumber: 2, ETag: '"b"' },
    ]);
  });

  describe('abortMultipartUpload', () => {
    it('treats an upload that is already gone as aborted', async () => {
      send.mockRejectedValueOnce(s3Error('NoSuchUpload', 404));
      await expect(storage.abortMultipartUpload('k', 'UP')).resolves.toBeUndefined();
      expect(send.mock.calls[0][0]).toBeInstanceOf(AbortMultipartUploadCommand);
    });

    it('rethrows other failures', async () => {
      send.mockRejectedValueOnce(s3Error('AccessDenied', 403));
      await expect(storage.abortMultipartUpload('k', 'UP')).rejects.toThrow('AccessDenied');
    });
  });

  describe('headObject', () => {
    it('returns size and type', async () => {
      send.mockResolvedValueOnce({ ContentLength: 42, ContentType: 'video/mp4' });
      await expect(storage.headObject('k')).resolves.toEqual({ size: 42, content_type: 'video/mp4' });
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    });

    it('returns null for a missing object (bare 404 NotFound)', async () => {
      send.mockRejectedValueOnce(s3Error('NotFound', 404));
      await expect(storage.headObject('k')).resolves.toBeNull();
    });

    it('returns null on a 404 with an unrecognised error name', async () => {
      send.mockRejectedValueOnce(s3Error('UnknownError', 404));
      await expect(storage.headObject('k')).resolves.toBeNull();
    });

    it('rethrows non-404 failures so callers do not mistake an outage for a missing file', async () => {
      send.mockRejectedValueOnce(s3Error('Forbidden', 403));
      await expect(storage.headObject('k')).rejects.toThrow('Forbidden');
    });
  });

  it('isNoSuchUpload recognises the error by name or code', () => {
    expect(isNoSuchUpload(s3Error('NoSuchUpload', 404))).toBe(true);
    expect(isNoSuchUpload({ Code: 'NoSuchUpload' })).toBe(true);
    expect(isNoSuchUpload(s3Error('NotFound', 404))).toBe(false);
    expect(isNoSuchUpload(undefined)).toBe(false);
  });
});
