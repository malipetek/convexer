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
  getLogs: (id: string, container: 'backend' | 'dashboard' | 'postgres' = 'backend', tail = 200) =>
    request<{ logs: string }>(`/instances/${id}/logs?container=${container}&tail=${tail}`),
  downloadLogs: (id: string, container: 'backend' | 'dashboard' | 'postgres' = 'backend') =>
    fetch(`${BASE}/instances/${id}/logs/download?container=${container}`, {
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }),
  restartContainer: (id: string, container: 'backend' | 'dashboard' | 'postgres' = 'backend') =>
    request<{ success: boolean }>(`/instances/${id}/restart?container=${container}`, {
      method: 'POST',
    }),
  getContainers: (id: string) =>
    request<{
      containers: Array<{
        role: string; name: string; image: string | null;
        status: string; running: boolean; startedAt: string | null;
        restartCount: number; ports: Array<{ containerPort: string; hostPort: string }>;
      }>
    }>(`/instances/${id}/containers`),
  updateSettings: (id: string, extra_env: Record<string, string>) =>
    request<Instance>(`/instances/${id}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ extra_env }),
    }),
  getStats: (id: string) =>
    request<InstanceStats>(`/instances/${id}/stats`),
  getVersion: () => request<{ current_version: string; latest_version?: string; has_update: boolean }>('/version'),
  checkUpdate: () => request<{ current_version: string; latest_version: string; has_update: boolean }>('/version/check'),
  updateApp: () => request<{ success: boolean }>('/version/update', { method: 'POST' }),
  getSettings: () => request<{ hostname: string }>('/settings'),
  saveSettings: (hostname: string) => request<{ success: boolean; hostname: string }>('/settings', {
    method: 'POST',
    body: JSON.stringify({ hostname }),
  }),
  getServerStats: () => request<{
    server_version: string;
    api_version: string;
    docker_server_address: string;
    storage_driver: string;
    os: string;
    kernel_version: string;
    architecture: string;
    cpus: number;
    load_average_1m: number;
    load_average_5m: number;
    load_average_15m: number;
    memory_total: number;
    memory_used: number;
    memory_free: number;
    memory_total_gb: string;
    memory_used_gb: string;
    memory_free_gb: string;
    memory_usage_percent: string;
    containers_running: number;
    containers_paused: number;
    containers_stopped: number;
    containers_total: number;
    images: number;
    volumes: number;
    networks: number;
    uptime_seconds: number;
    uptime_formatted: string;
    hostname: string;
    platform: string;
    release: string;
    disk_usage: Array<{
      filesystem: string;
      size: string;
      used: string;
      available: string;
      usage_percent: string;
      mountpoint: string;
    }>;
    docker_disk_usage: any;
    network_interfaces: Array<{
      name: string;
      addresses: Array<{
        family: string;
        address: string;
        netmask: string;
        internal: boolean;
      }>;
    }>;
  }>('/server/stats'),
  postgres: {
    listTables: (id: string) => request<{ tables: string[] }>(`/instances/${id}/postgres/tables`),
    getTableSchema: (id: string, name: string) => request<{ schema: any[] }>(`/instances/${id}/postgres/tables/${name}`),
    executeQuery: (id: string, query: string) => request<{ results: any[] }>(`/instances/${id}/postgres/query`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
    createBackup: (id: string) => fetch(`${BASE}/instances/${id}/postgres/backup`, {
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }),
    restoreBackup: (id: string, sql: string) => request<{ success: boolean }>(`/instances/${id}/postgres/restore`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    }),
    exportTable: (id: string, table: string) => fetch(`${BASE}/instances/${id}/postgres/export?table=${table}`, {
      headers: { 'Authorization': `Bearer ${getToken()}` },
    }),
    importTable: (id: string, table: string, csv: string) => request<{ success: boolean; inserted: number }>(`/instances/${id}/postgres/import`, {
      method: 'POST',
      body: JSON.stringify({ table, csv }),
    }),
    listExtensions: (id: string) => request<{ extensions: any[] }>(`/instances/${id}/postgres/extensions`),
    loadExtension: (id: string, name: string) => request<{ success: boolean }>(`/instances/${id}/postgres/extensions/${name}`, {
      method: 'POST',
    }),
  },
  backup: {
    getConfig: (id: string) => request<{ config: any }>(`/instances/${id}/backup/config`),
    createConfig: (id: string, config: any) => request<{ config: any }>(`/instances/${id}/backup/config`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),
    deleteConfig: (id: string) => request<{ success: boolean }>(`/instances/${id}/backup/config`, {
      method: 'DELETE',
    }),
    getHistory: (id: string, limit = 50) => request<{ history: any[] }>(`/instances/${id}/backup/history?limit=${limit}`),
    triggerBackup: (id: string, type = 'database,volume') => request<{ success: boolean }>(`/instances/${id}/backup/trigger`, {
      method: 'POST',
      body: JSON.stringify({ type }),
    }),
    restoreFromHistory: (id: string, backupId: string) => request<{ success: boolean; snapshotIds?: string[] }>(`/instances/${id}/backup/restore`, {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }),
    getBackupDetails: (backupId: string) => request<{ backup: any; syncStatus: any[]; preRestoreBackup?: any }>(`/backups/${backupId}/details`),
    deleteBackupLocalFile: (backupId: string) => request<{ success: boolean }>(`/backups/${backupId}/local`, {
      method: 'DELETE',
    }),
    getSettings: () => request<{ settings: any }>('/backup/settings'),
    updateSettings: (settings: any) => request<{ settings: any }>('/backup/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
    getSshKey: () => request<{ publicKey: string }>('/backup/ssh-key'),
    testDestination: (payload: any) => request<{ success: boolean; output: string }>('/backup/test-destination', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  },
  duplicateInstance: (id: string, newName: string) => request<{ instance: any }>(`/instances/${id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ newName }),
  }),
};
