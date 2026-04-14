import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Save, RefreshCw, Download } from 'lucide-react';
import { api } from '../api';

export default function Settings() {
  const queryClient = useQueryClient();
  const [hostname, setHostname] = useState('');
  const [saving, setSaving] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);

  const { data: versionInfo } = useQuery({
    queryKey: ['version'],
    queryFn: () => api.getVersion(),
  });

  const updateMutation = useMutation({
    mutationFn: () => api.updateApp(),
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['version'] });
      alert('Update successful! The app will reload.');
      setTimeout(() => window.location.reload(), 2000);
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Update failed');
    },
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      // TODO: Add API call to save global settings
      alert('Settings saved');
    } catch (err: any) {
      alert(err.message || 'Failed to save settings');
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

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold mb-6">Global Settings</h1>
        
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

            <div className="flex gap-2">
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
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
