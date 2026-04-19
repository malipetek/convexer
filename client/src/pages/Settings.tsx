import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Save, RefreshCw, Download, Cpu, HardDrive, Network, Container, Clock, Server, MemoryStick, Settings as SettingsIcon, Activity, PackageCheck, BarChart2, Bug, ExternalLink, Terminal } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { api } from '../api';

function ServerStats ()
{
  const { data: serverStats, isLoading } = useQuery({
    queryKey: ['serverStats'],
    queryFn: () => api.getServerStats(),
    refetchInterval: 10000,
  });

  if (isLoading) {
    return <div className="p-4">Loading server stats...</div>;
  }

  return (
    <div className="space-y-6">
      {/* System Info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Hostname</span>
          </div>
          <div className="font-mono text-sm">{serverStats?.hostname || 'N/A'}</div>
        </div>
        <div className="p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Uptime</span>
          </div>
          <div className="font-semibold text-sm">{serverStats?.uptime_formatted || 'N/A'}</div>
        </div>
        <div className="p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">OS</span>
          </div>
          <div className="font-mono text-xs">{serverStats?.os || 'N/A'}</div>
        </div>
        <div className="p-3 bg-muted rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Kernel</span>
          </div>
          <div className="font-mono text-xs">{serverStats?.kernel_version || 'N/A'}</div>
        </div>
      </div>

      {/* CPU & Memory */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              CPU
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Cores</span>
              <Badge variant="secondary">{serverStats?.cpus || 0}</Badge>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Load Average (1m)</span>
                <span className="font-mono">{serverStats?.load_average_1m?.toFixed(2) || '0'}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Load Average (5m)</span>
                <span className="font-mono">{serverStats?.load_average_5m?.toFixed(2) || '0'}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Load Average (15m)</span>
                <span className="font-mono">{serverStats?.load_average_15m?.toFixed(2) || '0'}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <MemoryStick className="h-4 w-4" />
              Memory
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="font-mono text-sm">{serverStats?.memory_total_gb || '0'} GB</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Used</span>
              <span className="font-mono text-sm">{serverStats?.memory_used_gb || '0'} GB</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Free</span>
              <span className="font-mono text-sm">{serverStats?.memory_free_gb || '0'} GB</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Usage</span>
                <span className="font-semibold">{serverStats?.memory_usage_percent || '0'}%</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${serverStats?.memory_usage_percent || 0}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Disk Usage */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            Disk Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {serverStats?.disk_usage && serverStats.disk_usage.length > 0 ? (
            <div className="space-y-3">
              {serverStats.disk_usage.map((disk, idx) => (
                <div key={idx} className="p-3 bg-muted rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-4 w-4 text-muted-foreground" />
                      <span className="font-mono text-xs">{disk.mountpoint}</span>
                    </div>
                    <Badge variant={parseInt(disk.usage_percent) > 80 ? 'destructive' : 'secondary'}>
                      {disk.usage_percent}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                    <div>
                      <span className="text-muted-foreground">Size: </span>
                      <span className="font-mono">{disk.size}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Used: </span>
                      <span className="font-mono">{disk.used}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Avail: </span>
                      <span className="font-mono">{disk.available}</span>
                    </div>
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${parseInt(disk.usage_percent) > 80 ? 'bg-red-500' : parseInt(disk.usage_percent) > 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
                      style={{ width: disk.usage_percent }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No disk usage data available</div>
          )}
        </CardContent>
      </Card>

      {/* Docker Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Container className="h-4 w-4" />
              Docker Containers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2 bg-green-500/10 rounded-lg">
                <div className="text-xl font-bold text-green-500">{serverStats?.containers_running || 0}</div>
                <div className="text-xs text-muted-foreground">Running</div>
              </div>
              <div className="p-2 bg-yellow-500/10 rounded-lg">
                <div className="text-xl font-bold text-yellow-500">{serverStats?.containers_paused || 0}</div>
                <div className="text-xs text-muted-foreground">Paused</div>
              </div>
              <div className="p-2 bg-gray-500/10 rounded-lg">
                <div className="text-xl font-bold text-gray-500">{serverStats?.containers_stopped || 0}</div>
                <div className="text-xs text-muted-foreground">Stopped</div>
              </div>
            </div>
            <div className="flex justify-between text-xs pt-2 border-t">
              <span className="text-muted-foreground">Total Containers</span>
              <span className="font-semibold">{serverStats?.containers_total || 0}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Total Images</span>
              <span className="font-semibold">{serverStats?.images || 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Server className="h-4 w-4" />
              Docker Resources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Storage Driver</span>
              <Badge variant="outline">{serverStats?.storage_driver || 'N/A'}</Badge>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Volumes</span>
              <span className="font-semibold">{serverStats?.volumes || 0}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Networks</span>
              <span className="font-semibold">{serverStats?.networks || 0}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Docker Version</span>
              <span className="font-mono text-xs">{serverStats?.server_version || 'N/A'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">API Version</span>
              <span className="font-mono text-xs">{serverStats?.api_version || 'N/A'}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Docker Disk Usage */}
      {serverStats?.docker_disk_usage && Object.keys(serverStats.docker_disk_usage).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              Docker Disk Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(serverStats.docker_disk_usage).map(([key, value]: [string, any]) => (
                <div key={key} className="p-3 bg-muted rounded-lg">
                  <div className="text-xs text-muted-foreground mb-1 capitalize">{key.replace('_', ' ')}</div>
                  <div className="font-mono text-sm">{value.total_size || 'N/A'}</div>
                  {value.reclaimable && (
                    <div className="text-xs text-muted-foreground mt-1">Reclaimable: {value.reclaimable}</div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Network Interfaces */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Network className="h-4 w-4" />
            Network Interfaces
          </CardTitle>
        </CardHeader>
        <CardContent>
          {serverStats?.network_interfaces && serverStats.network_interfaces.length > 0 ? (
            <div className="space-y-2">
              {serverStats.network_interfaces.map((iface, idx) => (
                <div key={idx} className="p-3 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Network className="h-4 w-4 text-muted-foreground" />
                    <span className="font-semibold text-sm">{iface.name}</span>
                  </div>
                  <div className="space-y-1">
                    {iface.addresses.map((addr, addrIdx) => (
                      <div key={addrIdx} className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{addr.family}</span>
                        <span className="font-mono">{addr.address}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No network interfaces data available</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const UMAMI_CONTAINERS = [
  { value: 'umami', label: 'App' },
  { value: 'umami-db', label: 'Database' },
];

const GLITCHTIP_CONTAINERS = [
  { value: 'glitchtip-web', label: 'Web' },
  { value: 'glitchtip-worker', label: 'Worker' },
  { value: 'glitchtip-db', label: 'Database' },
  { value: 'glitchtip-redis', label: 'Redis' },
];

function MonitoringLogs ({ containers }: { containers: { value: string; label: string }[] })
{
  const [selected, setSelected] = useState(containers[0].value);
  const logRef = useRef<HTMLPreElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['monitoring-logs', selected],
    queryFn: () => api.getMonitoringLogs(selected),
    refetchInterval: 5000,
  });

  useEffect(() =>
  {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Logs</span>
        <div className="flex gap-1 ml-2">
          {containers.map(c => (
            <button
              key={c.value}
              onClick={() => setSelected(c.value)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${selected === c.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <RefreshCw className={`h-3 w-3 ml-auto text-muted-foreground ${isFetching ? 'animate-spin' : ''}`} />
      </div>
      <pre
        ref={logRef}
        className="text-xs bg-black text-green-400 font-mono p-3 rounded overflow-auto max-h-60 whitespace-pre-wrap"
      >
        {data?.logs || 'No logs available'}
      </pre>
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [hostname, setHostname] = useState('');
  const [saving, setSaving] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateLogs, setUpdateLogs] = useState<string[]>([]);
  const [showLogsDialog, setShowLogsDialog] = useState(false);
  const [showSavedLogsDialog, setShowSavedLogsDialog] = useState(false);
  const [savedLogs, setSavedLogs] = useState('');
  const [rollingBack, setRollingBack] = useState(false);

  const { data: monitoringStatus, isLoading: monitoringLoading, refetch: refetchMonitoring } = useQuery({
    queryKey: ['monitoringStatus'],
    queryFn: () => api.getMonitoringStatus(),
    refetchInterval: 15000,
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

  // Use checkUpdate as the source of truth — it returns current_version,
  // latest_version, and has_update in a single call. Falls back gracefully if
  // the GitHub check fails (e.g. rate-limited) by calling getVersion.
  const { data: versionInfo } = useQuery({
    queryKey: ['version'],
    queryFn: async () =>
    {
      try {
        return await api.checkUpdate();
      } catch {
        const v = await api.getVersion();
        return { current_version: v.current_version, latest_version: undefined as any, has_update: false };
      }
    },
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const { data: rollbackStatus } = useQuery({
    queryKey: ['rollback-status'],
    queryFn: () => api.getRollbackStatus(),
    refetchOnWindowFocus: false,
  });

  const saveSettingsMutation = useMutation({
    mutationFn: (hostname: string) => api.saveSettings(hostname),
    onSuccess: () =>
    {
      alert('Settings saved');
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Failed to save settings');
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () =>
    {
      // Start the update
      await api.updateApp();
      setShowLogsDialog(true);
      setUpdateLogs(['Update started...']);

      // Poll the logs and status endpoints until completion
      let apiDownCount = 0;
      const pollInterval = setInterval(async () =>
      {
        try {
          // Fetch logs
          const logsData = await fetch('/api/version/update/logs').then(res => res.json()).catch(() => ({ logs: '' }));
          if (logsData.logs && logsData.logs !== '') {
            setUpdateLogs(prev => [...prev, logsData.logs]);
          }

          const status = await api.getUpdateStatus();
          apiDownCount = 0; // Reset counter on successful poll

          if (!status.running && status.success !== null) {
            clearInterval(pollInterval);
            setUpdateLogs(prev => [...prev, status.success ? 'Update completed successfully!' : 'Update failed.']);
            if (status.success) {
              queryClient.invalidateQueries({ queryKey: ['version'] });
              setTimeout(() => window.location.reload(), 3000);
            } else {
              setUpdating(false);
            }
          }
        } catch (err) {
          apiDownCount++;
          // If API is down for more than 10 consecutive polls (20 seconds), wait for it to come back
          if (apiDownCount > 10) {
            clearInterval(pollInterval);
            setUpdateLogs(prev => [...prev, 'API is down during update. Waiting for it to come back up...']);
            // Wait for API to come back up
            const retryInterval = setInterval(async () =>
            {
              try {
                await api.getVersion();
                clearInterval(retryInterval);
                // API is back up, check if update succeeded by comparing versions
                const versionData = await api.getVersion();
                const currentVersion = versionData.current_version;
                // If the version changed, the update succeeded
                if (currentVersion !== '1.0.36') {
                  setUpdateLogs(prev => [...prev, 'Update successful! Reloading...']);
                  setTimeout(() => window.location.reload(), 3000);
                } else {
                  setUpdateLogs(prev => [...prev, 'Update failed.']);
                  setUpdating(false);
                }
              } catch (retryErr) {
                // API still down, keep waiting
              }
            }, 3000);
          }
        }
      }, 2000);
    },
    onError: (err: any) =>
    {
      setUpdateLogs(prev => [...prev, `Update failed: ${err.message}`]);
      setUpdating(false);
    },
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettingsMutation.mutateAsync(hostname);
    } finally {
      setSaving(false);
    }
  };

  const handleCheckUpdate = async () =>
  {
    setCheckingUpdate(true);
    try {
      await api.checkUpdate();
      queryClient.invalidateQueries({ queryKey: ['version'] });
    } catch (err: any) {
      alert(err.message || 'Failed to check for updates');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleUpdate = () =>
  {
    if (confirm('This will update the app to the latest version. Continue?')) {
      setUpdating(true);
      updateMutation.mutate();
    }
  };

  const handleViewSavedLogs = async () =>
  {
    try {
      const data = await api.getSavedUpdateLogs();
      setSavedLogs(data.logs);
      setShowSavedLogsDialog(true);
    } catch (err: any) {
      alert(err.message || 'Failed to fetch saved logs');
    }
  };

  const handleRollback = async () =>
  {
    if (!rollbackStatus?.commit) return;
    if (confirm(`This will rollback to commit ${rollbackStatus.commit.slice(0, 7)}. The server will restart. Continue?`)) {
      setRollingBack(true);
      try {
        await api.rollback();
        alert('Rollback started. The server will restart shortly.');
        setTimeout(() => window.location.reload(), 5000);
      } catch (err: any) {
        alert(err.message || 'Rollback failed');
        setRollingBack(false);
      }
    }
  };

  return (
    <div className="p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Global Settings</h1>
          {versionInfo?.current_version && (
            <Badge variant={versionInfo.has_update ? 'default' : 'secondary'} className="font-mono">
              v{versionInfo.current_version}
              {versionInfo.has_update && versionInfo.latest_version && (
                <span className="ml-1 opacity-80">→ {versionInfo.latest_version}</span>
              )}
            </Badge>
          )}
        </div>

        <Tabs defaultValue="general" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="general">
              <SettingsIcon className="h-4 w-4 mr-2" />
              General
            </TabsTrigger>
            <TabsTrigger value="server">
              <Activity className="h-4 w-4 mr-2" />
              Server Stats
            </TabsTrigger>
            <TabsTrigger value="updates">
              <PackageCheck className="h-4 w-4 mr-2" />
              Updates
              {versionInfo?.has_update && (
                <Badge variant="default" className="ml-2 h-5 px-1.5 text-[10px]">new</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="monitoring">
              <BarChart2 className="h-4 w-4 mr-2" />
              Monitoring
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>Hostname Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="hostname">Base Hostname</Label>
                  <Input
                    id="hostname"
                    placeholder="convexer.example.com"
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                  />
                  <p className="text-sm text-muted-foreground">
                    This hostname will be used as the base for instance subdomains. For example, if set to "convexer.example.com", instances will be accessible as "instance-name.convexer.example.com".
                  </p>
                </div>

                <Button onClick={handleSave} disabled={saving}>
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? 'Saving...' : 'Save Settings'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="monitoring" className="mt-0">
            <div className="space-y-4">
              {/* Umami */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <BarChart2 className="h-5 w-5" />
                      Umami — Analytics
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      {monitoringLoading ? (
                        <Badge variant="secondary">checking...</Badge>
                      ) : monitoringStatus?.umami.running ? (
                        <Badge className="bg-green-600">running</Badge>
                      ) : (
                        <Badge variant="destructive">{monitoringStatus?.umami.status ?? 'not found'}</Badge>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => refetchMonitoring()}>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <a
                      href={monitoringStatus?.umami.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline font-mono text-sm flex items-center gap-1"
                    >
                      {monitoringStatus?.umami.url ?? 'http://umami.<domain>'}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="p-2 bg-muted rounded">
                      <span className="text-muted-foreground">App</span>
                      <div className="font-mono">{monitoringStatus?.umami.status ?? '—'}</div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <span className="text-muted-foreground">Database</span>
                      <div className="font-mono">{monitoringStatus?.umami.db_status ?? '—'}</div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Default login: <span className="font-mono">admin / umami</span> — change immediately after first login.
                    Create one Website per app, use the tracking script or API with the website ID.
                  </p>
                  <MonitoringLogs containers={UMAMI_CONTAINERS} />
                </CardContent>
              </Card>

              {/* GlitchTip */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <Bug className="h-5 w-5" />
                      GlitchTip — Error Tracking
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      {monitoringLoading ? (
                        <Badge variant="secondary">checking...</Badge>
                      ) : monitoringStatus?.glitchtip.running ? (
                        <Badge className="bg-green-600">running</Badge>
                      ) : (
                        <Badge variant="destructive">{monitoringStatus?.glitchtip.status ?? 'not found'}</Badge>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => refetchMonitoring()}>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <a
                      href={monitoringStatus?.glitchtip.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline font-mono text-sm flex items-center gap-1"
                    >
                      {monitoringStatus?.glitchtip.url ?? 'http://glitchtip.<domain>'}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    <div className="p-2 bg-muted rounded">
                      <span className="text-muted-foreground">Web</span>
                      <div className="font-mono">{monitoringStatus?.glitchtip.status ?? '—'}</div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <span className="text-muted-foreground">Worker</span>
                      <div className="font-mono">{monitoringStatus?.glitchtip.worker_status ?? '—'}</div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <span className="text-muted-foreground">Database</span>
                      <div className="font-mono">{monitoringStatus?.glitchtip.db_status ?? '—'}</div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <span className="text-muted-foreground">Redis</span>
                      <div className="font-mono">{monitoringStatus?.glitchtip.redis_status ?? '—'}</div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Sentry-compatible — use any Sentry SDK with DSN from GlitchTip.
                    Create an Organization, then one Project per app to get separate DSNs.
                  </p>
                  <MonitoringLogs containers={GLITCHTIP_CONTAINERS} />
                </CardContent>
              </Card>

              {/* Setup note */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">SDK Integration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <p><span className="font-semibold text-foreground">GlitchTip (React Native / mobile):</span> Install <span className="font-mono">@sentry/react-native</span>, set <span className="font-mono">dsn</span> to your GlitchTip project DSN.</p>
                  <p><span className="font-semibold text-foreground">Umami (web / server):</span> Use the JS snippet or <span className="font-mono">@umami/node</span> with your Website ID for server-side event tracking.</p>
                  <p className="text-xs">Both services are shared across all Convex instances — create separate projects/websites per app for clear separation.</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="server" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>Server Stats</CardTitle>
              </CardHeader>
              <CardContent>
                <ServerStats />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="updates" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>App Updates</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Current Version</div>
                    <div className="text-2xl font-bold">{versionInfo?.current_version || 'Loading...'}</div>
                  </div>
                  {versionInfo?.latest_version && (
                    <div className="text-right">
                      <div className="text-sm font-medium">Latest Version</div>
                      <Badge variant={versionInfo.has_update ? 'default' : 'secondary'}>
                        {versionInfo.latest_version}
                      </Badge>
                    </div>
                  )}
                </div>

                {versionInfo?.has_update && (
                  <div className="p-3 bg-primary/10 border border-primary/20 rounded-md">
                    <div className="text-sm font-medium text-primary">Update Available</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Version {versionInfo.latest_version} is available
                    </div>
                  </div>
                )}

                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    onClick={handleCheckUpdate}
                    disabled={checkingUpdate}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${checkingUpdate ? 'animate-spin' : ''}`} />
                    {checkingUpdate ? 'Checking...' : 'Check for Updates'}
                  </Button>
                  {versionInfo?.has_update && (
                    <Button
                      onClick={handleUpdate}
                      disabled={updating || updateMutation.isPending}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      {updating || updateMutation.isPending ? 'Updating...' : 'Update Now'}
                    </Button>
                  )}
                  {updating && (
                    <Button
                      variant="outline"
                      onClick={() => setShowLogsDialog(true)}
                    >
                      View Logs
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={handleViewSavedLogs}
                  >
                    View Last Update Logs
                  </Button>
                  {rollbackStatus?.available && (
                    <Button
                      variant="destructive"
                      onClick={handleRollback}
                      disabled={rollingBack}
                    >
                      Rollback to Previous Version
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={showLogsDialog} onOpenChange={setShowLogsDialog}>
          <DialogContent className="max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Update Logs</DialogTitle>
            </DialogHeader>
            <div className="bg-black text-green-400 font-mono text-sm p-4 rounded-md overflow-y-auto max-h-[60vh] whitespace-pre-wrap">
              {updateLogs.map((log, idx) => (
                <div key={idx}>{log}</div>
              ))}
              {updating && <div className="animate-pulse">_</div>}
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showSavedLogsDialog} onOpenChange={setShowSavedLogsDialog}>
          <DialogContent className="max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Last Update Logs</DialogTitle>
            </DialogHeader>
            <div className="bg-black text-green-400 font-mono text-sm p-4 rounded-md overflow-y-auto max-h-[60vh] whitespace-pre-wrap">
              {savedLogs || 'No saved logs available.'}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
