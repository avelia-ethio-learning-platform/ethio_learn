/// <reference types="jest" />
import { FindOperator, QueryFailedError } from 'typeorm';
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
} from '../entities';

/**
 * In-memory stand-in for the financial schema in unit tests: repositories with
 * the find operators the services use, unique indexes (partial ones too) that
 * throw 23505 like Postgres, the raw SQL of the wallet ledger and refunds,
 * advisory locks, and transactions and savepoints that roll their writes back
 * on a throw.
 *
 * Statements are atomic, so a conditional update decides one winner between
 * two interleaved flows, as it does under Postgres row locks. There is no
 * isolation between concurrent transactions: a rollback restores the whole
 * store, so race tests should not make a transaction throw.
 */
export type Row = Record<string, any>;

interface UniqueIndex {
  columns: string[];
  where?: (row: Row) => boolean;
}

function matchValue(value: unknown, want: unknown): boolean {
  if (want instanceof FindOperator) {
    switch (want.type) {
      case 'in':
        return (want.value as unknown[]).includes(value);
      case 'isNull':
        return value === null || value === undefined;
      case 'not':
        // `.value` unwraps a nested operator (Not(In([...])).value is the array); `.child` keeps it.
        return !matchValue(value, want.child ?? want.value);
      case 'lessThan':
        return value != null && (value as number) < (want.value as number);
      case 'lessThanOrEqual':
        return value != null && (value as number) <= (want.value as number);
      case 'moreThan':
        return value != null && (value as number) > (want.value as number);
      case 'between': {
        const [from, to] = want.value as unknown as [number, number];
        return value != null && (value as number) >= from && (value as number) <= to;
      }
      default:
        throw new Error(`fake db: unsupported operator ${want.type}`);
    }
  }
  return (value ?? null) === (want ?? null);
}

export function matches(row: Row, where: Row | Row[] = {}): boolean {
  if (Array.isArray(where)) return where.some((w) => matches(row, w));
  return Object.entries(where).every(([key, want]) => matchValue(row[key], want));
}

export function uniqueViolation(index: string): QueryFailedError {
  const driverError = Object.assign(new Error(`duplicate key value violates unique constraint "${index}"`), { code: '23505' });
  return new QueryFailedError('fake', [], driverError);
}

let idSeq = 0;
const newId = (prefix: string) => `${prefix}-${++idSeq}`;

export class FakeRepo {
  readonly metadata: { tablePath: string };

  constructor(
    readonly name: string,
    public rows: Row[] = [],
    private readonly uniques: UniqueIndex[] = [],
  ) {
    this.metadata = { tablePath: `financial.${name}` };
  }

  private violates(candidate: Row): string | null {
    for (const u of this.uniques) {
      if (u.where && !u.where(candidate)) continue;
      const clash = this.rows.some(
        (r) => r !== candidate && r.id !== candidate.id && (!u.where || u.where(r)) && u.columns.every((c) => (r[c] ?? null) === (candidate[c] ?? null)),
      );
      if (clash) return `${this.name}(${u.columns.join(',')})`;
    }
    return null;
  }

  /** The row would break a unique index (for INSERT … ON CONFLICT DO NOTHING). */
  conflicts(candidate: Row): boolean {
    return this.violates(candidate) !== null;
  }

  private select(opts: { where?: Row | Row[]; order?: Record<string, 'ASC' | 'DESC'>; take?: number } = {}): Row[] {
    let out = this.rows.filter((r) => matches(r, opts.where));
    const order = Object.entries(opts.order ?? {});
    if (order.length) {
      out = [...out].sort((a, b) => {
        for (const [key, dir] of order) {
          const [x, y] = [a[key], b[key]];
          if (x === y) continue;
          // Postgres: NULLS LAST for ASC, NULLS FIRST for DESC.
          if (x == null) return dir === 'ASC' ? 1 : -1;
          if (y == null) return dir === 'ASC' ? -1 : 1;
          return (x < y ? -1 : 1) * (dir === 'DESC' ? -1 : 1);
        }
        return 0;
      });
    }
    return opts.take != null ? out.slice(0, opts.take) : out;
  }

