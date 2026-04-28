import { Response } from 'express';

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ data });
}

export function legacyOk<T>(res: Response, data: T, status = 200) {
  res.status(status).json(data);
}

export function err(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

export function asError(error: unknown) {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(500, 'INTERNAL_ERROR', error.message);
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Unknown error');
}
