import {
  BulkPurchase,
  Coupon,
  Payment,
  Payout,
  PayoutHold,
  Referral,
  ReferralCode,
  RefundRequest,
  Sponsorship,
  Wallet,
  WalletTransaction,
} from './entities';
import { migrations } from './migrations';
import { OutboxEvent } from '@ethiopialearn/common';

/**
 * Everything that defines the financial schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'financial';
export const entities = [Payment, Payout, RefundRequest, PayoutHold, Coupon, Wallet, WalletTransaction, Sponsorship, BulkPurchase, ReferralCode, Referral, OutboxEvent];
export { migrations };
