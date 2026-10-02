import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** `GET coupons/validate?code=…&course_id=<uuid>` — course_id reaches an internal path, so it must be a uuid. */
export class CouponValidateQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @IsUUID('all')
  course_id: string;
}
