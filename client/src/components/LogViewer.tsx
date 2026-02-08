import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export default function LogViewer({ instanceId }: { instanceId: string }) {
  const [container, setContainer] = useState<'backend' | 'dashboard'>('backend');
  const logRef = useRef<HTMLPreElement>(null);

  const { data, error } = useQuery({
    queryKey: ['logs', instanceId, container],
    queryFn: () => api.getLogs(instanceId, container),
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div className="log-viewer">
      <div className="log-tabs">
        <button
          className={`btn btn-small ${container === 'backend' ? 'active' : ''}`}
          onClick={() => setContainer('backend')}
        >
          Backend
        </button>
        <button
          className={`btn btn-small ${container === 'dashboard' ? 'active' : ''}`}
          onClick={() => setContainer('dashboard')}
        >
          Dashboard
        </button>
      </div>
      {error && <div className="error-message">{(error as Error).message}</div>}
      <pre ref={logRef} className="log-content">
        {data?.logs || 'No logs available'}
      </pre>
    </div>
  );
}
