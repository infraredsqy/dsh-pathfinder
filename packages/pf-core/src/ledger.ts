import { createCyclesNamespace } from './cycles';
import { createDagNamespace } from './dag';
import { createInstructionsNamespace } from './instruct';
import { initLedger, registerLedger } from './initledger';
import type { InitReport, LedgerInitOptions, LedgerRegisterOptions } from './initledger';
import type {
  CycleRecord,
  CycleStatus,
  InstructionRecord,
  InstructionScope,
  InstructionTarget,
  MicroTimestamp,
  NodeMode,
  NodeRecord,
  NodeResult,
  NodeStatus,
  NodeWeight,
} from './types';

// ── dag: the graph ───────────────────────────────────────────────────────────

/** What registering a node takes: the title is required, the rest has defaults. */
export interface DagAddInput {
  title: string;
  description?: string;
  mode?: NodeMode;
  tags?: string[];
  weight?: NodeWeight;
  /** Dependencies declared right at node creation (node ids). */
  depends_on?: string[];
}

/** Change one node: whichever key is given is the key that changes. */
export interface DagUpdateInput {
  title?: string;
  description?: string;
  mode?: NodeMode;
  /** Replace with a new set of tags; null takes them all off (back to visible to every filter set). */
  tags?: string[] | null;
  /** Writing standard takes the weight key off (a missing key means standard). */
  weight?: NodeWeight;
}

/** The choices when removing a node. */
export interface DagRemoveOptions {
  /** Force the removal even when other nodes depend on it (the dependency edges are torn down with it). */
  force?: boolean;
}

/** The filter of list: by status, by readiness, by tag range, and a limit. */
export interface DagListFilter {
  status?: NodeStatus[];
  /** Ready ones only (the node itself is todo and every dependency is completed). */
  ready?: boolean;
  /** The filter range: in range means hitting at least one tag, or neither side having tags. */
  tags?: string[];
  limit?: number;
}

/** The choices of search. */
export interface DagSearchOptions {
  /** Search only nodes that are not finished. */
  activeOnly?: boolean;
  limit?: number;
}

/** A list row: the skeleton fields are all there; scores are given only on runnable nodes, blocked and completed ones have none. */
export interface NodeSummary {
  id: string;
  title: string;
  status: NodeStatus;
  mode: NodeMode;
  /** The node itself is todo and every dependency is completed. */
  ready: boolean;
  tags?: string[];
  weight?: NodeWeight;
  urgency_level?: number;
  importance_score?: number;
}

/** One upstream / downstream entry of context: depth starts at 1. */
export interface NodeContextEntry {
  id: string;
  title: string;
  status: string;
  depth: number;
}

/** The transitive closure of one node's upstream and downstream. */
export interface NodeContext {
  id: string;
  title: string;
  status: NodeStatus;
  upstream: NodeContextEntry[];
  downstream: NodeContextEntry[];
}

/** One row a search hit. */
export interface DagSearchHit {
  id: string;
  title: string;
  status: NodeStatus;
  ready: boolean;
  /** The full text when the title matched; when only the description matched, the full text or an excerpt depending on the number of hits. */
  description?: string;
}

/** The report of validate: cycles, dangling references, duplicate edges and isolated nodes. */
export interface DagValidationReport {
  ok: boolean;
  total: number;
  status_counts: Record<string, number>;
  /** One line per problem (cycle paths, dangling references, duplicate edges). */
  problems: string[];
  /** The isolated nodes found (ids of nodes with no `dependencies` and no dependents, in on-disk order).
   *  Isolated nodes are only named, not marked red: the verdict of `ok` still covers only cycles / dangling / duplicate edges. */
  isolated?: string[];
}

/** A registered node: the on-disk record plus an `id`. The on-disk record does not carry its own id (it
 *  is the key of the ideas.json node table), but add is the only verb where the engine generates an id,
 *  and without handing it back the caller cannot reach any following verb. */
export type AddedNode = NodeRecord & { id: string };

/** The graph namespace: reading and writing nodes and edges, these fourteen verbs. */
export interface DagNamespace {
  add(input: DagAddInput): Promise<AddedNode>;
  remove(id: string, options?: DagRemoveOptions): Promise<void>;
  update(id: string, patch: DagUpdateInput): Promise<NodeRecord>;
  /** Add one dependency edge (id depends on dependsOn); it checks for cycles itself and refuses on one. */
  link(id: string, dependsOn: string): Promise<void>;
  /** Take one dependency edge off. */
  unlink(id: string, dependency: string): Promise<void>;
  /** Change the status; landing completed writes completed_at, leaving completed takes it off. */
  setStatus(id: string, status: NodeStatus): Promise<NodeRecord>;
  /** Record a person's approval of this delivery; the timestamp defaults to now and only counts after the completion timestamp. */
  approve(id: string, at?: MicroTimestamp): Promise<NodeRecord>;
  /** Put a shelved node back to todo. */
  revive(id: string): Promise<NodeRecord>;
  /** Read one node's record; null when it is not on the graph. */
  get(id: string): Promise<NodeRecord | null>;
  /** Read the transitive closure of one node's upstream and downstream. */
  context(id: string): Promise<NodeContext>;
  /** Search titles and descriptions by regex; title hits come first. */
  search(query: string, options?: DagSearchOptions): Promise<DagSearchHit[]>;
  list(filter?: DagListFilter): Promise<NodeSummary[]>;
  /** The location path of one node's spec.md. */
  specPath(id: string): Promise<string>;
  /** Validate the whole graph: cycles, dangling references, duplicate edges and isolated nodes (isolated ones are only named, not marked red). */
  validate(): Promise<DagValidationReport>;
}

