/**
 * The main panel's shell: the five-pane tab row, switching between views, the fetch lines for
 * readings and preferences, and the assembly of each pane.
 *
 * Each pane's own layout is its own document: the map `map.tsx` (with its layout engine in
 * `map-layout.ts`), detail `detail.tsx`, instruction book `notes.tsx`, project settings `config.tsx`,
 * and the issue pane `pool.tsx`; the modal is `delete-confirm.tsx`; the
 * reading widgets shared by the map, detail, and instruction book are in `marks.tsx`.
 *
 * Not a single reading is computed here: the four records arrive through the port, and the pure
 * functions in `src/model` read them into the reading for this moment; this layer only draws it. The
 * panel's own display preferences live in the Host's settings document, read and written through
 * the port in `prefs.ts`.
 */
import * as React from 'react'
import type { PathfinderReading } from '../host/contract.ts'
import type { InstructionReading } from '../model/index.ts'
import { everySourceIs, readProject, readSessions } from '../model/index.ts'
import type { PrefField, PrefsSource, ViewId } from './prefs.ts'
import { clampSide, DEFAULT_SOURCE, PANEL_PREF_FIELDS, VIEW_IDS, VIEW_WORDS } from './prefs.ts'
import { useT } from './locale.ts'
import { failureWord } from './words.ts'
import type { Failure, Outcome } from './failure.ts'
import { failureOf } from './failure.ts'
import type { PanelPort } from './data.ts'
import { bucketOf, NO_WORKSPACES, type WorkspaceSource } from './workspaces.ts'
import { MapPane, type CardGo } from './map.tsx'
import { ConfigPane } from './config.tsx'
import { DeleteConfirm } from './delete-confirm.tsx'
import { DetailPane } from './detail.tsx'
import { NotesPane } from './notes.tsx'
import { IssuePool } from './pool.tsx'

/* The five views, in tab order: the ids are the settings document's own list (VIEW_IDS), so the
 * settings dropdown and the tab row cannot drift apart and neither knows the language. Every pane
 * fills the stage's footprint; the word on each tab is looked up when the tab row is drawn. */
const VIEWS = VIEW_IDS

export interface PanelProps {
  readonly port: PanelPort
  /** Which workspace to read, by the session it belongs to; without it nothing can be drawn. */
  readonly sessionId?: string | undefined
  /** Which settings document holds the panel's own preferences. Factory defaults apply when absent. */
  readonly prefs?: PrefsSource | undefined
  /** Where card clicks go: DSH's navigation gateway. Cards are inert without it. */
  readonly openSession?: ((target: string) => void) | undefined
  /** Which sessions exist on this machine right now: it decides whether the session a card points to is among them. */
  readonly knownSessions?: ReadonlySet<string> | undefined
  /** DSH's workspace list, the source of the selector at the top of the panel; without it no workspace is pickable and only this session's own workspace is read. */
  readonly workspaces?: WorkspaceSource | undefined
}

/** The notes when there is no session yet: no pane has anywhere to go. */
const NO_NOTES: Readonly<Record<string, string>> = Object.freeze({})

const NO_SESSIONS: ReadonlySet<string> = new Set<string>()

/** How far one reading has got. Which words a failure reads as is decided where it is drawn. */
type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly reading: PathfinderReading }
  | { readonly phase: 'failed'; readonly failure: Failure }
  /** No session is selected, so there is no workspace to read and no failure to speak of. */
  | { readonly phase: 'no-session' }

/**
 * What the one note line under the panel says.
 *
 * Two different things land there and they are not the same kind of text: the tool's own words,
 * carried out verbatim when it spoke while succeeding, and why an operation was refused, which is a
 * code this panel spells. Kept apart rather than flattened into one string, because only the second
 * is ours to translate.
 */
type Note =
  | { readonly kind: 'said'; readonly text: string }
  | { readonly kind: 'failure'; readonly failure: Failure }

/**
 * The level the panel reads at this moment.
 *
 * It stands first on the settings document's value; once the reader changes it on the panel, the
 * changed one leads, and the settings value (flipped elsewhere, or a write landing) follows as soon
 * as a new value arrives.
 * @param stored - The value the settings document states at this moment.
 */
function usePreference<T>(stored: T): [T, (next: T) => void] {
  const [local, setLocal] = React.useState<T>(stored)
  React.useEffect(() => {
    setLocal(stored)
  }, [stored])
  return [local, setLocal]
}

