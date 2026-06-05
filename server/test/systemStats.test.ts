import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPrimaryDiskUsage,
  parseDfOutput,
  parseDockerSystemDf,
} from '../src/systemStats.js';

test('parseDockerSystemDf reports the SIZE column as the displayed size', () =>
{
  const parsed = parseDockerSystemDf(`TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          28        16        14.5GB    6.442GB (44%)
Containers      33        16        12.27MB   11.5MB (93%)
Local Volumes   39        10        13.88GB   5.384MB (0%)
Build Cache     619       6         44.26GB   44GB
`);

  assert.equal(parsed.build_cache.total, '619');
  assert.equal(parsed.build_cache.active, '6');
  assert.equal(parsed.build_cache.size, '44.26GB');
  assert.equal(parsed.build_cache.total_size, '44.26GB');
  assert.equal(parsed.build_cache.reclaimable, '44GB');
});

test('getPrimaryDiskUsage prefers the host data mount over the container overlay', () =>
{
  const disks = parseDfOutput(`Filesystem     1B-blocks        Used   Available Use% Mounted on
overlay      80358158336 35533434880 41443876864  47% /
/dev/sda1    80358158336 35533434880 41443876864  47% /app/server/data
tmpfs            67108864           0    67108864   0% /dev
`);

  const primary = getPrimaryDiskUsage(disks, ['/app/server/data']);

  assert.equal(primary?.filesystem, '/dev/sda1');
  assert.equal(primary?.mountpoint, '/app/server/data');
  assert.equal(primary?.usage_percent, '47%');
});
