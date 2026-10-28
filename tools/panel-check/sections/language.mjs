/* 6f. The language switch: every word on both surfaces follows the port
 *
 * The shared locale-service stand-in is attached, switched and detached; the two word tables stay parallel.
 * Cut as-is from the single-file fixture (8743643): the criteria, the readings, the section
 * names and their order are untouched — this is a move, not a rewrite. */
import { fakeLocaleService } from '../../../tests/helpers/dsh-standins.mjs'

/** runLanguage */
export async function runLanguage(ctx) {
  const { client, React, act, createRoot, window, check } = ctx

  /* ---- 6f. The language switch: every word on both surfaces follows the port ----
   *
   * The point of moving words out of the model and host layers: the same panel, handed another
   * table, says another language — nothing re-registered, no word carried in a reading. DSH's
   * locale service is stood in for by the shared stand-in, in the shape `locale.ts` binds to
   * (register / bind / subscribe / getSnapshot); the port attaches to it, and a switch is one
   * call. `act` flushes the redraw; the panel's own fetch pass never runs for these mounts, so no
   * reading is spent on the language.
   */

  /** A fresh host div for one language mount, and its root rendered inside an `act` flush. */
  const languageHost = () => {
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    return host
  }
  const languageRoot = async (host, element) => {
    const root = createRoot(host)
    await act(async () => { root.render(element) })
    return root
  }

  /* 1. The settings page follows the language: its rows are keys in `prefs.ts`, spelled by the port. */
  const settingsLanguagePort = client.createLocalePort()
  const settingsLanguageService = fakeLocaleService('zh')
  settingsLanguagePort.attach(settingsLanguageService)
  const languageSettingsHost = languageHost()
  const languageSettingsRoot = await languageRoot(
    languageSettingsHost,
    React.createElement(client.SettingsSection, { locale: settingsLanguagePort }),
  )
  const settingsSaidZh = languageSettingsHost.textContent ?? ''
  await act(async () => { settingsLanguageService.switchTo('en') })
  const settingsSaidEn = languageSettingsHost.textContent ?? ''
  check(
    '语言一换，设置那一页当场换一套字：中文那一行换成英文那一行，中文不再留在页上',
    settingsSaidZh.includes('默认标签页')
      && settingsSaidEn.includes('Default tab')
      && settingsSaidEn.includes('默认标签页') === false,
    `中文时=${JSON.stringify(settingsSaidZh.slice(0, 48))} ｜ 英文时=${JSON.stringify(settingsSaidEn.slice(0, 48))}`,
  )
  await act(async () => { languageSettingsRoot.unmount() })

  /* 2. The bundled fallback: a deployment with no locale service keeps every word — Chinese, as before. */
  const fallbackLanguageHost = languageHost()
  const fallbackLanguageRoot = await languageRoot(
    fallbackLanguageHost,
    React.createElement(client.SettingsSection, { locale: client.createLocalePort() }),
  )
  const fallbackSaid = fallbackLanguageHost.textContent ?? ''
  check(
    '没接上语言服务：随包那份词典照样说话，这一页仍是中文（缺服务只降级功能，不丢字）',
    fallbackSaid.includes('默认标签页'),
    `页上=${JSON.stringify(fallbackSaid.slice(0, 48))}`,
  )
  await act(async () => { fallbackLanguageRoot.unmount() })

  /* 3. The main panel body follows the language. The panel component is taken the way the shell takes
   * it: boot a stand-in context, then read the registered service's `Panel`. */
  const languageApi = {}
  const languageCtx = {
    provide: (key, value) => { languageApi[key] = value },
    inject: (names, callback) => callback(languageCtx),
    get: () => undefined,
    effect: (run) => run(),
  }
  client.apply(languageCtx)
  const LanguagePanel = languageApi[client.SERVICE_KEY]?.Panel
  const bodyLanguagePort = client.createLocalePort()
  const bodyLanguageService = fakeLocaleService('zh')
  bodyLanguagePort.attach(bodyLanguageService)
  const languageBodyHost = languageHost()
  const languageBodyRoot = await languageRoot(
    languageBodyHost,
    React.createElement(LanguagePanel, { locale: bodyLanguagePort }),
  )
  const bodySaidZh = languageBodyHost.querySelector('.pf-none p')?.textContent ?? ''
  await act(async () => { bodyLanguageService.switchTo('en') })
  const bodySaidEn = languageBodyHost.querySelector('.pf-none p')?.textContent ?? ''
  check(
    '主面板正文也跟着换：没选中会话那句话换成英文，中文那句不再出现',
    bodySaidZh === client.WORD_TABLES.zh['panel.no-session']
      && bodySaidEn === client.WORD_TABLES.en['panel.no-session']
      && bodySaidZh !== bodySaidEn,
    `中文时=${JSON.stringify(bodySaidZh)} ｜ 英文时=${JSON.stringify(bodySaidEn)}`,
  )
  await act(async () => { languageBodyRoot.unmount() })

  /* 4. The chrome follows too: a port whose reads never answer leaves the panel on its loading pass,
   * which still draws the tab row — six words, swapped by the switch. */
  const neverAnswers = new Promise(() => undefined)
  const pendingPort = {
    source: 'none',
    read: () => neverAnswers,
    readSessions: () => neverAnswers,
    say: async () => ({ ok: false, code: 'no-write-channel' }),
    write: async () => ({ ok: false, code: 'no-write-channel' }),
    setPolicy: async () => ({ ok: false, code: 'no-write-channel' }),
    readConfig: () => neverAnswers,
    setConfig: async () => ({ ok: false, code: 'no-write-channel' }),
  }
  const chromeLanguagePort = client.createLocalePort()
  const chromeLanguageService = fakeLocaleService('zh')
  chromeLanguagePort.attach(chromeLanguageService)
  const languageChromeHost = languageHost()
  const languageChromeRoot = await languageRoot(
    languageChromeHost,
    React.createElement(LanguagePanel, { locale: chromeLanguagePort, sessionId: 's1', port: pendingPort }),
  )
  const chromeSaidZh = languageChromeHost.textContent ?? ''
  await act(async () => { chromeLanguageService.switchTo('en') })
  const chromeSaidEn = languageChromeHost.textContent ?? ''
  const CHROME_ZH = ['地图', '明细', '指令', '问题', '设置']
  const CHROME_EN = ['Map', 'Detail', 'Instructions', 'Issues', 'Settings']
  check(
    '面板骨架也跟着换：五个标签一套字换成另一套，英文那一边一个中文字都不留',
    CHROME_ZH.every((word) => chromeSaidZh.includes(word))
      && CHROME_EN.every((word) => chromeSaidEn.includes(word))
      && ['地图', '明细', '指令'].every((word) => chromeSaidEn.includes(word) === false),
    `中文时=${JSON.stringify(chromeSaidZh.slice(0, 56))} ｜ 英文时=${JSON.stringify(chromeSaidEn.slice(0, 56))}`,
  )
  await act(async () => { languageChromeRoot.unmount() })

  /* 5. The two lookup tables are parallel: same keys, every one carrying a word — except the "head" that
   * a language leading with the number deliberately leaves empty. */
  const zhKeys = Object.keys(client.WORD_TABLES.zh).sort()
  const enKeys = Object.keys(client.WORD_TABLES.en).sort()
  const emptyWords = (dict) => Object.keys(dict).filter((key) => dict[key].length === 0 && key.endsWith('.head') === false)
  check(
    '两本词典键是同一套、每枚键都有字（只有语言把数字放在前面时那枚 head 可以空着）',
    zhKeys.length > 0
      && JSON.stringify(zhKeys) === JSON.stringify(enKeys)
      && emptyWords(client.WORD_TABLES.zh).length === 0
      && emptyWords(client.WORD_TABLES.en).length === 0,
    `键 ${String(zhKeys.length)} 枚 ｜ 只在一本里的=${JSON.stringify(zhKeys.filter((key) => enKeys.includes(key) === false).concat(enKeys.filter((key) => zhKeys.includes(key) === false)))} ｜ 空着的=${JSON.stringify([...emptyWords(client.WORD_TABLES.zh), ...emptyWords(client.WORD_TABLES.en)])}`,
  )

  /* 6. Detaching the service falls back to the bundled table on the spot. */
  const detachLanguagePort = client.createLocalePort()
  const detachLanguageService = fakeLocaleService('zh')
  detachLanguagePort.attach(detachLanguageService)
  await act(async () => { detachLanguageService.switchTo('en') })
  const attachedSeat = detachLanguagePort.getSnapshot().t('seat.label')
  detachLanguagePort.attach(null)
  const detachedSeat = detachLanguagePort.getSnapshot().t('seat.label')
  check(
    '把语言服务摘掉：当场回到随包那份中文，不留上一个语言的尾巴',
    attachedSeat === client.WORD_TABLES.en['seat.label']
      && detachedSeat === '调度中心'
      && detachLanguagePort.getSnapshot().active === client.FALLBACK_LOCALE,
    `接上英文时=${JSON.stringify(attachedSeat)} ｜ 摘掉后=${JSON.stringify(detachedSeat)} ｜ 在册语言=${detachLanguagePort.getSnapshot().active}`,
  )

}
