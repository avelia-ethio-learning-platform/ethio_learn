import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { InternalHttpClient, InternalPath, internalPath } from './internal-client';

/**
 * Caps of the three batch endpoints (Phase 9e), shared by the endpoint and its
 * callers. 50 pairs, not more: each `learner:course` pair encodes to about 75
 * characters, and Node's default 16 KiB header budget holds the request line.
 */
export const BATCH_CAPS = { users: 100, lessonIds: 100, progressPairs: 50 } as const;

/**
 * Splits `a,b,c` (or a repeated param) into trimmed, non-empty items, so validation sees each one.
 * Lowercased: results are keyed by the id as the database returns it.
 */
const commaList = ({ value }: { value: unknown }) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]))
    .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v))
    .filter((v) => v !== '' && v != null);

/** `?ids=<uuid>,<uuid>` with 1..max ids: anything else is a 400. */
export function idsQuery(max: number) {
  class IdsQuery {
    @Transform(commaList)
    @IsArray()
    @ArrayMinSize(1, { message: 'ids is required (comma-separated)' })
    @ArrayMaxSize(max, { message: `ids accepts at most ${max} ids` })
    @IsUUID('all', { each: true, message: 'ids must be comma-separated uuids' })
    ids: string[] = [];
  }
  return IdsQuery;
}

/** `GET internal/users?ids=…[&fields=email]`. */
export class UserIdsQuery extends idsQuery(BATCH_CAPS.users) {
  @IsOptional()
  @IsIn(['email'])
  fields?: 'email';
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** `GET internal/entitlements/progress?pairs=<learner>:<course>,…` with 1..50 pairs. */
export class ProgressPairsQuery {
  @Transform(commaList)
  @IsArray()
  @ArrayMinSize(1, { message: 'pairs is required (comma-separated learner:course)' })
  @ArrayMaxSize(BATCH_CAPS.progressPairs, { message: `pairs accepts at most ${BATCH_CAPS.progressPairs} pairs` })
  @Matches(new RegExp(`^${UUID}:${UUID}$`), { each: true, message: 'pairs must be comma-separated learner_id:course_id uuids' })
  pairs: string[] = [];
}

/**
 * One batch read per chunk of `cap` distinct items, the chunks in parallel (a
 * page holds at most a few chunks). Returns each chunk's response in order;
 * no call for an empty list. Errors are the client's typed errors: whether a
 * failure degrades or propagates is the caller's call.
 */
export async function getMany<T>(
  client: Pick<InternalHttpClient, 'get'>,
  items: readonly string[],
  cap: number,
  path: (chunk: string[]) => InternalPath,
): Promise<T[]> {
  const distinct = [...new Set(items)];
  const chunks: string[][] = [];
  for (let i = 0; i < distinct.length; i += cap) chunks.push(distinct.slice(i, i + cap));
  return mapLimited(chunks, (chunk) => client.get<T>(path(chunk)));
}

/** Parallel internal calls at a time: peers on the free plan wake slowly, so a fan-out never stampedes them. */
export const PEER_CONCURRENCY = 4;

/** `Promise.all(items.map(fn))`, run `limit` at a time; results keep the input order. */
export async function mapLimited<I, O>(items: readonly I[], fn: (item: I) => Promise<O>, limit = PEER_CONCURRENCY): Promise<O[]> {
  const out: O[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

export interface UserSummary {
  id: string;
  name: string;
  role: string;
  email?: string;
}

/** Users by id from auth's batch endpoint; an unknown id is simply absent. Email only when asked for. */
export async function userSummaries(
  client: Pick<InternalHttpClient, 'get'>,
  ids: readonly string[],
  opts: { email?: boolean } = {},
): Promise<Map<string, UserSummary>> {
  const pages = await getMany<UserSummary[]>(client, ids, BATCH_CAPS.users, (chunk) =>
    opts.email ? internalPath`/api/v1/internal/users?ids=${chunk}&fields=email` : internalPath`/api/v1/internal/users?ids=${chunk}`,
  );
  return new Map(pages.flat().map((u) => [u.id, u]));
}

/** Live lesson ids per course from course's batch endpoint; every asked course is present (an unknown one has none). */
export async function courseLessonIds(client: Pick<InternalHttpClient, 'get'>, courseIds: readonly string[]): Promise<Map<string, string[]>> {
  const pages = await getMany<Record<string, string[]>>(client, courseIds, BATCH_CAPS.lessonIds, (chunk) =>
    internalPath`/api/v1/internal/courses/lesson-ids?ids=${chunk}`,
  );
  return new Map(pages.flatMap((p) => Object.entries(p)));
}

export interface LearnerProgress {
  learner_id: string;
  course_id: string;
  active: boolean;
  progress_percent: number | null;
  lessons_complete: boolean;
}

/** Progress per `learner:course` pair from enrollment's batch endpoint, keyed by the pair; a pair without an enrollment is absent. */
export async function learnerProgress(
  client: Pick<InternalHttpClient, 'get'>,
  pairs: readonly string[],
): Promise<Map<string, LearnerProgress>> {
  const pages = await getMany<LearnerProgress[]>(client, pairs, BATCH_CAPS.progressPairs, (chunk) =>
    internalPath`/api/v1/internal/entitlements/progress?pairs=${chunk}`,
  );
  return new Map(pages.flat().map((p) => [`${p.learner_id}:${p.course_id}`, p]));
}
