import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  /** Signed PUT URL so clients upload directly without proxying bytes through services. */
  getSignedUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<{ url: string; key: string }>;
  putObject(key: string, body: Buffer, contentType: string): Promise<string>;
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

  async getSignedUploadUrl(key: string, contentType: string, expiresInSeconds = 900) {
    const url = await getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
    return { url, key };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return key;
  }
}
