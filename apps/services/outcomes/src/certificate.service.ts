import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import PDFDocument = require('pdfkit');
import * as QRCode from 'qrcode';
import { env, EventBusService, InternalHttpClient } from '@ethiopialearn/common';
import {
  AssessmentResultPayload,
  CertificateIssuedPayload,
  CourseCompletedPayload,
  TrustTier,
  TrustTierChangedPayload,
} from '@ethiopialearn/contracts';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Assessment, AssessmentAttempt, Certificate, EducatorTierCache } from './entities';

@Injectable()
export class CertificateService implements OnModuleInit {
  private readonly logger = new Logger(CertificateService.name);
  private readonly webUrl = env('WEB_URL', 'http://localhost:3000');

  constructor(
    @InjectRepository(Certificate) private readonly certificates: Repository<Certificate>,
    @InjectRepository(Assessment) private readonly assessments: Repository<Assessment>,
    @InjectRepository(AssessmentAttempt) private readonly attempts: Repository<AssessmentAttempt>,
    @InjectRepository(EducatorTierCache) private readonly tierCache: Repository<EducatorTierCache>,
    private readonly bus: EventBusService,
    private readonly storage: S3StorageProvider,
    private readonly internal: InternalHttpClient,
  ) {}

  onModuleInit() {
    // Cert issuance triggers (spec §12.4): CourseCompleted when no assessment
    // is configured; AssessmentPassed when one is.
    this.bus.subscribe<CourseCompletedPayload>('CourseCompleted', async (p) => {
      if (await this.allRequiredAssessmentsPassed(p.course_id, p.learner_id)) {
        await this.issue(p);
      }
    });
    this.bus.subscribe<AssessmentResultPayload>('AssessmentPassed', async (p) => {
      // Lessons must also be complete (spec §10.1 completion definition).
      const enrollment = await this.internal.get<{ lessons_complete: boolean }>(
        `/api/v1/internal/enrollments/${p.enrollment_id}`,
      );
      if (!enrollment.lessons_complete) return;
      if (!(await this.allRequiredAssessmentsPassed(p.course_id, p.learner_id))) return;
      await this.issue({
        enrollment_id: p.enrollment_id,
        learner_id: p.learner_id,
        learner_email: p.learner_email,
        learner_name: p.learner_name,
        course_id: p.course_id,
        course_title: p.course_title,
        educator_id: p.educator_id,
        educator_name: p.educator_name,
        completed_at: new Date().toISOString(),
      });
    });
    // Spec event table: TrustTierChanged → Learning Outcomes. New certificates
    // snapshot the updated tier; issued snapshots stay immutable by design.
    this.bus.subscribe<TrustTierChangedPayload>('TrustTierChanged', async (p) => {
      await this.tierCache.save(this.tierCache.create({ educator_id: p.educator_id, tier: p.new_tier }));
    });
  }

  async issue(p: CourseCompletedPayload): Promise<void> {
    const existing = await this.certificates.findOne({ where: { enrollment_id: p.enrollment_id } });
    if (existing) return; // idempotent

    const uid = randomUUID();
    const signature = this.sign(uid);
    const verifyUrl = `${this.webUrl}/verify/${uid}`;

    const passedTypes = await this.passedAssessmentTypes(p.course_id, p.learner_id);
    const tierRow = p.educator_id ? await this.tierCache.findOne({ where: { educator_id: p.educator_id } }) : null;
    const tier = tierRow?.tier ?? TrustTier.NEW;

    const qrPng = await QRCode.toBuffer(verifyUrl, { width: 220, margin: 1 });
    const pdf = await this.renderPdf(p, uid, qrPng, passedTypes, tier);
    const pdfKey = `certificates/${uid}.pdf`;
    await this.storage.putObject(pdfKey, pdf, 'application/pdf');

    const cert = await this.certificates.save(
      this.certificates.create({
        enrollment_id: p.enrollment_id,
        certificate_uid: uid,
        signature,
        pdf_s3_key: pdfKey,
        qr_code_url: verifyUrl,
        learner_id: p.learner_id,
        learner_name: p.learner_name,
        course_id: p.course_id,
        course_title: p.course_title,
        educator_name: p.educator_name,
        assessment_badges: passedTypes,
        trust_tier_snapshot: tier,
      }),
    );

    await this.bus.publish<CertificateIssuedPayload>('CertificateIssued', {
      certificate_id: cert.id,
      certificate_uid: uid,
      enrollment_id: p.enrollment_id,
      learner_id: p.learner_id,
      learner_email: p.learner_email,
      learner_name: p.learner_name,
      course_id: p.course_id,
      course_title: p.course_title,
      verify_url: verifyUrl,
    });
    this.logger.log(`certificate issued ${uid} for enrollment ${p.enrollment_id}`);
  }

