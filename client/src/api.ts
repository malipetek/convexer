import { Instance } from './types';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getInstances: () => request<Instance[]>('/instances'),
  getInstance: (id: string) => request<Instance>(`/instances/${id}`),
  createInstance: (name?: string) =>
    request<Instance>('/instances', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  startInstance: (id: string) =>
    request<Instance>(`/instances/${id}/start`, { method: 'POST' }),
  stopInstance: (id: string) =>
    request<Instance>(`/instances/${id}/stop`, { method: 'POST' }),
  deleteInstance: (id: string) =>
    request<void>(`/instances/${id}`, { method: 'DELETE' }),
  forgetInstance: (id: string) =>
    request<void>(`/instances/${id}/forget`, { method: 'POST' }),
  getLogs: (id: string, container: 'backend' | 'dashboard' = 'backend', tail = 200) =>
    request<{ logs: string }>(`/instances/${id}/logs?container=${container}&tail=${tail}`),
};
