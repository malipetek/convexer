import crypto from 'crypto';
import db from './db.js';

export function createSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  const stmt = db.prepare('INSERT INTO sessions (token) VALUES (?)');
  stmt.run(token);
  return token;
}

export function isValidSession(token: string): boolean {
  const stmt = db.prepare('SELECT 1 FROM sessions WHERE token = ?');
  return !!stmt.get(token);
}

export function isAuthEnabled(): boolean {
  return !!process.env.AUTH_PASSWORD;
}
