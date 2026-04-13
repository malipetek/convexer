import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Instance } from '../types';
import { api } from '../api';
import LogViewer from './LogViewer';
import SettingsModal from './SettingsModal';
import MetricsBadge from './MetricsBadge';

export default function InstanceCard({ instance }: { instance: Instance }) {
  const [showLogs, setShowLogs] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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

  const forgetMutation = useMutation({
    mutationFn: () => api.forgetInstance(instance.id),
    onSuccess: invalidate,
  });

  const copyAdminKey = () => {
    if (!instance.admin_key) return;
    const textarea = document.createElement('textarea');
    textarea.value = instance.admin_key;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusClass = `status-${instance.status}`;

  return (
    <div className="instance-card">
      <div className="card-header">
        <h3>{instance.name}</h3>
        <div className="header-right">
          {instance.status === 'running' && <MetricsBadge instanceId={instance.id} />}
          <span className={`status-badge ${statusClass}`}>{instance.status}</span>
        </div>
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

        {instance.tunnel_backend && (
          <div className="tunnel-urls">
            <div className="port-item">
              <span className="port-label">Backend URL:</span>
              <a href={instance.tunnel_backend} target="_blank" rel="noopener">
                {instance.tunnel_backend}
              </a>
            </div>
            <div className="port-item">
              <span className="port-label">Dashboard URL:</span>
              <a href={instance.tunnel_dashboard} target="_blank" rel="noopener">
                {instance.tunnel_dashboard}
              </a>
            </div>
          </div>
        )}

        {instance.admin_key && (
          <div className="admin-key">
            <span className="port-label">Admin Key:</span>
            <input
              className="admin-key-input"
              type="text"
              readOnly
              value={instance.admin_key}
              onFocus={e => e.target.select()}
            />
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
          onClick={() => setShowSettings(true)}
        >
          Settings
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => setShowLogs(!showLogs)}
        >
          {showLogs ? 'Hide Logs' : 'Logs'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            if (confirm(`Forget "${instance.name}"? (DB only, containers stay)`)) {
              forgetMutation.mutate();
            }
          }}
          disabled={forgetMutation.isPending}
        >
          Forget
        </button>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm(`Delete instance "${instance.name}" and all its containers/data?`)) {
              deleteMutation.mutate();
            }
          }}
          disabled={deleteMutation.isPending}
        >
          Delete
        </button>
      </div>

      {showLogs && <LogViewer instanceId={instance.id} />}
      {showSettings && <SettingsModal instance={instance} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
