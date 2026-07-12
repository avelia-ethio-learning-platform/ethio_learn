import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InternalGuard } from '@ethiopialearn/common';
import { AssessmentAttempt, Certificate } from './entities';

/** Service-to-service reads used by the Financial refund rules (spec §10.4). */
@Controller('internal')
@UseGuards(InternalGuard)
export class OutcomesInternalController {
  constructor(
    @InjectRepository(Certificate) private readonly certificates: Repository<Certificate>,
    @InjectRepository(AssessmentAttempt) private readonly attempts: Repository<AssessmentAttempt>,
  ) {}

  @Get('enrollments/:id/outcomes-status')
  async outcomesStatus(@Param('id') enrollmentId: string) {
    const certificate = await this.certificates.findOne({ where: { enrollment_id: enrollmentId } });
    const passedAttempt = await this.attempts.findOne({ where: { enrollment_id: enrollmentId, passed: true } });
    return {
      certificate_issued: !!certificate,
      assessment_passed: !!passedAttempt,
    };
  }
}
