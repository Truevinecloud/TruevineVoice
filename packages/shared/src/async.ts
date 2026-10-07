/**
 * Small async helpers used by infrastructure probes.
 */

/** Converts an unknown thrown value into a short, log-safe string. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Rejects with a timeout error if `promise` does not settle within `timeoutMs`.
 *
 * The timer is always cleared so a resolved race cannot leave a pending timer
 * holding the Node.js event loop open.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Monotonic-ish elapsed time helper that also works on platforms without `performance`. */
export function elapsedMs(startedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.round(now - startedAt));
}
