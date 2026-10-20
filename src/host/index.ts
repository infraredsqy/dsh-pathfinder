/**
 * Entry point of the host half's plugin: installs a `pathfinderRecords`
 * service on the host.
 *
 * It holds no data and caches nothing: every call resolves the workspace root
 * from the session identity on the spot. The subprocess gateway is not in
 * `inject`; the write side fetches it on demand and rejects the operation if
 * it is missing, so the plugin never gets stuck pending installation.
 *
 * The export surface is only the four things the plugin protocol requires
 * (`name` / `inject` / `apply` / `Config`) plus the gateway class itself: the
 * line is installed by DSH's plugin loader (mount point in
 * `cordis.patch.yml`), which reads only those four; the other in-repo consumer
 * is `tests/host-plugin`. Readers of the gateway class are the self-check
 * fixture `tools/panel-check.mjs`, which builds a gateway from a fake host
 * context to drive the panel. Everything else is internal, each piece in its
 * own module; the browser half and tests import via deep paths, not through
 * the entry — names unused on the entry surface are not exported.
 */
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for the three services live on the package entries: they must stand on the Context type before `apply` installs the service. All type-only imports — nothing enters the runtime or the build output. */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import { Config } from './config.ts'
import { PathfinderRecordsGateway } from './gateway.ts'
import type { PathfinderRecords } from './contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host half's record-reading service; the interface the browser half's cell needs. */
    pathfinderRecords: PathfinderRecords
  }
}

/** The plugin line's own name; DSH's plugin protocol identifies the line by it. */
export const name = 'pathfinder-records'

/** `apply` runs only once these three are present; DSH's plugin protocol reads it before assembly. */
export const inject = ['workspaceFiles', 'sessions', 'sandboxPolicy']

/**
 * This line's settings schema; DSH's plugin protocol uses it to build the
 * settings namespace. When the host lacks schemastery this is `undefined` —
 * DSH reads that as "no form" and the line takes no place in settings.
 */
export { Config }

/** The gateway class itself; the self-check fixture `tools/panel-check.mjs` builds one from a fake host context to drive the panel. */
export { PathfinderRecordsGateway }

/**
 * Installs `ctx.pathfinderRecords`. The service unloads with the fiber this
 * plugin lives on.
 */
export function apply(ctx: Context): void {
  ctx.provide('pathfinderRecords', new PathfinderRecordsGateway(ctx))
}
