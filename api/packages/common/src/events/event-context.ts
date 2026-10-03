import { AsyncLocalStorage } from 'async_hooks';

/** The event a bus handler is running for: what shared helpers (inbox, email, dedupe) key on. */
export interface EventContext {
  event_id: string;
  event_type: string;
  correlation_id: string;
  /** The handler's name, as given to `subscribe` (or its default). */
  handler: string;
}

export const eventContext = new AsyncLocalStorage<EventContext>();

/** The event the current code runs for, or undefined outside a bus handler. */
export function currentEvent(): EventContext | undefined {
  return eventContext.getStore();
}
