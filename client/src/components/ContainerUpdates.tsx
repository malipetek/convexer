import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { RefreshCw, CheckCircle2, AlertCircle, CircleDot, PackageOpen, ArrowUpCircle } from 'lucide-react';

interface ContainerUpdatesProps {
  instanceId: string;
}

export default function ContainerUpdates({ instanceId }: ContainerUpdatesProps) {
  const queryClient = useQueryClient();
  const [targetVersion, setTargetVersion] = useState('latest');
  const [selectedRoles, setSelectedRoles] = useState<string[]>(['backend', 'dashboard', 'betterauth']);

  const { data: updates, isLoading, refetch } = useQuery({
    queryKey: ['container-updates', instanceId, targetVersion],
    queryFn: () => api.getContainerUpdates(instanceId, targetVersion),
    refetchInterval: 30_000,
  });

  const applyMutation = useMutation({
    mutationFn: (roles: string[]) => api.applyContainerUpdates(instanceId, { targetVersion, roles, backup: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['container-updates', instanceId] });
      queryClient.invalidateQueries({ queryKey: ['containers', instanceId] });
      alert('Container updates applied successfully');
    },
    onError: (err: any) => {
      alert(`Failed to apply updates: ${err.message}`);
    },
  });

  const roleLabel: Record<string, string> = {
    backend: 'Backend',
    dashboard: 'Dashboard',
    betterauth: 'Better Auth',
  };

  const getStatusBadge = (container: any) => {
    if (container.broken) {
      return <Badge variant="destructive" className="flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Broken</Badge>;
    }
    if (container.stale) {
      return <Badge variant="secondary" className="flex items-center gap-1"><PackageOpen className="h-3 w-3" /> Stale</Badge>;
    }
    if (!container.running) {
      return <Badge variant="outline" className="flex items-center gap-1"><CircleDot className="h-3 w-3" /> Stopped</Badge>;
    }
    return <Badge variant="default" className="flex items-center gap-1 bg-green-500"><CheckCircle2 className="h-3 w-3" /> Current</Badge>;
  };

  const handleApply = () => {
    if (selectedRoles.length === 0) {
      alert('Please select at least one container to update');
      return;
    }
    if (!confirm(`Update ${selectedRoles.map(r => roleLabel[r]).join(', ')} containers to version "${targetVersion}"?\n\nA backup will be taken automatically before updating.`)) return;
    applyMutation.mutate(selectedRoles);
  };

  const toggleRole = (role: string) => {
    setSelectedRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);
  };

  const staleOrBrokenContainers = updates?.containers.filter(c => c.stale || c.broken) || [];
  const hasUpdates = staleOrBrokenContainers.length > 0 || updates?.has_update;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PackageOpen className="h-5 w-5" />
              Container Updates
            </CardTitle>
            <CardDescription>Check and update container images</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
            Check
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Target Version:</label>
          <select
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
            className="px-3 py-1 text-sm border rounded-md bg-background"
          >
            <option value="latest">latest</option>
          </select>
        </div>

        {updates?.containers && (
          <div className="space-y-3">
            {updates.containers.map((container) => (
              <div key={container.role} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id={`role-${container.role}`}
                    checked={selectedRoles.includes(container.role)}
                    onChange={() => toggleRole(container.role)}
                    className="h-4 w-4"
                  />
                  <label htmlFor={`role-${container.role}`} className="font-medium text-sm cursor-pointer">
                    {roleLabel[container.role]}
                  </label>
                  {getStatusBadge(container)}
                </div>
                <div className="text-xs text-muted-foreground text-right">
                  <div>{container.current_image_id || 'Unknown'}</div>
                  {container.update_available && (
                    <div className="text-blue-500">→ {container.target_image_id}</div>
                  )}
                  {container.restart_count > 0 && (
                    <div className="text-yellow-500">{container.restart_count} restart{container.restart_count !== 1 ? 's' : ''}</div>
                  )}
                  {container.health_status && (
                    <div className={container.health_status === 'healthy' ? 'text-green-500' : 'text-red-500'}>
                      {container.health_status}
                    </div>
                  )}
                  {container.reason && (
                    <div className="text-muted-foreground max-w-[200px] truncate" title={container.reason}>
                      {container.reason}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleApply}
            disabled={applyMutation.isPending || selectedRoles.length === 0}
            size="sm"
          >
            <ArrowUpCircle className="h-4 w-4 mr-2" />
            {applyMutation.isPending ? 'Updating...' : `Update ${selectedRoles.length} container${selectedRoles.length !== 1 ? 's' : ''}`}
          </Button>
          {hasUpdates && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedRoles(staleOrBrokenContainers.map(c => c.role))}
            >
              Select Stale/Broken
            </Button>
          )}
        </div>

        {updates?.backup_ids && updates.backup_ids.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Backup IDs: {updates.backup_ids.join(', ')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
