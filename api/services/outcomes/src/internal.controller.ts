import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InternalGuard, UuidParam } from '@ethiopialearn/common';
import { AssessmentService } from './assessment.service';
import { AssessmentAttempt, Certificate } from './entities';

/** Service-to-service reads: Financial refund rules (spec §10.4) and the course revision diff. */
@Controller('internal')
@UseGuards(InternalGuard)
export class OutcomesInternalController {
  constructor(
    @InjectRepository(Certificate) private readonly certificates: Repository<Certificate>,
    @InjectRepository(AssessmentAttempt) private readonly attempts: Repository<AssessmentAttempt>,
    private readonly assessmentService: AssessmentService,
  ) {}

  @Get('enrollments/:id/outcomes-status')
  async outcomesStatus(@UuidParam('id') enrollmentId: string) {
    const certificate = await this.certificates.findOne({ where: { enrollment_id: enrollmentId } });
    const passedAttempt = await this.attempts.findOne({ where: { enrollment_id: enrollmentId, passed: true } });
    return {
      certificate_issued: !!certificate,
      assessment_passed: !!passedAttempt,
    };
  }

  /** Assessments staged on a live course, with answer keys, for the quality officer's revision diff. */
  @Get('courses/:id/pending-assessments')
  pendingAssessments(@UuidParam('id') courseId: string) {
    return this.assessmentService.pendingForReview(courseId);
  }
}
