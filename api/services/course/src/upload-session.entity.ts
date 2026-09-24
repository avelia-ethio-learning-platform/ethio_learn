import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type UploadSessionStatus = 'uploading' | 'completed' | 'aborted';

/** Postgres returns bigint as a string (it can exceed 2^53); upload sizes are
 *  capped far below that, so a plain number is safe and keeps the math simple. */
const bigintToNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * One presigned multipart upload (educator video). The server owns the
 * session so completion is idempotent, the per-user cap is enforceable and an
 * unfinished upload can be resumed from another device. Bytes never pass
 * through the API — the browser PUTs parts straight to object storage.
 */
@Entity({ name: 'upload_sessions' })
export class UploadSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  owner_id: string;

  @Column({ type: 'varchar', default: 'video' })
  kind: string;

  /** Lesson the video is attached to on completion (optional). */
  @Column({ type: 'uuid', nullable: true })
  lesson_id: string | null;

  /** Server-generated object key: videos/<owner_id>/<uuid>-<safe name>. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 400 })
  key: string;

  /** R2 upload ids are ~343 chars (observed), too long for varchar(255). */
  @Column({ type: 'text' })
  upload_id: string;

  @Column({ type: 'varchar', length: 200 })
  filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size: number;

  /** Fixed for the whole upload: R2 rejects unequal non-trailing parts. */
  @Column({ type: 'int' })
  part_size: number;

  @Column({ type: 'int' })
  part_count: number;

  @Column({ type: 'varchar', default: 'uploading' })
  status: UploadSessionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;
}
