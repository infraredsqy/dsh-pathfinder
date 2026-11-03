import type { Executor } from './executor';
import { createConfigNamespace } from './config';
import type { ConfigNamespace } from './config';
import { createConductorNamespace } from './conductor';
import type { ConductorNamespace } from './conductor';
import { createLedgerNamespace } from './ledger';
import type { LedgerNamespace } from './ledger';
import { createSessionsNamespace } from './sessions';
import type { SessionsNamespace } from './sessions';

/** The options of open; executor is the only injection point for the executor. */
export interface PfOpenOptions {
  /** The executor is handed in from outside; without one, actions that need an executor stay unavailable. */
  readonly executor?: Executor;
}

/** The pf handle: the project root plus four namespaces. */
export interface Pf {
  /** The project root, the spelling open received is kept as it is (open itself does not touch disk). */
  readonly root: string;
  readonly ledger: LedgerNamespace;
  readonly conductor: ConductorNamespace;
  readonly config: ConfigNamespace;
  readonly sessions: SessionsNamespace;
}

const executors = new WeakMap<Pf, Executor | undefined>();

/** Read the executor injected into a handle (an in-package seam, not on the frozen surface). */
export function executorOf(pf: Pf): Executor | undefined {
  return executors.get(pf);
}

/** Open the pf handle of a project. */
export function open(root: string, options: PfOpenOptions = {}): Pf {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('open(root, ...) needs a non-empty project root path');
  }
  const pf: Pf = {
    root,
    ledger: createLedgerNamespace(root),
    conductor: createConductorNamespace(root, options.executor),
    config: createConfigNamespace(root),
    sessions: createSessionsNamespace(root),
  };
  executors.set(pf, options.executor);
  return pf;
}
