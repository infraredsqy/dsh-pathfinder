/**
 * The panel's own section inside DSH's settings: one navigation row plus the page it opens.
 *
 * This section lives in DSH's own settings panel, not in the same tree as the main panel, so it
 * cannot reach the sheets bundled into `.pf-page` at build time — it carries its own stylesheet,
 * class names all use the `pfset-` prefix, and colors use only DSH's theme tokens. The page holds
 * only three rows of the panel's own display preferences, and it reads the same settings form as the
 * panel, so flipping a row changes the panel on the spot.
 */
import * as React from 'react'
import { PANEL_PREF_FIELDS, VIEW_IDS } from '../host/settings-fields.ts'
import { DEFAULT_SOURCE, VIEW_WORDS } from './prefs.ts'
import type { PrefField, PrefsForm, PrefsSource, PrefsStore } from './prefs.ts'
import { serviceAt } from './data.ts'
import { injectAt, report, serveOn, type SlotsService } from './context.ts'
import { localeOf, LOCALE_NS, LocaleProvider, useT, type LocaleSource } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { failureWord } from './words.ts'
import { SETTINGS_STYLE_ID, dropStyleTag, ensureStyleTag } from './style-tags.ts'

/**
 * The settings slot this section occupies: one registration is both the navigation row and the page
 * it opens.
 *
 * The official Plugins set would collide with the official settings pages' own rules, so the named
 * `settings.section` is used instead.
 */
export const SECTION_SLOT = 'settings.section'

/**
 * The settings namespace, i.e. the id of that `- insert:` line in `cordis.patch.yml`.
 *
 * In DSH a settings namespace is one plugin line: the host collects the namespace by that id, and
 * the browser half asks for the form by it. The two spots spell the same word with no second place
 * validating in between — changing the word here moves this page onto a namespace nobody serves.
 */
export const SETTINGS_NAMESPACE = 'pathfinder'

export const SECTION_ORDER = 60

/**
 * What this section's navigation row is called.
 *
 * A key: DSH calls this `label` function while drawing the row, so the word is looked up per frame
 * and a language switch needs no re-registration.
 */
export const SECTION_WORD: WordKey = 'settings.section'

const STYLE_ID = SETTINGS_STYLE_ID

/**
 * This section's stylesheet.
 *
 * Row shape follows the blueprint page (name + one hint + the control at the right end), geometry
 * follows DSH's own settings rows. Colors are written only as DSH's own alias tokens, with no
 * fallback literal colors left — this section lives only inside DSH's own settings panel, where the
 * aliases certainly exist. The two fallbacks for border-radius and font-family stay: they are about
 * geometry, independent of whether the tokens exist.
 */
const CSS = `
.pfset-page{display:flex;flex-direction:column;padding:8px 0;max-width:760px;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.pfset-row{display:flex;align-items:center;gap:12px;min-height:32px;padding:10px 0}
.pfset-row + .pfset-row{border-top:0.5px solid var(--dsw-alias-border-l2)}
.pfset-text{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0}
.pfset-label{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.pfset-info{position:relative;flex:none;width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-family:var(--ds-font-family-code,monospace);font-size:10px;line-height:1;color:var(--dsw-alias-label-caption);background:none;border:0.5px solid var(--dsw-alias-border-l3);border-radius:50%;corner-shape:round;cursor:help}
.pfset-info:hover,.pfset-info:focus{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-caption)}
.pfset-info::after{content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:-4px;z-index:2;width:max-content;max-width:260px;padding:3px 7px;font-size:13px;line-height:1.5;color:var(--dsw-alias-toast-label);background:var(--dsw-alias-tooltip-bg);border:0;border-radius:var(--dsw-radius-sm,8px);opacity:0;visibility:hidden;transition:opacity 120ms ease}
.pfset-info:hover::after,.pfset-info:focus::after{opacity:1;visibility:visible}
.pfset-seg{flex:none;display:inline-flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-md,10px)}
.pfset-segbtn{font:inherit;font-size:13px;line-height:18px;padding:5px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pfset-segbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pfset-segbtn[aria-pressed='true']{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pfset-select{flex:none;height:34px;padding:0 28px 0 12px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,10px);cursor:pointer}
.pfset-select option{background-color:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
body[data-ds-dark-theme] .pfset-select{color-scheme:dark}
.pfset-switch{flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;display:inline-flex}
.pfset-switch[aria-checked='true']{background:var(--dsw-alias-link)}
.pfset-swthumb{width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary);transition:transform 120ms ease}
.pfset-switch[aria-checked='true'] .pfset-swthumb{transform:translateX(16px)}
.pfset-msg{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
`

