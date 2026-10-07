import { v5 as uuidv5 } from 'uuid';

/** Never change it: the ids of events already sent would stop matching their re-sends. */
const STABLE_EVENT_NAMESPACE = '5b7bed6f-1ae7-4f20-9ae7-706f75b31ff1';

/**
 * The same event id for every send of one business event, keyed by what makes it
 * unique (for example `${payment.id}:PaymentConfirmed`), so a re-publish is the
 * same event to the consumers' dedupe (9a). Phase 9b decision 5.
 */
export function stableEventId(key: string): string {
  return uuidv5(key, STABLE_EVENT_NAMESPACE);
}
