import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Database, Copy } from 'lucide-react';
import { useState } from 'react';

export default function Home() {
  const queryClient = useQueryClient();
  const [duplicatingInstance, setDuplicatingInstance] = useState<string | null>(null);
  const [newInstanceName, setNewInstanceName] = useState('');

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
          <h3 className="text-xl font-semibold mb-2">No instances yet</h3>
          <p className="text-muted-foreground mb-6">Select "New Instance" from the sidebar to create your first Convex instance</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {instances.map(instance => (
          <Card key={instance.id} className="hover:border-primary transition-colors">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <Database className="h-5 w-5 text-muted-foreground" />
                <h3 className="font-semibold">{instance.name}</h3>
              </div>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div>Status: <span className="text-foreground">{instance.status}</span></div>
                <div>Backend: :{instance.backend_port}</div>
                <div>Dashboard: :{instance.dashboard_port}</div>
              </div>
              {duplicatingInstance === instance.id && (
                <div className="mt-4 pt-4 border-t space-y-2">
                  <input
                    type="text"
                    placeholder="New instance name"
                    value={newInstanceName}
                    onChange={(e) => setNewInstanceName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleDuplicate(instance.id)}
                      disabled={duplicateMutation.isPending}
                    >
                      {duplicateMutation.isPending ? 'Duplicating...' : 'Confirm'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                      {
                        setDuplicatingInstance(null);
                        setNewInstanceName('');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {duplicatingInstance !== instance.id && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4 w-full"
                  onClick={() =>
                  {
                    setDuplicatingInstance(instance.id);
                    setNewInstanceName(`${instance.name}-copy`);
                  }}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Duplicate
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
