import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { S3StorageProvider } from '@ethiopialearn/storage';

/**
 * Keys the upload endpoints generate: videos/<user id>/<uuid>-<safe file name>.
 * Anything else (another educator's prefix, projects/…, thumbnails/…, a
 * hand-typed path) is not a video uploaded for this course.
 */
export function videoKeyPattern(userId: string): RegExp {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`^videos/${escaped}/[0-9a-f-]{36}-[A-Za-z0-9._-]{1,200}$`);
}

/**
 * Lesson video key integrity. Every signed stream URL a learner receives
 * carries the object key in its path, so without this check an educator who
 * enrolled in someone else's paid course could point their own (even
 * free-preview) lesson at that course's video, or at an object that does not
 * exist.
 */
@Injectable()
export class VideoKeyService {
  private readonly logger = new Logger(VideoKeyService.name);

  constructor(private readonly storage: S3StorageProvider) {}

  /**
   * Allowed: no key, or a key the lesson already holds (live or staged), so
   * unrelated edits never re-validate an existing video. Otherwise the key must
   * sit under the course author's upload prefix (created_by) or the owning
   * account's (owner_id: they differ on courses whose owner is not the author,
   * e.g. seeded or transferred courses) and the object must exist with bytes.
   *
   * Uploads started for a specific lesson are keyed under the course author's
   * prefix by UploadService even when a platform admin performs them, so
   * staff uploads on an educator's lesson also pass.
   */
  async assertOwnVideoKey(
    course: { created_by: string; owner_id?: string | null },
    key: string | null | undefined,
    existingKeys: Array<string | null | undefined>,
  ): Promise<void> {
    // An empty string points at no object, like null: it clears the video.
    if (key === null || key === undefined || key === '') return;
    if (existingKeys.some((existing) => !!existing && existing === key)) return;

    const prefixes = [course.created_by, course.owner_id].filter((id): id is string => !!id);
    if (!prefixes.some((id) => videoKeyPattern(id).test(key))) {
      throw new BadRequestException(
        "That video was not uploaded by this course's instructor. Upload the file with this lesson's video button instead.",
      );
    }

    let stored: { size: number } | null;
    try {
      stored = await this.storage.headObject(key);
    } catch (err) {
      this.logger.warn(`Video key check failed for course author ${course.created_by}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Could not confirm the uploaded video right now — try saving again in a minute.');
    }
    if (!stored || stored.size <= 0) {
      throw new BadRequestException('Upload the video before attaching it — the file was not found in storage.');
    }
  }
}
