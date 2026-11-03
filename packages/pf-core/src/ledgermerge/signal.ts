/**
 * One handoff ticket under `.pf/signals/<line>/<node>.json` — the whole file is one record.
 *
 * A ticket is a report of one attempt: the two sides are two tries at the same node, and the later
 * try is the one that happened.
 *
 * - `status`: a terminal word (`completed` / `failed` / `stopped`) beats a non-terminal one
 *   (`pending` is the marker a re-run leaves), whatever the timestamps say.
 * - for every other field, when both sides changed one, the ticket carrying the **later
 *   `timestamp`** wins: the record says when it was written, and that is the only ordering that
 *   has anything to do with the two attempts. The driver is handed git's own temporary files, whose
 *   modification times say when git wrote those files and nothing about which attempt is later.
 * - when the two sides cannot be ordered — one of them carries no `timestamp`, or both carry the
 *   same one — nothing is guessed: it is a conflict for a person.
 * - two identical tickets are identical: a field only one side touched is asked about by nobody.
 */

import {
  MISSING,
  UNDECIDED,
  type FieldResolver,
  type MergeReport,
  asRecord,
  bothChanged,
  mergeMapping,
  threeWay,
} from './generic';

/**
 * Terminal: the work of this cell has a verdict — `completed` delivered, `failed` / `stopped` did not.
 * `pending` is the marker of "no verdict yet" (left by a re-run) and never enters this table.
 */
export const TERMINAL_SIGNAL_STATUSES = ['completed', 'failed', 'stopped'];

/** One handoff ticket: the later attempt wins, and a terminal status wins over a non-terminal one. */
export function mergeSignal(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const oursStamp = stampOf(ours);
  const theirsStamp = stampOf(theirs);
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (key === 'status') {
      return signalStatus(baseValue, oursValue, theirsValue, report, oursStamp, theirsStamp);
    }
    if (bothChanged(baseValue, oursValue, theirsValue)) {
      return laterTicket(report, key, oursValue, theirsValue, oursStamp, theirsStamp);
    }
    return threeWay(baseValue, oursValue, theirsValue);
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/** The ticket's own `timestamp`; null when that side has no usable one. */
function stampOf(value: unknown): string | null {
  const stamp = asRecord(value)['timestamp'];
  return typeof stamp === 'string' && stamp !== '' ? stamp : null;
}

/** Status: terminal beats non-terminal; only within the same tier does the ticket's own timestamp decide. */
function signalStatus(
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
  oursStamp: string | null,
  theirsStamp: string | null,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  const oursTerminal = isTerminal(oursValue);
  const theirsTerminal = isTerminal(theirsValue);
  if (oursTerminal !== theirsTerminal) {
    const winner = oursTerminal ? oursValue : theirsValue;
    report.decide(
      `note: status terminal beats non-terminal -> ${JSON.stringify(winner)}` +
        ` (ours=${JSON.stringify(oursValue)} theirs=${JSON.stringify(theirsValue)})`,
    );
    return winner;
  }
  return laterTicket(report, 'status, same tier', oursValue, theirsValue, oursStamp, theirsStamp);
}

function isTerminal(value: unknown): boolean {
  return typeof value === 'string' && TERMINAL_SIGNAL_STATUSES.includes(value);
}

/**
 * Both sides changed the same field to two values: take the ticket whose own `timestamp` is later.
 * Two sides that cannot be ordered — no timestamp on one of them, or the same timestamp on both —
 * go to a person instead of a coin being tossed.
 */
function laterTicket(
  report: MergeReport,
  what: string,
  oursValue: unknown,
  theirsValue: unknown,
  oursStamp: string | null,
  theirsStamp: string | null,
): unknown {
  if (oursStamp === null || theirsStamp === null) {
    const why =
      oursStamp === null && theirsStamp === null
        ? 'neither side carries a timestamp'
        : oursStamp === null
          ? 'this side carries no timestamp'
          : 'the other side carries no timestamp';
    report.conflict('note', what, oursValue, theirsValue, `${why}, so the two attempts cannot be ordered`);
    return MISSING;
  }
  if (oursStamp === theirsStamp) {
    report.conflict(
      'note',
      what,
      oursValue,
      theirsValue,
      `both attempts carry the timestamp ${oursStamp}, so they cannot be ordered`,
    );
    return MISSING;
  }
  const theirsIsLater = theirsStamp > oursStamp;
  report.decide(
    `note: ${what} both sides changed it -> take the later ticket by its own timestamp ` +
      `(${theirsIsLater ? 'theirs' : 'ours'}; ${oursStamp} vs ${theirsStamp})`,
  );
  return theirsIsLater ? theirsValue : oursValue;
}
