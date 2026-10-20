/** The sheet injected at build time is assembled by `tools/build-client.mjs`; this only names it. */
declare module 'virtual:pf-styles' {
  const css: string
  export default css
}