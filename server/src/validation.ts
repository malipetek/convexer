import { z } from 'zod';
import { AppError } from './http.js';

export const extraEnvSchema = z.record(z.string(), z.string());

export const createInstanceSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  extra_env: extraEnvSchema.optional(),
});

export const updateSettingsSchema = z.object({
  extra_env: extraEnvSchema.nullable().optional(),
});

export const updateHealthCheckSchema = z.object({
  health_check_timeout: z.number().int().min(5000).max(900000),
  postgres_health_check_timeout: z.number().int().min(5000).max(900000),
});

export const postgresQuerySchema = z.object({
  query: z.string().min(1).max(100000),
});

export const updateAppSchema = z.object({
  targetVersion: z.string().min(1).max(128).optional(),
});

export const rollbackSchema = z.object({
  targetJobId: z.string().min(1).optional(),
});

export const saveSettingsSchema = z.object({
  hostname: z.string().trim().max(253),
});

export const repairCleanupSchema = z.object({
  confirm: z.literal('prune-builder-cache'),
});

export function parseOrThrow<T>(schema: z.ZodSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', parsed.error.flatten());
  }
  return parsed.data;
}

export function parseExtraEnv(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const validated = extraEnvSchema.safeParse(parsed);
    if (!validated.success) return {};
    return validated.data;
  } catch {
    return {};
  }
}

export function toExtraEnvJson(extraEnv?: Record<string, string> | null): string | null {
  if (!extraEnv) return null;
  return JSON.stringify(extraEnv);
}
