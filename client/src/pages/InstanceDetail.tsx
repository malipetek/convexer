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
import { ArrowLeft, Copy, Settings, Activity, Play, Square, Trash2 } from 'lucide-react';
import MetricsBadge from '../components/MetricsBadge';
import MetricsGauge from '../components/MetricsGauge';
import MetricsGraph from '../components/MetricsGraph';

export default function InstanceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [metricsHistory, setMetricsHistory] = useState<Array<{ time: string; cpu: number; memory: number }>>([]);
  const [hostname, setHostname] = useState('');

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

  useEffect(() =>
  {
    if (settings) {
      setHostname(settings.hostname || '');
    }
  }, [settings]);

  useEffect(() => {
    if (stats) {
      const now = new Date().toLocaleTimeString();
      setMetricsHistory(prev => {
        const newHistory = [...prev, { time: now, cpu: stats.cpu_percent, memory: stats.memory_mb }];
        if (newHistory.length > 60) {
          return newHistory.slice(-60);
        }
        return newHistory;
      });
    }
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
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-6">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
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
                    <div className="grid grid-cols-3 gap-6">
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
                          label="Disk"
                          color="#f59e0b"
                        />
                        <div className="mt-2 text-sm font-semibold">
                          {(stats?.volume_size_bytes ? stats.volume_size_bytes / (1024 * 1024 * 1024) : 0).toFixed(2)} GB
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="metrics">
            <Card>
              <CardHeader>
                <CardTitle>Historical Metrics</CardTitle>
              </CardHeader>
              <CardContent>
                {instance.status === 'running' ? (
                  <MetricsGraph data={metricsHistory} />
                ) : (
                  <div className="text-center text-muted-foreground py-12">
                    Instance must be running to view metrics
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <InstanceSettings instance={instance} />
          </TabsContent>

          <TabsContent value="logs">
            <InstanceLogs instanceId={instance.id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function InstanceSettings({ instance }: { instance: any }) {
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
  );
}

function InstanceLogs({ instanceId }: { instanceId: string }) {
  const [container, setContainer] = useState<'backend' | 'dashboard'>('backend');
  const logRef = useRef<HTMLPreElement>(null);

  const { data, error } = useQuery({
    queryKey: ['logs', instanceId, container],
    queryFn: () => api.getLogs(instanceId, container),
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <Card>
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
