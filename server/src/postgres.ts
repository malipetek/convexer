import pg from 'pg';
import Docker from 'dockerode';
import { Instance } from './types.js';

const { Client } = pg;

export async function getPostgresConnection(instance: Instance): Promise<pg.Client> {
  const client = new Client({
    host: `convexer-postgres-${instance.name}`,
    port: 5432,
    user: 'postgres',
    password: instance.postgres_password,
    database: instance.instance_name.replace(/-/g, '_'),
  });
  await client.connect();
  return client;
}

export async function listTables(instance: Instance): Promise<string[]> {
  const client = await getPostgresConnection(instance);
  try {
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    return result.rows.map((row: any) => row.table_name);
  } finally {
    await client.end();
  }
}

export async function getTableSchema(instance: Instance, tableName: string): Promise<any[]> {
  const client = await getPostgresConnection(instance);
  try {
    const result = await client.query(`
      SELECT 
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function executeQuery(instance: Instance, query: string): Promise<any[]> {
  const client = await getPostgresConnection(instance);
  try {
    const result = await client.query(query);
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function createBackup(instance: Instance): Promise<string> {
  const docker = new Docker();
  const container = docker.getContainer(`convexer-postgres-${instance.name}`);
  
  const exec = await container.exec({
    Cmd: ['pg_dump', '-U', 'postgres', instance.instance_name.replace(/-/g, '_')],
    AttachStdout: true,
    AttachStderr: true,
  });
  
  const stream = await exec.start({ Detach: false, Tty: false });
  const chunks: Buffer[] = [];
  
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

export async function restoreBackup(instance: Instance, sql: string): Promise<void> {
  const docker = new Docker();
  const container = docker.getContainer(`convexer-postgres-${instance.name}`);
  
  const exec = await container.exec({
    Cmd: ['psql', '-U', 'postgres', '-d', instance.instance_name.replace(/-/g, '_')],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  
  const stream = await exec.start({ Detach: false, Tty: false, stdin: true });
  await stream.write(Buffer.from(sql));
  await stream.end();
}

export async function exportTable(instance: Instance, tableName: string): Promise<string> {
  const client = await getPostgresConnection(instance);
  try {
    const result = await client.query(`SELECT * FROM ${tableName}`);
    
    const headers = Object.keys(result.rows[0] || {});
    const csvRows = [headers.join(',')];
    
    for (const row of result.rows) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === null) return '';
        if (typeof val === 'string') return `"${val.replace(/"/g, '""')}"`;
        return String(val);
      });
      csvRows.push(values.join(','));
    }
    
    return csvRows.join('\n');
  } finally {
    await client.end();
  }
}

export async function importTable(instance: Instance, tableName: string, csv: string): Promise<number> {
  const client = await getPostgresConnection(instance);
  try {
    const lines = csv.trim().split('\n');
    const headers = lines[0].split(',');
    let inserted = 0;
    
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      const columns = headers.map(h => h.trim());
      const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
      
      const parsedValues = values.map(v => {
        if (v === '') return null;
        if (v.startsWith('"') && v.endsWith('"')) {
          return v.slice(1, -1).replace(/""/g, '"');
        }
        return v;
      });
      
      await client.query(
        `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
        parsedValues
      );
      inserted++;
    }
    
    return inserted;
  } finally {
    await client.end();
  }
}

export async function listExtensions(instance: Instance): Promise<any[]> {
  const client = await getPostgresConnection(instance);
  try {
    const result = await client.query(`
      SELECT 
        extname as name,
        extversion as version,
        n.nspname as schema
      FROM pg_extension e
      JOIN pg_namespace n ON e.extnamespace = n.oid
      ORDER BY extname
    `);
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function loadExtension(instance: Instance, extensionName: string): Promise<void> {
  const client = await getPostgresConnection(instance);
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "${extensionName}"`);
  } finally {
    await client.end();
  }
}
