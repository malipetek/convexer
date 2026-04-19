export interface Instance {
  id: string;
  name: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  backend_container_id: string | null;
  dashboard_container_id: string | null;
  postgres_container_id: string | null;
  backend_port: number;
  site_proxy_port: number;
  dashboard_port: number;
  postgres_port: number;
  volume_name: string;
  postgres_volume_name: string;
  postgres_password: string;
  admin_key: string | null;
  instance_name: string;
  instance_secret: string;
  error_message: string | null;
  extra_env: string | null;
  pinned_version: string | null;
  detected_version: string | null;
  health_check_timeout: number;
  postgres_health_check_timeout: number;
  betterauth_enabled: number;
  betterauth_container_id: string | null;
  betterauth_port: number;
  tunnel_backend?: string;
  tunnel_site?: string;
  tunnel_dashboard?: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArchivedInstance extends Instance
{
  backup_history: Array<{
    id: string;
    backup_type: string;
    status: string;
    size_bytes: number | null;
    file_path: string | null;
    label: string | null;
    started_at: string;
    completed_at: string | null;
  }>;
}

export interface InstanceStats
{
  cpu_percent: number;
  memory_mb: number;
  memory_limit_mb: number;
  volume_size_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  disk_read_bytes: number;
  disk_write_bytes: number;
  system_disk_total: number;
  system_disk_used: number;
  system_disk_available: number;
}
