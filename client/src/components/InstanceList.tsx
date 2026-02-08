import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import InstanceCard from './InstanceCard';

export default function InstanceList() {
  const { data: instances, isLoading, error } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  if (isLoading) return <div className="loading">Loading instances...</div>;
  if (error) return <div className="error">Failed to load instances: {(error as Error).message}</div>;
  if (!instances?.length) return <div className="empty">No instances yet. Create one to get started.</div>;

  return (
    <div className="instance-list">
      {instances.map(instance => (
        <InstanceCard key={instance.id} instance={instance} />
      ))}
    </div>
  );
}
