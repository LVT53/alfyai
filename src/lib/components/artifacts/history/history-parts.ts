/**
 * History mode's ONE lazy entry (ruling 76, ruling 68's pattern): the panel
 * imports this with `import()` the first time a reader opens History, never
 * statically, so the rail, the toolbar and the previews are not in the chat
 * page's first load or in an editor's. What the panel needs before that (which
 * kinds have a History mode) is `history-previews.ts`'s tiny registry.
 */
export { default as HistoryMode } from "./HistoryMode.svelte";
