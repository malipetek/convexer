import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Card, CardContent } from '../components/ui/card';
import { Database } from 'lucide-react';

export default function Home() {
  const { data: instances, isLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.getInstances(),
  });

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
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
