import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export const MiB = 1024 * 1024;

export const VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'] as const;
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type SmallUploadKind = 'video' | 'thumbnail' | 'photo';

/** Single-PUT uploads. Larger videos must use the resumable multipart flow. */
export const SMALL_UPLOAD_MAX_BYTES: Record<SmallUploadKind, number> = {
  thumbnail: 5 * MiB,
  photo: 5 * MiB,
  video: 16 * MiB,
};

/** POST /uploads — one presigned PUT with the exact size signed in. */
export class CreateUploadDto {
  @IsIn(['video', 'thumbnail', 'photo'])
  kind: SmallUploadKind;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  filename: string;

  // Checked against the per-kind allowlist in UploadService (the message names the allowed formats).
  @IsString()
  @MaxLength(100)
  content_type: string;

  // Per-kind maximum is enforced in UploadService so the message can name the limit.
  @IsInt()
  @Min(1)
  size: number;

  /**
   * Videos only: the lesson the video is for. The lesson must be editable by
   * the caller, and the object is keyed under the course author's prefix so it
   * can be attached even when a platform admin uploads it (as multipart does).
   */
  @IsOptional()
  @IsUUID()
  lesson_id?: string;
}

/** POST /uploads/multipart */
export class CreateMultipartUploadDto {
  @IsIn(['video'])
  kind: 'video';

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  filename: string;

  // Upper bound is MAX_VIDEO_UPLOAD_BYTES, read at request time in UploadService.
  @IsInt()
  @Min(1)
  size: number;

  @IsIn(VIDEO_CONTENT_TYPES as unknown as string[], {
    message: 'Videos must be MP4, WebM, MOV or M4V. Convert other formats to MP4 (H.264) first.',
  })
  content_type: string;

  @IsOptional()
  @IsUUID()
  lesson_id?: string;
}

/** POST /uploads/multipart/:id/parts — signed in batches so a large file does not trip the write rate limit. */
export class SignPartsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}

/** POST /uploads/multipart/:id/complete */
export class CompleteMultipartUploadDto {
  @IsOptional()
  @IsUUID()
  lesson_id?: string;
}
