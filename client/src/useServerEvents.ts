import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getEventsUrl, getToken } from './api';

type RuntimeEvent = {
  type: string;
  instanceId?: string | null;
  operationId?: string | null;
  targetId?: string | null;
  status?: string | null;
  changedFields?: string[];
  data?: Record<string, unknown>;
};

function invalidateInstanceQueries (queryClient: QueryClient, instanceId?: string | null)
{
  queryClient.invalidateQueries({ queryKey: ['instances'] });

  if (!instanceId) return;

  queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
  queryClient.invalidateQueries({ queryKey: ['containers', instanceId] });
  queryClient.invalidateQueries({ queryKey: ['container-updates', instanceId] });
  queryClient.invalidateQueries({ queryKey: ['instance-version-check', instanceId] });
}

function handleRuntimeEvent (queryClient: QueryClient, event: RuntimeEvent)
{
  if (event.type === 'connected') {
    queryClient.invalidateQueries({ queryKey: ['instances'] });
    queryClient.invalidateQueries({ queryKey: ['archived-instances'] });
    queryClient.invalidateQueries({ queryKey: ['version'] });
    queryClient.invalidateQueries({ queryKey: ['rollback-status'] });
    queryClient.invalidateQueries({ queryKey: ['admin-preflight'] });
    return;
  }

  if (event.type.startsWith('instance.')) {
    invalidateInstanceQueries(queryClient, event.instanceId || event.targetId);
    if (event.type === 'instance.archived' || event.type === 'instance.restored' || event.type === 'instance.deleted') {
      queryClient.invalidateQueries({ queryKey: ['archived-instances'] });
    }
    return;
  }

  if (event.type.startsWith('operation.')) {
    queryClient.invalidateQueries({ queryKey: ['operations'] });
    invalidateInstanceQueries(queryClient, event.targetId);
    return;
  }

  if (event.type.startsWith('update.')) {
    queryClient.invalidateQueries({ queryKey: ['version'] });
    queryClient.invalidateQueries({ queryKey: ['rollback-status'] });
    queryClient.invalidateQueries({ queryKey: ['admin-preflight'] });
  }
}

export function useServerEvents (enabled: boolean)
{
  const queryClient = useQueryClient();

  useEffect(() =>
  {
    if (!enabled) return;

    let stopped = false;
    let retryHandle: number | undefined;
    const abortController = new AbortController();

    const processChunk = (rawEvent: string) =>
    {
      const data = rawEvent
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.replace(/^data:\s?/, ''))
        .join('\n');

      if (!data) return;

      try {
        handleRuntimeEvent(queryClient, JSON.parse(data) as RuntimeEvent);
      } catch (error) {
        console.warn('Failed to process server event:', error);
      }
    };

    const connect = async () =>
    {
      const token = getToken();
      if (!token) return;

      try {
        const response = await fetch(getEventsUrl(), {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            processChunk(rawEvent);
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === 'AbortError')) {
          queryClient.invalidateQueries({ queryKey: ['instances'] });
        }
      } finally {
        if (!stopped) {
          retryHandle = window.setTimeout(connect, 3000);
        }
      }
    };

    void connect();

    return () => {
      stopped = true;
      abortController.abort();
      if (retryHandle !== undefined) window.clearTimeout(retryHandle);
    };
  }, [enabled, queryClient]);
}
