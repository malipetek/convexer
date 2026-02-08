export interface Instance {
  id: string;
  name: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  backend_container_id: string | null;
  dashboard_container_id: string | null;
  backend_port: number;
  site_proxy_port: number;
  dashboard_port: number;
  volume_name: string;
  admin_key: string | null;
  instance_name: string;
  instance_secret: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateInstanceRequest {
  name?: string;
}
