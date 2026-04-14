import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export default function CreateDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [retentionDelay, setRetentionDelay] = useState('');
  const [maxConcurrentMutations, setMaxConcurrentMutations] = useState('');
  const [maxConcurrentQueries, setMaxConcurrentQueries] = useState('');
  const [rustLog, setRustLog] = useState('info');
  const [subdomain, setSubdomain] = useState('');
  const [dashboardSubdomain, setDashboardSubdomain] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
    {
      const extraEnv: Record<string, string> = {};
      if (retentionDelay) extraEnv.DOCUMENT_RETENTION_DELAY = retentionDelay;
      if (maxConcurrentMutations) extraEnv.APPLICATION_MAX_CONCURRENT_MUTATIONS = maxConcurrentMutations;
      if (maxConcurrentQueries) extraEnv.APPLICATION_MAX_CONCURRENT_QUERIES = maxConcurrentQueries;
      if (rustLog !== 'info') extraEnv.RUST_LOG = rustLog;
      if (subdomain) extraEnv.SUBDOMAIN = subdomain;
      if (dashboardSubdomain) extraEnv.DASHBOARD_SUBDOMAIN = dashboardSubdomain;
      return api.createInstance(name || undefined, Object.keys(extraEnv).length > 0 ? extraEnv : undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Instance</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Instance Name (optional)</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-project"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              autoFocus
            />
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full"
          >
            {showAdvanced ? '− Hide Advanced Settings' : '+ Show Advanced Settings'}
          </Button>

          {showAdvanced && (
            <div className="space-y-4 p-4 bg-muted rounded-md">
              <h4 className="font-semibold">Advanced Settings</h4>

              <div className="space-y-2">
                <Label htmlFor="retention">Document Retention Delay (seconds)</Label>
                <Input
                  id="retention"
                  type="number"
                  value={retentionDelay}
                  onChange={e => setRetentionDelay(e.target.value)}
                  placeholder="172800 (2 days)"
                />
                <p className="text-sm text-muted-foreground">
                  How long soft-deleted documents are kept before permanent removal
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mutations">Max Concurrent Mutations</Label>
                <Input
                  id="mutations"
                  type="number"
                  value={maxConcurrentMutations}
                  onChange={e => setMaxConcurrentMutations(e.target.value)}
                  placeholder="16"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="queries">Max Concurrent Queries</Label>
                <Input
                  id="queries"
                  type="number"
                  value={maxConcurrentQueries}
                  onChange={e => setMaxConcurrentQueries(e.target.value)}
                  placeholder="16"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="logLevel">Log Level (RUST_LOG)</Label>
                <Select value={rustLog} onValueChange={setRustLog}>
                  <SelectTrigger id="logLevel">
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

              <div className="space-y-2">
                <Label htmlFor="subdomain">Instance Subdomain (optional)</Label>
                <Input
                  id="subdomain"
                  value={subdomain}
                  onChange={e => setSubdomain(e.target.value)}
                  placeholder="swift-bear-123"
                />
                <p className="text-sm text-muted-foreground">
                  Leave empty to auto-generate a random subdomain
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dashboardSubdomain">Dashboard Subdomain (optional)</Label>
                <Input
                  id="dashboardSubdomain"
                  value={dashboardSubdomain}
                  onChange={e => setDashboardSubdomain(e.target.value)}
                  placeholder="calm-cat-456"
                />
                <p className="text-sm text-muted-foreground">
                  Leave empty to auto-generate a random subdomain for the dashboard
                </p>
              </div>
            </div>
          )}

          {mutation.error && (
            <div className="text-sm text-destructive">{(mutation.error as Error).message}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
