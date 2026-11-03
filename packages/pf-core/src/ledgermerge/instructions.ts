/**
 * `instructions.json` — the standing user instructions, plus the traces a removal leaves.
 *
 * A record indexed by `id`, with the merged result written back as a list; the record also carries `removed`, the
 * tombstone table (an `id` plus a timestamp, no text). What this engine adds on top of the generic walk:
 *
 * - entries propagate deletions like the graph does: one side takes the entry off (`ledger.instructions.remove`) and
 *   the other leaves it alone, so it is gone. One side takes it off and the other edited it is the graph's
 *   "delete vs edit" shape: a conflict, judged by a person.
 * - removal traces are unioned by `id` — nobody takes one back, and they are the evidence that keeps two machines
 *   from minting the same id when they pull from each other. Two machines each removing the same instruction differ
 *   only in the timestamp; the earlier one wins: whoever removed it first is when it left this record.
 * - resolving (archiving / putting back) is one act: `state` / `resolved_at` are written together by one code path,
 *   so the driver judges these two as one group: if only one side changed them, take that side; if both changed
 *   them, order the two by `resolved_at` and the newer act wins as a whole group. Putting an entry back **clears**
 *   that timestamp: one side put it back while the other changed it again, and with no timestamp on either side
 *   there is nothing to order them by — a conflict. `note` deliberately stays outside the group: a sentence a person
 *   wrote is never quietly overwritten, so a `note` both sides changed is a conflict.
 * - both sides adding the same `id` with different content is an addition collision: a conflict.
 */

import {
  MISSING,
  UNDECIDED,
  type FieldResolver,
  type MergeReport,
  asRecord,
  get,
  isRecord,
  keyOrder,
  mergeEntries,
  mergeMapping,
  plainField,
  stampField,
  threeWay,
} from './generic';

/** The two fields one resolution act writes together; the driver judges them as one group. */
export const RESOLUTION_GROUP = ['state', 'resolved_at'];

/** The traces a removal leaves live under this key: only an `id` and a timestamp, no text. */
const REMOVED = 'removed';

/** The instructions record: `instructions` is walked entry by entry (deletions propagate), and the `removed` traces are unioned by id. */
export function mergeInstructions(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of keyOrder(ours, theirs)) {
    if (field === 'instructions') {
      const merged = mergeEntries(
        get(base, field),
        get(ours, field),
        get(theirs, field),
        report,
        mergeInstruction,
        indexById,
        true,
      );
      out[field] = [...merged.values()];
    } else if (field === REMOVED) {
      const merged = mergeEntries(
        get(base, field),
        get(ours, field),
        get(theirs, field),
        report,
        mergeTombstone,
        indexById,
      );
      out[field] = [...merged.values()];
    } else {
      out[field] = plainField(
        'instructions.json',
        field,
        get(base, field),
        get(ours, field),
        get(theirs, field),
        report,
      );
    }
  }
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (value !== MISSING) merged[key] = value;
  }
  return merged;
}

/** A group indexed by `id`: the entries themselves, or their removal traces. */
function indexById(items: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (Array.isArray(items)) {
    for (const entry of items) {
      if (!isRecord(entry)) continue;
      const id = entry['id'];
      if (id === undefined || id === null || id === '') continue;
      out.set(String(id), entry);
    }
  } else if (isRecord(items)) {
    for (const [id, entry] of Object.entries(items)) out.set(id, entry);
  }
  return out;
}

/** One instruction: the resolution group follows its own rule, the remaining fields follow the ordinary ones. */
function mergeInstruction(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (RESOLUTION_GROUP.includes(key)) {
      return resolution(label, key, baseValue, oursValue, theirsValue, ours, theirs, report);
    }
    return plainField(label, key, baseValue, oursValue, theirsValue, report);
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/**
 * One removal trace: the id, and the moment it left.
 *
 * A trace is the record of a fact, and nothing in the engine takes one back, so the fields follow the ordinary rules
 * and the timestamp takes the **earlier** side: two machines each removing the same entry differ only in the
 * timestamp, and whoever removed it first is when it left this record.
 */
function mergeTombstone(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (key === 'at') {
      return stampField(label, key, baseValue, oursValue, theirsValue, report, 'min');
    }
    return plainField(label, key, baseValue, oursValue, theirsValue, report);
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/** The resolution group: the side with the newer `resolved_at` wins the group as a whole; two timestamps that cannot be ordered need a person. */
function resolution(
  label: string,
  key: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  const oursStamp = get(ours, 'resolved_at');
  const theirsStamp = get(theirs, 'resolved_at');
  if (
    typeof oursStamp === 'string' &&
    typeof theirsStamp === 'string' &&
    oursStamp !== theirsStamp
  ) {
    const oursIsLater = oursStamp > theirsStamp;
    const later = oursIsLater ? oursStamp : theirsStamp;
    report.decide(
      `${label}: both sides changed this instruction's resolution -> take the side with ` +
        `the newer resolved_at (${oursIsLater ? 'ours' : 'theirs'} ${later})`,
    );
    return get(oursIsLater ? ours : theirs, key);
  }
  // Putting an entry back **clears** that timestamp, and a cleared timestamp only meets one with a value when both
  // sides touched this group: two owner acts on two machines, and neither record has a timestamp to order them by.
  // Say that out loud — "resolved_at cannot order the two" would send the reader looking for two timestamps.
  const note =
    (oursStamp === null) !== (theirsStamp === null)
      ? 'one side put this entry back in force (clearing the moment it was withdrawn) while ' +
        'the other side changed it again -- two owner acts collided'
      : 'resolved_at cannot order the two';
  report.conflict(label, key, oursValue, theirsValue, note);
  return MISSING;
}
