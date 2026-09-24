import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { InternalGuard } from '@ethiopialearn/common';
import { CourseService, isLiveRow } from './course.service';

/** Service-to-service READ endpoints (via gateway + internal token). */
@Controller('internal')
@UseGuards(InternalGuard)
export class CourseInternalController {
  constructor(private readonly service: CourseService) {}

  @Get('courses/:id')
  async course(@Param('id') id: string) {
    const course = await this.service.courseOrThrow(id);
    return {
      id: course.id,
      title: course.title,
      owner_id: course.owner_id,
      owner_type: course.owner_type,
      pricing_type: course.pricing_type,
      price_etb: course.price_etb ? Number(course.price_etb) : null,
      status: course.status,
      // Outcomes authorizes assessment authoring against these.
      institution_id: course.institution_id,
      created_by: course.created_by,
    };
  }

  /** LIVE lesson id list for completion detection in Enrollment & Progress. */
  @Get('courses/:id/lesson-ids')
  async lessonIds(@Param('id') id: string) {
    return { lesson_ids: await this.service.lessonIdsForCourse(id) };
  }

  /** Section + lesson titles as a flat outline — used by the AI study coach. */
  @Get('courses/:id/outline')
  async outline(@Param('id') id: string) {
    return { outline: await this.service.outlineForCourse(id) };
  }

  /** `live: false` = added in an unapproved revision; enrollment refuses progress on it. */
  @Get('lessons/:id')
  async lesson(@Param('id') id: string) {
    const { lesson, section, course } = await this.service.lessonWithCourse(id);
    return { id: lesson.id, course_id: course.id, title: lesson.title, live: isLiveRow(lesson) && isLiveRow(section) };
  }

  /** Published-course count per owner — used for trust-tier math (spec §10.5). */
  @Get('owners/:id/published-count')
  async publishedCount(@Param('id') ownerId: string) {
    return { published_count: await this.service.publishedCountForOwner(ownerId) };
  }
}
