import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Repository } from 'typeorm';

/** Append-only audit log for admin actions (spec §13 auditability). */
@Entity({ name: 'audit_log' })
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  actor_id: string;

  @Column()
  action: string;

  @Column()
  target: string;

  @Column({ type: 'jsonb', default: {} })
  detail: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

export async function appendAudit(
  repo: Repository<AuditLog>,
  actorId: string,
  action: string,
  target: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await repo.save(repo.create({ actor_id: actorId, action, target, detail }));
}
