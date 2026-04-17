import { useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Cpu, MemoryStick, ArrowDownUp, HardDrive } from 'lucide-react';

export interface MetricSample
{
  /** Unix ms */
  t: number;
  cpu: number;
  memMb: number;
  memLimitMb: number;
  /** Cumulative bytes */
  netRx: number;
  netTx: number;
  diskR: number;
  diskW: number;
}

interface ChartRow
{
  t: number;
  label: string;
  cpu: number;
  memMb: number;
  memPct: number;
  netRxKBs: number;
  netTxKBs: number;
  diskRKBs: number;
  diskWKBs: number;
}

const RANGES = [
  { label: '1m', ms: 60 * 1000 },
  { label: '5m', ms: 5 * 60 * 1000 },
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: 'All', ms: Infinity },
] as const;

type RangeLabel = typeof RANGES[number]['label'];

function fmtTime (ms: number): string
{
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtRate (kbs: number): string
{
  if (kbs >= 1024) return `${(kbs / 1024).toFixed(2)} MB/s`;
  if (kbs >= 1) return `${kbs.toFixed(1)} KB/s`;
  return `${(kbs * 1024).toFixed(0)} B/s`;
}

function summarize (rows: ChartRow[], key: keyof ChartRow): { current: number; peak: number; avg: number }
{
  if (rows.length === 0) return { current: 0, peak: 0, avg: 0 };
  let sum = 0;
  let peak = -Infinity;
  for (const r of rows) {
    const v = Number(r[key]) || 0;
    sum += v;
    if (v > peak) peak = v;
  }
  const last = Number(rows[rows.length - 1][key]) || 0;
  return { current: last, peak: Math.max(peak, 0), avg: sum / rows.length };
}

interface Props
{
  samples: MetricSample[];
  isRunning: boolean;
}

export default function InstanceMetrics ({ samples, isRunning }: Props)
{
  const [range, setRange] = useState<RangeLabel>('5m');

  const rows = useMemo<ChartRow[]>(() =>
  {
    if (samples.length < 2) return [];
    const out: ChartRow[] = [];
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      const dtSec = Math.max((cur.t - prev.t) / 1000, 0.001);
      // Rates (counters can reset on container restart — clamp negatives to 0)
      const netRx = Math.max(cur.netRx - prev.netRx, 0) / dtSec / 1024;
      const netTx = Math.max(cur.netTx - prev.netTx, 0) / dtSec / 1024;
      const diskR = Math.max(cur.diskR - prev.diskR, 0) / dtSec / 1024;
      const diskW = Math.max(cur.diskW - prev.diskW, 0) / dtSec / 1024;
      const cpuVal = cur.cpu ?? 0;
      const memMbVal = cur.memMb ?? 0;
      const memLimitVal = cur.memLimitMb ?? 0;
      out.push({
        t: cur.t,
        label: fmtTime(cur.t),
        cpu: +cpuVal.toFixed(2),
        memMb: +memMbVal.toFixed(1),
        memPct: memLimitVal > 0 ? +((memMbVal / memLimitVal) * 100).toFixed(1) : 0,
        netRxKBs: +netRx.toFixed(2),
        netTxKBs: +netTx.toFixed(2),
        diskRKBs: +diskR.toFixed(2),
        diskWKBs: +diskW.toFixed(2),
      });
    }
    return out;
  }, [samples]);

  const windowed = useMemo<ChartRow[]>(() =>
  {
    const rangeMs = RANGES.find(r => r.label === range)!.ms;
    if (!Number.isFinite(rangeMs)) return rows;
    const cutoff = Date.now() - rangeMs;
    return rows.filter(r => r.t >= cutoff);
  }, [rows, range]);

  const cpuLimit = useMemo(() =>
  {
    // Most Convex backend containers are single-core at default; clamp Y to at least 100.
    const max = windowed.reduce((m, r) => Math.max(m, r.cpu), 0);
    return Math.max(100, Math.ceil(max / 50) * 50);
  }, [windowed]);

  const memLimit = samples.length > 0 ? samples[samples.length - 1].memLimitMb : 0;

  const cpuSum = summarize(windowed, 'cpu');
  const memSum = summarize(windowed, 'memMb');
  const netRxSum = summarize(windowed, 'netRxKBs');
  const netTxSum = summarize(windowed, 'netTxKBs');
  const diskRSum = summarize(windowed, 'diskRKBs');
  const diskWSum = summarize(windowed, 'diskWKBs');

  if (!isRunning) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          Instance must be running to view metrics.
        </CardContent>
      </Card>
    );
  }

  if (windowed.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          Collecting metrics&hellip; {samples.length > 0 ? `(${samples.length} samples so far)` : ''}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Range selector */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {windowed.length} sample{windowed.length === 1 ? '' : 's'} over the last {range}
        </div>
        <div className="flex gap-1 rounded-md border bg-background p-1">
          {RANGES.map(r => (
            <Button
              key={r.label}
              size="sm"
              variant={range === r.label ? 'default' : 'ghost'}
              className="h-7 px-3 text-xs"
              onClick={() => setRange(r.label)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MetricPanel
          title="CPU"
          icon={<Cpu className="h-4 w-4" />}
          stats={[
            { label: 'Now', value: `${cpuSum.current.toFixed(1)}%` },
            { label: 'Peak', value: `${cpuSum.peak.toFixed(1)}%` },
            { label: 'Avg', value: `${cpuSum.avg.toFixed(1)}%` },
          ]}
          color="#22c55e"
          yMax={cpuLimit}
          yFormatter={v => `${v}%`}
          tooltipFormatter={v => [`${Number(v).toFixed(2)}%`, 'CPU']}
          data={windowed}
          series={[{ key: 'cpu', name: 'CPU %' }]}
        />

        <MetricPanel
          title="Memory"
          icon={<MemoryStick className="h-4 w-4" />}
          stats={[
            { label: 'Now', value: `${memSum.current.toFixed(0)} MB` },
            { label: 'Peak', value: `${memSum.peak.toFixed(0)} MB` },
            { label: 'Limit', value: memLimit > 0 ? `${memLimit.toFixed(0)} MB` : '—' },
          ]}
          color="#3b82f6"
          yMax={memLimit > 0 ? memLimit : undefined}
          yFormatter={v => `${v}`}
          tooltipFormatter={v => [`${Number(v).toFixed(1)} MB`, 'Memory']}
          referenceY={memLimit > 0 ? memLimit : undefined}
          referenceLabel={memLimit > 0 ? 'Limit' : undefined}
          data={windowed}
          series={[{ key: 'memMb', name: 'Memory (MB)' }]}
        />

        <MetricPanel
          title="Network I/O"
          icon={<ArrowDownUp className="h-4 w-4" />}
          stats={[
            { label: 'RX', value: fmtRate(netRxSum.current) },
            { label: 'TX', value: fmtRate(netTxSum.current) },
            { label: 'Peak', value: fmtRate(Math.max(netRxSum.peak, netTxSum.peak)) },
          ]}
          color="#8b5cf6"
          yFormatter={v => fmtRate(Number(v))}
          tooltipFormatter={(v, name) => [fmtRate(Number(v)), name as string]}
          data={windowed}
          series={[
            { key: 'netRxKBs', name: 'RX', color: '#8b5cf6' },
            { key: 'netTxKBs', name: 'TX', color: '#ec4899' },
          ]}
        />

        <MetricPanel
          title="Disk I/O"
          icon={<HardDrive className="h-4 w-4" />}
          stats={[
            { label: 'Read', value: fmtRate(diskRSum.current) },
            { label: 'Write', value: fmtRate(diskWSum.current) },
            { label: 'Peak', value: fmtRate(Math.max(diskRSum.peak, diskWSum.peak)) },
          ]}
          color="#f59e0b"
          yFormatter={v => fmtRate(Number(v))}
          tooltipFormatter={(v, name) => [fmtRate(Number(v)), name as string]}
          data={windowed}
          series={[
            { key: 'diskRKBs', name: 'Read', color: '#f59e0b' },
            { key: 'diskWKBs', name: 'Write', color: '#ef4444' },
          ]}
        />
      </div>
    </div>
  );
}

interface Series
{
  key: keyof ChartRow;
  name: string;
  color?: string;
}

interface MetricPanelProps
{
  title: string;
  icon: React.ReactNode;
  stats: Array<{ label: string; value: string }>;
  color: string;
  data: ChartRow[];
  series: Series[];
  yMax?: number;
  yFormatter?: (v: number) => string;
  tooltipFormatter?: (value: any, name: any) => [string, string];
  referenceY?: number;
  referenceLabel?: string;
}

function MetricPanel ({
  title,
  icon,
  stats,
  color,
  data,
  series,
  yMax,
  yFormatter,
  tooltipFormatter,
  referenceY,
  referenceLabel,
}: MetricPanelProps)
{
  const gradId = `grad-${title.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          <div className="flex gap-4 text-xs">
            {stats.map(s => (
              <div key={s.label} className="text-right">
                <div className="text-muted-foreground">{s.label}</div>
                <div className="font-mono font-semibold">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-4">
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((s, idx) => (
                <linearGradient key={s.key as string} id={`${gradId}-${idx}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color || color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={s.color || color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              interval="preserveStartEnd"
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              width={50}
              domain={yMax !== undefined ? [0, yMax] : [0, 'auto']}
              tickFormatter={yFormatter}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '0.5rem',
                fontSize: '12px',
              }}
              formatter={tooltipFormatter as any}
              labelFormatter={label => `Time: ${label}`}
            />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: '11px' }} />}
            {referenceY !== undefined && (
              <ReferenceLine
                y={referenceY}
                stroke="hsl(var(--destructive))"
                strokeDasharray="3 3"
                label={{ value: referenceLabel, fontSize: 10, position: 'insideTopRight' }}
              />
            )}
            {series.map((s, idx) => (
              <Area
                key={s.key as string}
                type="monotone"
                dataKey={s.key as string}
                name={s.name}
                stroke={s.color || color}
                strokeWidth={2}
                fill={`url(#${gradId}-${idx})`}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
