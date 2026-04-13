import { Instance, InstanceStats } from './types';

const BASE = '/api';

export function getToken(): string | null {
  return localStorage.getItem('convexer_token');
}

export function setToken(token: string) {
  localStorage.setItem('convexer_token', token);
}

export function clearToken() {
  localStorage.removeItem('convexer_token');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function login(password: string): Promise<string> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Login failed');
  }
  const { token } = await res.json();
  setToken(token);
  return token;
}

export const api = {
  getInstances: () => request<Instance[]>('/instances'),
  getInstance: (id: string) => request<Instance>(`/instances/${id}`),
  createInstance: (name?: string, extra_env?: Record<string, string>) =>
    request<Instance>('/instances', {
      method: 'POST',
      body: JSON.stringify({ name, extra_env }),
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
  updateSettings: (id: string, extra_env: Record<string, string>) =>
    request<Instance>(`/instances/${id}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ extra_env }),
    }),
  getStats: (id: string) =>
    request<InstanceStats>(`/instances/${id}/stats`),
};
