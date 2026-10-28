/**
 * The two things both preview generators open a .pf ledger with: the `--ledger` argument and
 * the JSON files inside it. One implementation here, so the generators cannot drift on how a
 * ledger is addressed or read.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The ledger directory named by `--ledger <path>`: prints the usage line and exits 2 when
 * the argument or its value is missing.
 */
export function ledgerDir(argv, usage) {
  const at = argv.indexOf('--ledger');
  if (at < 0 || argv[at + 1] === undefined) {
    console.error(usage);
    process.exit(2);
  }
  return path.resolve(argv[at + 1]);
}

/** One JSON file inside the ledger, parsed. */
export function readLedgerJson(ledger, rel) {
  return JSON.parse(fs.readFileSync(path.join(ledger, rel), 'utf8'));
}
