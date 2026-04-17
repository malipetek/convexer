import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge } from './ui/badge';
import { Cpu, HardDrive, MemoryStick } from 'lucide-react';

interface MetricsBadgeProps {
  instanceId: string;
}

export default function MetricsBadge({ instanceId }: MetricsBadgeProps) {
  const { data: stats, isLoading, error } = useQuery({
    queryKey: ['stats', instanceId],
    queryFn: () => api.getStats(instanceId),
    refetchInterval: 10000,
    enabled: true,
  });

  if (isLoading) {
    return <Badge variant="outline" className="text-xs">Loading...</Badge>;
  }

  if (error || !stats) {
    return null;
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1">
        <Cpu className="h-3 w-3" />
        <span>{(stats.cpu_percent ?? 0).toFixed(1)}%</span>
      </div>
      <div className="flex items-center gap-1">
        <MemoryStick className="h-3 w-3" />
        <span>{(stats.memory_mb ?? 0).toFixed(0)} MB</span>
      </div>
      <div className="flex items-center gap-1">
        <HardDrive className="h-3 w-3" />
        <span>{formatBytes(stats.volume_size_bytes)}</span>
      </div>
    </div>
  );
}
