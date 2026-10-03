import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955685613 } from './1790955685613-Baseline';
import { IndexTuning1790956077866 } from './1790956077866-IndexTuning';
import { PaymentEffects1790966512486 } from './1790966512486-PaymentEffects';
import { PaymentIntegrityIndexes1790966512487 } from './1790966512487-PaymentIntegrityIndexes';
import { CouponPerUserLimit1790966512488 } from './1790966512488-CouponPerUserLimit';
import { CapIndexes1790966512489 } from './1790966512489-CapIndexes';
import { PendingCreditsRefundMark1790966512490 } from './1790966512490-PendingCreditsRefundMark';
import { PendingCreditIndexes1790966512491 } from './1790966512491-PendingCreditIndexes';
import { Outbox1791054801417 } from './1791054801417-Outbox';

// Every migration of the financial schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [
  Baseline1790955685613,
  IndexTuning1790956077866,
  PaymentEffects1790966512486,
  PaymentIntegrityIndexes1790966512487,
  CouponPerUserLimit1790966512488,
  CapIndexes1790966512489,
  PendingCreditsRefundMark1790966512490,
  PendingCreditIndexes1790966512491,
  Outbox1791054801417,
];
