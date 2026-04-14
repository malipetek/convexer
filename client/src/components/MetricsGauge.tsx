import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

interface MetricsGaugeProps {
  value: number;
  max: number;
  label: string;
  color: string;
}

export default function MetricsGauge({ value, max, label, color }: MetricsGaugeProps) {
  const percentage = Math.min((value / max) * 100, 100);
  const data = [
    { name: 'used', value: percentage },
    { name: 'remaining', value: 100 - percentage },
  ];

  const COLORS = [color, '#e5e7eb'];

  return (
    <div className="text-center">
      <div className="relative h-32">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="70%"
              startAngle={180}
              endAngle={0}
              innerRadius={40}
              outerRadius={60}
              paddingAngle={0}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center">
          <span className="text-2xl font-bold">{percentage.toFixed(0)}%</span>
        </div>
      </div>
      <div className="text-sm text-muted-foreground mt-2">{label}</div>
    </div>
  );
}