  /** Public verification (spec §9.4) — validates the signed uid. */
  async verify(uid: string) {
    const cert = await this.certificates.findOne({ where: { certificate_uid: uid } });
    if (!cert || cert.invalidated) return { valid: false };
    const expected = this.sign(cert.certificate_uid);
    const stored = Buffer.from(cert.signature);
    const computed = Buffer.from(expected);
    if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) {
      // Signature mismatch = tampering (spec §10.6). TODO(spec-open-question):
      // no domain event exists for certificate-manipulation flags in the MVP
      // registry; logged for admin follow-up instead.
      this.logger.warn(`certificate signature mismatch for ${uid}`);
      return { valid: false };
    }
    return {
      valid: true,
      course_title: cert.course_title,
      learner_name: cert.learner_name,
      educator_name: cert.educator_name,
      issued_at: cert.issued_at,
      trust_tier: cert.trust_tier_snapshot,
      assessment_badges: cert.assessment_badges,
    };
  }

  async listForLearner(learnerId: string) {
    const rows = await this.certificates.find({ where: { learner_id: learnerId }, order: { issued_at: 'DESC' } });
    return rows.map((c) => ({
      id: c.id,
      certificate_uid: c.certificate_uid,
      course_id: c.course_id,
      course_title: c.course_title,
      educator_name: c.educator_name,
      issued_at: c.issued_at,
      verify_url: c.qr_code_url,
      assessment_badges: c.assessment_badges,
    }));
  }

  async downloadUrl(learnerId: string, certificateId: string) {
    const cert = await this.certificates.findOne({ where: { id: certificateId, learner_id: learnerId } });
    if (!cert) throw new NotFoundException('Certificate not found');
    return this.storage.getSignedStreamUrl(cert.pdf_s3_key, 900);
  }

  async allRequiredAssessmentsPassed(courseId: string, learnerId: string): Promise<boolean> {
    const required = await this.assessments.find({ where: { course_id: courseId, is_required: true } });
    for (const assessment of required) {
      const passed = await this.attempts.findOne({
        where: { assessment_id: assessment.id, learner_id: learnerId, passed: true },
      });
      if (!passed) return false;
    }
    return true;
  }

  private async passedAssessmentTypes(courseId: string, learnerId: string): Promise<string[]> {
    const all = await this.assessments.find({ where: { course_id: courseId } });
    const types: string[] = [];
    for (const assessment of all) {
      const passed = await this.attempts.findOne({
        where: { assessment_id: assessment.id, learner_id: learnerId, passed: true },
      });
      if (passed && !types.includes(assessment.type)) types.push(assessment.type);
    }
    return types;
  }

  private sign(uid: string): string {
    return createHmac('sha256', env('CERT_SIGNING_SECRET', env('JWT_SECRET', 'dev-jwt-secret-change-me'))).update(uid).digest('hex');
  }

  private renderPdf(
    p: CourseCompletedPayload,
    uid: string,
    qrPng: Buffer,
    badges: string[],
    tier: TrustTier,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 48 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(24, 24, doc.page.width - 48, doc.page.height - 48).lineWidth(2).stroke('#0f766e');
      doc.moveDown(2);
      doc.fontSize(14).fillColor('#0f766e').text('ETHIOPIALEARN', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(30).fillColor('#111827').text('Certificate of Completion', { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(12).fillColor('#374151').text('This certifies that', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(26).fillColor('#111827').text(p.learner_name || 'Learner', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(12).fillColor('#374151').text('has successfully completed', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(20).fillColor('#111827').text(p.course_title, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#374151').text(`Instructor: ${p.educator_name || '—'}   ·   Trust tier: ${tier}`, { align: 'center' });
      doc.moveDown(0.3);
      doc.text(`Completed: ${new Date(p.completed_at).toDateString()}`, { align: 'center' });
      if (badges.length > 0) {
        doc.moveDown(0.3);
        doc.text(`Assessments passed: ${badges.join(', ')}`, { align: 'center' });
      }
      doc.image(qrPng, doc.page.width - 160, doc.page.height - 170, { width: 110 });
      doc.fontSize(9).fillColor('#6b7280').text(`Certificate ID: ${uid}`, 48, doc.page.height - 90);
      doc.text(`Verify: ${this.webUrl}/verify/${uid}`, 48, doc.page.height - 76);
      doc.end();
    });
  }
}
