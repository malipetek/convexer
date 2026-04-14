import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Card, CardContent } from './ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

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
    <Card className="mt-4">
      <CardContent className="p-0">
        <Tabs value={container} onValueChange={(value) => setContainer(value as 'backend' | 'dashboard')}>
          <TabsList className="w-full rounded-none border-b">
            <TabsTrigger value="backend">Backend</TabsTrigger>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          </TabsList>
          <TabsContent value="backend" className="p-4">
            {error && (
              <div className="text-sm text-destructive mb-2">{(error as Error).message}</div>
            )}
            <pre
              ref={logRef}
              className="text-xs bg-muted p-4 rounded overflow-auto max-h-96 font-mono"
            >
              {data?.logs || 'No logs available'}
            </pre>
          </TabsContent>
          <TabsContent value="dashboard" className="p-4">
            {error && (
              <div className="text-sm text-destructive mb-2">{(error as Error).message}</div>
            )}
            <pre
              ref={logRef}
              className="text-xs bg-muted p-4 rounded overflow-auto max-h-96 font-mono"
            >
              {data?.logs || 'No logs available'}
            </pre>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
