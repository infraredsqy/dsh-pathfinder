/* panel-check's DOM drivers, one copy each of press / type / pick. React tracks a controlled node's
 * value through the prototype setter: assigning `element.value` directly reads as "unchanged" to it,
 * so the typing and picking drivers go through the setter. Every write waits `settle` — the panel
 * reads back after each one. */

/**
 * The drivers over one booted fixture: `window` is the jsdom window, `act` React's flush, and
 * `inFlight` the fixture's own read-pass promise list — `settle` waits it out.
 */
export function makeDrivers({ window, act, inFlight }) {
  /* Wait out the panel's actions for this pass: after a write it reads once more, so wait until nothing is in flight. */
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      const pending = inFlight.splice(0)
      if (pending.length === 0) return
      await act(async () => { await Promise.all(pending) })
    }
  }
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
  }
  /** Types into the row's number box and commits with Enter. */
  const typeNumber = async (row, value) => {
    const field = row.querySelector('input')
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      field.focus()
      setValue.call(field, String(value))
      field.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => { field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await settle()
  }
  /** Picks one entry of a select by its value. */
  const setSelect = async (select, value) => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    await act(async () => {
      setValue.call(select, value)
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
  }
  return { settle, click, typeNumber, setSelect }
}
