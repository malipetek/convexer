import { useState } from 'react';
import { Instance } from '../types';
import { api } from '../api';

interface SettingsModalProps {
  instance: Instance;
  onClose: () => void;
}

export default function SettingsModal({ instance, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState('retention');
  const [saving, setSaving] = useState(false);
  const [extraEnv, setExtraEnv] = useState<Record<string, string>>(() => {
    try {
      return instance.extra_env ? JSON.parse(instance.extra_env) : {};
    } catch {
      return {};
    }
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateSettings(instance.id, extraEnv);
      onClose();
    } catch (err: any) {
      alert(err.message || 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: string, value: string) => {
    setExtraEnv(prev => {
      const updated = { ...prev };
      if (value === '') {
        delete updated[key];
      } else {
        updated[key] = value;
      }
      return updated;
    });
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'retention':
        return (
          <div className="settings-tab">
            <h3>Retention</h3>
            <div className="form-group">
              <label>DOCUMENT_RETENTION_DELAY (seconds)</label>
              <input
                type="number"
                value={extraEnv.DOCUMENT_RETENTION_DELAY || '172800'}
                onChange={e => handleChange('DOCUMENT_RETENTION_DELAY', e.target.value)}
                placeholder="172800 (2 days)"
              />
              <small>How long soft-deleted documents are kept before permanent removal</small>
            </div>
          </div>
        );
      case 'performance':
        return (
          <div className="settings-tab">
            <h3>Performance & Concurrency</h3>
            <div className="form-group">
              <label>APPLICATION_MAX_CONCURRENT_MUTATIONS</label>
              <input
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_MUTATIONS || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_MUTATIONS', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="form-group">
              <label>APPLICATION_MAX_CONCURRENT_QUERIES</label>
              <input
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_QUERIES || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_QUERIES', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="form-group">
              <label>APPLICATION_MAX_CONCURRENT_V8_ACTIONS</label>
              <input
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_V8_ACTIONS || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_V8_ACTIONS', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="form-group">
              <label>APPLICATION_MAX_CONCURRENT_NODE_ACTIONS</label>
              <input
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_NODE_ACTIONS || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_NODE_ACTIONS', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="form-group">
              <label>ACTIONS_USER_TIMEOUT_SECS</label>
              <input
                type="number"
                value={extraEnv.ACTIONS_USER_TIMEOUT_SECS || ''}
                onChange={e => handleChange('ACTIONS_USER_TIMEOUT_SECS', e.target.value)}
                placeholder="Default"
              />
            </div>
            <div className="form-group">
              <label>HTTP_SERVER_TIMEOUT_SECONDS</label>
              <input
                type="number"
                value={extraEnv.HTTP_SERVER_TIMEOUT_SECONDS || ''}
                onChange={e => handleChange('HTTP_SERVER_TIMEOUT_SECONDS', e.target.value)}
                placeholder="Default"
              />
            </div>
          </div>
        );
      case 'observability':
        return (
          <div className="settings-tab">
            <h3>Observability</h3>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={extraEnv.DISABLE_METRICS_ENDPOINT === 'false'}
                  onChange={e => handleChange('DISABLE_METRICS_ENDPOINT', e.target.checked ? 'false' : 'true')}
                />
                Enable Prometheus /metrics endpoint
              </label>
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={extraEnv.REDACT_LOGS_TO_CLIENT === 'true'}
                  onChange={e => handleChange('REDACT_LOGS_TO_CLIENT', e.target.checked ? 'true' : '')}
                />
                Redact PII from client-visible logs
              </label>
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={extraEnv.DISABLE_BEACON === 'true'}
                  onChange={e => handleChange('DISABLE_BEACON', e.target.checked ? 'true' : '')}
                />
                Disable anonymous usage telemetry
              </label>
            </div>
            <div className="form-group">
              <label>RUST_LOG</label>
              <select
                value={extraEnv.RUST_LOG || 'info'}
                onChange={e => handleChange('RUST_LOG', e.target.value)}
              >
                <option value="error">error</option>
                <option value="warn">warn</option>
                <option value="info">info</option>
                <option value="debug">debug</option>
                <option value="trace">trace</option>
              </select>
            </div>
          </div>
        );
      case 'storage':
        return (
          <div className="settings-tab">
            <h3>Storage (S3 / MinIO)</h3>
            <div className="form-group">
              <label>S3_ENDPOINT_URL</label>
              <input
                type="text"
                value={extraEnv.S3_ENDPOINT_URL || ''}
                onChange={e => handleChange('S3_ENDPOINT_URL', e.target.value)}
                placeholder="https://s3.amazonaws.com or MinIO endpoint"
              />
            </div>
            <div className="form-group">
              <label>S3_STORAGE_FILES_BUCKET</label>
              <input
                type="text"
                value={extraEnv.S3_STORAGE_FILES_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_FILES_BUCKET', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>S3_STORAGE_MODULES_BUCKET</label>
              <input
                type="text"
                value={extraEnv.S3_STORAGE_MODULES_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_MODULES_BUCKET', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>S3_STORAGE_SEARCH_BUCKET</label>
              <input
                type="text"
                value={extraEnv.S3_STORAGE_SEARCH_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_SEARCH_BUCKET', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>S3_STORAGE_EXPORTS_BUCKET</label>
              <input
                type="text"
                value={extraEnv.S3_STORAGE_EXPORTS_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_EXPORTS_BUCKET', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET</label>
              <input
                type="text"
                value={extraEnv.S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>AWS_ACCESS_KEY_ID</label>
              <input
                type="text"
                value={extraEnv.AWS_ACCESS_KEY_ID || ''}
                onChange={e => handleChange('AWS_ACCESS_KEY_ID', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>AWS_SECRET_ACCESS_KEY</label>
              <input
                type="password"
                value={extraEnv.AWS_SECRET_ACCESS_KEY || ''}
                onChange={e => handleChange('AWS_SECRET_ACCESS_KEY', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>AWS_REGION</label>
              <input
                type="text"
                value={extraEnv.AWS_REGION || ''}
                onChange={e => handleChange('AWS_REGION', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={extraEnv.AWS_S3_FORCE_PATH_STYLE === 'true'}
                  onChange={e => handleChange('AWS_S3_FORCE_PATH_STYLE', e.target.checked ? 'true' : '')}
                />
                Force path-style (for MinIO)
              </label>
            </div>
          </div>
        );
      case 'database':
        return (
          <div className="settings-tab">
            <h3>Database (Postgres / MySQL)</h3>
            <div className="form-group">
              <label>DATABASE_URL</label>
              <input
                type="text"
                value={extraEnv.DATABASE_URL || ''}
                onChange={e => handleChange('DATABASE_URL', e.target.value)}
                placeholder="Generic SQL connection URL"
              />
            </div>
            <div className="form-group">
              <label>POSTGRES_URL</label>
              <input
                type="text"
                value={extraEnv.POSTGRES_URL || ''}
                onChange={e => handleChange('POSTGRES_URL', e.target.value)}
                placeholder="postgres://user:pass@host:5432/db"
              />
            </div>
            <div className="form-group">
              <label>MYSQL_URL</label>
              <input
                type="text"
                value={extraEnv.MYSQL_URL || ''}
                onChange={e => handleChange('MYSQL_URL', e.target.value)}
                placeholder="mysql://user:pass@host:3306/db"
              />
            </div>
            <small>Leave blank to use default SQLite (recommended for development)</small>
          </div>
        );
      case 'network':
        return (
          <div className="settings-tab">
            <h3>Network</h3>
            <div className="form-group">
              <label>CONVEX_CLOUD_ORIGIN</label>
              <input
                type="text"
                value={extraEnv.CONVEX_CLOUD_ORIGIN || ''}
                onChange={e => handleChange('CONVEX_CLOUD_ORIGIN', e.target.value)}
                placeholder="Auto-set by Traefik when DOMAIN is configured"
              />
            </div>
            <div className="form-group">
              <label>CONVEX_SITE_ORIGIN</label>
              <input
                type="text"
                value={extraEnv.CONVEX_SITE_ORIGIN || ''}
                onChange={e => handleChange('CONVEX_SITE_ORIGIN', e.target.value)}
                placeholder="Auto-set by Traefik when DOMAIN is configured"
              />
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={extraEnv.DO_NOT_REQUIRE_SSL === 'true'}
                  onChange={e => handleChange('DO_NOT_REQUIRE_SSL', e.target.checked ? 'true' : '')}
                />
                Do not require SSL (not recommended for production)
              </label>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal settings-modal">
        <div className="modal-header">
          <h2>Settings: {instance.name}</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="settings-tabs">
            <button className={activeTab === 'retention' ? 'active' : ''} onClick={() => setActiveTab('retention')}>Retention</button>
            <button className={activeTab === 'performance' ? 'active' : ''} onClick={() => setActiveTab('performance')}>Performance</button>
            <button className={activeTab === 'observability' ? 'active' : ''} onClick={() => setActiveTab('observability')}>Observability</button>
            <button className={activeTab === 'storage' ? 'active' : ''} onClick={() => setActiveTab('storage')}>Storage</button>
            <button className={activeTab === 'database' ? 'active' : ''} onClick={() => setActiveTab('database')}>Database</button>
            <button className={activeTab === 'network' ? 'active' : ''} onClick={() => setActiveTab('network')}>Network</button>
          </div>
          <div className="settings-content">
            {renderTab()}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save & Restart Backend'}
          </button>
        </div>
      </div>
    </div>
  );
}
