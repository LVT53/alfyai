/**
 * The Document toolbar's one action list (Feature 2 · Artifacts, Slice 1,
 * T7; redesign §5.2/§9.2, Wave 2.5 Step 5). Pure data — no `@tiptap/*`, no
 * DOM — so `DocumentToolbar.svelte` can render every button without
 * importing the editor (T7.8's source-scan test enforces this for the
 * toolbar host), and `DocumentBody.svelte` (which DOES hold the live editor)
 * is the only place an action id turns into an `editor.chain()...run()`
 * call. `MobileToolbar.svelte` (T11) reuses this same list for its primary
 * row plus the `More` sheet, rather than a second, possibly-drifted set of
 * ids.
 *
 * Grouped to match the approved mockup's `B I S | H1 H2 | • 1. ☑ | ❝ ⊞ 🔗 |
 * ↶ ↷` layout exactly (including dropping the old "Code" button, which the
 * mockup's own toolbar never had): `group` is what `DocumentToolbar.svelte`
 * draws a divider between, never within.
 */
import type { LucideIcon } from "@lucide/svelte";
import {
	Bold,
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
	// Kept as a valid id (handleToolbarAction's switch, and any earlier
	// persisted metadata that might reference it) even though no toolbar
	// button produces it any more — the approved mockup's own toolbar never
	// had a Code button (redesign §9.2).
	| "code"
	| "table"
	| "link"
	| "undo"
	| "redo"
	// T12: opens DownloadSheet.svelte. Wave 2.5 Step 3 moved the trigger into
	// the panel header (`ArtifactPanelHeader`'s Download action, via
	// `DocumentBody.svelte`'s `registerPanelActions`) — kept as a valid id for
	// the same reason "code" is, not because a toolbar button still exists.
	| "download"
	// RV-1B, T6: opens VersionsSheet.svelte. Wave 2.5 Step 3 moved the
	// trigger into the panel header's version button — same note as above.
	| "history";

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
	/** Which toolbar group this belongs to (redesign §5.2's grouped, dividered layout). Consecutive actions with the same `group` sit together; a divider renders wherever it changes. */
	group: number;
}

export const DOCUMENT_TOOLBAR_ACTIONS: DocumentToolbarAction[] = [
	{
		id: "bold",
		icon: Bold,
		labelKey: "artifacts.document.toolbar.bold",
		group: 1,
	},
	{
		id: "italic",
		icon: Italic,
		labelKey: "artifacts.document.toolbar.italic",
		group: 1,
	},
	{
		id: "strike",
		icon: Strikethrough,
		labelKey: "artifacts.document.toolbar.strike",
		group: 1,
	},
	{
		id: "heading1",
		icon: Heading1,
		labelKey: "artifacts.document.toolbar.heading",
		labelParams: { n: 1 },
		group: 2,
	},
	{
		id: "heading2",
		icon: Heading2,
		labelKey: "artifacts.document.toolbar.heading",
		labelParams: { n: 2 },
		group: 2,
	},
	{
		id: "bulletList",
		icon: List,
		labelKey: "artifacts.document.toolbar.bullets",
		group: 3,
	},
	{
		id: "orderedList",
		icon: ListOrdered,
		labelKey: "artifacts.document.toolbar.numbers",
		group: 3,
	},
	{
		id: "taskList",
		icon: ListChecks,
		labelKey: "artifacts.document.toolbar.tasks",
		group: 3,
	},
	{
		id: "quote",
		icon: Quote,
		labelKey: "artifacts.document.toolbar.quote",
		group: 4,
	},
	{
		id: "table",
		icon: Table,
		labelKey: "artifacts.document.toolbar.table",
		momentary: true,
		group: 4,
	},
	{
		id: "link",
		icon: Link,
		labelKey: "artifacts.document.toolbar.link",
		group: 4,
	},
	{
		id: "undo",
		icon: Undo2,
		labelKey: "artifacts.document.toolbar.undo",
		momentary: true,
		group: 5,
	},
	{
		id: "redo",
		icon: Redo2,
		labelKey: "artifacts.document.toolbar.redo",
		momentary: true,
		group: 5,
	},
];
