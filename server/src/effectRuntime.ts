import { Effect, Schedule } from 'effect';
import { AppError, asError } from './http.js';

export type AppEffect<A> = Effect.Effect<A, AppError, never>;

export const transientRetrySchedule = Schedule.exponential('250 millis').pipe(
  Schedule.compose(Schedule.recurs(3)),
  Schedule.jittered
);

export function tryPromiseApp<A> (options: {
  try: () => Promise<A>;
  code: string;
  status?: number;
  message?: string;
}): AppEffect<A>
{
  return Effect.tryPromise({
    try: options.try,
    catch: (error) => {
      const appError = asError(error);
      return new AppError(
        options.status ?? appError.status,
        options.code,
        options.message ?? appError.message,
        appError.details
      );
    },
  });
}

export function withTransientRetry<A> (effect: AppEffect<A>): AppEffect<A>
{
  return effect.pipe(Effect.retry(transientRetrySchedule));
}

export async function runAppEffect<A> (effect: AppEffect<A>): Promise<A>
{
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    throw asError(error);
  }
}
