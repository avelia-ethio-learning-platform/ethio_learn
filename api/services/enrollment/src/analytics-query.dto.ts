import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** `GET enrollments/analytics?course_ids=<uuid>,<uuid>` — comma-separated list, split here so validation sees real ids. */
export class AnalyticsQuery {
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '' && v != null),
  )
  @IsArray()
  @ArrayMinSize(1, { message: 'course_ids is required (comma-separated)' })
  @ArrayMaxSize(25, { message: 'course_ids accepts at most 25 ids' })
  @IsUUID('all', { each: true, message: 'course_ids must be comma-separated uuids' })
  course_ids: string[] = [];
}
