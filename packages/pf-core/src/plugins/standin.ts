import { join } from 'node:path';
import type { ConfigValue } from '../config';
import type { PluginContext, PluginDeclaration, PluginInsertTarget } from './types';

/**
 * doctor's stand-in context: the scene used when the implementation a declaration names is really asked once — a
 * temporary project, a stand-in line without tags, an empty graph. A knob the declaration configured takes the
 * first usable value of its kind (number / integer take 1, word takes its first word, switch takes on); a declared
 * reading whose source the core or the declaration itself can supply is given 1; every other reading honestly
 * answers "none this round".
 *
 * **No subprocess, not one byte written.** capture answers empty text, run answers that it ran (the stand-in
 * is there to answer the contract's shape, never to carry a command out), and spec_path only says
 * the spelling of the location. Validation uses it to judge whether an implementation keeps the contract, never to
 * change the graph or open a session.
 */
export function standInContext(decl: PluginDeclaration, project: string): PluginContext {
  const knobs = recordOf((decl as Record<string, unknown>).knobs);
  const readings = recordOf((decl as Record<string, unknown>).readings);
  const sources = recordOf((decl as Record<string, unknown>).sources);

  const values = new Map<string, ConfigValue>();
  for (const [key, raw] of Object.entries(knobs)) {
    const cell = recordOf(raw);
    if (Object.keys(cell).length === 0) continue;
    values.set(key, cellValue(cell));
  }
  // The stand-in values of readings: the core's ticket or a source the declaration claims is given 1, and the rest answer "none".
  const served = new Set(['ticket', ...Object.keys(sources)]);
  const numbers = new Map<string, number>();
  for (const [key, raw] of Object.entries(readings)) {
    const cell = recordOf(raw);
    const source = cell.source;
    if (typeof source === 'string' && served.has(source)) numbers.set(key, 1);
  }

  const cycle: Record<string, unknown> = {
    id: 'validator',
    title: "the validator's stand-in line",
    tags: [],
    status: 'active',
  };

  return {
    root: project,
    cycle,
    nodeId: null,
    sig: {},
    dag: { nodes: {} },
    target: null as PluginInsertTarget | null,
    knob: (name: string) => Promise.resolve(values.get(name) ?? null),
    reading: (key: string) => Promise.resolve(numbers.get(key) ?? null),
    nodesWithTag: () => [],
    capture: () => Promise.resolve(''),
    run: () => Promise.resolve(true),
    specPath: (nodeId: string) => join(project, 'stand-in', `${nodeId}.md`),
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The stand-in value of one declared cell: the first value this kind of cell allows. */
function cellValue(cell: Record<string, unknown>): ConfigValue {
  const kind = cell.kind;
  if (kind === 'number' || kind === 'integer') return 1;
  const words = cell.values;
  if (kind === 'word' && Array.isArray(words) && words.length > 0 && typeof words[0] === 'string') {
    return words[0];
  }
  return 'on';
}
