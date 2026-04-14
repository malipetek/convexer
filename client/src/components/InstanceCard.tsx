import { Instance } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Link } from 'react-router-dom';

export default function InstanceCard({ instance }: { instance: Instance }) {
  const statusColors = {
    creating: 'bg-blue-500/10 text-blue-500',
    running: 'bg-green-500/10 text-green-500',
    stopped: 'bg-gray-500/10 text-gray-500',
    error: 'bg-red-500/10 text-red-500',
  };

  return (
    <Link to={`/instances/${instance.id}`}>
      <Card className="hover:border-primary transition-colors cursor-pointer">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{instance.name}</CardTitle>
            <Badge className={statusColors[instance.status as keyof typeof statusColors]}>
              {instance.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div>Backend: :{instance.backend_port}</div>
            <div>Dashboard: :{instance.dashboard_port}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