  create = jest.fn((x: Row) => ({ ...x }));
  // `lock` (FOR UPDATE) is accepted and ignored: there is no isolation to model here.
  find = jest.fn(async (opts?: { where?: Row | Row[]; order?: Record<string, 'ASC' | 'DESC'>; take?: number; lock?: unknown }) =>
    this.select(opts).map((r) => ({ ...r })),
  );
  findOne = jest.fn(async (opts?: { where?: Row | Row[]; order?: Record<string, 'ASC' | 'DESC'> }) => {
    const row = this.select(opts)[0];
    return row ? { ...row } : null;
  });
  count = jest.fn(async (opts?: { where?: Row | Row[] }) => this.select(opts).length);

  private persist(x: Row): Row {
    const stored: Row = { created_at: new Date(), ...x, id: x.id ?? newId(this.name) };
    const clash = this.violates(stored);
    if (clash) throw uniqueViolation(clash);
    const i = this.rows.findIndex((r) => r.id === stored.id);
    if (i === -1) this.rows.push(stored);
    else this.rows[i] = { ...this.rows[i], ...stored };
    x.id = stored.id;
    x.created_at ??= stored.created_at;
    return x;
  }

  save = jest.fn(async (x: Row | Row[]) => (Array.isArray(x) ? x.map((r) => this.persist(r)) : this.persist(x)));
  insert = jest.fn(async (x: Row) => {
    if (x.id && this.rows.some((r) => r.id === x.id)) throw uniqueViolation(`${this.name}(id)`);
    this.persist(x);
    return { identifiers: [{ id: x.id }] };
  });
  update = jest.fn(async (where: Row, patch: Row) => {
    const hit = this.rows.filter((r) => matches(r, where));
    for (const r of hit) {
      const next = { ...r, ...patch };
      const clash = this.violates(next);
      if (clash) throw uniqueViolation(clash);
      Object.assign(r, patch);
    }
    return { affected: hit.length, raw: [], generatedMaps: [] };
  });
  increment = jest.fn(async (where: Row, column: string, by: number) => {
    const hit = this.rows.filter((r) => matches(r, where));
    hit.forEach((r) => (r[column] = Number(r[column] ?? 0) + by));
    return { affected: hit.length };
  });
  delete = jest.fn(async (where: Row) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { affected: before - this.rows.length };
  });
}

const UNIQUE_WALLET_KINDS = ['topup', 'cashback', 'referral_reward', 'purchase'];

