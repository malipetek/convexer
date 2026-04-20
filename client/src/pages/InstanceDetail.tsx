import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { ArrowLeft, Copy, Settings, Activity, Play, Square, Trash2, RefreshCw, Download, Upload, Database, FileDown, FileUp, Archive, Box, CircleDot, AlertCircle, CheckCircle2, ArrowUpCircle, PackageOpen } from 'lucide-react';
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

function formatBytes (bytes: number | null | undefined): string
{
  if (!bytes || bytes === 0) return '0 B';
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
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      queryClient.invalidateQueries({ queryKey: ['archived-instances'] });
      navigate('/');
    },
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
            <TabsTrigger value="backups">Backups</TabsTrigger>
            <TabsTrigger value="containers">Containers</TabsTrigger>
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
                      if (confirm(`Archive "${instance.name}"? Containers and volumes will be removed after taking a backup. The instance will move to Archives and can be permanently deleted later.`)) {
                        deleteMutation.mutate();
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    <Archive className="h-4 w-4 mr-2" />
                    {deleteMutation.isPending ? 'Archiving…' : 'Archive & Delete'}
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
                        href={instance.tunnel_dashboard + '/'}
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
                  <CardDescription className="text-xs">
                    Backend: Convex API endpoint | Site: HTTP actions endpoint | Dashboard: Admin UI
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Backend URL</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() =>
                      {
                        const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                        const url = env.BACKEND_DOMAIN || `${instance.name}.${hostname || 'convexer.example.com'}`;
                        navigator.clipboard.writeText(`https://${url}`);
                      }}>
                        Copy
                      </Button>
                    </div>
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
                      className="text-sm text-blue-500 hover:underline font-mono block"
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
                    <p className="text-xs text-muted-foreground">
                      Use this URL in your frontend to connect to Convex
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Site URL (HTTP Actions)</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() =>
                      {
                        const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                        const url = env.SITE_DOMAIN || `${instance.name}-site.${hostname || 'convexer.example.com'}`;
                        navigator.clipboard.writeText(`https://${url}`);
                      }}>
                        Copy
                      </Button>
                    </div>
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
                      className="text-sm text-blue-500 hover:underline font-mono block"
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
                    <p className="text-xs text-muted-foreground">
                      HTTP actions and webhook endpoints
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Dashboard URL</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() =>
                      {
                        const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                        const url = env.DASHBOARD_DOMAIN || `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        navigator.clipboard.writeText(`https://${url}/`);
                      }}>
                        Copy
                      </Button>
                    </div>
                    <a
                      href={`https://${(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.DASHBOARD_DOMAIN || `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-dash.${hostname || 'convexer.example.com'}`;
                        }
                      })()}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-500 hover:underline font-mono block"
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
                    <p className="text-xs text-muted-foreground">
                      Admin dashboard for viewing data and logs
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Auth Dashboard URL</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() =>
                      {
                        const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                        const url = env.BETTERAUTH_DOMAIN || `${instance.name}-auth.${hostname || 'convexer.example.com'}`;
                        navigator.clipboard.writeText(`http://${url}/api/auth`);
                      }}>
                        Copy
                      </Button>
                    </div>
                    <a
                      href={`http://${(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.BETTERAUTH_DOMAIN || `${instance.name}-auth.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-auth.${hostname || 'convexer.example.com'}`;
                        }
                      })()}/api/auth`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-500 hover:underline font-mono block"
                    >
                      {(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.BETTERAUTH_DOMAIN || `${instance.name}-auth.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}-auth.${hostname || 'convexer.example.com'}`;
                        }
                      })()}/api/auth
                    </a>
                    <p className="text-xs text-muted-foreground">
                      Better Auth sidecar — runs Node.js-only plugins (infra, SSO, etc.)
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>CLI Setup</CardTitle>
                  <CardDescription className="text-xs">
                    Use these values with npx convex dev or npx convex deploy
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">CONVEX_SELF_HOSTED_URL</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() =>
                      {
                        const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                        const url = env.BACKEND_DOMAIN || `${instance.name}.${hostname || 'convexer.example.com'}`;
                        navigator.clipboard.writeText(`https://${url}`);
                      }}>
                        Copy
                      </Button>
                    </div>
                    <div className="text-sm text-muted-foreground font-mono bg-muted p-2 rounded">
                      https://{(() =>
                      {
                        try {
                          const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                          return env.BACKEND_DOMAIN || `${instance.name}.${hostname || 'convexer.example.com'}`;
                        } catch {
                          return `${instance.name}.${hostname || 'convexer.example.com'}`;
                        }
                      })()}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">CONVEX_SELF_HOSTED_ADMIN_KEY</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() =>
                      {
                        if (instance.admin_key) navigator.clipboard.writeText(instance.admin_key);
                      }}>
                        Copy
                      </Button>
                    </div>
                    <div className="text-sm text-muted-foreground font-mono bg-muted p-2 rounded break-all">
                      {instance.admin_key || 'Not available'}
                    </div>
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
                          {(stats?.cpu_percent ?? 0).toFixed(1)}%
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
                          {(stats?.memory_mb ?? 0).toFixed(0)} MB / {(stats?.memory_limit_mb ?? 4096).toFixed(0)} MB
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {(((stats?.memory_mb ?? 0) / (stats?.memory_limit_mb ?? 4096)) * 100).toFixed(1)}%
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
                          {((stats?.volume_size_bytes ?? 0) / (1024 * 1024 * 1024)).toFixed(2)} GB
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
            <InstanceSettings instance={instance} />
          </TabsContent>

          <TabsContent value="backups">
            <BackupsTab
              instanceId={id!}
              backupConfig={backupConfig}
              setBackupConfig={setBackupConfig}
              savingBackup={savingBackup}
              setSavingBackup={setSavingBackup}
              saveBackupConfigMutation={saveBackupConfigMutation}
            />
          </TabsContent>

          <TabsContent value="containers">
            <ContainersTab instanceId={instance.id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function VersionUpgradeCard ({ instance }: { instance: any })
{
  const queryClient = useQueryClient();
  const [targetVersion, setTargetVersion] = useState('');
  const [upgradeResult, setUpgradeResult] = useState<{ success: boolean; message: string } | null>(null);

  const upgradeMutation = useMutation({
    mutationFn: (version: string) => api.upgradeInstance(instance.id, version),
    onSuccess: (data) =>
    {
      setUpgradeResult({ success: true, message: data.message || 'Upgrade successful' });
      setTargetVersion('');
      queryClient.invalidateQueries({ queryKey: ['instance', instance.id] });
    },
    onError: (err: any) =>
    {
      setUpgradeResult({ success: false, message: err.message || 'Upgrade failed' });
    },
  });

  const handleUpgrade = () =>
  {
    const version = targetVersion.trim() || 'latest';
    if (!confirm(`Upgrade instance to Convex version "${version}"?\n\nA backup will be taken automatically before upgrading. The instance will restart.`)) return;
    setUpgradeResult(null);
    upgradeMutation.mutate(version);
  };

  const currentVersion = instance.pinned_version || 'latest';

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageOpen className="h-4 w-4" />
          Convex Version
        </CardTitle>
        <CardDescription>
          Upgrade or pin this instance to a specific Convex backend version.
          A backup is created automatically before any upgrade.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Current version:</span>
          <Badge variant="secondary" className="font-mono">{currentVersion}</Badge>
          {instance.detected_version && instance.detected_version !== instance.pinned_version && (
            <Badge variant="outline" className="font-mono text-xs">detected: {instance.detected_version}</Badge>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="e.g. 0.1.0 (leave empty for latest)"
            value={targetVersion}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTargetVersion(e.target.value)}
            disabled={upgradeMutation.isPending}
            className="font-mono"
          />
          <Button
            onClick={handleUpgrade}
            disabled={upgradeMutation.isPending}
            className="shrink-0"
          >
            {upgradeMutation.isPending
              ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Upgrading…</>
              : <><ArrowUpCircle className="h-4 w-4 mr-2" />Upgrade</>
            }
          </Button>
        </div>

        {upgradeMutation.isPending && (
          <p className="text-xs text-muted-foreground">
            Pulling image, backing up, and recreating containers — this may take a few minutes…
          </p>
        )}

        {upgradeResult && (
          <div className={`flex items-start gap-2 text-sm p-3 rounded-md border ${upgradeResult.success ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-300' : 'bg-destructive/10 border-destructive/20 text-destructive'}`}>
            {upgradeResult.success
              ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            }
            <span>{upgradeResult.message}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InstanceSettings ({ instance }: { instance: any })
{
  const [saving, setSaving] = useState(false);
  const [extraEnv, setExtraEnv] = useState<Record<string, string>>(() => {
    try {
      return instance.extra_env ? JSON.parse(instance.extra_env) : {};
    } catch {
      return {};
    }
  });
  const customEnvRef = useRef<HTMLTextAreaElement>(null);
  const [healthCheckTimeout, setHealthCheckTimeout] = useState(instance.health_check_timeout || 300000);
  const [postgresHealthCheckTimeout, setPostgresHealthCheckTimeout] = useState(instance.postgres_health_check_timeout || 60000);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Parse customEnvRef value into extraEnv before saving
      const lines = customEnvRef.current?.value.split('\n') || [];
      const parsed: Record<string, string> = {};
      for (const line of lines) {
        if (!line.trim()) continue;
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) continue;
        const key = line.slice(0, eqIndex).trim();
        const value = line.slice(eqIndex + 1).trim();
        parsed[key] = value;
      }
      const finalExtraEnv = {
        ...Object.fromEntries(
          Object.entries(extraEnv).filter(([k]) => ['DOCUMENT_RETENTION_DELAY', 'APPLICATION_MAX_CONCURRENT_MUTATIONS', 'RUST_LOG', 'DISABLE_METRICS_ENDPOINT', 'BACKEND_DOMAIN', 'SITE_DOMAIN', 'DASHBOARD_DOMAIN', 'BETTERAUTH_DOMAIN'].includes(k))
        ),
        ...parsed,
      };
      await api.updateSettings(instance.id, finalExtraEnv);
      await api.updateHealthCheckSettings(instance.id, healthCheckTimeout, postgresHealthCheckTimeout);
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

          <div className="space-y-2">
            <Label htmlFor="betterauth-domain">Better Auth Custom Domain (optional)</Label>
            <Input
              id="betterauth-domain"
              placeholder="auth.example.com"
              value={extraEnv.BETTERAUTH_DOMAIN || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleChange('BETTERAUTH_DOMAIN', e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Set a custom domain for the Better Auth sidecar (leave empty for default subdomain)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-env">Custom Environment Variables</Label>
            <textarea
              id="custom-env"
              ref={customEnvRef}
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="KEY=value"
              defaultValue={(() =>
              {
                try {
                  const env = instance.extra_env ? JSON.parse(instance.extra_env) : {};
                  return Object.entries(env)
                    .filter(([k]) => !['DOCUMENT_RETENTION_DELAY', 'APPLICATION_MAX_CONCURRENT_MUTATIONS', 'RUST_LOG', 'DISABLE_METRICS_ENDPOINT', 'BACKEND_DOMAIN', 'SITE_DOMAIN', 'DASHBOARD_DOMAIN', 'BETTERAUTH_DOMAIN'].includes(k))
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n');
                } catch {
                  return '';
                }
              })()}
            />
            <p className="text-sm text-muted-foreground">
              Add custom environment variables (one per line, format: KEY=value)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="health-check-timeout">Backend Health Check Timeout (ms)</Label>
            <Input
              id="health-check-timeout"
              type="number"
              value={healthCheckTimeout}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHealthCheckTimeout(Number(e.target.value))}
              min="10000"
              max="600000"
              step="10000"
            />
            <p className="text-xs text-muted-foreground">
              Maximum time to wait for Convex backend to become healthy (default: 300000ms / 5 minutes)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="postgres-health-check-timeout">PostgreSQL Health Check Timeout (ms)</Label>
            <Input
              id="postgres-health-check-timeout"
              type="number"
              value={postgresHealthCheckTimeout}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPostgresHealthCheckTimeout(Number(e.target.value))}
              min="10000"
              max="120000"
              step="5000"
            />
            <p className="text-xs text-muted-foreground">
              Maximum time to wait for PostgreSQL to become ready (default: 60000ms / 1 minute)
            </p>
          </div>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save & Restart Backend'}
          </Button>
        </CardContent>
      </Card>

      <VersionUpgradeCard instance={instance} />
    </>
  );
}

function BackupsTab ({ instanceId, backupConfig, setBackupConfig, savingBackup, setSavingBackup, saveBackupConfigMutation }: { instanceId: string; backupConfig: any; setBackupConfig: any; savingBackup: boolean; setSavingBackup: any; saveBackupConfigMutation: any })
{
  return (
    <>
      <BackupNowCard instanceId={instanceId} />

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

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Remote Backup Destination
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DestinationSection instanceId={instanceId} />
        </CardContent>
      </Card>
    </>
  );
}

function labelStyle (label?: string): { bg: string; text: string; dot: string }
{
  if (!label || label === 'Manual') return { bg: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', text: 'Manual', dot: 'bg-blue-500' };
  if (label === 'Scheduled') return { bg: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', text: 'Scheduled', dot: 'bg-gray-400' };
  if (label === 'Pre-restore snapshot') return { bg: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', text: 'Snapshot', dot: 'bg-amber-500' };
  return { bg: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300', text: label, dot: 'bg-purple-500' };
}

function BackupNowCard ({ instanceId }: { instanceId: string })
{
  const queryClient = useQueryClient();
  const [backupType, setBackupType] = useState<'database' | 'volume' | 'database,volume'>('database,volume');
  const [detailBackupId, setDetailBackupId] = useState<string | null>(null);

  const { data: historyData } = useQuery({
    queryKey: ['backupHistory', instanceId],
    queryFn: () => api.backup.getHistory(instanceId, 30),
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  const triggerMutation = useMutation({
    mutationFn: () => api.backup.triggerBackup(instanceId, backupType),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backupHistory', instanceId] }),
    onError: (err: any) => alert(err.message || 'Failed to trigger backup'),
  });

  const [restoringId, setRestoringId] = useState<string | null>(null);

  const restoreMutation = useMutation({
    mutationFn: (backupId: string) => api.backup.restoreFromHistory(instanceId, backupId),
    onMutate: (backupId) => setRestoringId(backupId),
    onSuccess: () =>
    {
      setRestoringId(null);
      queryClient.invalidateQueries({ queryKey: ['backupHistory', instanceId] });
      alert('Restored successfully. A pre-restore snapshot was saved automatically.');
    },
    onError: (err: any) =>
    {
      setRestoringId(null);
      alert(err.message || 'Restore failed');
    },
  });

  const history: any[] = historyData?.history || [];

  if (!instanceId) return null;

  // Group history by local date string
  const grouped: { date: string; entries: any[] }[] = [];
  for (const h of history) {
    const date = new Date(h.started_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const last = grouped[grouped.length - 1];
    if (last && last.date === date) last.entries.push(h);
    else grouped.push({ date, entries: [h] });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            Create Backup
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-2">
              <Label htmlFor="manual-backup-type">Backup Type</Label>
              <Select value={backupType} onValueChange={(v: any) => setBackupType(v)}>
                <SelectTrigger id="manual-backup-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="database">Database Only</SelectItem>
                  <SelectItem value="volume">Volume Only</SelectItem>
                  <SelectItem value="database,volume">Database &amp; Volume</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => triggerMutation.mutate()} disabled={triggerMutation.isPending}>
              {triggerMutation.isPending
                ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Running...</>
                : <><FileDown className="h-4 w-4 mr-2" />Back Up Now</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleDot className="h-4 w-4" />
              Snapshot Timeline
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="space-y-6">
              {grouped.map((group, gi) => (
                <div key={group.date}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{group.date}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  <div className="relative ml-3">
                    {/* vertical timeline line */}
                    <div className="absolute left-[7px] top-0 bottom-0 w-px bg-border" />
                    <div className="space-y-3">
                      {group.entries.map((h: any, idx: number) =>
                      {
                        const ls = labelStyle(h.label);
                        const isFirst = gi === 0 && idx === 0;
                        return (
                          <div key={h.id || idx} className="relative flex gap-4 pl-8">
                            {/* timeline dot */}
                            <div className={`absolute left-0 top-[10px] w-[15px] h-[15px] rounded-full border-2 border-background ${h.status === 'running' ? 'bg-yellow-500 animate-pulse' :
                                h.status === 'failed' ? 'bg-red-500' :
                                  ls.dot
                              } z-10`} />

                            <div className={`flex-1 rounded-lg border p-3 transition-colors cursor-pointer hover:border-primary/50 ${isFirst && h.status === 'completed' ? 'border-primary/40 bg-primary/5' : 'bg-card'}`} onClick={() => setDetailBackupId(h.id)}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${ls.bg}`}>{ls.text}</span>
                                    <span className="text-xs font-medium capitalize">{h.backup_type}</span>
                                    {isFirst && h.status === 'completed' && (
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/20 text-primary">Latest</span>
                                    )}
                                    {h.restored_at && (
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">Last restored</span>
                                    )}
                                    {h.status === 'running' && (
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">Running…</span>
                                    )}
                                    {h.status === 'failed' && (
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">Failed</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 mt-1">
                                    <span className="text-xs text-muted-foreground">
                                      {new Date(h.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    {h.size_bytes && (
                                      <span className="text-xs text-muted-foreground">· {formatBytes(h.size_bytes)}</span>
                                    )}
                                  </div>
                                  {h.error_message && (
                                    <p className="text-xs text-red-500 mt-1 truncate">{h.error_message}</p>
                                  )}
                                </div>

                                {h.status === 'completed' && (
                                  <Button
                                    size="sm"
                                    variant={isFirst ? 'outline' : 'ghost'}
                                    className="h-7 px-2 text-xs shrink-0"
                                    disabled={!!restoringId}
                                    onClick={() =>
                                    {
                                      if (window.confirm(`Roll back to this ${h.backup_type} snapshot?\n\nTaken: ${new Date(h.started_at).toLocaleString()}\n\nThe current state will be saved as a "Pre-restore snapshot" before rolling back.`)) {
                                        restoreMutation.mutate(h.id);
                                      }
                                    }}
                                  >
                                    {restoringId === h.id
                                      ? <RefreshCw className="h-3 w-3 animate-spin" />
                                      : <><Upload className="h-3 w-3 mr-1" />Roll back</>}
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {detailBackupId && (
        <BackupDetailDialog
          backupId={detailBackupId}
          open={!!detailBackupId}
          onClose={() => setDetailBackupId(null)}
        />
      )}
    </>
  );
}

function BackupDetailDialog ({ backupId, open, onClose }: { backupId: string; open: boolean; onClose: () => void })
{
  const queryClient = useQueryClient();
  const { data: details, isLoading } = useQuery({
    queryKey: ['backupDetails', backupId],
    queryFn: () => api.backup.getBackupDetails(backupId),
    enabled: open && !!backupId,
  });

  const deleteLocalMutation = useMutation({
    mutationFn: () => api.backup.deleteBackupLocalFile(backupId),
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['backupDetails', backupId] });
      queryClient.invalidateQueries({ queryKey: ['backupHistory'] });
    },
    onError: (err: any) => alert(err.message || 'Failed to delete local file'),
  });

  const backup = details?.backup;
  const syncStatus = details?.syncStatus || [];
  const preRestoreBackup = details?.preRestoreBackup;

  if (!backup) return null;

  const syncStatusBadge = (status: string) =>
  {
    if (status === 'completed') return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Synced</Badge>;
    if (status === 'failed') return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">Failed</Badge>;
    if (status === 'pending') return <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">Pending</Badge>;
    return <Badge>{status}</Badge>;
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5" />
            Backup Details
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Loading...</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Type</div>
                <div className="font-medium capitalize">{backup.backup_type}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Status</div>
                <div className="font-medium capitalize">{backup.status}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Size</div>
                <div className="font-medium">{backup.size_bytes ? formatBytes(backup.size_bytes) : 'N/A'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Created</div>
                <div className="font-medium">{new Date(backup.started_at).toLocaleString()}</div>
              </div>
              {backup.restored_at && (
                <div>
                  <div className="text-muted-foreground">Last Restored</div>
                  <div className="font-medium">{new Date(backup.restored_at).toLocaleString()}</div>
                </div>
              )}
              {backup.file_path ? (
                <div>
                  <div className="text-muted-foreground">Local File</div>
                  <div className="font-medium text-xs truncate">Available</div>
                </div>
              ) : (
                <div>
                  <div className="text-muted-foreground">Local File</div>
                  <div className="font-medium text-muted-foreground">Offloaded</div>
                </div>
              )}
            </div>

            {syncStatus.length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">Sync Status</div>
                <div className="space-y-1">
                  {syncStatus.map((s: any) => (
                    <div key={s.id} className="flex items-center justify-between text-sm p-2 bg-muted rounded">
                      <span className="capitalize">{s.provider}</span>
                      {syncStatusBadge(s.status)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preRestoreBackup && (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800">
                <div className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-1">Pre-restore snapshot</div>
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  Created {new Date(preRestoreBackup.started_at).toLocaleString()} before this backup was restored.
                </div>
              </div>
            )}

            {backup.file_path && (
              <DialogFooter>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                  {
                    if (window.confirm('Delete local backup file? Metadata will be preserved but the file will be removed to free disk space.')) {
                      deleteLocalMutation.mutate();
                    }
                  }}
                  disabled={deleteLocalMutation.isPending}
                >
                  {deleteLocalMutation.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                  Delete Local Copy
                </Button>
              </DialogFooter>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DestinationSection ({ instanceId }: { instanceId: string })
{
  const queryClient = useQueryClient();
  const { data: destinationsData, isLoading } = useQuery({
    queryKey: ['backupDestinations', instanceId],
    queryFn: () => api.backup.getDestinations(instanceId),
    enabled: !!instanceId,
  });

  const [editingDest, setEditingDest] = useState<string | null>(null);
  const [newDestType, setNewDestType] = useState<string>('rsync');
  const [showAddForm, setShowAddForm] = useState(false);

  const destinations = destinationsData?.destinations || [];

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.backup.updateDestination(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backupDestinations', instanceId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.backup.deleteDestination(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backupDestinations', instanceId] }),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => api.backup.createDestination(instanceId, data),
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['backupDestinations', instanceId] });
      setShowAddForm(false);
      setNewDestType('rsync');
    },
  });

  const destTypeLabel = (type: string) =>
  {
    const labels: Record<string, string> = { rsync: 'Rsync', koofr: 'Koofr', webdav: 'WebDAV', s3: 'S3' };
    return labels[type] || type;
  };

  const DestinationForm = ({ dest, onCancel, onSave }: { dest?: any; onCancel: () => void; onSave: (data: any) => void }) =>
  {
    const [formData, setFormData] = useState(() =>
    {
      if (dest) {
        const { id, instance_id, created_at, updated_at, ...rest } = dest;
        return rest;
      }
      return { destination_type: newDestType, enabled: 1 };
    });

    return (
      <div className="space-y-4 border-t pt-4">
        {dest && (
          <div className="flex items-center justify-between">
            <Label>Enabled</Label>
            <Switch
              checked={formData.enabled === 1}
              onCheckedChange={(checked) => setFormData({ ...formData, enabled: checked ? 1 : 0 })}
            />
          </div>
        )}

        {formData.destination_type === 'rsync' && (
          <div className="space-y-2">
            <Label htmlFor="rsync-target">Rsync Target (user@host:path)</Label>
            <Input
              id="rsync-target"
              placeholder="user@backup-server:/backups"
              value={formData.rsync_target || ''}
              onChange={(e) => setFormData({ ...formData, rsync_target: e.target.value })}
            />
          </div>
        )}

        {formData.destination_type === 'koofr' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="koofr-email">Koofr Email</Label>
              <Input
                id="koofr-email"
                type="email"
                value={formData.koofr_email || ''}
                onChange={(e) => setFormData({ ...formData, koofr_email: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="koofr-password">Koofr Password</Label>
              <Input
                id="koofr-password"
                type="password"
                value={formData.koofr_password || ''}
                onChange={(e) => setFormData({ ...formData, koofr_password: e.target.value })}
              />
            </div>
          </>
        )}

        {formData.destination_type === 'webdav' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="webdav-url">WebDAV URL</Label>
              <Input
                id="webdav-url"
                placeholder="https://dav.example.com/remote.php/webdav/"
                value={formData.webdav_url || ''}
                onChange={(e) => setFormData({ ...formData, webdav_url: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="webdav-user">Username</Label>
              <Input
                id="webdav-user"
                value={formData.webdav_user || ''}
                onChange={(e) => setFormData({ ...formData, webdav_user: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="webdav-password">Password</Label>
              <Input
                id="webdav-password"
                type="password"
                value={formData.webdav_password || ''}
                onChange={(e) => setFormData({ ...formData, webdav_password: e.target.value })}
              />
            </div>
          </>
        )}

        {formData.destination_type === 's3' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="s3-bucket">S3 Bucket</Label>
              <Input
                id="s3-bucket"
                placeholder="my-backup-bucket"
                value={formData.s3_bucket || ''}
                onChange={(e) => setFormData({ ...formData, s3_bucket: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-region">Region</Label>
              <Input
                id="s3-region"
                placeholder="us-east-1"
                value={formData.s3_region || ''}
                onChange={(e) => setFormData({ ...formData, s3_region: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-access-key">Access Key</Label>
              <Input
                id="s3-access-key"
                value={formData.s3_access_key || ''}
                onChange={(e) => setFormData({ ...formData, s3_access_key: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-secret-key">Secret Key</Label>
              <Input
                id="s3-secret-key"
                type="password"
                value={formData.s3_secret_key || ''}
                onChange={(e) => setFormData({ ...formData, s3_secret_key: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s3-endpoint">Endpoint (optional)</Label>
              <Input
                id="s3-endpoint"
                placeholder="https://s3.amazonaws.com"
                value={formData.s3_endpoint || ''}
                onChange={(e) => setFormData({ ...formData, s3_endpoint: e.target.value })}
              />
            </div>
          </>
        )}

        <div className="space-y-2">
          <Label htmlFor="remote-subfolder">Remote Subfolder (optional)</Label>
          <Input
            id="remote-subfolder"
            placeholder="instance-backups"
            value={formData.remote_subfolder || ''}
            onChange={(e) => setFormData({ ...formData, remote_subfolder: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Subfolder within the remote destination for this instance's backups</p>
        </div>

        <div className="flex gap-2">
          <Button onClick={() => onSave(formData)}>{dest ? 'Save' : 'Add Destination'}</Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    );
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading destinations...</div>;

  return (
    <div className="space-y-4">
      {destinations.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8">
          No remote destinations configured. Add one to enable off-site backups.
        </div>
      ) : (
        <div className="space-y-3">
          {destinations.map((dest: any) => (
            <div key={dest.id} className="border rounded-lg p-4">
              {editingDest === dest.id ? (
                <DestinationForm
                  dest={dest}
                  onCancel={() => setEditingDest(null)}
                  onSave={(data) => updateMutation.mutate({ id: dest.id, data })}
                />
              ) : (
                <>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="font-semibold capitalize">{destTypeLabel(dest.destination_type)}</span>
                        <Switch
                          checked={dest.enabled === 1}
                          onCheckedChange={(checked) => updateMutation.mutate({ id: dest.id, data: { enabled: checked ? 1 : 0 } })}
                        />
                        {dest.enabled === 1 && <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Active</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground space-y-1">
                        {dest.destination_type === 'rsync' && <div>Target: {dest.rsync_target}</div>}
                        {dest.destination_type === 'koofr' && <div>Email: {dest.koofr_email}</div>}
                        {dest.destination_type === 'webdav' && <div>URL: {dest.webdav_url}</div>}
                        {dest.destination_type === 's3' && <div>Bucket: {dest.s3_bucket} / {dest.s3_region}</div>}
                        {dest.remote_subfolder && <div>Subfolder: {dest.remote_subfolder}</div>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditingDest(dest.id)}>Edit</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                          {
                            if (window.confirm('Delete this destination?')) {
                              deleteMutation.mutate(dest.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {!showAddForm ? (
        <Button variant="outline" className="w-full" onClick={() => setShowAddForm(true)}>
          <Upload className="h-4 w-4 mr-2" />
          Add Remote Destination
        </Button>
      ) : (
        <div className="border rounded-lg p-4 bg-muted/50">
          <div className="mb-4">
            <Label htmlFor="new-dest-type">Destination Type</Label>
            <Select value={newDestType} onValueChange={setNewDestType}>
              <SelectTrigger id="new-dest-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rsync">Rsync</SelectItem>
                <SelectItem value="koofr">Koofr</SelectItem>
                <SelectItem value="webdav">WebDAV</SelectItem>
                <SelectItem value="s3">S3 Compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DestinationForm
            onCancel={() => setShowAddForm(false)}
            onSave={(data) => createMutation.mutate(data)}
          />
        </div>
      )}
    </div>
  );
}

function ContainersTab ({ instanceId }: { instanceId: string })
{
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['containers', instanceId],
    queryFn: () => api.getContainers(instanceId),
    refetchInterval: 10_000,
  });

  const { data: logData, isFetching: logFetching } = useQuery({
    queryKey: ['container-logs', instanceId, selectedRole],
    queryFn: () => api.getLogs(instanceId, selectedRole as any, 300),
    enabled: !!selectedRole,
    refetchInterval: 5_000,
  });

  useEffect(() =>
  {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logData]);

  const statusColor: Record<string, string> = {
    running: 'text-green-500',
    exited: 'text-muted-foreground',
    restarting: 'text-yellow-500',
    'not found': 'text-destructive',
  };

  const roleLabel: Record<string, string> = {
    backend: 'Backend',
    dashboard: 'Dashboard',
    postgres: 'Postgres',
  };

  const containers = data?.containers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Containers</h3>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading containers…</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {containers.map((c) =>
          {
            const isSelected = selectedRole === c.role;
            const Icon = c.role === 'postgres' ? Database : c.role === 'dashboard' ? Activity : Box;
            return (
              <Card
                key={c.role}
                className={`cursor-pointer transition-colors ${isSelected ? 'border-primary' : 'hover:border-primary/50'}`}
                onClick={() => setSelectedRole(isSelected ? null : c.role)}
              >
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{roleLabel[c.role] ?? c.role}</span>
                    </div>
                    {c.status === 'running' ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : c.status === 'not found' ? (
                      <AlertCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <CircleDot className={`h-4 w-4 ${statusColor[c.status] ?? 'text-muted-foreground'}`} />
                    )}
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div className="font-mono truncate">{c.name}</div>
                    <div className={`font-medium capitalize ${statusColor[c.status] ?? ''}`}>{c.status}</div>
                    {c.image && <div className="truncate">{c.image.split('/').pop()}</div>}
                    {c.restartCount > 0 && (
                      <div className="text-yellow-500">{c.restartCount} restart{c.restartCount !== 1 ? 's' : ''}</div>
                    )}
                    {c.ports.length > 0 && (
                      <div className="font-mono">:{c.ports.map(p => p.hostPort).join(', :')}</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {selectedRole && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">{roleLabel[selectedRole] ?? selectedRole} Logs</CardTitle>
            <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${logFetching ? 'animate-spin' : ''}`} />
          </CardHeader>
          <CardContent className="p-0">
            <pre
              ref={logRef}
              className="text-xs bg-muted p-4 rounded-b overflow-auto max-h-80 font-mono whitespace-pre-wrap"
            >
              {logData?.logs || 'No logs available'}
            </pre>
          </CardContent>
        </Card>
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
