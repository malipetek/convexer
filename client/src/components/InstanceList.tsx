import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import InstanceCard from './InstanceCard';
import { Card, CardContent } from './ui/card';
import { Database, Plus } from 'lucide-react';
import { Button } from './ui/button';

export default function InstanceList() {
  const { data: instances, isLoading, error } = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.getInstances(),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center">
          <Database className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-pulse" />
          <p className="text-muted-foreground">Loading instances...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="py-12 text-center">
          <p className="text-destructive">Error loading instances</p>
        </CardContent>
      </Card>
    );
  }

  if (!instances || instances.length === 0) {
    return (
      <Card>
        <CardContent className="py-24 text-center">
          <Database className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-xl font-semibold mb-2">No instances yet</h3>
          <p className="text-muted-foreground mb-6">Create your first Convex instance to get started</p>
          <Button onClick={() => window.dispatchEvent(new CustomEvent('open-create-dialog'))}>
            <Plus className="h-4 w-4 mr-2" />
            Create Instance
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {instances.map(instance => (
        <InstanceCard key={instance.id} instance={instance} />
      ))}
    </div>
  );
}
