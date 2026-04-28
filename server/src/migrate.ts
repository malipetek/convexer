import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

export function runMigrations() {
  const dbPath = path.join(process.env.DATA_DIR || process.cwd(), 'convexer.db');
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.join(dirname, 'drizzle');
  if (!fs.existsSync(migrationsFolder)) {
    sqlite.close();
    return;
  }

  const files = fs.readdirSync(migrationsFolder)
    .filter(file => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsFolder, file), 'utf8');
    if (sql.trim()) {
      sqlite.exec(sql);
    }
  }
  sqlite.close();
}
