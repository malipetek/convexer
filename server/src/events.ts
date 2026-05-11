export type RuntimeEvent = {
  id: string;
  type: string;
  createdAt: string;
  instanceId?: string | null;
  operationId?: string | null;
  targetId?: string | null;
  status?: string | null;
  changedFields?: string[];
  message?: string | null;
  data?: Record<string, unknown>;
};

type RuntimeEventInput = Omit<RuntimeEvent, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: string;
};

type RuntimeEventListener = (event: RuntimeEvent) => void;

const listeners = new Set<RuntimeEventListener>();
const recentEvents: RuntimeEvent[] = [];
let sequence = 0;
const RECENT_EVENT_LIMIT = 100;

export function publishEvent (input: RuntimeEventInput): RuntimeEvent
{
  const event: RuntimeEvent = {
    ...input,
    id: input.id || `${Date.now()}-${sequence += 1}`,
    createdAt: input.createdAt || new Date().toISOString(),
  };

  recentEvents.push(event);
  if (recentEvents.length > RECENT_EVENT_LIMIT) {
    recentEvents.splice(0, recentEvents.length - RECENT_EVENT_LIMIT);
  }

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[events] listener failed:', error instanceof Error ? error.message : String(error));
    }
  }

  return event;
}

export function subscribeEvents (listener: RuntimeEventListener): () => void
{
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentEvents (): RuntimeEvent[]
{
  return [...recentEvents];
}

export function formatSseEvent (event: RuntimeEvent): string
{
  return `id: ${event.id}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`;
}
