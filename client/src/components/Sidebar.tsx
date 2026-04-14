import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Link, useLocation } from 'react-router-dom';
import { Card } from './ui/card';
import { Database, Plus, Settings as SettingsIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

interface SidebarProps {
  onCreate?: () => void;
}

export default function Sidebar({ onCreate }: SidebarProps) {
  const location = useLocation();
  const { data: instances, isLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.getInstances(),
  });

  const isActive = (path: string) => location.pathname === path;

  return (
    <aside className="w-64 border-r bg-card h-screen flex flex-col">
      <div className="p-4 border-b">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 bg-primary rounded-lg">
            <Database className="h-5 w-5 text-primary-foreground" />
          </div>
          <h1 className="text-xl font-bold">Convexer</h1>
        </div>
        <Button className="w-full" size="sm" onClick={onCreate}>
          <Plus className="h-4 w-4 mr-2" />
          New Instance
        </Button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4">
        <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Instances</h2>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <nav className="space-y-1">
            {instances?.map(instance => (
              <Link
                key={instance.id}
                to={`/instances/${instance.id}`}
                className={`flex items-center justify-between p-2 rounded-lg transition-colors ${
                  isActive(`/instances/${instance.id}`)
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Database className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{instance.name}</span>
                </div>
                <Badge
                  variant={isActive(`/instances/${instance.id}`) ? 'secondary' : 'outline'}
                  className="text-xs flex-shrink-0"
                >
                  {instance.status}
                </Badge>
              </Link>
            ))}
            {instances?.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                No instances
              </div>
            )}
          </nav>
        )}
      </div>

      <div className="p-4 border-t">
        <Link
          to="/settings"
          className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${
            isActive('/settings')
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-muted'
          }`}
        >
          <SettingsIcon className="h-4 w-4" />
          <span>Settings</span>
        </Link>
      </div>
    </aside>
  );
}
