import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

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
    return <span className="metrics-badge loading">Loading metrics...</span>;
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
    <span className="metrics-badge">
      CPU {stats.cpu_percent.toFixed(1)}% · RAM {stats.memory_mb.toFixed(0)} MB · Disk {formatBytes(stats.volume_size_bytes)}
    </span>
  );
}