// ── cycles: lines ────────────────────────────────────────────────────────────

/** Set up a line: the id and the picking range are required. */
export interface CycleCreateInput {
  id: string;
  title?: string;
  /** The filter range this line picks nodes by. */
  tags: string[];
  /** Force another one even when another line is already running. */
  force?: boolean;
}

/** Set up a line and pin the node that opens it: parallel lands in this line's policy-layer parallel slot. */
export interface CycleStartInput extends CycleCreateInput {
  /** How many nodes this line claims at once; 1 by default. */
  parallel?: number;
}

/** One policy value: word / integer / number / switch; null takes this entry off and drops back to the next layer. */
export type CyclePolicyValue = string | number | boolean | null;

/** The effective policy set of one line (the current values, as read). */
export type CyclePolicySet = Record<string, string | number | boolean>;

/** Settle one step of a line: hand back the verdict and the line records this step in path. */
export interface CycleCloseInput {
  node: string;
  result: NodeResult;
  summary?: string;
  outputs?: Record<string, unknown>;
}

/** The cycles namespace: setting up, running, stopping and settling one work line, these eleven verbs. */
export interface CyclesNamespace {
  create(input: CycleCreateInput): Promise<CycleRecord>;
  start(input: CycleStartInput): Promise<CycleRecord>;
  rename(id: string, title: string): Promise<CycleRecord>;
  setStatus(id: string, status: CycleStatus): Promise<CycleRecord>;
  /** Write one policy of a line's own and hand back the whole effective set. */
  setPolicy(id: string, key: string, value: CyclePolicyValue): Promise<CyclePolicySet>;
  list(): Promise<CycleRecord[]>;
  /** The line that should be working now; null when there is none. */
  current(): Promise<CycleRecord | null>;
  show(id: string): Promise<CycleRecord>;
  /** Claim a node onto this line's roster. */
  hold(id: string, node: string): Promise<CycleRecord>;
  /** Settle one step: the verdict goes into path, and the claim is laid down with it. */
  close(id: string, input: CycleCloseInput): Promise<CycleRecord>;
  /** Pick a line that did not run to the end back up and run it again; `drop` also clears the claim, which is what a dead session needs. */
  retry(id: string, node?: string, options?: { drop?: boolean }): Promise<CycleRecord>;
}

// ── instructions ─────────────────────────────────────────────────────────────

/** Register one instruction: the text and the scope are required, the binding follows the scope. */
export interface InstructionAddInput {
  text: string;
  scope: InstructionScope;
  target?: InstructionTarget;
  /** The binding when scope is cycle / node. */
  cycle?: string;
  node?: string;
  said_by?: string;
  note?: string;
  /** Lapses after this many nodes have closed the line. */
  stop_after_nodes?: number;
}

/** The filter of list: by default only the live ones are given. */
export interface InstructionListFilter {
  /** Give the archived ones along with them. */
  all?: boolean;
  scope?: InstructionScope;
  node?: string;
}

/** The instructions namespace: the user instruction channel, these five verbs. */
export interface InstructionsNamespace {
  add(input: InstructionAddInput): Promise<InstructionRecord>;
  list(filter?: InstructionListFilter): Promise<InstructionRecord[]>;
  /** Resolve one instruction (lands resolved_at). */
  resolve(id: string): Promise<InstructionRecord>;
  /** Put an archived instruction back in force. */
  revive(id: string): Promise<InstructionRecord>;
  /** Take the instruction off the records (leaving a trace of the id and the timestamp). */
  remove(id: string): Promise<void>;
}

// ── ledger: the record directory and the three sub-namespaces ────────────────

export type {
  ExcludeReading,
  InitReport,
  LedgerInitOptions,
  LedgerLayout,
  LedgerRegisterOptions,
  MergeDriverReading,
  OwnRepoReading,
} from './initledger';

/** The record directory (`.pf/`) namespace: init, register, and the graph, cycles and instructions sub-spaces. */
export interface LedgerNamespace {
  /**
   * Set up the `.pf/` record directory for a project and hand back what it did: the layout files
   * (always), plus the three best-effort attachments — a repository of `.pf`'s own, the project
   * repository's `info/exclude` line, the merge driver's two git config keys — each missing one
   * named in `warnings` rather than thrown.
   */
  init(options?: LedgerInitOptions): Promise<InitReport>;
  /** Write the merge driver into this project's git config (the `[merge "pf"]` section); skipped silently when git cannot be asked (no runner, or not a git checkout). */
  register(options?: LedgerRegisterOptions): Promise<void>;
  readonly dag: DagNamespace;
  readonly cycles: CyclesNamespace;
  readonly instructions: InstructionsNamespace;
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Assemble the ledger namespace: init, register and the three blocks of graph, lines and instructions
 * (the locations come from the caller's project root).
 */
export function createLedgerNamespace(root: string): LedgerNamespace {
  return {
    init: (options) => initLedger(root, options),
    register: (options) => registerLedger(root, options),
    dag: createDagNamespace(root),
    cycles: createCyclesNamespace(root),
    instructions: createInstructionsNamespace(root),
  };
}
