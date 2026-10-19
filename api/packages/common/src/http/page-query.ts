import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

interface LimitOptions {
  defaultLimit: number;
  maxLimit: number;
}

/** `?limit=` as a validated DTO: a bad value answers 400 instead of being clamped silently. */
export function limitQuery({ defaultLimit, maxLimit }: LimitOptions) {
  class LimitQuery {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(maxLimit)
    limit: number = defaultLimit;
  }
  return LimitQuery;
}

/** `?page=&limit=` as a validated DTO (page 1..10000, limit 1..maxLimit). */
export function pageQuery(opts: LimitOptions) {
  class PageQuery extends limitQuery(opts) {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(10000)
    page: number = 1;
  }
  return PageQuery;
}
