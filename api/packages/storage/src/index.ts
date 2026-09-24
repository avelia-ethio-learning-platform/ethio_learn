import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** A part the storage backend has received for an in-progress multipart upload. */
export interface UploadedPart {
  part_number: number;
  size: number;
  etag: string;
}

export interface StoredObjectInfo {
  size: number;
  content_type: string | null;
}

/**
 * VideoStorageProvider abstraction (spec §14): MVP ships the S3/MinIO
 * implementation serving uploads via signed, time-limited URLs. Transcoding is
 * intentionally NOT implemented here — swap in a Mux/Bunny/ffmpeg-backed
 * provider later without touching the services.
 *
 * Raw S3 URLs/keys are never returned to clients (spec §0 rule 5); only
 * signed, expiring URLs leave this module.
 */
export interface StorageProvider {
  /** Signed GET URL for playback/download. */
  getSignedStreamUrl(key: string, expiresInSeconds?: number): Promise<{ url: string; expires_in: number }>;
  /**
   * Signed PUT URL so clients upload directly without proxying bytes through
   * services. The Content-Type is always part of the signature, so the client
   * must send exactly `contentType`; when contentLength is given it is signed
   * too. The storage backend rejects (403) a PUT that differs in either.
   */
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
    contentLength?: number,
  ): Promise<{ url: string; key: string }>;
  putObject(key: string, body: Buffer, contentType: string): Promise<string>;
  /** Starts a multipart upload; the Content-Type set here is the object's final type. Returns the upload id. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** Signed PUT URL for one part, with its exact byte length signed. */
  presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number, expiresInSeconds?: number): Promise<string>;
  /** Every part received so far, in part-number order. Throws NoSuchUpload when the upload is gone. */
  listAllParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: Array<{ part_number: number; etag: string }>): Promise<void>;
  /** Idempotent: an upload that is already gone counts as aborted. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Size and type of a stored object, or null when it does not exist. */
  headObject(key: string): Promise<StoredObjectInfo | null>;
}

/** True when the backend says the multipart upload id no longer exists (completed, aborted or expired). */
export function isNoSuchUpload(err: unknown): boolean {
  const e = err as { name?: string; Code?: string } | null;
  return e?.name === 'NoSuchUpload' || e?.Code === 'NoSuchUpload';
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  // HEAD responses have no body, so the SDK can only report the bare status.
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Public-facing endpoint for presigned URLs (browser-reachable, e.g. localhost MinIO). */
  private readonly publicClient: S3Client;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT; // unset in real AWS
    const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? endpoint;
    const config = {
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      },
      forcePathStyle: true,
      // The SDK default (WHEN_SUPPORTED) bakes a CRC32 of an EMPTY body into
      // every presigned PUT URL (x-amz-checksum-crc32=AAAAAA==); the browser
      // sends the real bytes, so the checksum is always wrong. R2 ignores it
      // today, but other S3-compatible backends reject it.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...config, ...(endpoint ? { endpoint } : {}) });
    this.publicClient = new S3Client({ ...config, ...(publicEndpoint ? { endpoint: publicEndpoint } : {}) });
    this.bucket = process.env.S3_BUCKET ?? 'ethiopialearn';
  }

  async getSignedStreamUrl(key: string, expiresInSeconds = 900) {
    const url = await getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
    return { url, expires_in: expiresInSeconds };
  }

  async getSignedUploadUrl(key: string, contentType: string, expiresInSeconds = 900, contentLength?: number) {
    const url = await getSignedUrl(
      this.publicClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
      }),
      // The S3 presigner leaves Content-Type unsigned by default, so the
      // uploader could store any type (e.g. text/html under thumbnails/ on the
      // public bucket) and the caller's content-type allowlist would mean
      // nothing. Signing it makes storage reject (403) a PUT whose
      // Content-Type header differs from the declared one.
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
    return { url, key };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return key;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!res.UploadId) throw new Error(`Storage did not return an upload id for ${key}`);
    return res.UploadId;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number, expiresInSeconds = 7200) {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async listAllParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    // ListParts pages at 1000 parts (R2's maximum page size).
    for (;;) {
      const res = await this.client.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, ...(marker ? { PartNumberMarker: marker } : {}) }),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber === undefined || !p.ETag) continue;
        parts.push({ part_number: p.PartNumber, size: p.Size ?? 0, etag: p.ETag });
      }
      if (!res.IsTruncated || !res.NextPartNumberMarker || res.NextPartNumberMarker === marker) break;
      marker = res.NextPartNumberMarker;
    }
    return parts.sort((a, b) => a.part_number - b.part_number);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: Array<{ part_number: number; etag: string }>): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.part_number - b.part_number).map((p) => ({ PartNumber: p.part_number, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      if (!isNoSuchUpload(err)) throw err;
    }
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, content_type: res.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
