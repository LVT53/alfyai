/**
 * The Document toolbar's one action list (Feature 2 · Artifacts, Slice 1,
 * T7). Pure data — no `@tiptap/*`, no DOM — so `DocumentToolbar.svelte` can
 * render every button without importing the editor (T7.8's source-scan test
 * enforces this for the toolbar host), and `DocumentBody.svelte` (which DOES
 * hold the live editor) is the only place an action id turns into an
 * `editor.chain()...run()` call. `MobileToolbar.svelte` (T11) reuses this
 * same list for its primary row plus the `More` sheet, rather than a second,
 * possibly-drifted set of ids.
 */
import type { LucideIcon } from "@lucide/svelte";
import {
	Bold,
	Code,
	Heading1,
	Heading2,
	Italic,
	Link,
	List,
	ListChecks,
	ListOrdered,
	Quote,
	Redo2,
	Strikethrough,
	Table,
	Undo2,
} from "@lucide/svelte";
import type { I18nKey } from "$lib/i18n";

export type DocumentToolbarActionId =
	| "bold"
	| "italic"
	| "strike"
	| "heading1"
	| "heading2"
	| "bulletList"
	| "orderedList"
	| "taskList"
	| "quote"
	| "code"
	| "table"
	| "link"
	| "undo"
	| "redo";

export interface DocumentToolbarAction {
	id: DocumentToolbarActionId;
	icon: LucideIcon;
	labelKey: I18nKey;
	labelParams?: Record<string, number | string>;
	/**
	 * A one-shot command (insert a table, step the history) never shows a
	 * pressed state, unlike a mark/block toggle (bold, heading, …) whose
	 * pressed state mirrors `editor.isActive(...)` at the current selection.
	 */
	momentary?: boolean;
}

export const DOCUMENT_TOOLBAR_ACTIONS: DocumentToolbarAction[] = [
	{ id: "bold", icon: Bold, labelKey: "artifacts.document.toolbar.bold" },
	{ id: "italic", icon: Italic, labelKey: "artifacts.document.toolbar.italic" },
	{
		id: "strike",
		icon: Strikethrough,
		labelKey: "artifacts.document.toolbar.strike",
	},
	{
		id: "heading1",
		icon: Heading1,
		labelKey: "artifacts.document.toolbar.heading",
		labelParams: { n: 1 },
	},
	{
		id: "heading2",
		icon: Heading2,
		labelKey: "artifacts.document.toolbar.heading",
		labelParams: { n: 2 },
	},
	{
		id: "bulletList",
		icon: List,
		labelKey: "artifacts.document.toolbar.bullets",
	},
	{
		id: "orderedList",
		icon: ListOrdered,
		labelKey: "artifacts.document.toolbar.numbers",
	},
	{
		id: "taskList",
		icon: ListChecks,
		labelKey: "artifacts.document.toolbar.tasks",
	},
	{ id: "quote", icon: Quote, labelKey: "artifacts.document.toolbar.quote" },
	{ id: "code", icon: Code, labelKey: "artifacts.document.toolbar.code" },
	{
		id: "table",
		icon: Table,
		labelKey: "artifacts.document.toolbar.table",
		momentary: true,
	},
	{ id: "link", icon: Link, labelKey: "artifacts.document.toolbar.link" },
	{
		id: "undo",
		icon: Undo2,
		labelKey: "artifacts.document.toolbar.undo",
		momentary: true,
	},
	{
		id: "redo",
		icon: Redo2,
		labelKey: "artifacts.document.toolbar.redo",
		momentary: true,
	},
];
