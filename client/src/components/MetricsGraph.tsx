import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface MetricsGraphProps {
  data: Array<{ time: string; cpu: number; memory: number }>;
}

export default function MetricsGraph({ data }: MetricsGraphProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis 
          dataKey="time" 
          className="text-xs text-muted-foreground"
          tick={{ fontSize: 12 }}
        />
        <YAxis 
          className="text-xs text-muted-foreground"
          tick={{ fontSize: 12 }}
        />
        <Tooltip 
          contentStyle={{ 
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '0.5rem',
          }}
        />
        <Legend />
        <Line 
          type="monotone" 
          dataKey="cpu" 
          stroke="hsl(var(--primary))" 
          strokeWidth={2}
          name="CPU %"
          dot={false}
        />
        <Line 
          type="monotone" 
          dataKey="memory" 
          stroke="hsl(var(--secondary))" 
          strokeWidth={2}
          name="Memory MB"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
