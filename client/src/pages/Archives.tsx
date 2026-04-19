import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ArchivedInstance } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Archive, Database, Trash2, CheckCircle, XCircle, HardDrive } from 'lucide-react';
import { useState } from 'react';

function formatBytes(bytes: number | null) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function BackupRow({ b }: { b: ArchivedInstance['backup_history'][0] }) {
  const ok = b.status === 'completed';
  return (
    <div className="flex items-center gap-3 text-sm py-1.5 border-b last:border-0">
      {ok
        ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
        : <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />}
      <span className="capitalize text-muted-foreground w-16 shrink-0">{b.backup_type}</span>
      <span className="text-muted-foreground">{b.label ?? 'Manual'}</span>
      <span className="ml-auto font-mono text-xs text-muted-foreground">{formatBytes(b.size_bytes)}</span>
    </div>
  );
}

export default function Archives() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data: archived, isLoading } = useQuery({
    queryKey: ['archived-instances'],
    queryFn: () => api.getArchivedInstances(),
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (id: string) => api.permanentlyDeleteInstance(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archived-instances'] });
      setConfirming(null);
    },
    onError: (err: any) => alert(err.message || 'Failed to delete'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Archive className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-pulse" />
          <p className="text-muted-foreground">Loading archives...</p>
        </div>
      </div>
    );
  }

  if (!archived || archived.length === 0) {
    return (
      <div className="p-8">
        <h2 className="text-2xl font-bold mb-1">Archives</h2>
        <p className="text-sm text-muted-foreground mb-8">Deleted instances are kept here with their backups until permanently removed.</p>
        <Card className="max-w-md mx-auto">
          <CardContent className="py-20 text-center">
            <Archive className="h-14 w-14 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No archived instances</h3>
            <p className="text-muted-foreground text-sm">When you delete an instance, it will appear here with its pre-deletion backups.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold mb-1">Archives</h2>
      <p className="text-sm text-muted-foreground mb-8">
        {archived.length} archived instance{archived.length === 1 ? '' : 's'} · Deleted instances with pre-deletion backups. Permanently delete to free disk space.
      </p>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {archived.map((instance: ArchivedInstance) => {
          const isConfirming = confirming === instance.id;
          const hasBackups = instance.backup_history.length > 0;
          const allSuccess = hasBackups && instance.backup_history.every(b => b.status === 'completed');
          const anyFailed = instance.backup_history.some(b => b.status === 'failed');

          return (
            <Card key={instance.id} className={isConfirming ? 'border-destructive' : ''}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Database className="h-4 w-4 text-muted-foreground shrink-0" />
                    <CardTitle className="text-base truncate">{instance.name}</CardTitle>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs text-muted-foreground">archived</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Archived {formatDate(instance.archived_at)}
                </p>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="bg-muted/40 rounded-md px-3 py-2">
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
                    <HardDrive className="h-3.5 w-3.5" />
                    Backups
                    {allSuccess && <CheckCircle className="h-3 w-3 text-green-500 ml-auto" />}
                    {anyFailed && <XCircle className="h-3 w-3 text-red-400 ml-auto" />}
                  </div>
                  {hasBackups ? (
                    instance.backup_history.map(b => <BackupRow key={b.id} b={b} />)
                  ) : (
                    <p className="text-xs text-muted-foreground italic">No backups recorded</p>
                  )}
                </div>

                {isConfirming ? (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive font-medium">
                      This will permanently delete all backup files. This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1"
                        disabled={permanentDeleteMutation.isPending}
                        onClick={() => permanentDeleteMutation.mutate(instance.id)}
                      >
                        {permanentDeleteMutation.isPending ? 'Deleting…' : 'Confirm Delete'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirming(instance.id)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Permanently Delete
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
