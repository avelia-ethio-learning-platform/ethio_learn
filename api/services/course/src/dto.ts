import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CourseCategory, PricingType } from '@ethiopialearn/contracts';

export class LessonInputDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title: string;

  /** One-line lesson description (the AI outline generator fills this in). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  video_s3_key?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  duration_seconds?: number;
}

export class SectionInputDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title: string;

  @IsBoolean()
  is_free_preview: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LessonInputDto)
  lessons?: LessonInputDto[];
}

export class CreateCourseDto {
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  title: string;

  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  description: string;

  @IsEnum(CourseCategory)
  category: CourseCategory;

  /** English only for MVP (spec §7.2). */
  @IsIn(['en'])
  language: string;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @IsEnum(PricingType)
  pricing_type: PricingType;

  @IsOptional()
  @IsNumber()
  @Min(1)
  price_etb?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectionInputDto)
  sections?: SectionInputDto[];
}

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(CourseCategory)
  category?: CourseCategory;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @IsOptional()
  @IsEnum(PricingType)
  pricing_type?: PricingType;

  @IsOptional()
  @IsNumber()
  @Min(1)
  price_etb?: number;
}

export class UploadRequestDto {
  @IsIn(['video', 'thumbnail', 'photo'])
  kind: 'video' | 'thumbnail' | 'photo';

  @IsString()
  @MaxLength(200)
  filename: string;

  @IsString()
  @MaxLength(100)
  content_type: string;
}
