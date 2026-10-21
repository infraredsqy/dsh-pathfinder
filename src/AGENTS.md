# src/ — Host half, model layer, and browser half: records read in, readings computed, panel drawn

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

**Words are not data.** The model says what a reading IS; the client says how it READS (`client/words.ts` for the spelling of a fact, `client/locales/` for the lookup tables). Nothing in `model/` or `host/` spells a sentence for a reader — a reader's language lives in the browser, so a sentence decided here could only ever be in the wrong one. Adding a language means adding a file beside `locales/zh.ts` with the same key set and one line in `locales/index.ts`; nothing else changes.

- `host/` — Host half: the plugin entry, the service for those record and note endpoints, boundary shapes, data fetching and writing, the settings schema. A refusal travels as a code (`failure.ts`), never as a sentence. Read when changing data fetching or boundary shapes
- `model/` — Model layer: the four records and the session-note shape, plus one instant → the reading at that instant; pure functions, no data fetching, no DOM. Read when changing how readings are computed or the record shapes
- `client/` — Browser half: the main panel, the settings section, the two mount points in the dispatch-center panel, and the language layer (`locale.ts` attaches to DSH's own language service; `locales/` holds the lookup tables). Read when changing the UI or when adding a language
