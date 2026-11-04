#!/usr/bin/env node
/**
 * `pf`: the transport layer's entry. Node runs this file directly (the shebang names Node, and no
 * shell-specific host is involved), so the command is the same one on every platform; the work is
 * in `lib/`.
 */
import { main } from './lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2));