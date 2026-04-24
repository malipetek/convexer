import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Database, Copy, Search, X } from 'lucide-react';
import { useState } from 'react';

type StatusFilter = 'all' | 'running' | 'stopped' | 'creating' | 'error';

const STATUS_STYLES: Record<string, string> = {
  creating: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  running: 'bg-green-500/10 text-green-500 border-green-500/20',
  stopped: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  error: 'bg-red-500/10 text-red-500 border-red-500/20',
};

export default function Home() {
  const queryClient = useQueryClient();
  const [duplicatingInstance, setDuplicatingInstance] = useState<string | null>(null);
  const [newInstanceName, setNewInstanceName] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data: instances, isLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.getInstances(),
  });

  const duplicateMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.duplicateInstance(id, name),
    onSuccess: () =>
    {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setDuplicatingInstance(null);
      setNewInstanceName('');
      alert('Instance duplicated successfully');
    },
    onError: (err: any) =>
    {
      alert(err.message || 'Failed to duplicate instance');
    },
  });

  const handleDuplicate = (instanceId: string) =>
  {
    if (!newInstanceName.trim()) {
      alert('Please enter a name for the new instance');
      return;
    }
    duplicateMutation.mutate({ id: instanceId, name: newInstanceName });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Database className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-pulse" />
          <p className="text-muted-foreground">Loading instances...</p>
        </div>
      </div>
    );
  }

  if (!instances || instances.length === 0) {
    return (
      <Card className="max-w-md mx-auto mt-20">
        <CardContent className="py-24 text-center">
          <Database className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-xl font-semibold mb-2" data-testid="home-no-instances-title">No instances yet</h3>
          <p className="text-muted-foreground mb-6">Select "New Instance" from the sidebar to create your first Convex instance</p>
        </CardContent>
      </Card>
    );
  }

  const counts = {
    all: instances.length,
    running: instances.filter(i => i.status === 'running').length,
    stopped: instances.filter(i => i.status === 'stopped').length,
    creating: instances.filter(i => i.status === 'creating').length,
    error: instances.filter(i => i.status === 'error').length,
  } satisfies Record<StatusFilter, number>;

  const filtered = instances.filter(i =>
  {
    if (statusFilter !== 'all' && i.status !== statusFilter) return false;
    if (search.trim() && !i.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  const filterChips: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'running', label: 'Running' },
    { value: 'stopped', label: 'Stopped' },
    { value: 'creating', label: 'Creating' },
    { value: 'error', label: 'Error' },
  ];

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Dashboard</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {counts.all} instance{counts.all === 1 ? '' : 's'}
            {counts.running > 0 && <> · <span className="text-green-500">{counts.running} running</span></>}
            {counts.stopped > 0 && <> · <span className="text-muted-foreground">{counts.stopped} stopped</span></>}
            {counts.error > 0 && <> · <span className="text-red-500">{counts.error} error</span></>}
          </p>
        </div>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search instances…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {filterChips.map(chip =>
        {
          const active = statusFilter === chip.value;
          const count = counts[chip.value];
          if (chip.value !== 'all' && count === 0) return null;
          return (
            <Button
              key={chip.value}
              size="sm"
              variant={active ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setStatusFilter(chip.value)}
            >
              {chip.label}
              <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-[10px]">{count}</Badge>
            </Button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            No instances match your filters.
            {(search || statusFilter !== 'all') && (
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter('all'); }}>
                  Clear filters
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map(instance =>
            {
              const isDuplicating = duplicatingInstance === instance.id;
              const statusClass = STATUS_STYLES[instance.status] || STATUS_STYLES.stopped;
              const CardInner = (
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <Database className="h-5 w-5 text-muted-foreground shrink-0" />
                      <h3 className="font-semibold truncate">{instance.name}</h3>
                    </div>
                    <Badge className={`${statusClass} border capitalize shrink-0`}>
                      {instance.status}
                    </Badge>
                  </div>
                  <div className="space-y-1.5 text-sm text-muted-foreground font-mono">
                    <div>Backend: :{instance.backend_port}</div>
                    <div>Dashboard: :{instance.dashboard_port}</div>
                  </div>
                  {isDuplicating && (
                    <div className="mt-4 pt-4 border-t space-y-2" onClick={(e) => e.preventDefault()}>
                      <Input
                        placeholder="New instance name"
                        value={newInstanceName}
                        onChange={(e) => setNewInstanceName(e.target.value)}
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={(e) => { e.preventDefault(); handleDuplicate(instance.id); }}
                          disabled={duplicateMutation.isPending}
                        >
                          {duplicateMutation.isPending ? 'Duplicating...' : 'Confirm'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) =>
                          {
                          e.preventDefault();
                            setDuplicatingInstance(null);
                            setNewInstanceName('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {!isDuplicating && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-4 w-full"
                      onClick={(e) =>
                      {
                      e.preventDefault();
                        setDuplicatingInstance(instance.id);
                        setNewInstanceName(`${instance.name}-copy`);
                      }}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Duplicate
                    </Button>
                  )}
                </CardContent>
              );

              return isDuplicating ? (
                <Card key={instance.id} className="border-primary">
                  {CardInner}
              </Card>
              ) : (
                <Link key={instance.id} to={`/instances/${instance.id}`} className="block">
                  <Card className="hover:border-primary transition-colors h-full">
                    {CardInner}
                  </Card>
                </Link>
              );
            })}
          </div>
      )}
    </div>
  );
}