export function ensureSettingsStyle(): void {
  ensureStyleTag(STYLE_ID, CSS)
}

export function dropSettingsStyle(): void {
  dropStyleTag(STYLE_ID)
}

export interface SettingsSectionProps {
  /** The port the panel uses to read and write settings; factory defaults apply when absent. */
  readonly source?: PrefsSource | undefined
  /** Which language to speak; the bundled fallback applies when absent. */
  readonly locale?: LocaleSource | undefined
}

/** This section's stylesheet body, for the self-check fixture to measure against the same copy. */
export const SETTINGS_CSS: string = CSS

function Row(props: {
  readonly label: string
  readonly tip: string | null
  readonly control: React.ReactNode
}): React.ReactElement {
  const t = useT()
  return (
    <div className="pfset-row">
      <div className="pfset-text">
        <span className="pfset-label">{props.label}</span>
        {props.tip === null
          ? null
          : (
            <button
              type="button"
              className="pfset-info"
              data-tip={props.tip}
              aria-label={t('settings.row.help', { label: props.label })}
            >
              i
            </button>
          )}
      </div>
      {props.control}
    </div>
  )
}

/**
 * The section's page.
 *
 * It wraps itself in the language provider: DSH draws this page inside its own settings panel, a
 * different tree from the main panel, so it cannot inherit the provider that one mounts. Both are
 * handed the same port by `apply`, so the two speak one language.
 */
export function SettingsSection(props: SettingsSectionProps): React.ReactElement {
  ensureSettingsStyle()
  return React.createElement(
    LocaleProvider,
    { source: props.locale },
    React.createElement(SettingsPage, { source: props.source }),
  )
}

function SettingsPage(props: SettingsSectionProps): React.ReactElement {
  const t = useT()
  const source = props.source ?? DEFAULT_SOURCE
  const snapshot = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const prefs = snapshot.prefs
  const write = (field: PrefField, value: unknown): void => {
    void source.write(field, value)
  }

  return (
    <div className="pfset-page">
      <Row
        label={t('settings.tab.label')}
        tip={null}
        control={(
          <select
            className="pfset-select"
            aria-label={t('settings.tab.label')}
            value={prefs.tab}
            onChange={(event) => write(PANEL_PREF_FIELDS.defaultTab, event.target.value)}
          >
            {VIEW_IDS.map((id) => <option key={id} value={id}>{t(VIEW_WORDS[id])}</option>)}
          </select>
        )}
      />
      <Row
        label={t('settings.archived.label')}
        tip={t('settings.archived.tip')}
        control={(
          <button
            type="button"
            className="pfset-switch"
            role="switch"
            aria-checked={prefs.archived}
            aria-label={t('settings.archived.label')}
            onClick={() => write(PANEL_PREF_FIELDS.showArchived, !prefs.archived)}
          >
            <span className="pfset-swthumb" />
          </button>
        )}
      />
      <Row
        label={t('settings.other-states.label')}
        tip={t('settings.other-states.tip')}
        control={(
          <button
            type="button"
            className="pfset-switch"
            role="switch"
            aria-checked={prefs.otherStates}
            aria-label={t('settings.other-states.label')}
            onClick={() => write(PANEL_PREF_FIELDS.showOtherStates, !prefs.otherStates)}
          >
            <span className="pfset-swthumb" />
          </button>
        )}
      />
      {snapshot.status === 'unavailable'
        ? (
          <p className="pfset-msg">
            {t('settings.unavailable', { ns: SETTINGS_NAMESPACE })}
          </p>
        )
        : null}
      {/* This is the row shown when a write-back is refused: `mutate` returns only a `false`, the
          panel's `void …write(…)` call sites drop it, and all the reader sees is the control
          snapping back. The reason is a code on the port's reading, spelled here — the same refusal
          the panel spells on its own note line. */}
      {snapshot.refused
        ? <p className="pfset-msg" role="status">{failureWord(t, { code: 'settings-refused' })}</p>
        : null}
    </div>
  )
}

