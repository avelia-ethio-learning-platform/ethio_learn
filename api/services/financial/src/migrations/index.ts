import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955685613 } from './1790955685613-Baseline';
import { IndexTuning1790956077866 } from './1790956077866-IndexTuning';
import { PaymentEffects1790966512486 } from './1790966512486-PaymentEffects';
import { PaymentIntegrityIndexes1790966512487 } from './1790966512487-PaymentIntegrityIndexes';
import { CouponPerUserLimit1790966512488 } from './1790966512488-CouponPerUserLimit';
import { CapIndexes1790966512489 } from './1790966512489-CapIndexes';

// Every migration of the financial schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [
  Baseline1790955685613,
  IndexTuning1790956077866,
  PaymentEffects1790966512486,
  PaymentIntegrityIndexes1790966512487,
  CouponPerUserLimit1790966512488,
  CapIndexes1790966512489,
];
