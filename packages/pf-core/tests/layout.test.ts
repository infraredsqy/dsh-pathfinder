import { describe, expect, it } from 'vitest';
import {
  PF_DIR_NAME,
  launchPromptPath,
  ledgerLockPath,
  nodeDir,
  nodeTempDir,
  pfPaths,
  sessionNotePath,
  signalPath,
  startedMarkerPath,
} from '../src/paths.ts';
import { join } from 'node:path';

/** Directory layout: every write target comes from a constant or a function in `src/paths.ts`. */

describe('.pf directory layout', () => {
  it('record files and the four records sit in place; the issue pool lives under issues/', () => {
    const root = join('some', 'project');
    const paths = pfPaths(root);
    expect(paths.root).toBe(root);
    expect(paths.pfDir).toBe(join(root, PF_DIR_NAME));
    expect(PF_DIR_NAME).toBe('.pf');
    expect(paths.stateJson).toBe(join(root, '.pf', 'state.json'));
    expect(paths.ideasJson).toBe(join(root, '.pf', 'ideas.json'));
    expect(paths.instructionsJson).toBe(join(root, '.pf', 'instructions.json'));
    expect(paths.issuesJson).toBe(join(root, '.pf', 'issues', 'issues.json'));
  });

  it('signals, nodes, metadata and session notes land where the layout says', () => {
    const paths = pfPaths('p');
    expect(paths.signalsDir).toBe(join('p', '.pf', 'signals'));
    expect(paths.nodesDir).toBe(join('p', '.pf', 'nodes'));
    expect(paths.metaDir).toBe(join('p', '.pf', 'meta'));
    expect(paths.sessionsDir).toBe(join('p', '.pf', 'meta', 'sessions'));
    expect(signalPath(paths, 'pf-core', 'df5129ce')).toBe(
      join('p', '.pf', 'signals', 'pf-core', 'df5129ce.json'),
    );
    expect(nodeDir(paths, 'df5129ce')).toBe(join('p', '.pf', 'nodes', 'df5129ce'));
    expect(nodeTempDir(paths, 'df5129ce')).toBe(join('p', '.pf', 'nodes', 'df5129ce', 'temp'));
    expect(sessionNotePath(paths, 'df5129ce')).toBe(
      join('p', '.pf', 'meta', 'sessions', 'df5129ce.json'),
    );
    expect(ledgerLockPath(paths)).toBe(join('p', '.pf', 'meta', 'ledger.lock'));
  });

  it('every builder that takes a node id runs the same guard, so no caller string spells another location', () => {
    const paths = pfPaths('p');
    // The id-to-path guard is one seat: the node directory and its files, and the signal / session /
    // launch places, all refuse the spellings that would join outside the node's own place.
    const builders: Array<(nodeId: string) => string> = [
      (nodeId) => nodeDir(paths, nodeId),
      (nodeId) => nodeTempDir(paths, nodeId),
      (nodeId) => signalPath(paths, 'pf-core', nodeId),
      (nodeId) => sessionNotePath(paths, nodeId),
      (nodeId) => launchPromptPath(paths, 'pf-core', nodeId),
      (nodeId) => startedMarkerPath(paths, 'pf-core', nodeId),
    ];
    for (const bad of ['', '.', '..', '../..', 'a/b', 'a\\b']) {
      for (const build of builders) {
        expect(() => build(bad), `${JSON.stringify(bad)} must not become a path`).toThrow(
          /not one name a record directory can hold/,
        );
      }
    }
  });
});