/**
 * Wire this section onto settings: first attach the panel's port to
 * `configForms.get(SETTINGS_NAMESPACE)` (panel and settings page read the same form from then on),
 * then register one entry into `settings.section`. Each is hung on its own `effect`, and each is
 * contained in its own `try` (the shared-assembly layer's containment); when `slots` is
 * unreachable, the first still attaches and is still withdrawn.
 *
 * Services are awaited with dynamic `ctx.inject` (`ctx.get` comes up empty in this deployment, and
 * silently); when `slots` / `configForms` cannot be fetched, quietly do nothing. The section is
 * deliberately not hung on the `configForms.whileServed`
 * gate: that gate omits the registration entirely when the host does not serve this namespace, and
 * the omission is reported nowhere — the settings simply lack this page. A page that stands there
 * and states what it cannot do beats a page that silently never appears.
 *
 * The registration must especially never repeat: `slots.register` throws when the same id is
 * already registered, and that throw lands inside the slot registry's notification — React's own
 * subscription sits on that same notification, so the page stays visible, the controls stay lit,
 * and yet everything is dead to mouse and keyboard.
 * @param ctx - The browser-half plugin context.
 * @param store - The settings port read by both the panel and the settings page.
 * @param locale - The same language port the panel speaks through, handed to the page so the two do not drift.
 */
export function registerSettingsSection(ctx: unknown, store: PrefsStore, locale: LocaleSource): void {
  injectAt(ctx, ['slots', 'configForms'], '设置那一页没接上', (owner) => {
    /* The returned withdrawer hangs on its own `effect`: the settings form belongs to ui-settings'
     * service, which outlives this plugin — every attached subscriber must be given back, or each
     * reload leaves one more behind on it. */
    const attachForm = (): (() => void) => {
      const forms = serviceAt(owner, 'configForms')
      const getForm = forms?.get
      if (typeof getForm !== 'function') return () => undefined
      try {
        return store.attach((getForm as (namespace: string) => PrefsForm).call(forms, SETTINGS_NAMESPACE))
      } catch (error) {
        report('设置表单没接上，面板按出厂那几条画', error)
        return () => undefined
      }
    }
    serveOn(owner, attachForm, 'dsh-pathfinder: settings form')

    const slots = serviceAt(owner, 'slots') as SlotsService | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

    let registration: unknown = null
    const contribute = (): void => {
      if (registration !== null) return
      try {
        registration = slots.inject?.(SECTION_SLOT, () => slots.register?.({
          name: SECTION_SLOT,
          id: SETTINGS_NAMESPACE,
          order: SECTION_ORDER,
          /* Marked with the dictionary this outlet speaks, and the word is looked up per frame, so
           * a language switch redraws the row. */
          locale: LOCALE_NS,
          label: () => localeOf(locale).t(SECTION_WORD),
          /* The reading binds only when the slot actually renders: this layer does not read it early on the slot's behalf. */
          inject: () => ({ source: store, locale }),
        }, SettingsSection))
      } catch (error) {
        registration = null
        report('设置那一页没注册上', error)
      }
    }
    const withdraw = (): void => {
      if (registration === null) return
      const dispose = registration
      registration = null
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        report('设置那一页没撤下来', error)
      }
    }
    serveOn(owner, () => {
      contribute()
      return withdraw
    }, 'dsh-pathfinder: settings page')
  })
}