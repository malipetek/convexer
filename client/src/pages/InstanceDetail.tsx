import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { ArrowLeft, Copy, Settings, Activity, Play, Square, Trash2, RefreshCw, Download, Upload, Database, FileDown, FileUp, Archive } from 'lucide-react';
import MetricsBadge from '../components/MetricsBadge';
import MetricsGauge from '../components/MetricsGauge';
import InstanceMetrics, { type MetricSample } from '../components/InstanceMetrics';

const SCHEDULE_PRESETS = [
  { label: 'Daily at 2 AM', cron: '0 2 * * *' },
  { label: 'Every 2 days at 2 AM', cron: '0 2 */2 * *' },
  { label: 'Every 3 days at 2 AM', cron: '0 2 */3 * *' },
  { label: 'Weekly on Sunday at 2 AM', cron: '0 2 * * 0' },
  { label: 'Every 2 weeks on Sunday at 2 AM', cron: '0 2 */14 * *' },
  { label: 'Monthly on the 1st at 2 AM', cron: '0 2 1 * *' },
];

function formatBytes (bytes: number): string
{
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default function InstanceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [metricsHistory, setMetricsHistory] = useState<MetricSample[]>([]);
  const [hostname, setHostname] = useState('');
  const [duplicating, setDuplicating] = useState(false);
  const [newInstanceName, setNewInstanceName] = useState('');
  const [backupConfig, setBackupConfig] = useState<any>(null);
  const [savingBackup, setSavingBackup] = useState(false);

  const { data: instance, isLoading } = useQuery({
    queryKey: ['instance', id],
    queryFn: () => api.getInstance(id!),
  });

  const { data: stats } = useQuery({
    queryKey: ['stats', id],
    queryFn: () => api.getStats(id!),
    refetchInterval: 5000,
    enabled: instance?.status === 'running',
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const { data: backupConfigData } = useQuery({
    queryKey: ['backupConfig', id],
    queryFn: () => api.backup.getConfig(id!),
    enabled: !!id,
  });

  useEffect(() =>
  {
    if (backupConfigData?.config) {
      setBackupConfig(backupConfigData.config);
    }
  }, [backupConfigData]);

  useEffect(() =>
  {
    if (settings) {
      setHostname(settings.hostname || '');
    }
  }, [settings]);

  useEffect(() => {
    if (!stats) return;
    setMetricsHistory(prev =>
    {
      const sample: MetricSample = {
        t: Date.now(),
        cpu: stats.cpu_percent,
        memMb: stats.memory_mb,
        memLimitMb: stats.memory_limit_mb,
        netRx: stats.network_rx_bytes,
        netTx: stats.network_tx_bytes,
        diskR: stats.disk_read_bytes,
        diskW: stats.disk_write_bytes,
      };
      const next = [...prev, sample];
      // Keep ~15 minutes at 5s sampling (180 samples) plus a little headroom.
      if (next.length > 240) return next.slice(-240);
      return next;
    });
  }, [stats]);

  const startMutation = useMutation({
    mutationFn: () => api.startInstance(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instance', id] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopInstance(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instance', id] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteInstance(id!),
    onSuccess: () => navigate('/'),
  });

  const duplicateMutation = useMutation({
    mutationFn: (name: string) => api.duplicateInstance(id!, name),
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setDuplicating(false);
      setNewInstanceName('');
      alert('Instance duplicated successfully');
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Failed to duplicate instance');
    },
  });

  const saveBackupConfigMutation = useMutation({
    mutationFn: (config: any) => api.backup.createConfig(id!, config),
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['backupConfig', id] });
      setSavingBackup(false);
      alert('Backup configuration saved');
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Failed to save backup configuration');
      setSavingBackup(false);
    },
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(instance?.admin_key || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) {
    return <div className="p-8">Loading...</div>;
  }

  if (!instance) {
    return <div className="p-8">Instance not found</div>;
  }

  const statusColors = {
    creating: 'bg-blue-500/10 text-blue-500',
    running: 'bg-green-500/10 text-green-500',
    stopped: 'bg-gray-500/10 text-gray-500',
    error: 'bg-red-500/10 text-red-500',
  };

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-2xl font-bold flex-1">{instance.name}</h1>
          <Badge className={statusColors[instance.status as keyof typeof statusColors]}>
            {instance.status}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
            {
              setDuplicating(true);
              setNewInstanceName(`${instance.name}-copy`);
            }}
          >
            <Archive className="h-4 w-4 mr-2" />
            Duplicate
          </Button>
        </div>

        {duplicating && (
          <Card className="mb-6 border-primary">
            <CardHeader>
              <CardTitle>Duplicate Instance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>New Instance Name</Label>
                <Input
                  placeholder="Enter new instance name"
                  value={newInstanceName}
                  onChange={(e) => setNewInstanceName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() =>
                  {
                    if (!newInstanceName.trim()) {
                      alert('Please enter a name for the new instance');
                      return;
                    }
                    duplicateMutation.mutate(newInstanceName);
                  }}
                  disabled={duplicateMutation.isPending}
                >
                  {duplicateMutation.isPending ? 'Duplicating...' : 'Confirm Duplicate'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                  {
                    setDuplicating(false);
                    setNewInstanceName('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="overview">
          <TabsList className="mb-6">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="database">Database</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Actions</CardTitle>
                </CardHeader>
                <CardContent className="flex gap-2">
                  {instance.status === 'stopped' && (
                    <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                      <Play className="h-4 w-4 mr-2" />
                      Start
                    </Button>
                  )}
                  {instance.status === 'running' && (
                    <Button variant="secondary" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
                      <Square className="h-4 w-4 mr-2" />
                      Stop
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    onClick={() => {
                      if (confirm(`Delete instance "${instance.name}" and all its containers/data?`)) {
                        deleteMutation.mutate();
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                </CardContent>
              </Card>

              {instance.tunnel_backend && (
                <Card>
                  <CardHeader>
                    <CardTitle>Tunnel URLs</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground w-32">Backend:</span>
                      <a
                        href={instance.tunnel_backend}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-500 hover:underline"
                      >
                        {instance.tunnel_backend}
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground w-32">Site:</span>
                      <a
                        href={instance.tunnel_site}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-500 hover:underline"
                      >
                        {instance.tunnel_site}
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground w-32">Dashboard:</span>
                      <a
                        href={instance.tunnel_dashboard}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-500 hover:underline"
                      >
                        {instance.tunnel_dashboard}
                      </a>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>Subdomain URLs</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground w-32">Backend:</span>
                    <a
                      href={`https://${(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.BACKEND_DOMAIN || `${instance.name}.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}.${hostname || 'convexer.example.com'}`;
                        }
                      })()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-500 hover:underline font-mono"
                    >
                      {(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.BACKEND_DOMAIN || `${instance.name}.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}.${hostname || 'convexer.example.com'}`;
                        }
                      })()}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground w-32">Site:</span>
                    <a
                      href={`https://${(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.SITE_DOMAIN || `${instance.name}-site.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-site.${hostname || 'convexer.example.com'}`;
                        }
                      })()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-500 hover:underline font-mono"
                    >
                      {(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.SITE_DOMAIN || `${instance.name}-site.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-site.${hostname || 'convexer.example.com'}`;
                        }
                      })()}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground w-32">Dashboard:</span>
                    <a
                      href={`https://${(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.DASHBOARD_DOMAIN || `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        }
                      })()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-500 hover:underline font-mono"
                    >
                      {(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.DASHBOARD_DOMAIN || `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        }
                      })()}
                    </a>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Admin Key</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono">
                      {instance.admin_key || 'Generating...'}
                    </code>
                    <Button size="sm" variant="outline" onClick={handleCopy}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {instance.status === 'running' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Live Metrics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-6 mb-6">
                      <div className="text-center">
                        <MetricsGauge
                          value={stats?.cpu_percent || 0}
                          max={100}
                          label="CPU"
                          color="#22c55e"
                        />
                        <div className="mt-2 text-sm font-semibold">
                          {stats?.cpu_percent.toFixed(1)}%
                        </div>
                      </div>
                      <div className="text-center">
                        <MetricsGauge
                          value={stats?.memory_mb || 0}
                          max={stats?.memory_limit_mb || 4096}
                          label="Memory"
                          color="#3b82f6"
                        />
                        <div className="mt-2 text-sm font-semibold">
                          {stats?.memory_mb.toFixed(0)} MB / {stats?.memory_limit_mb?.toFixed(0) || 4096} MB
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {((stats?.memory_mb || 0) / (stats?.memory_limit_mb || 4096) * 100).toFixed(1)}%
                        </div>
                      </div>
                      <div className="text-center">
                        <MetricsGauge
                          value={stats?.volume_size_bytes ? stats.volume_size_bytes / (1024 * 1024 * 1024) : 0}
                          max={50}
                          label="Volume"
                          color="#f59e0b"
                        />
                        <div className="mt-2 text-sm font-semibold">
                          {(stats?.volume_size_bytes ? stats.volume_size_bytes / (1024 * 1024 * 1024) : 0).toFixed(2)} GB
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 bg-muted rounded-lg">
                        <h3 className="text-sm font-semibold mb-2">Network I/O</h3>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">RX:</span>
                            <span className="font-mono">{formatBytes(stats?.network_rx_bytes || 0)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">TX:</span>
                            <span className="font-mono">{formatBytes(stats?.network_tx_bytes || 0)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="p-4 bg-muted rounded-lg">
                        <h3 className="text-sm font-semibold mb-2">Disk I/O</h3>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Read:</span>
                            <span className="font-mono">{formatBytes(stats?.disk_read_bytes || 0)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Write:</span>
                            <span className="font-mono">{formatBytes(stats?.disk_write_bytes || 0)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {stats && stats.system_disk_total > 0 && (
                      <div className="mt-4 p-4 bg-muted rounded-lg">
                        <h3 className="text-sm font-semibold mb-2">System Disk Usage</h3>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Total:</span>
                            <span className="font-mono">{formatBytes(stats.system_disk_total)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Used:</span>
                            <span className="font-mono">{formatBytes(stats.system_disk_used)} ({((stats.system_disk_used / stats.system_disk_total) * 100).toFixed(1)}%)</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Available:</span>
                            <span className="font-mono">{formatBytes(stats.system_disk_available)}</span>
                          </div>
                          <div className="w-full bg-secondary rounded-full h-2 mt-2">
                            <div
                              className="bg-blue-500 h-2 rounded-full"
                              style={{ width: `${(stats.system_disk_used / stats.system_disk_total) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="metrics">
            <InstanceMetrics samples={metricsHistory} isRunning={instance.status === 'running'} />
          </TabsContent>

          <TabsContent value="database">
            <DatabaseTab instance={instance} />
          </TabsContent>

          <TabsContent value="settings">
            <InstanceSettings
              instance={instance}
              backupConfig={backupConfig}
              setBackupConfig={setBackupConfig}
              savingBackup={savingBackup}
              setSavingBackup={setSavingBackup}
              saveBackupConfigMutation={saveBackupConfigMutation}
            />
          </TabsContent>

          <TabsContent value="logs">
            <InstanceLogs instanceId={instance.id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function InstanceSettings ({ instance, backupConfig, setBackupConfig, savingBackup, setSavingBackup, saveBackupConfigMutation }: { instance: any; backupConfig: any; setBackupConfig: any; savingBackup: boolean; setSavingBackup: any; saveBackupConfigMutation: any })
{
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
      alert('Settings saved');
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

  const handleSwitchChange = (key: string, checked: boolean, trueValue: string = 'true') => {
    handleChange(key, checked ? trueValue : '');
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Instance Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="retention-delay">DOCUMENT_RETENTION_DELAY (seconds)</Label>
            <Input
              id="retention-delay"
              type="number"
              value={extraEnv.DOCUMENT_RETENTION_DELAY || '172800'}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('DOCUMENT_RETENTION_DELAY', e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mutations">APPLICATION_MAX_CONCURRENT_MUTATIONS</Label>
            <Input
              id="mutations"
              type="number"
              value={extraEnv.APPLICATION_MAX_CONCURRENT_MUTATIONS || '16'}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('APPLICATION_MAX_CONCURRENT_MUTATIONS', e.target.value)}
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

          <div className="flex items-center justify-between">
            <Label htmlFor="metrics">Enable Prometheus /metrics endpoint</Label>
            <Switch
              id="metrics"
              checked={extraEnv.DISABLE_METRICS_ENDPOINT === 'false'}
              onCheckedChange={(checked: boolean) => handleSwitchChange('DISABLE_METRICS_ENDPOINT', checked, 'false')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="backend-domain">Backend Custom Domain (optional)</Label>
            <Input
              id="backend-domain"
              placeholder="myapp.example.com"
              value={extraEnv.BACKEND_DOMAIN || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('BACKEND_DOMAIN', e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Set a custom domain for the backend (leave empty for default subdomain)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="site-domain">Site Custom Domain (optional)</Label>
            <Input
              id="site-domain"
              placeholder="site.example.com"
              value={extraEnv.SITE_DOMAIN || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('SITE_DOMAIN', e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Set a custom domain for the site (leave empty for default subdomain)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dashboard-domain">Dashboard Custom Domain (optional)</Label>
            <Input
              id="dashboard-domain"
              placeholder="dash.example.com"
              value={extraEnv.DASHBOARD_DOMAIN || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('DASHBOARD_DOMAIN', e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Set a custom domain for the dashboard (leave empty for default subdomain)
            </p>
          </div>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save & Restart Backend'}
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            Backup Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Enable Backups</div>
              <div className="text-xs text-muted-foreground">Automatically backup this instance on schedule</div>
            </div>
            <Switch
              checked={backupConfig?.enabled === 1}
              onCheckedChange={(checked: boolean) => setBackupConfig({ ...backupConfig, enabled: checked ? 1 : 0 })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="backup-schedule">Backup Frequency</Label>
            <Select
              value={SCHEDULE_PRESETS.find(p => p.cron === (backupConfig?.schedule || '0 2 * * 0'))?.cron || 'custom'}
              onValueChange={(value) =>
              {
                if (value !== 'custom') {
                  setBackupConfig({ ...backupConfig, schedule: value });
                }
              }}
              disabled={!backupConfig?.enabled}
            >
              <SelectTrigger id="backup-schedule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map(preset => (
                  <SelectItem key={preset.cron} value={preset.cron}>{preset.label}</SelectItem>
                ))}
                <SelectItem value="custom">Custom (cron expression)</SelectItem>
              </SelectContent>
            </Select>
            {!SCHEDULE_PRESETS.find(p => p.cron === (backupConfig?.schedule || '0 2 * * 0')) && (
              <Input
                placeholder="0 2 * * 0"
                value={backupConfig?.schedule || ''}
                onChange={(e) => setBackupConfig({ ...backupConfig, schedule: e.target.value })}
                disabled={!backupConfig?.enabled}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="backup-retention">Retention Days</Label>
            <Input
              id="backup-retention"
              type="number"
              placeholder="30"
              value={backupConfig?.retention_days || 30}
              onChange={(e) => setBackupConfig({ ...backupConfig, retention_days: parseInt(e.target.value) || 30 })}
              disabled={!backupConfig?.enabled}
            />
            <p className="text-xs text-muted-foreground">
              Number of days to keep backups before deletion
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="backup-types">Backup Types</Label>
            <Select
              value={backupConfig?.backup_types || 'database,volume'}
              onValueChange={(value) => setBackupConfig({ ...backupConfig, backup_types: value })}
              disabled={!backupConfig?.enabled}
            >
              <SelectTrigger id="backup-types">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="database">Database Only</SelectItem>
                <SelectItem value="volume">Volume Only</SelectItem>
                <SelectItem value="database,volume">Database & Volume</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DestinationSection
            backupConfig={backupConfig}
            setBackupConfig={setBackupConfig}
          />

          <Button
            onClick={() =>
            {
              setSavingBackup(true);
              saveBackupConfigMutation.mutate(backupConfig);
            }}
            disabled={savingBackup}
          >
            {savingBackup ? 'Saving...' : 'Save Backup Configuration'}
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

function DestinationSection ({ backupConfig, setBackupConfig }: { backupConfig: any; setBackupConfig: any })
{
  const [showSshKey, setShowSshKey] = useState(false);
  const [sshKey, setSshKey] = useState('');
  const [loadingKey, setLoadingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const destType = backupConfig?.destination_type || 'local';
  const update = (patch: any) => setBackupConfig({ ...backupConfig, ...patch });

  const loadSshKey = async () =>
  {
    setLoadingKey(true);
    try {
      const { publicKey } = await api.backup.getSshKey();
      setSshKey(publicKey);
      setShowSshKey(true);
    } catch (err: any) {
      alert(err.message || 'Failed to load SSH key');
    } finally {
      setLoadingKey(false);
    }
  };

  const handleCopyKey = () =>
  {
    navigator.clipboard.writeText(sshKey);
    alert('SSH public key copied to clipboard');
  };

  const handleTest = async () =>
  {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.backup.testDestination({
        destination_type: destType,
        rsync_target: backupConfig?.rsync_target,
        koofr_email: backupConfig?.koofr_email,
        koofr_password: backupConfig?.koofr_password,
        webdav_url: backupConfig?.webdav_url,
        webdav_user: backupConfig?.webdav_user,
        webdav_password: backupConfig?.webdav_password,
        remote_subfolder: backupConfig?.remote_subfolder,
      });
      setTestResult({ success: true, message: result.output || 'Connection successful!' });
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
      <div className="space-y-2">
        <Label className="text-sm font-semibold">Backup Destination</Label>
        <Select
          value={destType}
          onValueChange={(value) => update({ destination_type: value })}
          disabled={!backupConfig?.enabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local only (no remote sync)</SelectItem>
            <SelectItem value="rsync">Rsync (SSH)</SelectItem>
            <SelectItem value="koofr">Koofr</SelectItem>
            <SelectItem value="webdav">WebDAV (generic)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {destType === 'rsync' && (
        <>
          <div className="flex items-center justify-between">
            <Label className="text-xs">SSH Authentication</Label>
            <Button type="button" variant="outline" size="sm" onClick={loadSshKey} disabled={loadingKey}>
              {loadingKey ? 'Loading...' : 'Show SSH Public Key'}
            </Button>
          </div>

          {showSshKey && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Add this SSH public key to <code className="bg-background px-1 rounded">~/.ssh/authorized_keys</code> on your destination server:
              </p>
              <div className="relative">
                <pre className="text-xs p-2 bg-background border rounded overflow-x-auto break-all whitespace-pre-wrap">{sshKey}</pre>
                <Button type="button" size="sm" variant="ghost" className="absolute top-1 right-1" onClick={handleCopyKey}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="rsync-target" className="text-xs">Rsync Target</Label>
            <Input
              id="rsync-target"
              placeholder="user@host:/path/to/backups"
              value={backupConfig?.rsync_target || ''}
              onChange={(e) => update({ rsync_target: e.target.value })}
              disabled={!backupConfig?.enabled}
            />
            <p className="text-xs text-muted-foreground">
              Format: <code className="bg-background px-1 rounded">user@host:/path</code>
            </p>
          </div>
        </>
      )}

      {destType === 'koofr' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="koofr-email" className="text-xs">Koofr Email</Label>
            <Input
              id="koofr-email"
              type="email"
              placeholder="you@example.com"
              value={backupConfig?.koofr_email || ''}
              onChange={(e) => update({ koofr_email: e.target.value })}
              disabled={!backupConfig?.enabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="koofr-password" className="text-xs">Koofr App Password</Label>
            <Input
              id="koofr-password"
              type="password"
              placeholder="App password from Koofr settings"
              value={backupConfig?.koofr_password || ''}
              onChange={(e) => update({ koofr_password: e.target.value })}
              disabled={!backupConfig?.enabled}
            />
            <p className="text-xs text-muted-foreground">
              Create an app password at <a href="https://app.koofr.net/app/admin/preferences/password" target="_blank" rel="noreferrer" className="underline">app.koofr.net → Preferences → App passwords</a>. WebDAV endpoint <code className="bg-background px-1 rounded">app.koofr.net/dav/Koofr</code> is used automatically.
            </p>
          </div>
        </>
      )}

      {destType === 'webdav' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="webdav-url" className="text-xs">WebDAV URL</Label>
            <Input
              id="webdav-url"
              placeholder="https://webdav.example.com/dav"
              value={backupConfig?.webdav_url || ''}
              onChange={(e) => update({ webdav_url: e.target.value })}
              disabled={!backupConfig?.enabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="webdav-user" className="text-xs">Username</Label>
            <Input
              id="webdav-user"
              value={backupConfig?.webdav_user || ''}
              onChange={(e) => update({ webdav_user: e.target.value })}
              disabled={!backupConfig?.enabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="webdav-password" className="text-xs">Password</Label>
            <Input
              id="webdav-password"
              type="password"
              value={backupConfig?.webdav_password || ''}
              onChange={(e) => update({ webdav_password: e.target.value })}
              disabled={!backupConfig?.enabled}
            />
          </div>
        </>
      )}

      {destType !== 'local' && (
        <div className="space-y-2">
          <Label htmlFor="remote-subfolder" className="text-xs">Remote Subfolder (optional)</Label>
          <Input
            id="remote-subfolder"
            placeholder="convexer-backups/production"
            value={backupConfig?.remote_subfolder || ''}
            onChange={(e) => update({ remote_subfolder: e.target.value })}
            disabled={!backupConfig?.enabled}
          />
          <p className="text-xs text-muted-foreground">
            Backups will be placed in this folder within the destination. Leave empty to use the root.
          </p>
        </div>
      )}

      {destType !== 'local' && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </Button>
        </div>
      )}

      {testResult && (
        <div className={`text-xs p-2 rounded ${testResult.success ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'}`}>
          <div className="font-semibold">{testResult.success ? 'Connection OK' : 'Connection Failed'}</div>
          <pre className="whitespace-pre-wrap mt-1">{testResult.message}</pre>
        </div>
      )}
    </div>
  );
}

function InstanceLogs({ instanceId }: { instanceId: string }) {
  const [container, setContainer] = useState<'backend' | 'dashboard'>('backend');
  const logRef = useRef<HTMLPreElement>(null);
  const queryClient = useQueryClient();

  const { data, error } = useQuery({
    queryKey: ['logs', instanceId, container],
    queryFn: () => api.getLogs(instanceId, container),
    refetchInterval: 3000,
  });

  const restartMutation = useMutation({
    mutationFn: () => api.restartContainer(instanceId, container),
    onSuccess: () =>
    {
      alert(`${container} container restarted successfully`);
      queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Failed to restart container');
    },
  });

  const handleDownloadLogs = async () =>
  {
    try {
      const response = await api.downloadLogs(instanceId, container);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${instanceId}-${container}-logs-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(err.message || 'Failed to download logs');
    }
  };

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>Container Logs</CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleDownloadLogs}>
            <Download className="h-4 w-4 mr-1" />
            Download
          </Button>
          <Button size="sm" variant="outline" onClick={() => restartMutation.mutate()} disabled={restartMutation.isPending}>
            <RefreshCw className={`h-4 w-4 mr-1 ${restartMutation.isPending ? 'animate-spin' : ''}`} />
            Restart
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs value={container} onValueChange={(value) => setContainer(value as 'backend' | 'dashboard')}>
          <TabsList className="w-full rounded-none border-b">
            <TabsTrigger value="backend">Backend</TabsTrigger>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          </TabsList>
          <TabsContent value="backend" className="p-4">
            {error && (
              <div className="text-sm text-destructive mb-2">{(error as Error).message}</div>
            )}
            <pre
              ref={logRef}
              className="text-xs bg-muted p-4 rounded overflow-auto max-h-96 font-mono"
            >
              {data?.logs || 'No logs available'}
            </pre>
          </TabsContent>
          <TabsContent value="dashboard" className="p-4">
            {error && (
              <div className="text-sm text-destructive mb-2">{(error as Error).message}</div>
            )}
            <pre
              ref={logRef}
              className="text-xs bg-muted p-4 rounded overflow-auto max-h-96 font-mono"
            >
              {data?.logs || 'No logs available'}
            </pre>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function DatabaseTab ({ instance }: { instance: any })
{
  const [query, setQuery] = useState('');
  const [queryResults, setQueryResults] = useState<any[] | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableSchema, setTableSchema] = useState<any[] | null>(null);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importTableName, setImportTableName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const { data: tables, isLoading: tablesLoading, refetch: refetchTables } = useQuery({
    queryKey: ['postgres-tables', instance.id],
    queryFn: () => api.postgres.listTables(instance.id),
    enabled: instance.status === 'running',
  });

  const { data: schema, isLoading: schemaLoading, refetch: refetchSchema } = useQuery({
    queryKey: ['postgres-schema', instance.id, selectedTable],
    queryFn: () => api.postgres.getTableSchema(instance.id, selectedTable!),
    enabled: !!selectedTable,
  });

  const executeMutation = useMutation({
    mutationFn: () => api.postgres.executeQuery(instance.id, query),
    onSuccess: (data) =>
    {
      setQueryResults(data.results);
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Query failed');
    },
  });

  const handleExecuteQuery = () =>
  {
    if (!query.trim()) return;
    executeMutation.mutate();
  };

  const handleSelectTable = (tableName: string) =>
  {
    setSelectedTable(tableName);
    setTableSchema(null);
  };

  const handleRefreshTables = () =>
  {
    refetchTables();
  };

  const handleRefreshSchema = () =>
  {
    if (selectedTable) {
      refetchSchema();
    }
  };

  const handleBackup = async () =>
  {
    try {
      const response = await api.postgres.createBackup(instance.id);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${instance.name}-backup-${Date.now()}.sql`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(err.message || 'Backup failed');
    }
  };

  const handleRestore = async () =>
  {
    if (!backupFile) {
      alert('Please select a backup file');
      return;
    }
    const sql = await backupFile.text();
    try {
      await api.postgres.restoreBackup(instance.id, sql);
      alert('Database restored successfully');
      setBackupFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      refetchTables();
    } catch (err: any) {
      alert(err.message || 'Restore failed');
    }
  };

  const handleExport = async () =>
  {
    if (!selectedTable) {
      alert('Please select a table first');
      return;
    }
    try {
      const response = await api.postgres.exportTable(instance.id, selectedTable);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedTable}-export-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(err.message || 'Export failed');
    }
  };

  const handleImport = async () =>
  {
    if (!importFile || !importTableName) {
      alert('Please select a file and enter a table name');
      return;
    }
    const csv = await importFile.text();
    try {
      const result = await api.postgres.importTable(instance.id, importTableName, csv);
      alert(`Imported ${result.inserted} rows successfully`);
      setImportFile(null);
      setImportTableName('');
      if (importFileInputRef.current) {
        importFileInputRef.current.value = '';
      }
      refetchTables();
    } catch (err: any) {
      alert(err.message || 'Import failed');
    }
  };

  useEffect(() =>
  {
    if (schema) {
      setTableSchema(schema.schema);
    }
  }, [schema]);

  if (instance.status !== 'running') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Database Management</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center text-muted-foreground py-12">
            Instance must be running to manage PostgreSQL database
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle>Tables</CardTitle>
          <Button size="sm" variant="outline" onClick={handleRefreshTables} disabled={tablesLoading}>
            <RefreshCw className={`h-4 w-4 ${tablesLoading ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {tablesLoading ? (
            <div className="text-muted-foreground">Loading tables...</div>
          ) : tables?.tables && tables.tables.length > 0 ? (
            <div className="space-y-2">
              {tables.tables.map((table) => (
                <Button
                  key={table}
                  variant={selectedTable === table ? 'default' : 'outline'}
                  className="w-full justify-start"
                  onClick={() => handleSelectTable(table)}
                >
                  <Database className="h-4 w-4 mr-2" />
                  {table}
                </Button>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground">No tables found</div>
          )}
        </CardContent>
      </Card>

      {selectedTable && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Table Schema: {selectedTable}</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleRefreshSchema} disabled={schemaLoading}>
                <RefreshCw className={`h-4 w-4 ${schemaLoading ? 'animate-spin' : ''}`} />
              </Button>
              <Button size="sm" variant="outline" onClick={handleExport}>
                <FileDown className="h-4 w-4 mr-1" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {schemaLoading ? (
              <div className="text-muted-foreground">Loading schema...</div>
            ) : tableSchema && tableSchema.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Column</th>
                    <th className="text-left p-2">Type</th>
                    <th className="text-left p-2">Nullable</th>
                    <th className="text-left p-2">Default</th>
                  </tr>
                </thead>
                <tbody>
                  {tableSchema.map((col: any, idx: number) => (
                    <tr key={idx} className="border-b">
                      <td className="p-2 font-mono">{col.column_name}</td>
                      <td className="p-2 font-mono text-xs">{col.data_type}</td>
                      <td className="p-2">{col.is_nullable}</td>
                      <td className="p-2 font-mono text-xs">{col.column_default || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-muted-foreground">No schema information available</div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Query Runner</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            className="w-full h-32 p-3 border rounded font-mono text-sm bg-slate-900 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter SQL query..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <Button
            onClick={handleExecuteQuery}
            disabled={executeMutation.isPending || !query.trim()}
          >
            {executeMutation.isPending ? 'Executing...' : 'Execute Query'}
          </Button>
          {queryResults && queryResults.length > 0 && (
            <div className="mt-4">
              <h3 className="font-semibold mb-2">Results ({queryResults.length} rows)</h3>
              <div className="overflow-auto max-h-64 border rounded">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100">
                    <tr>
                      {Object.keys(queryResults[0]).map((key) => (
                        <th key={key} className="text-left p-2 border-b">
                          {key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryResults.map((row: any, idx: number) => (
                      <tr key={idx} className="border-b">
                        {Object.values(row).map((val: any, vIdx: number) => (
                          <td key={vIdx} className="p-2">
                            {val === null ? '<null>' : String(val)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {queryResults && queryResults.length === 0 && (
            <div className="text-muted-foreground">Query returned no results</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Database Utilities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <h3 className="font-semibold text-sm">Backup Database</h3>
            <Button onClick={handleBackup} variant="outline" className="w-full">
              <Download className="h-4 w-4 mr-2" />
              Download Backup (.sql)
            </Button>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-sm">Restore Database</h3>
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".sql"
                onChange={(e) => setBackupFile(e.target.files?.[0] || null)}
                className="flex-1 text-sm"
              />
              <Button onClick={handleRestore} disabled={!backupFile}>
                <Upload className="h-4 w-4 mr-2" />
                Restore
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-sm">Import CSV to Table</h3>
            <Input
              placeholder="Table name"
              value={importTableName}
              onChange={(e) => setImportTableName(e.target.value)}
              className="mb-2"
            />
            <div className="flex gap-2">
              <input
                ref={importFileInputRef}
                type="file"
                accept=".csv"
                onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                className="flex-1 text-sm"
              />
              <Button onClick={handleImport} disabled={!importFile || !importTableName}>
                <FileUp className="h-4 w-4 mr-2" />
                Import
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
