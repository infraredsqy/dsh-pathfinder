import { unlink } from 'node:fs/promises';

/**
 * Small helpers for disk and waiting: the retry cadence, and telling Node error codes apart.
 *
 * The backoff cadence (removing a file and waiting a while share the same limit and
 * interval): small steps within the limit, past the limit the error is handed out
 * as it is, never silently continued.
 */

/** Base of the retry backoff: after the n-th failure wait `RETRY_BASE_MS * n` milliseconds before trying again. */
export const RETRY_BASE_MS = 50;

/** Total attempts of the same step (the first one included). */
export const RETRY_ATTEMPTS = 4;

/** Wait a while as such (the cadence of backoff retries); it continues by itself when the time is up. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/** The code of a Node disk error (`ENOENT`, `EEXIST`, `EPERM` …); no code means an empty answer. */
export function errorCodeOf(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** This step failed because the target was absent all along (even the enclosing directory is only a plain file). */
export function isMissingPath(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** This step failed because another process is holding the target right now (a brief standoff on Windows). */
export function isBusyPath(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'EPERM' || code === 'EACCES';
}

/** This step failed because the target is already there (an exclusive creation met an existing file). */
export function isExistingPath(error: unknown): boolean {
  return errorCodeOf(error) === 'EEXIST';
}

/**
 * Remove a record file:
 * absent counts as removed already; on a standoff it backs off and retries at the step's
 * own cadence, and if the standoff is still there once the limit is reached the error is
 * handed out as it is.
 *
 * Both spellings of the standoff code are accepted: some runtimes report "another process
 * holds it" as a PermissionError (EPERM/EACCES, the reading `isBusyPath` takes); Node on
 * Windows spells the same share-violation EBUSY — taking only the former would not cover
 * that brief standoff.
 */
export async function unlinkWithRetry(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (isMissingPath(error)) return;
      const busy = isBusyPath(error) || errorCodeOf(error) === 'EBUSY';
      if (!busy || attempt >= RETRY_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
}
