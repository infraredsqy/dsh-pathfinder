import { fileURLToPath } from 'node:url';
import { hashDirectory } from './helpers/hash-dir.ts';

/**
 * The global guard for the whole suite: record the hash of the repo root `.pf` before the run,
 * recompute it at teardown and compare. Engine operations belong in temp dirs; whoever lands a
 * change inside the repo root `.pf` fails the whole suite.
 */
export default function globalSetup(): () => void {
  const pfDir = fileURLToPath(new URL('../.pf', import.meta.url));
  const before = hashDirectory(pfDir);
  return () => {
    const after = hashDirectory(pfDir);
    if (after !== before) {
      throw new Error(
        `the repo root .pf hash differs before and after the whole suite: before=${before} after=${after}. ` +
          'Engine operations belong in temp dirs; nothing may land in the repo root .pf.',
      );
    }
  };
}