export function PathfinderPanel(props: PanelProps): React.ReactElement {
  const { port, sessionId, openSession, knownSessions } = props
  /* Every word this pane prints comes from here. The translator reads the active language at call
   * time, so a redraw after a language switch says the new one without anything being re-created. */
  const t = useT()
  /* The workspace selector at the top of the panel: the candidates are DSH's own list, and the read
   * goes to the picked workspace. The picked one lives only on this screen; the panel's own
   * preferences have nothing to do with it, and no key is left in local storage. Before anything is
   * picked it follows whichever bucket this session falls into; a session belonging to no workspace
   * is "ungrouped", which is exactly this session's own root. */
  const workspaceStore = props.workspaces ?? NO_WORKSPACES
  const workspaceList = React.useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  )
  const items = workspaceList.items
  const mine = React.useMemo(() => bucketOf(items, sessionId), [items, sessionId])
  const [pickedSpace, setPickedSpace] = React.useState<string | null | undefined>(undefined)
  const chosen = React.useMemo(() => {
    if (pickedSpace === undefined) return mine
    if (pickedSpace === null) return undefined
    /* The picked one is no longer in the list (deleted elsewhere): fall back to this session's own bucket. */
    return items.find((item) => item.workspaceId === pickedSpace) ?? mine
  }, [pickedSpace, mine, items])
  /* The root handed to the host half: an empty string means nothing was picked, read by this session's own root. */
  const workspaceRoot = chosen?.path ?? ''
  /* The session belongs to some workspace yet the reader picked "ungrouped": ungrouped is no root,
   * so do not read. Without this step the empty root would ride the session's cwd back to the
   * workspace it belongs to — usually the very one from before, the screen unmoved, looking like a
   * stale frame. When this session itself sits in the ungrouped bucket, "ungrouped" is still its
   * own root, and the read goes on. */
  const pickedNone = pickedSpace === null && mine !== undefined
  /* The panel's own preferences: the reading comes from that settings form, and the write goes out
   * through the same port; before the settings service attaches it serves the factory defaults, and
   * the panel draws as usual. */
  const store = props.prefs ?? DEFAULT_SOURCE
  const preferences = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const stored = preferences.prefs
  const [tab, setTab] = usePreference<ViewId>(stored.tab)
  const [sideWidth, setSideWidth] = usePreference<number>(stored.sideWidth)
  const [otherStates, setOtherStates] = usePreference<boolean>(stored.otherStates)
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [notes, setNotes] = React.useState<Readonly<Record<string, string>>>(NO_NOTES)
  /* Which moment the read happened at: fixed on the fetch beat. Everything displays by it — the
   * reading already carries this moment; "now" is never fetched separately. */
  const [at, setAt] = React.useState<Date>(() => new Date())
  const [tick, setTick] = React.useState(0)
  const [note, setNote] = React.useState<Note | null>(null)
  const [lineId, setLineId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<InstructionReading | null>(null)

  /* Fetching: read once on the pass this view becomes visible; again when the workspace changes or
   * after a write lands (`tick` is that pass's marker). */
  React.useEffect(() => {
    if (sessionId === undefined || sessionId.length === 0) {
      setLoad({ phase: 'no-session' })
      return undefined
    }
    if (pickedNone) return undefined
    let live = true
    setLoad({ phase: 'loading' })
    port.read(sessionId, workspaceRoot).then(
      (reading) => {
        if (!live) return
        setAt(new Date())
        setLoad({ phase: 'ok', reading })
      },
      (error: unknown) => {
        if (!live) return
        setLoad({ phase: 'failed', failure: failureOf(error) })
      },
    )
    return () => { live = false }
  }, [port, sessionId, workspaceRoot, tick, pickedNone])

  /* Session notes: the host half carries the notes directory back verbatim, and the model layer
   * reads "which session each cell should go to" against it. Only the map has cards to click, so
   * the read happens only on the passes that pane is visible; an unreadable one draws as empty. The
   * write-side verbs cannot touch the notes, so `tick` does not follow them. */
  React.useEffect(() => {
    if (pickedNone || tab !== 'map' || sessionId === undefined || sessionId.length === 0) {
      setNotes(NO_NOTES)
      return undefined
    }
    let live = true
    port.readSessions(sessionId, workspaceRoot).then(
      (reading) => { if (live) setNotes(readSessions(reading.notes)) },
      () => { if (live) setNotes(NO_NOTES) },
    )
    return () => { live = false }
  }, [port, sessionId, workspaceRoot, tab, pickedNone])

  /* The click on a card: only when the record's session is on this machine right now does the card
   * click through. The session identity is recognized in two places — this machine's own notes
   * first, then the field on the record itself. Missing either the roster or the navigation gateway,
   * every card on this screen sits quietly. */
  const cardGo = React.useMemo<CardGo | null>(() => {
    if (openSession === undefined) return null
    const known = knownSessions ?? NO_SESSIONS
    return {
      targetOf: (node) => {
        const session = notes[node.id] ?? node.session
        return session !== undefined && session.length > 0 && known.has(session) ? session : null
      },
      open: openSession,
    }
  }, [notes, knownSessions, openSession])

  const reading = load.phase === 'ok' ? load.reading : null
  const project = React.useMemo(
    () => (reading === null
      ? null
      : readProject({
        nodes: reading.nodes,
        cycles: reading.cycles,
        instructions: reading.instructions,
        issues: reading.issues,
        at,
      })),
    [reading, at],
  )

  const cycles = project?.cycles ?? []
  const picked = cycles.find((cycle) => cycle.id === lineId) ?? cycles[0] ?? null

  /* Whether this workspace has any nodes: not a single cell in the reading means none. When there
   * are none, the five node-following panes each collapse to one sentence, and the header's count
   * row goes away with them — empty column heads and three zeros would be speaking for a record
   * that says nothing. The invariant "the four sources are disjoint and together the whole" holds in
   * one place, the model layer; it is not re-derived here by summing column lengths. */
  const noNodes = project !== null && project.nodes.length === 0

  /* Every write on the panel goes through this hand: put the sentence verbatim onto the note line,
   * and on success read again (`tick` moves, and the reading effect above re-runs). Returning
   * "did it land" is for the "record one" row — only a landed sentence clears the box; when the
   * tool refuses, the original words stay in the box for further editing. */
  const onWrite = React.useCallback(
    (run: () => Promise<Outcome>): Promise<boolean> => {
      setNote(null)
      return run().then(
        (outcome) => {
          /* Success carries the tool's own words when it said any; a refusal carries a code, and the
           * note line spells it when it is drawn — not here, where the reader's language is unknown. */
          setNote(outcome.ok
            ? (outcome.text.length > 0 ? { kind: 'said', text: outcome.text } : null)
            : { kind: 'failure', failure: { code: outcome.code, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) } })
          if (outcome.ok) setTick((value) => value + 1)
          return outcome.ok
        },
        (error: unknown) => {
          setNote({ kind: 'failure', failure: failureOf(error) })
          return false
        },
      )
    },
    [],
  )

  /* The change made on the panel: the changed value leads, then it is written back to the settings
   * document — both sides read the same form, so the settings page's row moves on the spot too.
   * When the write cannot land, the control does not silently snap back: the sentence in the port's
   * reading lands on the note line below, and when the service has not arrived there is its own
   * sentence for that too. */
  const prefNote = React.useRef<Note | null>(null)
  const keep = React.useCallback((field: PrefField, value: unknown): void => {
    void store.write(field, value).then((accepted) => {
      /* Two different failures are possible and they read differently: the settings service refused
       * the change, or there is no settings service at all and the change lives only on this screen. */
      const said: Note | null = accepted
        ? null
        : { kind: 'failure', failure: { code: store.getSnapshot().refused ? 'settings-refused' : 'settings-unwritable' } }
      const was = prefNote.current
      prefNote.current = said
      /* On success take the previous "not saved" sentence back; other notes (the write-side ones) stay put. */
      if (said === null) setNote((held) => (held === was ? null : held))
      else setNote(said)
    }, () => undefined)
  }, [store])

  const pickView = React.useCallback((id: ViewId) => {
    setTab(id)
    keep(PANEL_PREF_FIELDS.defaultTab, id)
  }, [keep])

  const pickOtherStates = React.useCallback((on: boolean) => {
    setOtherStates(on)
    keep(PANEL_PREF_FIELDS.showOtherStates, on)
  }, [keep])

  /* Whether this screen has anything to say. Picking "ungrouped" while this session has a home
   * means that pane has no record under it; none of the four sources listed means this workspace
   * has no such record; listed but none parseable means unreadable. In all three cases all five
   * panes are speechless, and the pane collapses to one sentence — the plaque and the workspace
   * selector stay; tabs and body go together. */
  const nothing = pickedNone
    ? t('panel.ungrouped-empty')
    : load.phase === 'no-session'
      ? t('panel.no-session')
      : load.phase === 'failed'
        ? failureWord(t, load.failure)
        : reading !== null && everySourceIs(reading, 'missing')
          ? t('panel.no-record')
          : reading !== null && everySourceIs(reading, 'unusable')
            ? t('panel.unreadable')
            : null

  return (
    <div className="pf-page">
      <header className="pf-head">
        <div className="pf-head-left">
          <div className="pf-head-top">
            <span className="pf-brand">PATHFINDER</span>
            {items.length === 0 ? null : (
              <span className="pf-pick">
                <select
                  aria-label={t('workspace.aria')}
                  value={chosen?.workspaceId ?? ''}
                  onChange={(event) => setPickedSpace(event.target.value.length === 0 ? null : event.target.value)}
                >
                  {items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
                  {/* The pile of sessions belonging to no workspace, which DSH itself calls "ungrouped", stands last on the list. */}
                  <option value="">{t('workspace.ungrouped')}</option>
                </select>
              </span>
            )}
          </div>
        </div>
        {nothing === null ? (
          <div className="pf-tabs" role="tablist">
            {VIEWS.map((id) => (
              <button
                key={id}
                type="button"
                className="pf-tab"
                id={`tab-${id}`}
                role="tab"
                aria-selected={id === tab}
                aria-controls={`pane-${id}`}
                onClick={() => pickView(id)}
              >
                {t(VIEW_WORDS[id])}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {nothing === null ? (
      <div className="pf-stage">
        {/* The frame fills the footprint in every view — each pane scrolls what does not fit inside
            itself — and every pane inside it is a direct child, so its own `flex` does the sharing. */}
        <div className="pf-frame is-fill" id="frame">
          <MapPane
            active={tab === 'map'}
            noNodes={noNodes}
            project={project}
            go={cardGo}
            onRefresh={() => setTick((value) => value + 1)}
          />

          <DetailPane
            active={tab === 'detail'}
            noNodes={noNodes}
            cycles={cycles}
            picked={picked}
            project={project}
            sideWidth={sideWidth}
            onSideWidth={setSideWidth}
            onSideCommit={(px) => keep(PANEL_PREF_FIELDS.sideWidth, clampSide(px))}
            onPickLine={setLineId}
          />

          <NotesPane
            active={tab === 'notes'}
            noNodes={noNodes}
            project={project}
            cycles={cycles}
            showArchived={stored.archived}
            onAdd={(text, scope, cycle, node) => (
              onWrite(() => port.say(sessionId ?? '', workspaceRoot, text, scope, cycle, node))
            )}
            onArchive={(id) => { void onWrite(() => port.write('archive', sessionId ?? '', workspaceRoot, id)) }}
            onRevive={(id) => { void onWrite(() => port.write('revive', sessionId ?? '', workspaceRoot, id)) }}
            onDelete={(instruction) => setDeleting(instruction)}
          />

          {/* This pane acts as its own page root: the `is-embed` yield marker hangs on it together
              with the page marker (`pf-issue`), and the build gateway folds that sheet by its own
              page marker. */}
          <div
            className="pf-pane is-frame is-embed pf-issue"
            id="pane-issue"
            role="tabpanel"
            aria-labelledby="tab-issue"
            data-fill=""
            hidden={tab !== 'issue'}
          >
            {project === null ? null : (
              <IssuePool project={project} showOtherStates={otherStates} onShowOtherStates={pickOtherStates} />
            )}
          </div>

          <ConfigPane
            port={port}
            sessionId={sessionId ?? ''}
            workspaceRoot={workspaceRoot}
            noNodes={noNodes}
            active={tab === 'config'}
            onNote={setNote}
          />
        </div>
      </div>
      ) : (
        <div className="pf-none">
          <p>{nothing}</p>
        </div>
      )}

      {note === null ? null : (
        <p className="pf-innone">{note.kind === 'said' ? note.text : failureWord(t, note.failure)}</p>
      )}

      {deleting === null ? null : (
        <DeleteConfirm
          instruction={deleting}
          said={deleting.text ?? ''}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id
            setDeleting(null)
            onWrite(() => port.write('remove', sessionId ?? '', workspaceRoot, id))
          }}
        />
      )}
    </div>
  )
}
