import { currentContext } from '../context';

/** The event a bus handler is running for: what shared helpers (inbox, email, dedupe) key on. */
export interface EventContext {
  event_id: string;
  event_type: string;
  correlation_id: string;
  /** The handler's name, as given to `subscribe` (or its default). */
  handler: string;
}

/** The event the current code runs for, or undefined outside a bus handler. A view onto the request context. */
export function currentEvent(): EventContext | undefined {
  const context = currentContext();
  if (!context?.event_id) return undefined;
  const { event_id, event_type = '', correlation_id = '', handler = '' } = context;
  return { event_id, event_type, correlation_id, handler };
}
