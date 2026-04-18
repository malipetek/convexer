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
  created_at: string;
  updated_at: string;
}

export interface CreateInstanceRequest {
  name?: string;
  extra_env?: Record<string, string>;
}
