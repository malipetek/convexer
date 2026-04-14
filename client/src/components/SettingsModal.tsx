import { useState } from 'react';
import { Instance } from '../types';
import { api } from '../api';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Switch } from './ui/switch';

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

  const handleCheckbox = (key: string, checked: boolean, trueValue: string = 'true') =>
  {
    handleChange(key, checked ? trueValue : '');
  };

  const handleSwitchChange = (key: string, checked: boolean, trueValue: string = 'true') =>
  {
    handleChange(key, checked ? trueValue : '');
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings: {instance.name}</DialogTitle>
        </DialogHeader>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="retention">Retention</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="observability">Observability</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            <TabsTrigger value="database">Database</TabsTrigger>
            <TabsTrigger value="network">Network</TabsTrigger>
          </TabsList>

          <TabsContent value="retention" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="retention-delay">DOCUMENT_RETENTION_DELAY (seconds)</Label>
              <Input
                id="retention-delay"
                type="number"
                value={extraEnv.DOCUMENT_RETENTION_DELAY || '172800'}
                onChange={e => handleChange('DOCUMENT_RETENTION_DELAY', e.target.value)}
                placeholder="172800 (2 days)"
              />
              <p className="text-sm text-muted-foreground">
                How long soft-deleted documents are kept before permanent removal
              </p>
            </div>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mutations">APPLICATION_MAX_CONCURRENT_MUTATIONS</Label>
              <Input
                id="mutations"
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_MUTATIONS || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_MUTATIONS', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="queries">APPLICATION_MAX_CONCURRENT_QUERIES</Label>
              <Input
                id="queries"
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_QUERIES || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_QUERIES', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v8-actions">APPLICATION_MAX_CONCURRENT_V8_ACTIONS</Label>
              <Input
                id="v8-actions"
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_V8_ACTIONS || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_V8_ACTIONS', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="node-actions">APPLICATION_MAX_CONCURRENT_NODE_ACTIONS</Label>
              <Input
                id="node-actions"
                type="number"
                value={extraEnv.APPLICATION_MAX_CONCURRENT_NODE_ACTIONS || '16'}
                onChange={e => handleChange('APPLICATION_MAX_CONCURRENT_NODE_ACTIONS', e.target.value)}
                placeholder="16"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actions-timeout">ACTIONS_USER_TIMEOUT_SECS</Label>
              <Input
                id="actions-timeout"
                type="number"
                value={extraEnv.ACTIONS_USER_TIMEOUT_SECS || ''}
                onChange={e => handleChange('ACTIONS_USER_TIMEOUT_SECS', e.target.value)}
                placeholder="Default"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="http-timeout">HTTP_SERVER_TIMEOUT_SECONDS</Label>
              <Input
                id="http-timeout"
                type="number"
                value={extraEnv.HTTP_SERVER_TIMEOUT_SECONDS || ''}
                onChange={e => handleChange('HTTP_SERVER_TIMEOUT_SECONDS', e.target.value)}
                placeholder="Default"
              />
            </div>
          </TabsContent>

          <TabsContent value="observability" className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="metrics">Enable Prometheus /metrics endpoint</Label>
              <Switch
                id="metrics"
                checked={extraEnv.DISABLE_METRICS_ENDPOINT === 'false'}
                onCheckedChange={(checked: boolean) => handleCheckbox('DISABLE_METRICS_ENDPOINT', checked, 'false')}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="redact-logs">Redact PII from client-visible logs</Label>
              <Switch
                id="redact-logs"
                checked={extraEnv.REDACT_LOGS_TO_CLIENT === 'true'}
                onCheckedChange={(checked: boolean) => handleCheckbox('REDACT_LOGS_TO_CLIENT', checked)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="disable-telemetry">Disable anonymous usage telemetry</Label>
              <Switch
                id="disable-telemetry"
                checked={extraEnv.DISABLE_BEACON === 'true'}
                onCheckedChange={(checked: boolean) => handleCheckbox('DISABLE_BEACON', checked)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rust-log">RUST_LOG</Label>
              <Select value={extraEnv.RUST_LOG || 'info'} onValueChange={value => handleChange('RUST_LOG', value)}>
                <SelectTrigger id="rust-log">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="error">error</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="debug">debug</SelectItem>
                  <SelectItem value="trace">trace</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </TabsContent>

          <TabsContent value="storage" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="s3-endpoint">S3_ENDPOINT_URL</Label>
              <Input
                id="s3-endpoint"
                type="text"
                value={extraEnv.S3_ENDPOINT_URL || ''}
                onChange={e => handleChange('S3_ENDPOINT_URL', e.target.value)}
                placeholder="https://s3.amazonaws.com or MinIO endpoint"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-files">S3_STORAGE_FILES_BUCKET</Label>
              <Input
                id="s3-files"
                type="text"
                value={extraEnv.S3_STORAGE_FILES_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_FILES_BUCKET', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-modules">S3_STORAGE_MODULES_BUCKET</Label>
              <Input
                id="s3-modules"
                type="text"
                value={extraEnv.S3_STORAGE_MODULES_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_MODULES_BUCKET', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-search">S3_STORAGE_SEARCH_BUCKET</Label>
              <Input
                id="s3-search"
                type="text"
                value={extraEnv.S3_STORAGE_SEARCH_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_SEARCH_BUCKET', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-exports">S3_STORAGE_EXPORTS_BUCKET</Label>
              <Input
                id="s3-exports"
                type="text"
                value={extraEnv.S3_STORAGE_EXPORTS_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_EXPORTS_BUCKET', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-snapshots">S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET</Label>
              <Input
                id="s3-snapshots"
                type="text"
                value={extraEnv.S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET || ''}
                onChange={e => handleChange('S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aws-key">AWS_ACCESS_KEY_ID</Label>
              <Input
                id="aws-key"
                type="text"
                value={extraEnv.AWS_ACCESS_KEY_ID || ''}
                onChange={e => handleChange('AWS_ACCESS_KEY_ID', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aws-secret">AWS_SECRET_ACCESS_KEY</Label>
              <Input
                id="aws-secret"
                type="password"
                value={extraEnv.AWS_SECRET_ACCESS_KEY || ''}
                onChange={e => handleChange('AWS_SECRET_ACCESS_KEY', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aws-region">AWS_REGION</Label>
              <Input
                id="aws-region"
                type="text"
                value={extraEnv.AWS_REGION || ''}
                onChange={e => handleChange('AWS_REGION', e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="force-path">Force path-style (for MinIO)</Label>
              <Switch
                id="force-path"
                checked={extraEnv.AWS_S3_FORCE_PATH_STYLE === 'true'}
                onCheckedChange={(checked: boolean) => handleCheckbox('AWS_S3_FORCE_PATH_STYLE', checked)}
              />
            </div>
          </TabsContent>

          <TabsContent value="database" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="database-url">DATABASE_URL</Label>
              <Input
                id="database-url"
                type="text"
                value={extraEnv.DATABASE_URL || ''}
                onChange={e => handleChange('DATABASE_URL', e.target.value)}
                placeholder="Generic SQL connection URL"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="postgres-url">POSTGRES_URL</Label>
              <Input
                id="postgres-url"
                type="text"
                value={extraEnv.POSTGRES_URL || ''}
                onChange={e => handleChange('POSTGRES_URL', e.target.value)}
                placeholder="postgres://user:pass@host:5432/db"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mysql-url">MYSQL_URL</Label>
              <Input
                id="mysql-url"
                type="text"
                value={extraEnv.MYSQL_URL || ''}
                onChange={e => handleChange('MYSQL_URL', e.target.value)}
                placeholder="mysql://user:pass@host:3306/db"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Leave blank to use default SQLite (recommended for development)
            </p>
          </TabsContent>

          <TabsContent value="network" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cloud-origin">CONVEX_CLOUD_ORIGIN</Label>
              <Input
                id="cloud-origin"
                type="text"
                value={extraEnv.CONVEX_CLOUD_ORIGIN || ''}
                onChange={e => handleChange('CONVEX_CLOUD_ORIGIN', e.target.value)}
                placeholder="Auto-set by Traefik when DOMAIN is configured"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-origin">CONVEX_SITE_ORIGIN</Label>
              <Input
                id="site-origin"
                type="text"
                value={extraEnv.CONVEX_SITE_ORIGIN || ''}
                onChange={e => handleChange('CONVEX_SITE_ORIGIN', e.target.value)}
                placeholder="Auto-set by Traefik when DOMAIN is configured"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="no-ssl">Do not require SSL (not recommended for production)</Label>
              <Switch
                id="no-ssl"
                checked={extraEnv.DO_NOT_REQUIRE_SSL === 'true'}
                onCheckedChange={(checked: boolean) => handleCheckbox('DO_NOT_REQUIRE_SSL', checked)}
              />
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save & Restart Backend'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
