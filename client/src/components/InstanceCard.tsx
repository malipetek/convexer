import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Instance } from '../types';
import { api } from '../api';
import LogViewer from './LogViewer';

export default function InstanceCard({ instance }: { instance: Instance }) {
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['instances'] });

  const startMutation = useMutation({
    mutationFn: () => api.startInstance(instance.id),
    onSuccess: invalidate,
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopInstance(instance.id),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteInstance(instance.id),
    onSuccess: invalidate,
  });

  const copyAdminKey = () => {
    if (instance.admin_key) {
      navigator.clipboard.writeText(instance.admin_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const statusClass = `status-${instance.status}`;

  return (
    <div className="instance-card">
      <div className="card-header">
        <h3>{instance.name}</h3>
        <span className={`status-badge ${statusClass}`}>{instance.status}</span>
      </div>

      <div className="card-body">
        <div className="ports">
          <div className="port-item">
            <span className="port-label">Backend:</span>
            <a href={`http://localhost:${instance.backend_port}`} target="_blank" rel="noopener">
              :{instance.backend_port}
            </a>
          </div>
          <div className="port-item">
            <span className="port-label">Site Proxy:</span>
            <a href={`http://localhost:${instance.site_proxy_port}`} target="_blank" rel="noopener">
              :{instance.site_proxy_port}
            </a>
          </div>
          <div className="port-item">
            <span className="port-label">Dashboard:</span>
            <a href={`http://localhost:${instance.dashboard_port}`} target="_blank" rel="noopener">
              :{instance.dashboard_port}
            </a>
          </div>
        </div>

        {instance.admin_key && (
          <div className="admin-key">
            <span className="port-label">Admin Key:</span>
            <code>{instance.admin_key.substring(0, 20)}...</code>
            <button className="btn btn-small" onClick={copyAdminKey}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        )}

        {instance.error_message && (
          <div className="error-message">{instance.error_message}</div>
        )}
      </div>

      <div className="card-actions">
        {instance.status === 'stopped' && (
          <button
            className="btn btn-success"
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
          >
            Start
          </button>
        )}
        {instance.status === 'running' && (
          <button
            className="btn btn-warn"
            onClick={() => stopMutation.mutate()}
            disabled={stopMutation.isPending}
          >
            Stop
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => setShowLogs(!showLogs)}
        >
          {showLogs ? 'Hide Logs' : 'Logs'}
        </button>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm(`Delete instance "${instance.name}"?`)) {
              deleteMutation.mutate();
            }
          }}
          disabled={deleteMutation.isPending}
        >
          Delete
        </button>
      </div>

      {showLogs && <LogViewer instanceId={instance.id} />}
    </div>
  );
}
