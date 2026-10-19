import { ForbiddenException } from '@nestjs/common';
import { UserContext } from '@ethiopialearn/common';
import { FraudSubjectType } from '@ethiopialearn/contracts';
import { QualityController } from './controllers';
import { QualityService } from './quality.service';

const QO = { id: 'qo1', role: 'quality_officer', email: 'q@x.et' } as UserContext;
const ADMIN = { id: 'adm1', role: 'platform_admin', email: 'a@x.et' } as UserContext;
const PAYEE = '0b0c5f5e-8f3a-4f55-9a43-2f1a8e0b6c11';
const signal = { subject_type: FraudSubjectType.COURSE, subject_id: '6f1c2c1e-1d2b-4a3c-8e4f-5a6b7c8d9e0f', signal_type: 'plagiarism', detail: 'copied' };

describe('POST /fraud/signals', () => {
  const setup = () => {
    const raiseFraudSignal = jest.fn(async (input: object) => ({ id: 'f1', ...input }));
    return { raiseFraudSignal, controller: new QualityController({ raiseFraudSignal } as unknown as QualityService) };
  };

  it("does not let a QO hold a payee's payouts", async () => {
    const t = setup();
    await expect(t.controller.raiseSignal(QO, { ...signal, payee_id: PAYEE })).rejects.toThrow(ForbiddenException);
    expect(t.raiseFraudSignal).not.toHaveBeenCalled();
  });

  it('still lets a QO raise a signal without a payee', async () => {
    const t = setup();
    await t.controller.raiseSignal(QO, signal);
    expect(t.raiseFraudSignal).toHaveBeenCalledWith({ ...signal, payee_id: null });
  });

  it('lets a platform admin name the payee', async () => {
    const t = setup();
    await t.controller.raiseSignal(ADMIN, { ...signal, payee_id: PAYEE });
    expect(t.raiseFraudSignal).toHaveBeenCalledWith({ ...signal, payee_id: PAYEE });
  });
});
