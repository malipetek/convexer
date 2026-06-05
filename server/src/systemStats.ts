export interface DiskUsageEntry
{
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usage_percent: string;
  mountpoint: string;
}

export interface DockerDiskUsageEntry
{
  total: string;
  active: string;
  size: string;
  total_size: string;
  reclaimable: string;
}

export type DockerDiskUsage = Record<string, DockerDiskUsageEntry>;

const DOCKER_SYSTEM_DF_TYPES = ['Images', 'Containers', 'Local Volumes', 'Build Cache'];

export function parseDfOutput (stdout: string): DiskUsageEntry[]
{
  return stdout
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line =>
    {
      const parts = line.split(/\s+/);
      if (parts.length < 6 || parts[0].startsWith('/dev/loop')) return [];

      return [{
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        usage_percent: parts[4],
        mountpoint: parts.slice(5).join(' '),
      }];
    });
}

export function getPrimaryDiskUsage (entries: DiskUsageEntry[], preferredMounts: string[]): DiskUsageEntry | undefined
{
  for (const mountpoint of preferredMounts) {
    const entry = entries.find(disk => disk.mountpoint === mountpoint);
    if (entry) return entry;
  }

  return entries.find(disk => disk.mountpoint === '/')
    || entries.find(disk => !disk.filesystem.startsWith('tmpfs'))
    || entries[0];
}

export function getDisplayDiskUsage (entries: DiskUsageEntry[], primary?: DiskUsageEntry): DiskUsageEntry[]
{
  if (!primary) return entries;

  const seen = new Set([diskIdentity(primary)]);
  const secondary = entries
    .filter(entry => !entry.filesystem.startsWith('tmpfs'))
    .filter(entry =>
    {
      const identity = diskIdentity(entry);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });

  return [primary, ...secondary];
}

export function parseDockerSystemDf (stdout: string): DockerDiskUsage
{
  const usage: DockerDiskUsage = {};

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('TYPE')) continue;

    const type = DOCKER_SYSTEM_DF_TYPES.find(candidate => line.startsWith(candidate));
    if (!type) continue;

    const rest = line.slice(type.length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 4) continue;

    const [total, active, size, ...reclaimableParts] = parts;
    usage[type.toLowerCase().replace(/\s+/g, '_')] = {
      total,
      active,
      size,
      total_size: size,
      reclaimable: reclaimableParts.join(' '),
    };
  }

  return usage;
}

function diskIdentity (entry: DiskUsageEntry): string
{
  return [entry.size, entry.used, entry.available, entry.usage_percent].join('|');
}