export function fakeDb() {
  const repos = new Map<unknown, FakeRepo>([
    [Payment, new FakeRepo('payments', [], [{ columns: ['chapa_tx_ref'] }])],
    [Payout, new FakeRepo('payouts')],
    [RefundRequest, new FakeRepo('refund_requests', [], [{ columns: ['payment_id'], where: (r) => ['pending', 'approved'].includes(r.status) }])],
    [PayoutHold, new FakeRepo('payout_holds')],
    [Coupon, new FakeRepo('coupons', [], [{ columns: ['code'] }])],
    [Wallet, new FakeRepo('wallets')],
    [WalletTransaction, new FakeRepo('wallet_transactions', [], [{ columns: ['kind', 'reference'], where: (r) => UNIQUE_WALLET_KINDS.includes(r.kind) }])],
    [Referral, new FakeRepo('referrals', [], [{ columns: ['referred_user_id'], where: (r) => r.referred_user_id != null }])],
    [ReferralCode, new FakeRepo('referral_codes', [], [{ columns: ['code'] }])],
    [Sponsorship, new FakeRepo('sponsorships')],
    [BulkPurchase, new FakeRepo('bulk_purchases')],
  ]);
  const repo = (entity: unknown): FakeRepo => {
    const r = repos.get(entity);
    if (!r) throw new Error('fake db: unknown entity');
    return r;
  };
  const wallets = repo(Wallet);
  const walletTx = repo(WalletTransaction);
  const heldLocks = new Set<string>();
  /** A raw UPDATE without RETURNING: patches the rows that match and resolves to [[], rowCount], as query() does under pg. */
  const updateWhere = (table: FakeRepo, hit: (row: Row) => boolean, patch: Row): [Row[], number] => {
    const rows = table.rows.filter(hit);
    rows.forEach((r) => Object.assign(r, patch));
    return [[], rows.length];
  };

  /** Every statement the services send as raw SQL, interpreted in memory. */
  const runQuery = async (sql: string, params: any[] = [], txLocks?: Set<string>): Promise<any> => {
    const s = sql.replace(/\s+/g, ' ').trim();
    // A credit names its state (available or pending); a debit takes the column defaults.
    if (
      /^INSERT INTO financial\.wallet_transactions \(user_id, amount_etb, kind, reference, note, state, available_at, payment_id\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\) ON CONFLICT DO NOTHING RETURNING id$/.test(s) ||
      /^INSERT INTO financial\.wallet_transactions \(user_id, amount_etb, kind, reference, note\) VALUES \(\$1, \$2, \$3, \$4, \$5\) ON CONFLICT DO NOTHING RETURNING id$/.test(s)
    ) {
      const [user_id, amount_etb, kind, reference, note, state = 'available', available_at = null, payment_id = null] = params;
      const row = { user_id, amount_etb, kind, reference, note, state, available_at, payment_id };
      if (walletTx.conflicts(row)) return [];
      await walletTx.insert(row);
      return [{ id: (row as Row).id }];
    }
    if (
      s ===
      "UPDATE financial.wallet_transactions SET state = 'available' WHERE user_id = $1 AND state = 'pending' AND available_at <= now() AND NOT EXISTS (SELECT 1 FROM financial.payments p WHERE p.id = wallet_transactions.payment_id AND (p.refund_requested_at IS NOT NULL OR p.status <> 'confirmed')) RETURNING amount_etb"
    ) {
      const held = (t: Row) => repo(Payment).rows.some((p) => p.id === t.payment_id && (p.refund_requested_at != null || p.status !== 'confirmed'));
      const matured = (t: Row) => t.available_at != null && new Date(t.available_at).getTime() <= Date.now();
      const released = walletTx.rows.filter((t) => t.user_id === params[0] && t.state === 'pending' && matured(t) && !held(t));
      released.forEach((t) => (t.state = 'available'));
      return [released.map((t) => ({ amount_etb: t.amount_etb })), released.length];
    }
    // The owner's pending total (all pending rows, whatever their purchase's refund state).
    if (s === "SELECT COALESCE(SUM(amount_etb), 0) AS sum FROM financial.wallet_transactions WHERE user_id = $1 AND state = 'pending'") {
      const sum = walletTx.rows.filter((t) => t.user_id === params[0] && t.state === 'pending').reduce((acc, t) => acc + Number(t.amount_etb), 0);
      return [{ sum: sum.toFixed(2) }];
    }
    // An approved refund voids its purchase's pending cashback and referral reward.
    if (s === "UPDATE financial.wallet_transactions SET state = 'void' WHERE payment_id = $1 AND state = 'pending' AND kind IN ('cashback', 'referral_reward')") {
      const voidable = (t: Row) => t.payment_id === params[0] && t.state === 'pending' && ['cashback', 'referral_reward'].includes(t.kind);
      return updateWhere(walletTx, voidable, { state: 'void' });
    }
    // Refunds: the request's mark, the approval's flip, and the denial's clear.
    if (s === "UPDATE financial.payments SET refund_requested_at = now() WHERE id = $1 AND status = 'confirmed' AND payout_id IS NULL AND refund_requested_at IS NULL") {
      const markable = (p: Row) => p.id === params[0] && p.status === 'confirmed' && p.payout_id == null && p.refund_requested_at == null;
      return updateWhere(repo(Payment), markable, { refund_requested_at: new Date() });
    }
    if (s === "UPDATE financial.payments SET status = 'refunded' WHERE id = $1 AND status = 'confirmed' AND payout_id IS NULL") {
      return updateWhere(repo(Payment), (p) => p.id === params[0] && p.status === 'confirmed' && p.payout_id == null, { status: 'refunded' });
    }
    if (s === 'UPDATE financial.payments SET refund_requested_at = NULL WHERE id = $1') {
      return updateWhere(repo(Payment), (p) => p.id === params[0], { refund_requested_at: null });
    }
    if (/^INSERT INTO financial\.wallets .* ON CONFLICT \(user_id\) DO NOTHING$/.test(s)) {
      if (!wallets.rows.some((w) => w.user_id === params[0])) wallets.rows.push({ id: params[0], user_id: params[0], balance_etb: '0.00' });
      return [];
    }
    let m = /^UPDATE financial\.wallets SET balance_etb = balance_etb ([+-]) \$2, updated_at = now\(\) WHERE user_id = \$1( AND balance_etb >= \$2)? RETURNING balance_etb$/.exec(s);
    if (m) {
      const w = wallets.rows.find((r) => r.user_id === params[0]);
      const amount = Number(params[1]);
      if (!w || (m[2] && Number(w.balance_etb) < amount)) return [[], 0];
      w.balance_etb = (Number(w.balance_etb) + (m[1] === '+' ? amount : -amount)).toFixed(2);
      return [[{ balance_etb: w.balance_etb }], 1];
    }
    if (/^SELECT balance_etb FROM financial\.wallets WHERE user_id = \$1$/.test(s)) {
      const w = wallets.rows.find((r) => r.user_id === params[0]);
      return w ? [{ balance_etb: w.balance_etb }] : [];
    }
    m = /^SELECT payee_id FROM financial\.payments WHERE status = 'confirmed' AND payout_id IS NULL AND purpose <> 'wallet_topup' AND payee_id <> \$1 AND amount_etb > 0 AND payee_id > \$2 GROUP BY payee_id ORDER BY payee_id LIMIT (\d+)$/.exec(s);
    if (m) {
      const payees = repo(Payment)
        .rows.filter(
          (p) =>
            p.status === 'confirmed' && p.payout_id == null && p.purpose !== 'wallet_topup' && p.payee_id !== params[0] && Number(p.amount_etb) > 0 && p.payee_id > params[1],
        )
        .map((p) => p.payee_id as string);
      return [...new Set(payees)].sort().slice(0, Number(m[1])).map((payee_id) => ({ payee_id }));
    }
    m = /^SELECT pg_try_advisory_xact_lock\(hashtextextended\(\$1, 0\)\) AS locked$/.exec(s);
    if (m) {
      if (!txLocks) throw new Error('fake db: advisory xact lock outside a transaction');
      if (heldLocks.has(params[0]) && !txLocks.has(params[0])) return [{ locked: false }];
      heldLocks.add(params[0]);
      txLocks.add(params[0]);
      return [{ locked: true }];
    }
    throw new Error(`fake db: unexpected SQL: ${s}`);
  };

  const snapshot = () => [...repos.values()].map((r) => r.rows.map((row) => ({ ...row })));
  const restore = (snap: Row[][]) => [...repos.values()].forEach((r, i) => (r.rows = snap[i]));

  /** Wraps fn like a transaction (or a savepoint when nested): its writes vanish on a throw. */
  const atomically = async <T>(fn: () => Promise<T>): Promise<T> => {
    const snap = snapshot();
    try {
      return await fn();
    } catch (err) {
      restore(snap);
      throw err;
    }
  };

  const managerFor = (txLocks?: Set<string>) => {
    const manager: any = {
      getRepository: (entity: unknown) => repo(entity),
      query: jest.fn((sql: string, params?: any[]) => runQuery(sql, params, txLocks)),
      transaction: jest.fn((fn: (m: any) => Promise<unknown>) => atomically(() => fn(manager))),
    };
    return manager;
  };

  const transaction = async <T>(fn: (m: any) => Promise<T>): Promise<T> => {
    const locks = new Set<string>();
    try {
      return await atomically(() => fn(managerFor(locks)));
    } finally {
      locks.forEach((l) => heldLocks.delete(l));
    }
  };
  const dataSource = {
    manager: managerFor(),
    query: jest.fn((sql: string, params?: any[]) => runQuery(sql, params)),
    transaction: jest.fn(transaction) as unknown as typeof transaction & jest.Mock,
  };

  return { repo, dataSource, heldLocks };
}
