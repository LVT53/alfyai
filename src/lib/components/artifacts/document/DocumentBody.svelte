<script module lang="ts">
/**
 * The editor module's cached promise, at MODULE scope (mirrors
 * `DocumentWorkspace.svelte`'s own `artifactBodyModulePromises` — a `<script>`
 * block's top-level state is per-INSTANCE, but `<script module>` is shared
 * across every instance this file ever creates), so `import("./document-editor")`
 * — the whole cost of Tiptap/ProseMirror — resolves at most once no matter
 * how many times a `DocumentBody` mounts, unmounts, or is asked to load a
 * different document (T7.1, T7.8).
 */
import type * as DocumentEditorModule from "./document-editor";

let editorModulePromise: Promise<typeof DocumentEditorModule> | null = null;

function loadEditorModule(): Promise<typeof DocumentEditorModule> {
	if (!editorModulePromise) {
		// A rejected import must not poison the cache forever: the "Error" state's
		// Retry button (`retryLoad` below) has to be able to make the browser
		// actually try the network request again after a transient chunk-load
		// failure, not replay the same dead promise on every click.
		editorModulePromise = import("./document-editor").catch((error) => {
			editorModulePromise = null;
			throw error;
		});
	}
	return editorModulePromise;
}
</script>

<script lang="ts">
/**
 * The Document body the panel's registry loads (Feature 2 · Artifacts,
 * Slice 1, T7): tab strip + toolbar + editor host. **Not** the editor
 * itself — `document-editor.ts` (imported only through `loadEditorModule`
 * above) is the one module in this feature that ever imports `@tiptap/*`,
 * so a chat page that never opens a Document never pays for it. This file,
 * `DocumentToolbar.svelte` and `toolbar-actions.ts` all stay clean of that
 * import (T7.8's source-scan test enforces it for this file and the
 * toolbar).
 *
 * Takes Slice 0's `ArtifactBodyProps` verbatim (`slice-1.md` Task T7) — the
 * panel resolves this component through `ARTIFACT_BODIES.document` with a
 * cached-promise loader, so the factory's own internal shape (the editor
 * module, the autosave loop) is this slice's business alone.
 *
 * `DocumentWorkspace.svelte` reuses ONE `DocumentBody` instance across every
 * open Document (there is no `{#key}` around it — confirmed by reading that
 * file — so switching the active tab only changes this component's props,
 * it does not remount it). The effect below therefore keys its whole
 * load-and-mount sequence on the `artifactId` PROP, not on component mount,
 * so opening a second Document while this body is already showing a first
 * one tears down the first editor and mounts a fresh one against the new id
 * — the module stays cached (above), only the per-document state reloads.
 */
import { onDestroy, tick, untrack } from "svelte";
import { cubicIn, cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import {
	acknowledgeDocumentReviewBlocks,
	askAlfyInComment,
	createArtifactComment,
	createDocumentCopy,
	fetchArtifact,
	fetchDocumentReviewState,
	resolveArtifactComment,
	saveArtifactBody,
	saveDocumentTabs,
} from "$lib/client/api/artifacts";
import { ApiError } from "$lib/client/api/http";
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";
import RefusalNotice from "$lib/components/artifacts/RefusalNotice.svelte";
import ReviewBar from "$lib/components/artifacts/ReviewBar.svelte";
import { t } from "$lib/i18n";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import { makeAnchor } from "$lib/shared/artifact-document/anchor";
import {
	type DocumentBlock,
	mapBlocksToTabs,
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { isPhoneViewport, watchPhoneViewport } from "$lib/utils/viewport.svelte";
import {
	MOTION_DURATION,
	MOTION_EASING,
	prefersReducedMotion,
	reducedMotionAnimate,
	reducedMotionAware,
} from "$lib/utils/motion";
import {
	reconstructDocumentPatch,
	type DocumentAlfyActivity,
} from "./alfy-activity";
import AlfyWriting from "./AlfyWriting.svelte";
import { COMPOSER_BUBBLE_SIZE, computeBubblePlacement } from "./bubble-placement";
import { documentTabsFromCardMetadata } from "./card-view";
import CommentsSheet from "./CommentsSheet.svelte";
import {
	createDocumentAutosave,
	type DocumentAutosaveHandle,
	type DocumentAutosaveResult,
} from "./document-autosave";
// `DocumentEditorModule` itself (the `typeof import("./document-editor")`
// namespace every `...Fn` closure below is typed against) comes from the
// `<script module>` block above — it is already visible here, and importing
// it a second time in this instance script is a duplicate-identifier error.
import type {
	AlfyChangeEntry,
	ChangePillEntry,
	CommentAnchorTarget,
	Editor,
} from "./document-editor";
import DocumentToolbar from "./DocumentToolbar.svelte";
import DownloadSheet from "./DownloadSheet.svelte";
import MarginPanel from "./MarginPanel.svelte";
import MobileToolbar from "./MobileToolbar.svelte";
import SelectionBubble from "./SelectionBubble.svelte";
import Tabs from "./Tabs.svelte";
import type { DocumentToolbarActionId } from "./toolbar-actions";
import VersionsSheet from "./VersionsSheet.svelte";

let {
	artifactId,
	title,
	conversationId: panelConversationId,
	alfyActivity = null,
	onDirtyChange,
	onBodyChange,
	registerPanelActions,
	onCommentCountChange,
}: ArtifactBodyProps = $props();

type LoadState = "loading" | "ready" | "load_error" | "not_found";
type SaveNotice = "offline" | "tooLarge" | "conflict" | "deleted" | null;

let loadState = $state<LoadState>("loading");
let saveNotice = $state<SaveNotice>(null);
/** Mirrors every `onDirtyChange?.(...)` call so the toolbar's own "Saved"/"Saving…" state (redesign §5.2/§9.2) can read it locally, without waiting on the panel's round trip. */
let isDirty = $state(false);
let versionNumber = $state<number | null>(null);
/**
 * RV-1B, coordinator item 6: the last body hash this component KNOWS is
 * stored — from the initial load, from a reload that followed someone
 * else's write (a comment mutation or Alfy's own edit bumping the version),
 * or from this component's own most recent successful save. The autosave
 * loop sends this as `guard.baseHash` on every save (`bindAutosave` below),
 * so a second tab's save that landed in between is detected as `stale`
 * instead of silently overwritten — `expectVersion` alone cannot catch
 * this, because ruling 47's coalescing lets two tabs' saves both legally
 * target the SAME, unmoved version number.
 */
let knownBodyHash = $state<string | null>(null);
let activeActionIds = $state<Set<DocumentToolbarActionId>>(new Set());
// T9: the tab strip. `Tabs.svelte` owns its own add/rename/delete UI and
// hands back the new list through `onChange`; this body's only job is to
// persist it (through the SAME body route every edit uses,
// `saveDocumentTabs`) and track which one is active. Switching the active
// tab never touches the editor — `handleTabActivate` only updates
// `activeTabId`, so a tab switch cannot remount or reload the document
// (T9.1).
let tabs = $state<DocumentTab[]>([]);
let activeTabId = $state<string>("");
// The current binding: starts as the prop, but T7.10's "save a copy" escape
// hatch re-points it at a BRAND NEW artifact without the panel's own
// `activeDocumentId` changing — the panel still thinks it is showing the
// old (now-deleted) id, but this body keeps working against the new one.
// See the open question in the slice report: a follow-up should thread a
// rebind callback through the panel so the tab/breadcrumb catches up too.
let boundArtifactId = $state(untrack(() => artifactId));
let editorEl = $state<HTMLDivElement | undefined>();

let editor: Editor | null = null;
let autosave: DocumentAutosaveHandle | null = null;
let readMarkdownFn: typeof DocumentEditorModule.readMarkdown | null = null;
/** Redesign §5.2 "Tabs switch sections", Wave 2.5 Step 5 — see `document-editor.ts`'s own doc comment. */
let setActiveDocumentTabFn:
	| typeof DocumentEditorModule.setActiveDocumentTab
	| null = null;
/** Review 2.5 (rd/review-2-5.md:191-197) — see `document-editor.ts`'s own doc comment. */
let appendEmptyTabSectionFn:
	| typeof DocumentEditorModule.appendEmptyTabSection
	| null = null;
let editorReady = $derived(loadState === "ready");

/**
 * The toolbar's own right-aligned save state (redesign §5.2/§9.2: "the
 * existing save notices move into the toolbar's right end"). `offline`/
 * `conflict` reuse `saveNotice` for a compact label; the detailed sentence
 * (plus, for `tooLarge`/`deleted`, an action) stays on the existing
 * `.document-save-banner` below — those two states are not compact-label
 * material, so they are not duplicated here.
 */
type ToolbarSaveState = "saving" | "saved" | "offline" | "conflict";
let toolbarSaveState = $derived<ToolbarSaveState>(
	saveNotice === "offline"
		? "offline"
		: saveNotice === "conflict"
			? "conflict"
			: isDirty
				? "saving"
				: "saved",
);

// ---- T8 live: marks.ts's surface, reached only through document-editor.ts's
// lazy re-exports (never a static "./marks" import from this file). ---------
let applyAlfyChangesFn: typeof DocumentEditorModule.applyAlfyChanges | null =
	null;
let keepChangeFn: typeof DocumentEditorModule.keepChange | null = null;
let undoChangeFn: typeof DocumentEditorModule.undoChange | null = null;
let remarkChangeFn: typeof DocumentEditorModule.remarkChange | null = null;
let changeDocRangeFn: typeof DocumentEditorModule.changeDocRange | null = null;
let scrollToChangeFn: typeof DocumentEditorModule.scrollToChange | null = null;
/** Wave 2.5 Step 10: pushes `pendingChanges` into the editor's own widget-decoration plugin — see `change-pill-decoration.ts`. */
let setChangePillsFn: typeof DocumentEditorModule.setChangePills | null = null;
let summarizeRefusalsFn: typeof DocumentEditorModule.summarizeRefusals | null =
	null;
let refusalReasonI18nKeyFn:
	| typeof DocumentEditorModule.refusalReasonI18nKey
	| null = null;
/** Wave 2.5 Step 9/11: the Ask-Alfy chain's own decoration write sides — see `alfy-writing-decoration.ts`'s header. */
let setAlfyWritingBlockFn:
	| typeof DocumentEditorModule.setAlfyWritingBlock
	| null = null;
let setSelectionPendingFn:
	| typeof DocumentEditorModule.setSelectionPending
	| null = null;
let setRefusedLinesFn: typeof DocumentEditorModule.setRefusedLines | null =
	null;
let blockRectFn: typeof DocumentEditorModule.blockRect | null = null;
let selectAndScrollToBlockFn:
	| typeof DocumentEditorModule.selectAndScrollToBlock
	| null = null;

// ---- T10: comments margin and the selection bubble -------------------------
// Kept to this one block: `loadMarkdownFn`/`readSelectionContextFn` mirror
// `readMarkdownFn` above (captured once the lazy module resolves, in
// `runLoad`), `comments`/`blocks` feed `MarginPanel`'s live anchor
// resolution, and `selectionBubble` is the live selection's own screen
// position plus its (already-validated) `Anchor`, or `null` when there is
// nothing to show. `contentEl` is a `$state` ref (Svelte 5: a `bind:this`
// an effect/handler reads must be) so `updateSelectionBubble` can measure it.
let loadMarkdownFn: typeof DocumentEditorModule.loadMarkdown | null = null;
let readSelectionContextFn:
	| typeof DocumentEditorModule.readSelectionAnchorContext
	| null = null;
let comments = $state<ArtifactComment[]>([]);
let blocks = $state<DocumentBlock[]>([]);
let selectionBubble = $state<
	| {
			x: number;
			y: number;
			placement: "above" | "below";
			anchor: Anchor;
			/** The raw selected text (`readSelectionAnchorContext`'s own `quote`) — `SelectionBubble.svelte` truncates it for display. */
			quote: string;
	  }
	| null
>(null);
let contentEl = $state<HTMLDivElement | undefined>();

// ---- Redesign §3.2, Wave 2.5 Step 7: the rail's two-way link ---------------
// `commentAnchors` is whatever `MarginPanel.svelte` last resolved (its own
// `resolveTextAnchor` work, reported up rather than redone here);
// `activeCommentId` is whichever thread is currently linked — hover/focus on
// its card in the rail, or its own words in the text having been
// clicked/focused — driving BOTH the rail's `.is-active` card chrome and the
// editor's own decoration. `focusCommentRequest` is a ONE-SHOT signal (a
// bumped token, never just the id) for "scroll the rail to and focus THIS
// thread's card" — kept separate from `activeCommentId` on purpose: merely
// hovering a card must never also yank scroll/keyboard focus toward it.
let commentAnchors = $state<CommentAnchorTarget[]>([]);
let activeCommentId = $state<string | null>(null);
let focusCommentRequest = $state<{ commentId: string; token: number } | null>(
	null,
);
let setCommentAnchorsFn:
	| typeof DocumentEditorModule.setCommentAnchors
	| null = null;
let scrollToCommentAnchorFn:
	| typeof DocumentEditorModule.scrollToCommentAnchor
	| null = null;

// ---- Wave 2.5 Step 8: the rail's phone sheet / narrow-panel drawer --------
// `.document-content`'s own CSS mirrors this exact threshold under
// `@container (min-width: 820px)` — the two must stay in step, since this is
// the JS half deciding whether `CommentsSheet` should even mount, and the
// CSS half is what actually hides the inline rail at the same width.
const NARROW_PANEL_THRESHOLD_PX = 820;
let documentBodyEl = $state<HTMLDivElement | undefined>();
let panelContainerWidth = $state(0);
/** The review bar's own live rendered height (Review 2.5, rd/review-2-5.md:98-108) — read by the effect below and used to reserve enough bottom padding under the last paragraph. */
let reviewBarSlotEl = $state<HTMLDivElement | undefined>();
let reviewBarHeight = $state(0);
let isPhone = $state(isPhoneViewport());
/** `0` means "not measured yet" (no ResizeObserver in this environment, e.g. jsdom) — treated as "not narrow" rather than a false-positive drawer. */
let isNarrowPanel = $derived(
	panelContainerWidth > 0 && panelContainerWidth < NARROW_PANEL_THRESHOLD_PX,
);
let commentsOverlayOpen = $state(false);
/** commentId -> the changeId its own `@Alfy` reply produced this session (`maybeAskAlfy` below) — ephemeral, like `pendingChanges` itself. */
let changeIdByCommentId = $state<Map<string, string>>(new Map());
let changeChipByCommentId = $derived.by(() => {
	const map: Record<string, "pending" | "kept" | "undone"> = {};
	for (const [commentId, changeId] of changeIdByCommentId) {
		const pending = pendingChanges.get(changeId);
		if (pending) map[commentId] = pending.status;
	}
	return map;
});
// ---- end redesign §3.2 -----------------------------------------------

// ---- T8 live: Alfy's chat-turn edits appear in the open Document ----------
// `alfyWritingLabel` drives the shimmer; `pendingChanges` drives the inline
// pill (one per applied op, keyed by `changeId`) AND the review bar;
// `refusalNotice` is `null` until a landed call actually refused something.
// `handledActivityKey` guards against reprocessing the SAME settled call
// twice (an unrelated re-render must not re-apply marks or re-open a notice
// that Keep/Undo already resolved) — the "loadedArtifactId" guard above is
// this block's own model.
/** Redesign §4.2 item 4: "shown for at least 600ms even when the call is faster, so it is seen." */
const ALFY_WRITING_MIN_VISIBLE_MS = 600;
/** Redesign §7.2 #13: "the pill leaves after 1.4s" once Kept. */
const KEEP_SETTLE_MS = 1400;
/** Redesign §7.2 #14: "the pill shows 'Undone · Redo' for 5s". */
const UNDO_SETTLE_MS = 5000;
/**
 * Redesign §7.2 #12: "rises from below the text column and fades in / sinks
 * and fades out" — `fly`'s own `y` covers "rises"/"sinks", its built-in
 * opacity interpolation covers the fade; `reducedMotionAware` collapses both
 * to instant under `prefers-reduced-motion` (motion.ts's own header: Svelte's
 * `css` transitions interpolate styles directly, so app.css's global
 * animation-duration override cannot reach them — unlike the CSS `@keyframes`
 * pill-arrival animation in `ChangeBar.svelte`, which needs no such wrapper).
 */
const reviewBarFly = reducedMotionAware(fly);

interface PendingAlfyChange {
	entry: AlfyChangeEntry;
	status: "pending" | "kept" | "undone";
	/**
	 * Ruling 61: true when this pending change was restored from a reload for
	 * a block Alfy ADDED (no parent counterpart) — Undo deletes it rather than
	 * restoring empty content (`marks.ts`'s own `isNewBlock` doc comment).
	 * Never set for a live-session change (the live path always knows exactly
	 * what to restore, via `entry.previousMarkdown`).
	 */
	isNewBlock?: boolean;
	/** Captured from `blocks` state right before Undo replaces the text — Redo's own restore target. */
	appliedMarkdown?: string;
	/** Captured right before Undo removes the mark structurally — the pill's own fallback anchor while `status` is `"undone"` (`change-pill-decoration.ts`'s own `fallbackPos`). */
	fallbackPos?: number;
}
let alfyWritingLabel = $state<string | null>(null);
let pendingChanges = $state<Map<string, PendingAlfyChange>>(new Map());
/** The review bar's own stepper position (0-based) into the CURRENTLY pending entries, in Map-insertion order. */
let reviewIndex = $state(0);
/** Keyed by changeId — cleared by Redo (cancels the pending removal) or by `removePendingChange` itself; a plain Map, never `$state`, since it drives no render on its own. */
const undoSettleTimers = new Map<string, ReturnType<typeof setTimeout>>();
let refusalNotice = $state<{
	message: string;
	items: { label: string; reason: string }[];
	seeChangeLabel: string | null;
	firstAppliedChangeId: string | null;
	/** Every refused block this call touched — `setRefusedLinesFn`'s own dashed-gutter-rule target, and (its first entry) "Ask again"'s own return point. */
	refusedBlockIds: string[];
} | null>(null);
let handledActivityKey = "";
// ---- end T8 live -----------------------------------------------------

function updateBlocksFromMarkdown(markdown: string): void {
	blocks = parseDocument(markdown, { mint: false }).blocks;
}

/**
 * `Tabs.svelte`'s badge (redesign §5.2): how many of THIS tab's own comment
 * THREADS (root comments, never replies) are still open. `mapBlocksToTabs`
 * (`shared/artifact-document/blocks.ts`) owns the block→tab walk itself —
 * the SAME one `MarginPanel.svelte`'s own per-tab comment scoping uses, so
 * the two never drift apart — recomputed here (rather than read back out of
 * the editor's decoration) because this needs to run whenever `comments`
 * changes too, not just `tabs`/`blocks`.
 */
function computeTabBadgeCounts(
	docBlocks: DocumentBlock[],
	docComments: ArtifactComment[],
	docTabs: DocumentTab[],
): Record<string, number> {
	const blockIdToTabId = mapBlocksToTabs(docBlocks, docTabs);
	if (blockIdToTabId.size === 0) return {};
	const counts: Record<string, number> = {};
	for (const comment of docComments) {
		if (comment.status !== "open") continue;
		if (!comment.anchor || comment.anchor.kind !== "text") continue;
		const tabId = blockIdToTabId.get(comment.anchor.blockId);
		if (!tabId) continue;
		counts[tabId] = (counts[tabId] ?? 0) + 1;
	}
	return counts;
}

let tabBadgeCounts = $derived(computeTabBadgeCounts(blocks, comments, tabs));

function updateSelectionBubble(): void {
	if (!editor || !readSelectionContextFn || !contentEl) {
		clearSelectionBubble();
		return;
	}
	const context = readSelectionContextFn(editor);
	if (!context) {
		clearSelectionBubble();
		return;
	}
	const anchor = makeAnchor(context);
	if (!anchor) {
		clearSelectionBubble();
		return;
	}
	// `computeBubblePlacement` (bubble-placement.ts) converts the selection's
	// VIEWPORT rect into this scroll container's own local coordinate space —
	// scroll offset included — and clamps/flips it into the container's
	// currently visible window. `null` means the selection has scrolled fully
	// out of view: hide the bubble rather than pin it to nothing visible.
	// Placement is computed against the GROWN composer's own footprint
	// (`COMPOSER_BUBBLE_SIZE`, redesign §9.2's "composer-height-aware flip"),
	// not the small resting pill's, so growing in place never needs a
	// re-flip — see `bubble-placement.ts`'s own doc comment on the constant.
	const hostRect = contentEl.getBoundingClientRect();
	const placement = computeBubblePlacement(
		context.rect,
		{
			hostRect,
			scrollLeft: contentEl.scrollLeft,
			scrollTop: contentEl.scrollTop,
			clientWidth: contentEl.clientWidth,
			clientHeight: contentEl.clientHeight,
		},
		COMPOSER_BUBBLE_SIZE,
	);
	if (!placement) {
		clearSelectionBubble();
		return;
	}
	selectionBubble = { ...placement, anchor, quote: context.quote };
	// Redesign §4.2 item 2: "the selection keeps a dashed amber 'pending'
	// highlight so you still see what you are asking about" — the live
	// selection's own raw positions, captured now rather than resolved later
	// (alfy-writing-decoration.ts's own header comment explains why raw
	// positions are enough for this one, unlike a comment anchor).
	setSelectionPendingFn?.(editor, {
		from: editor.state.selection.from,
		to: editor.state.selection.to,
	});
}

/** Clears the bubble/composer AND its own pending highlight together — the one exit path every "nothing to show" branch above and `dismissSelectionBubble` below share, so the two states can never drift apart. */
function clearSelectionBubble(): void {
	selectionBubble = null;
	if (editor) setSelectionPendingFn?.(editor, null);
}

/**
 * Review 2.5 (rd/review-2-5.md:198-207): the one DOM reach into
 * `SelectionBubble.svelte`'s own rendered output this Tiptap-free component
 * never hands back a ref for — same query shape as
 * `VersionsSheet.svelte`/`DownloadSheet.svelte`'s own `findAnchorEl`.
 * `data-testid="selection-bubble"` is the toolbar itself on a phone
 * (`.selection-docked-bar`) and its wrapper on desktop
 * (`.selection-bubble`, with `.selection-bubble-toolbar` nested inside) —
 * either way, its first non-disabled `button` is "Ask Alfy". `false` when
 * nothing is open to focus (no live selection, or the bubble/composer never
 * mounted) — the caller (`document-editor.ts`'s own Tab handler) lets a
 * plain Tab fall through to its normal behaviour in that case.
 */
function focusSelectionPill(): boolean {
	if (!selectionBubble) return false;
	const button = document.querySelector<HTMLButtonElement>(
		'[data-testid="selection-bubble"] button:not([disabled])',
	);
	if (!button) return false;
	button.focus();
	return true;
}

/**
 * Redesign §4.4 "Escape returns to the text with the selection intact":
 * dismissing while keyboard focus is still INSIDE the bubble/composer
 * (`focusSelectionPill` above, or the composer's own Cancel/Escape) would
 * otherwise strand focus at `<body>` once the focused button/textarea is
 * unmounted — refocusing the editor (never collapses `state.selection` on
 * its own) is what actually leaves the selection visibly intact. A
 * mouse-driven dismiss (clicking elsewhere) never has focus inside the
 * bubble to begin with, so this branch is a no-op for that path.
 */
function dismissSelectionBubble(): void {
	const hadBubbleFocus = !!document.activeElement?.closest(
		'[data-testid="selection-bubble"]',
	);
	clearSelectionBubble();
	// `editor.view.focus()` directly — Tiptap's own `commands.focus()`
	// defers the actual DOM focus (a `requestAnimationFrame`, for its own
	// cross-browser reasons), which loses this race: Svelte's reactive
	// removal of the (still-focused, until this call) pill button ran
	// first, and the browser's own "focused element left the DOM" default
	// already moved focus to `<body>` before the deferred call ever fired.
	// ProseMirror's own `EditorView.focus()` moves DOM focus immediately.
	if (hadBubbleFocus) editor?.view?.focus();
}

/**
 * Re-fetches this artifact's comments (and, if Alfy's own change bumped the
 * version, the body too) after any comment mutation. `loadMarkdownFn` swaps
 * the LIVE editor content the same way an Undo does (Contracts: a fresh
 * `setContent`, ids re-absorbed) — never a ProseMirror-position-based patch,
 * so it cannot land in the wrong place.
 */
async function refreshAfterCommentChange(): Promise<void> {
	try {
		const conversationId = panelConversationId ?? null;
		const detail = await fetchArtifact(boundArtifactId, conversationId);
		comments = detail.comments;
		const newBody = detail.artifact.body ?? "";
		if (detail.artifact.versionNumber !== versionNumber) {
			versionNumber = detail.artifact.versionNumber;
			knownBodyHash = detail.artifact.bodyHash;
			if (editor && loadMarkdownFn) loadMarkdownFn(editor, newBody);
		}
		updateBlocksFromMarkdown(newBody);
	} catch {
		// Best-effort: the margin simply shows slightly stale state until the
		// next successful refresh (the next mutation, or reopening the panel).
	}
}

function mentionsAlfy(text: string): boolean {
	return /@alfy\b/i.test(text);
}

/** `Anchor` is a union across the whole family (text/node/point) — a Document comment's is always `"text"`, the only kind that names a block. */
function textAnchorBlockId(anchor: Anchor | null | undefined): string | null {
	return anchor?.kind === "text" ? anchor.blockId : null;
}

/** The block an `@Alfy` reply's own thread is anchored to — a reply carries no anchor of its own, only its thread root does. */
function findThreadBlockId(commentId: string): string | null {
	for (const comment of comments) {
		if (comment.id === commentId) return textAnchorBlockId(comment.anchor);
		for (const reply of comment.replies) {
			if (reply.id === commentId) return textAnchorBlockId(comment.anchor);
		}
	}
	return null;
}

/**
 * T8 live: "`@Alfy` comment replies that apply a change go through the same
 * marks path." The comment route never returns the ops it tried (only
 * `{outcome, applied, refused, version}` — `comments.ts`'s
 * `AlfyCommentReplyResult`), but every `@Alfy` patch is scoped to exactly
 * ONE block (the thread's own anchor), so a synthetic single-op `PatchSet`
 * targeting that block, run through the SAME `reconstructDocumentPatch` +
 * `applyAlfyChangesFn` the tool-call path uses, marks it correctly — as
 * `replaceBlock` (never `insertText`/`replaceRange`, the two ops
 * `applyAlfyChangeMarks` would try to mark PRECISELY): the browser was never
 * told which of the three op kinds the server actually chose, so marking the
 * whole block is the honest, always-correct representation of "this block
 * changed," not a guess at a narrower range.
 */
async function maybeAskAlfy(
	commentId: string,
	blockId: string | null,
): Promise<void> {
	const conversationId = panelConversationId ?? null;
	const previousBlocksById = new Map(blocks.map((b) => [b.id, b]));

	// Redesign §4.2 item 4 / Wave 2.5 Step 11: "Alfy is writing" IN PLACE on
	// the target block — possible here (unlike the T8-live chat-tool-call
	// path's own global `AlfyWriting.svelte` banner) because this block is
	// known SYNCHRONOUSLY: it is the thread's own anchor, not a tool call's
	// still-streaming input. Shown for at least `ALFY_WRITING_MIN_VISIBLE_MS`
	// even when the call settles faster, so a fast reply is still seen —
	// scheduled, never awaited, so it cannot delay applying the result below.
	const writingBlockSet = Boolean(blockId && editor && setAlfyWritingBlockFn);
	if (writingBlockSet && blockId && editor && setAlfyWritingBlockFn) {
		setAlfyWritingBlockFn(editor, {
			blockId,
			tagLabel: $t("artifacts.document.writing.tag"),
		});
	}
	const writingStartedAt = Date.now();
	function scheduleClearAlfyWritingBlock(): void {
		if (!writingBlockSet) return;
		const remaining = Math.max(
			0,
			ALFY_WRITING_MIN_VISIBLE_MS - (Date.now() - writingStartedAt),
		);
		const clear = () => {
			if (editor && setAlfyWritingBlockFn) setAlfyWritingBlockFn(editor, null);
		};
		if (remaining === 0) clear();
		else setTimeout(clear, remaining);
	}

	let outcome: Awaited<ReturnType<typeof askAlfyInComment>>["outcome"] | null =
		null;
	try {
		const result = await askAlfyInComment(
			boundArtifactId,
			commentId,
			conversationId,
		);
		outcome = result.outcome;
	} catch {
		// The reply (or refusal) already lives in the thread when the call
		// succeeds; a failed call here just leaves the thread as it was — the
		// next refresh (another comment, a reload) will show the truth again.
	} finally {
		await refreshAfterCommentChange();
		scheduleClearAlfyWritingBlock();
	}

	if (outcome !== "applied" || !blockId || !editor || !applyAlfyChangesFn) {
		return;
	}
	const previous = previousBlocksById.get(blockId);
	const reconstructed = reconstructDocumentPatch(
		{
			key: `alfy-comment-${commentId}`,
			artifactId: boundArtifactId,
			toolName: "edit_artifact",
			status: "applied",
			label: null,
			patches: [{ op: "replaceBlock", blockId, baseHash: previous?.hash ?? "" }],
			refusedBlocks: [],
			appliedCount: 1,
		},
		previousBlocksById,
	);
	if (!reconstructed) return;
	const entries = applyAlfyChangesFn(editor, reconstructed, reconstructed.patch);
	const nextPending = new Map(pendingChanges);
	// Redesign §3.2's change chip: THIS comment (the `@Alfy` reply that just
	// applied) is the one message whose card should carry it — one op per
	// reply (the doc comment above: "every `@Alfy` patch is scoped to exactly
	// ONE block"), so the first entry is always the whole story.
	if (entries[0]) {
		const nextChangeIds = new Map(changeIdByCommentId);
		nextChangeIds.set(commentId, entries[0].changeId);
		changeIdByCommentId = nextChangeIds;
	}
	for (const entry of entries) {
		nextPending.set(entry.changeId, { entry, status: "pending" });
	}
	pendingChanges = nextPending;
}

/** Returns the created comment's own id — the selection composer's "send" (`handleSelectionSubmit` below) needs it to find the new card for its own travel animation. */
async function postComment(anchor: Anchor, body: string): Promise<string> {
	const conversationId = panelConversationId ?? null;
	const created = await createArtifactComment(
		boundArtifactId,
		anchor,
		body,
		undefined,
		conversationId,
	);
	await refreshAfterCommentChange();
	if (mentionsAlfy(body)) {
		await maybeAskAlfy(created.id, textAnchorBlockId(anchor));
	}
	return created.id;
}

/**
 * The selection composer's "Send" (redesign §7.2 #9: "the composer's box
 * travels to the new thread's place in the margin and becomes the card; the
 * card fades in during the second half"). `sourceRect` is `null` on a phone
 * (`SelectionBubble.svelte`'s own doc comment: "a phone sheet has nothing to
 * travel from") — the card simply appears, matching the reduced-motion path
 * exactly, since a phone composer has nothing on-screen to measure a travel
 * from either way. Best-effort past the post itself: a card the traveling
 * ghost can't find (a slow render, or the margin currently showing a
 * different tab) just means the card appears without the flourish.
 */
async function handleSelectionSubmit(
	anchor: Anchor,
	body: string,
	sourceRect: DOMRect | null,
): Promise<void> {
	const createdId = await postComment(anchor, body);
	selectionBubble = null;
	if (!sourceRect || prefersReducedMotion() || !contentEl) return;
	await tick();
	const target = contentEl.querySelector(
		`[data-comment-id="${createdId}"]`,
	);
	if (!(target instanceof HTMLElement)) return;
	const targetRect = target.getBoundingClientRect();

	const ghost = document.createElement("div");
	Object.assign(ghost.style, {
		position: "fixed",
		left: `${sourceRect.left}px`,
		top: `${sourceRect.top}px`,
		width: `${sourceRect.width}px`,
		height: `${sourceRect.height}px`,
		borderRadius: "var(--radius-md)",
		border: "1px solid var(--border-default)",
		backgroundColor: "var(--surface-overlay)",
		boxShadow: "var(--shadow-lg, var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18)))",
		pointerEvents: "none",
		zIndex: "50",
	});
	document.body.appendChild(ghost);

	const dx = targetRect.left - sourceRect.left;
	const dy = targetRect.top - sourceRect.top;
	const sx = sourceRect.width > 0 ? targetRect.width / sourceRect.width : 1;
	const sy = sourceRect.height > 0 ? targetRect.height / sourceRect.height : 1;
	const travel = reducedMotionAnimate(
		ghost,
		[
			{ transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 },
			{
				transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
				opacity: 0,
			},
		],
		{ duration: MOTION_DURATION.emphasis, easing: MOTION_EASING.emphasis },
	);
	// "The card fades in during the second half" — a 150ms delay into the
	// SAME travel duration, applied directly to the real card DOM node
	// (`MarginPanel.svelte`'s own — this never touches its Svelte state).
	target.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], {
		duration: MOTION_DURATION.emphasis,
		delay: MOTION_DURATION.standard,
	});
	await travel.finished;
	ghost.remove();
}

async function postReply(parentId: string, body: string): Promise<void> {
	const conversationId = panelConversationId ?? null;
	const created = await createArtifactComment(
		boundArtifactId,
		null,
		body,
		parentId,
		conversationId,
	);
	await refreshAfterCommentChange();
	if (mentionsAlfy(body)) {
		await maybeAskAlfy(created.id, findThreadBlockId(parentId));
	}
}

async function handleCommentResolve(
	commentId: string,
	resolved: boolean,
): Promise<void> {
	const conversationId = panelConversationId ?? null;
	try {
		await resolveArtifactComment(
			boundArtifactId,
			commentId,
			resolved,
			conversationId,
		);
	} finally {
		await refreshAfterCommentChange();
	}
}
// ---- end T10 -----------------------------------------------------------

// ---- T8 live: reacting to a chat-turn edit_artifact/create_artifact call ---
/**
 * The one place that reacts to `alfyActivity` (this body's only channel from
 * the chat page — one prop, `slice-1.md`'s "T8 live"). Every branch is
 * idempotent against re-renders: `handledActivityKey` guards the settle
 * branch, and "running" simply re-derives the same label each time.
 *
 * RV-1B: a real browser can settle a call (a fast model, or this slice's own
 * mocked provider) before `runLoad`'s `Promise.all([loadEditorModule(),
 * fetchArtifact(...)])` resolves, so `editor`/`loadMarkdownFn`/
 * `applyAlfyChangesFn` are still null when this effect first sees the
 * settled activity. Reading `editorReady` here — not just inside
 * `landAlfyActivity` — makes it a tracked dependency, so this effect reruns
 * the instant the editor becomes ready instead of silently losing the call:
 * `handledActivityKey` is set only once the call is actually about to be
 * processed, never as a side effect of merely having been seen.
 */
$effect(() => {
	const activity = alfyActivity;
	if (!activity || activity.artifactId !== boundArtifactId) {
		// Fully derived, not just "nothing to do": a document switch (or the
		// activity moving on to a different artifact) must not leave a stale
		// shimmer from whatever was showing a moment ago.
		alfyWritingLabel = null;
		return;
	}

	if (activity.status === "running") {
		alfyWritingLabel = activity.label ?? title;
		return;
	}
	// Settled (applied/refused/failed): the shimmer never outlives its call
	// (T8.6), whatever else this activity turns out to mean.
	alfyWritingLabel = null;

	const key = `${activity.key}:${activity.status}`;
	if (key === handledActivityKey) return;
	// The call stays un-handled (and this effect will re-run and retry) until
	// the editor can actually receive it — see this effect's own comment.
	if (!editorReady) return;
	handledActivityKey = key;

	if (activity.status === "failed") return;
	void landAlfyActivity(activity);
});

/**
 * `edit_artifact` landed (applied or partially/fully refused): reloads the
 * new version, then marks exactly the applied ops using inverses
 * reconstructed from THIS body's own pre-edit blocks (never a full server
 * `PatchResult` — the live stream does not carry one; see
 * `alfy-activity.ts`'s header comment). `create_artifact` has no prior
 * version to diff against, so `reconstructDocumentPatch` returns `null` and
 * this is a no-op beyond the reload the version-number check below already
 * does.
 */
async function landAlfyActivity(activity: DocumentAlfyActivity): Promise<void> {
	if (!editor || !loadMarkdownFn || !applyAlfyChangesFn) return;
	const previousBlocksById = new Map(blocks.map((b) => [b.id, b]));

	try {
		const conversationId = panelConversationId ?? null;
		const detail = await fetchArtifact(boundArtifactId, conversationId);
		const newBody = detail.artifact.body ?? "";
		if (detail.artifact.versionNumber !== versionNumber) {
			versionNumber = detail.artifact.versionNumber;
			knownBodyHash = detail.artifact.bodyHash;
			loadMarkdownFn(editor, newBody);
		}
		updateBlocksFromMarkdown(newBody);
		comments = detail.comments;

		const reconstructed = reconstructDocumentPatch(activity, previousBlocksById);
		if (!reconstructed) {
			refusalNotice = null;
			return;
		}

		const entries = applyAlfyChangesFn(editor, reconstructed, reconstructed.patch);
		const nextPending = new Map(pendingChanges);
		for (const entry of entries) {
			nextPending.set(entry.changeId, { entry, status: "pending" });
		}
		pendingChanges = nextPending;

		const summary = summarizeRefusalsFn?.(reconstructed) ?? null;
		if (summary && refusalReasonI18nKeyFn) {
			const refusedBlockIds = summary.items.map((item) => item.blockId);
			refusalNotice = {
				message: $t("artifacts.document.refused.notice", {
					count: summary.count,
				}),
				items: summary.items.map((item) => ({
					label: item.blockLabel,
					reason: $t(refusalReasonI18nKeyFn?.(item.code) as never),
				})),
				seeChangeLabel:
					entries.length > 0
						? $t("artifacts.document.refused.seeChange")
						: null,
				firstAppliedChangeId: entries[0]?.changeId ?? null,
				refusedBlockIds,
			};
			// Redesign §4.2 "Refusal": "a dashed amber rule in the gutter" on
			// every refused line, not just the pinned card.
			setRefusedLinesFn?.(editor, { blockIds: refusedBlockIds });
		} else {
			refusalNotice = null;
			setRefusedLinesFn?.(editor, null);
		}
	} catch {
		// Best-effort, mirroring `refreshAfterCommentChange`: the panel shows
		// slightly stale state until the next successful refresh rather than
		// surfacing a second, unrelated error path here.
	}
}

/**
 * Ruling 61's own write side, fire-and-forget from every Keep/Undo (live or
 * reload-restored — both "acknowledge", ruling 61's own word): best-effort,
 * exactly like `refreshAfterCommentChange` elsewhere in this file — a failed
 * call just means the block re-appears as pending on the NEXT reload, a
 * safe, visible failure mode, never a hard dependency for the live session
 * (AGENTS.md: "auxiliary services... should degrade gracefully").
 */
async function acknowledgeReview(blockIds: string[]): Promise<void> {
	if (blockIds.length === 0) return;
	try {
		await acknowledgeDocumentReviewBlocks(
			boundArtifactId,
			blockIds,
			panelConversationId ?? null,
		);
	} catch {
		// See above.
	}
}

/**
 * Keep: clears exactly this change's mark, leaves the text. The mark's own
 * CLEAR is deferred to the end of the pill's 1.4s "Kept" window (redesign
 * §7.2 #13) rather than instant, so `change-pill-decoration.ts`'s own live
 * mark lookup keeps finding a position for the pill throughout — never
 * instant like the pre-redesign bar's own `keepAlfyChange` call used to be.
 */
function handleKeepChange(changeId: string): void {
	const pending = pendingChanges.get(changeId);
	if (!pending) return;
	pendingChanges = new Map(pendingChanges).set(changeId, {
		...pending,
		status: "kept",
	});
	void acknowledgeReview([pending.entry.blockId]);
	setTimeout(() => {
		if (editor && keepChangeFn) keepChangeFn(editor, changeId);
		removePendingChange(changeId);
	}, KEEP_SETTLE_MS);
}

/**
 * Undo: restores exactly this change's pre-edit text and treats that as a
 * USER edit — scheduled through the normal autosave path (T8's own rule),
 * not a second, silent write. Unlike Keep, the mark is gone the instant this
 * runs (`undoAlfyChange` replaces the whole node) — `changeDocRangeFn`
 * captures its LAST live position first, as the pill's own fallback anchor
 * for the "Undone · Redo" window (redesign §7.2 #14). `appliedMarkdown` is
 * ALSO captured first (from `blocks` state, still showing the pre-undo,
 * Alfy-applied text) — Redo's own restore target, since nothing else keeps
 * what Undo is about to overwrite.
 */
function handleUndoChange(changeId: string): void {
	if (!editor || !undoChangeFn) return;
	const pending = pendingChanges.get(changeId);
	if (!pending) return;
	const fallbackPos = changeDocRangeFn?.(editor, changeId)?.to;
	const appliedMarkdown = blocks.find(
		(b) => b.id === pending.entry.blockId,
	)?.markdown;
	undoChangeFn(editor, {
		...pending.entry,
		isNewBlock: pending.isNewBlock,
	});
	pendingChanges = new Map(pendingChanges).set(changeId, {
		...pending,
		status: "undone",
		fallbackPos,
		appliedMarkdown,
	});
	const canonical = currentCanonicalMarkdown();
	if (canonical !== null) {
		autosave?.schedule(canonical);
		updateBlocksFromMarkdown(canonical);
	}
	void acknowledgeReview([pending.entry.blockId]);
	const timer = setTimeout(() => removePendingChange(changeId), UNDO_SETTLE_MS);
	undoSettleTimers.set(changeId, timer);
}

/**
 * Redo: reverses Undo within its own settle window — restores the captured
 * `appliedMarkdown` (the SAME mechanism as Undo, in reverse: `undoChangeFn`
 * is generically "set this block's content to X", never direction-specific)
 * and re-marks the block under the SAME `changeId` so the pill goes back to
 * `"pending"`. A change with `insertedBlockIds` in its live-session entry
 * loses those extra blocks on Redo (Undo already removed them, and only
 * `appliedMarkdown`'s own block is captured) — a deliberate, narrow
 * simplification; see the report's own deviations.
 */
function handleRedoChange(changeId: string): void {
	if (!editor || !undoChangeFn || !remarkChangeFn) return;
	const pending = pendingChanges.get(changeId);
	if (!pending || pending.status !== "undone") return;
	const timer = undoSettleTimers.get(changeId);
	if (timer !== undefined) {
		clearTimeout(timer);
		undoSettleTimers.delete(changeId);
	}
	if (pending.appliedMarkdown !== undefined) {
		undoChangeFn(editor, {
			blockId: pending.entry.blockId,
			previousMarkdown: pending.appliedMarkdown,
		});
	}
	remarkChangeFn(editor, changeId, pending.entry.blockId);
	pendingChanges = new Map(pendingChanges).set(changeId, {
		...pending,
		status: "pending",
		fallbackPos: undefined,
	});
	const canonical = currentCanonicalMarkdown();
	if (canonical !== null) {
		autosave?.schedule(canonical);
		updateBlocksFromMarkdown(canonical);
	}
}

function removePendingChange(changeId: string): void {
	const timer = undoSettleTimers.get(changeId);
	if (timer !== undefined) {
		clearTimeout(timer);
		undoSettleTimers.delete(changeId);
	}
	const nextPending = new Map(pendingChanges);
	nextPending.delete(changeId);
	pendingChanges = nextPending;
}

/** Keep all / Undo all (redesign §4.2 item 6, the review bar) — every still-pending entry gets the SAME per-change handler a single Keep/Undo click would. */
function handleKeepAllChanges(): void {
	for (const [changeId, pending] of pendingChanges) {
		if (pending.status === "pending") handleKeepChange(changeId);
	}
}

function handleUndoAllChanges(): void {
	for (const [changeId, pending] of pendingChanges) {
		if (pending.status === "pending") handleUndoChange(changeId);
	}
}

/** "See what Alfy did" / a comment's own change chip — scrolls to one already-applied change's own mark. */
function seeChange(changeId: string): void {
	if (!editor || !scrollToChangeFn) return;
	scrollToChangeFn(editor, changeId);
}

function handleSeeChange(): void {
	if (refusalNotice?.firstAppliedChangeId) seeChange(refusalNotice.firstAppliedChangeId);
}

// ---- Wave 2.5 Step 10: the review bar's own stepper ------------------------
// `pendingList` is every STILL-PENDING entry, in Map-insertion order (live
// changes land in the order Alfy made them; ruling 61's reload restore
// inserts in the SAME order the server returns, already sorted by which
// Alfy version made them — `document-ops.ts`'s own `computePendingReviewBlocks`).
let pendingList = $derived(
	[...pendingChanges.entries()].filter(([, p]) => p.status === "pending"),
);
$effect(() => {
	if (reviewIndex >= pendingList.length) {
		reviewIndex = Math.max(0, pendingList.length - 1);
	}
});

function handleReviewPrev(): void {
	if (pendingList.length === 0) return;
	reviewIndex = (reviewIndex - 1 + pendingList.length) % pendingList.length;
	const [changeId] = pendingList[reviewIndex];
	seeChange(changeId);
}

function handleReviewNext(): void {
	if (pendingList.length === 0) return;
	reviewIndex = (reviewIndex + 1) % pendingList.length;
	const [changeId] = pendingList[reviewIndex];
	seeChange(changeId);
}
// ---- end Wave 2.5 Step 10 review bar stepper ------------------------------

// ---- Ruling 61: a pending Alfy change survives a reload --------------------
/**
 * Fetches the server's own recomputed pending set and marks each block
 * again (redesign §4.2's own "Reload with a pending change": "marked again
 * and counted in the review bar"). `remarkChangeFn` marks the WHOLE block
 * under a synthetic `changeId` (the block id itself — there is no live
 * per-character opId left from a past session, and ruling 61's own pending
 * set is block-granular, never op-granular), the same coarse fallback
 * `applyAlfyChangeMarks` already uses when it cannot find a precise range.
 * `myToken` mirrors `runLoad`'s own guard: a document switched away from
 * before this resolves must not paint marks onto whatever is open NOW.
 */
async function restorePendingReview(
	artifactIdAtCall: string,
	conversationId: string | null,
	myToken: number,
): Promise<void> {
	let pending: Awaited<ReturnType<typeof fetchDocumentReviewState>>;
	try {
		pending = await fetchDocumentReviewState(artifactIdAtCall, conversationId);
	} catch {
		// Best-effort (see `acknowledgeReview`'s own comment) — reads the same
		// as "no marker yet": nothing pending.
		return;
	}
	if (myToken !== loadToken || !editor || pending.length === 0) return;

	const nextPending = new Map(pendingChanges);
	for (const block of pending) {
		const changeId = block.blockId;
		if (!remarkChangeFn?.(editor, changeId, block.blockId)) continue;
		nextPending.set(changeId, {
			entry: {
				changeId,
				blockId: block.blockId,
				blockLabel: block.blockLabel,
				previousMarkdown: block.previousMarkdown,
			},
			status: "pending",
			isNewBlock: block.isNewBlock,
		});
	}
	pendingChanges = nextPending;
}
// ---- end ruling 61 ---------------------------------------------------------

/** The pinned refusal card's own "Dismiss" — clears the card and its line's dashed rule together, so the two can never drift. */
function dismissRefusalNotice(): void {
	refusalNotice = null;
	if (editor) setRefusedLinesFn?.(editor, null);
}

/**
 * The pinned refusal card's own "Ask again" (redesign §4.2 "Refusal") —
 * re-selects the refused line and scrolls to it, re-surfacing the selection
 * pill there (`selectAndScrollToBlockFn` sets the editor's own selection,
 * which `handleSelectionUpdate` already turns into a shown bubble — the SAME
 * flow the user would reach by selecting the text themselves), rather than
 * jumping straight into an open composer.
 */
function handleAskAgainRefusal(): void {
	const blockId = refusalNotice?.refusedBlockIds[0];
	if (!blockId || !editor || !selectAndScrollToBlockFn) return;
	selectAndScrollToBlockFn(editor, blockId);
	dismissRefusalNotice();
}
// ---- end T8 live ---------------------------------------------------------

// ---- T12: the download sheet -----------------------------------------------
let downloadSheetOpen = $state(false);
// ---- end T12 -------------------------------------------------------------

// ---- RV-1B, T6: the versions sheet — VersionsSheet.svelte existed and was
// unit-tested but had no toolbar action opening it anywhere in the app; see
// the "history" action in toolbar-actions.ts and its handler below. ---------
let versionsSheetOpen = $state(false);
// ---- end T6 ----------------------------------------------------------------

/** The editor's current text, canonicalised through the SERVER's own pipeline (T7.2) — never a second canonicaliser. */
function currentCanonicalMarkdown(): string | null {
	if (!editor || !readMarkdownFn) return null;
	const raw = readMarkdownFn(editor);
	return serializeDocument(parseDocument(raw).blocks);
}

function updateActiveActionIds(): void {
	if (!editor) return;
	const next = new Set<DocumentToolbarActionId>();
	if (editor.isActive("bold")) next.add("bold");
	if (editor.isActive("italic")) next.add("italic");
	if (editor.isActive("strike")) next.add("strike");
	if (editor.isActive("heading", { level: 1 })) next.add("heading1");
	if (editor.isActive("heading", { level: 2 })) next.add("heading2");
	if (editor.isActive("bulletList")) next.add("bulletList");
	if (editor.isActive("orderedList")) next.add("orderedList");
	if (editor.isActive("taskList")) next.add("taskList");
	if (editor.isActive("blockquote")) next.add("quote");
	if (editor.isActive("codeBlock")) next.add("code");
	if (editor.isActive("link")) next.add("link");
	activeActionIds = next;
}

function handleDirty(): void {
	// A too-large refusal stops the loop (T7.11); the natural next edit is a
	// user shortening the document, so give that attempt a chance rather than
	// staying stopped forever over a document that may no longer be too big.
	// A "deleted" refusal is different: nothing short of `saveCopy` fixes a
	// gone artifact id, so that one is never auto-resumed here.
	if (saveNotice === "tooLarge" && autosave?.stopped) {
		autosave.resume();
	}
	isDirty = true;
	onDirtyChange?.(true);
}

function handleUpdate(): void {
	updateActiveActionIds();
	const canonical = currentCanonicalMarkdown();
	if (canonical !== null) {
		autosave?.schedule(canonical);
		// Keeps the margin's anchor resolution live as the user types, not just
		// after the next full reload.
		updateBlocksFromMarkdown(canonical);
	}
}

/** T10: the same selection callback the editor already fires, extended to also raise/hide the bubble. */
function handleSelectionUpdate(): void {
	updateActiveActionIds();
	updateSelectionBubble();
}

function handleSaveResult(result: DocumentAutosaveResult, markdown: string): void {
	if (result.ok) {
		if (typeof result.version === "number") versionNumber = result.version;
		// RV-1B, coordinator item 6: remember what just landed, so the NEXT
		// autosave's `baseHash` guards against a second tab's save that lands
		// in between, instead of silently overwriting it.
		if (typeof result.bodyHash === "string") knownBodyHash = result.bodyHash;
		saveNotice = null;
		isDirty = false;
		onDirtyChange?.(false);
		onBodyChange?.(markdown);
		return;
	}
	switch (result.reason) {
		case "too_large":
			saveNotice = "tooLarge";
			autosave?.stop();
			break;
		case "not_found":
			saveNotice = "deleted";
			autosave?.stop();
			break;
		case "version_conflict":
		case "stale":
			saveNotice = "conflict";
			break;
		default:
			saveNotice = "offline";
	}
}

/**
 * Wave 2.5 Step 3: the shared trigger for the header's version button
 * (`ArtifactPanelHeader`, via `registerPanelActions` below) — the ONE History
 * entry the redesign wants, replacing the toolbar's own "history" action.
 * Each popover now anchors to its OWN header button (Step 8), so only one
 * still closes the other here to avoid two floating panels open together,
 * not because they would visually overlap at the same spot.
 */
function openVersionsSheet(): void {
	downloadSheetOpen = false;
	versionsSheetOpen = true;
}

/** The header's Download action (`registerPanelActions`), replacing the toolbar's own "download" action. */
function openDownloadSheet(): void {
	versionsSheetOpen = false;
	downloadSheetOpen = true;
}

/** The header's Comments button (`registerPanelActions`, Wave 2.5 Step 8) and a tapped highlight's own fallback (`handleEditorAnchorActivate` below) both funnel through here. */
function openCommentsOverlay(): void {
	commentsOverlayOpen = true;
}

// Wave 2.5 Step 3: hands the panel header the sheet triggers above, so
// `ArtifactPanelHeader.svelte`/`DocumentWorkspace.svelte` can open them
// without knowing anything about Tiptap or this body's own state — see
// `ArtifactBodyProps.registerPanelActions`. No dependency this effect reads
// ever changes (the functions are stable closures over local `$state`
// setters), so this runs once, after mount, like `onMount` — but as an
// effect, a future need to re-register per `artifactId` (the panel's rail
// can swap which item is open without remounting this body) is one
// dependency read away rather than a rewrite.
$effect(() => {
	registerPanelActions?.({
		openVersions: openVersionsSheet,
		openDownload: openDownloadSheet,
		openComments: openCommentsOverlay,
	});
});

/** Wave 2.5 Step 8: the header Comments button's own open-thread badge — every open (non-resolved) thread across the whole document, not just the active tab (the button represents the document, the same way the mockup's header count does). */
let openCommentCount = $derived(
	comments.filter((comment) => comment.status !== "resolved").length,
);
$effect(() => {
	onCommentCountChange?.(openCommentCount);
});

$effect(() => {
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
	return stopWatchingViewport;
});

// Tracks this body's own rendered width so the inline rail (CSS, the SAME
// 820px threshold — see `NARROW_PANEL_THRESHOLD_PX`) and the overlay
// (`commentsOverlayOpen`'s presentation, below) agree on when there is room
// for the 300px column. Guarded: jsdom (this component's own tests) has no
// ResizeObserver, and the panel must render correctly without one — see
// `MarginPanel.svelte`'s own identical guard.
$effect(() => {
	const el = documentBodyEl;
	if (!el || typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver((entries) => {
		const width = entries[0]?.contentRect.width;
		if (width !== undefined) panelContainerWidth = width;
	});
	observer.observe(el);
	return () => observer.disconnect();
});

// Review 2.5 (rd/review-2-5.md:98-108): the review bar is now a normal-flow,
// `position: sticky` child at the end of the text column (see
// `.document-review-bar-slot`'s own CSS comment) rather than an absolutely
// positioned overlay — so it no longer floats over whatever paragraph is
// last, but the LAST paragraph still needs real scroll room to clear the
// bar's own height before the column runs out of content to scroll through
// (the classic "sticky footer covers the last line" problem). Same guarded
// ResizeObserver shape as the width-tracking effect above; the bar's own
// height changes with viewport width (the phone layout wraps taller) and
// content (refused-count text, i18n string length), so this stays live
// rather than a one-time measurement.
$effect(() => {
	const el = reviewBarSlotEl;
	if (!el || typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver((entries) => {
		const height = entries[0]?.contentRect.height;
		if (height !== undefined) reviewBarHeight = height;
	});
	observer.observe(el);
	return () => observer.disconnect();
});

// Closes a stray-open overlay the moment the layout no longer needs one
// (a window/panel resize back above the threshold) — otherwise the drawer
// would float uselessly ALONGSIDE the now-visible inline rail.
$effect(() => {
	if (!isPhone && !isNarrowPanel) commentsOverlayOpen = false;
});

function handleToolbarAction(id: DocumentToolbarActionId): void {
	// T12/T6: the two toolbar actions that never touch the live editor
	// directly — they open a sheet instead. Wave 2.5 Step 5 moves both
	// actions out of the toolbar and into the panel header (above); these two
	// branches stay as a harmless fallback until that step lands.
	if (id === "download") {
		openDownloadSheet();
		return;
	}
	if (id === "history") {
		openVersionsSheet();
		return;
	}
	if (!editor) return;
	const chain = editor.chain().focus();
	switch (id) {
		case "bold":
			chain.toggleBold().run();
			break;
		case "italic":
			chain.toggleItalic().run();
			break;
		case "strike":
			chain.toggleStrike().run();
			break;
		case "heading1":
			chain.toggleHeading({ level: 1 }).run();
			break;
		case "heading2":
			chain.toggleHeading({ level: 2 }).run();
			break;
		case "bulletList":
			chain.toggleBulletList().run();
			break;
		case "orderedList":
			chain.toggleOrderedList().run();
			break;
		case "taskList":
			chain.toggleTaskList().run();
			break;
		case "quote":
			chain.toggleBlockquote().run();
			break;
		case "code":
			chain.toggleCodeBlock().run();
			break;
		case "table":
			chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
			break;
		case "link":
			handleLinkAction();
			break;
		case "undo":
			chain.undo().run();
			break;
		case "redo":
			chain.redo().run();
			break;
	}
	updateActiveActionIds();
}

function handleLinkAction(): void {
	if (!editor) return;
	if (editor.isActive("link")) {
		editor.chain().focus().unsetLink().run();
		return;
	}
	const url =
		typeof window !== "undefined"
			? window.prompt($t("artifacts.document.toolbar.link"))
			: null;
	if (!url || !url.trim()) return;
	editor.chain().focus().toggleLink({ href: url.trim() }).run();
}

/**
 * Switching the active tab never remounts or reloads the document (T9.1) —
 * `setActiveDocumentTabFn` dispatches a no-op-for-history meta transaction
 * that only updates which blocks the tab-section decoration hides (redesign
 * §5.2), the same document, editor instance and undo stack throughout.
 */
function handleTabActivate(tabId: string): void {
	activeTabId = tabId;
	if (editor) setActiveDocumentTabFn?.(editor, tabs, tabId);
}

/**
 * Persists an add/rename/delete from `Tabs.svelte` through the SAME body
 * route every other edit uses (`saveDocumentTabs`, one write path — T9.2/
 * T9.7). The strip already updated itself optimistically (it renders
 * straight from its own `tabs` prop change); on a refusal it is simply
 * overwritten by the next successful load rather than rolled back, matching
 * this body's existing "keep the user's text, surface the notice" failure
 * shape for every other save.
 *
 * Review 2.5 (rd/review-2-5.md:191-197): a brand-new tab (`Tabs.svelte`'s
 * `addTab`, `startBlockId: ""`) gets a real anchor block here, BEFORE the
 * canonical text below is read — `appendEmptyTabSection`'s own doc comment
 * has the why — so this is the ONE case where a tabs-only change does NOT
 * carry the editor's text along unchanged; every other caller (rename,
 * delete) is untouched.
 */
async function handleTabsChange(next: DocumentTab[]): Promise<void> {
	const previousIds = new Set(tabs.map((tab) => tab.id));
	const blankNewTab = next.find(
		(tab) => tab.startBlockId === "" && !previousIds.has(tab.id),
	);
	if (blankNewTab && editor) {
		const mintedId = appendEmptyTabSectionFn?.(editor) ?? null;
		if (mintedId) {
			next = next.map((tab) =>
				tab.id === blankNewTab.id ? { ...tab, startBlockId: mintedId } : tab,
			);
		}
	}
	tabs = next;
	// An add/delete can move section boundaries even when `activeTabId`
	// itself is unchanged (e.g. deleting a LATER tab); a rename cannot, but
	// re-dispatching is a cheap no-op either way (redesign §5.2).
	if (editor) setActiveDocumentTabFn?.(editor, next, activeTabId);
	const canonical = currentCanonicalMarkdown();
	if (canonical === null) return;
	const result = await saveDocumentTabs(
		boundArtifactId,
		next,
		canonical,
		versionNumber ?? undefined,
		panelConversationId ?? null,
	);
	handleSaveResult(result, canonical);
}

/**
 * Creates (or replaces) the autosave loop bound to `id`. Pulled out of
 * `runLoad` so `handleSaveCopy` can call it too: the OLD `autosave`'s `save`
 * closure captured the now-deleted artifact id, so simply calling
 * `.resume()` on it would keep saving against a 404 forever. A fresh
 * instance is bound to the new id instead — the escape hatch actually
 * escapes.
 */
function bindAutosave(id: string, conversationId: string | null): void {
	autosave?.stop();
	autosave = createDocumentAutosave({
		// RV-1B, coordinator item 6: `knownBodyHash` is read here, not
		// captured — this closure is bound once per load/copy, but every
		// scheduled save must send whatever this component most recently
		// learned was stored, including what ITS OWN previous save just wrote
		// (`handleSaveResult` below). Without a `baseHash` at all, the route
		// has nothing to refuse a second tab's save against, and ruling 47's
		// coalescing means both tabs' `expectVersion` can legally agree too.
		save: (markdown) =>
			saveArtifactBody(
				id,
				markdown,
				versionNumber ?? undefined,
				conversationId,
				undefined,
				{ baseHash: knownBodyHash ?? undefined },
			),
		onResult: handleSaveResult,
	});
}

async function handleSaveCopy(): Promise<void> {
	const canonical = currentCanonicalMarkdown();
	if (canonical === null) return;
	try {
		const conversationId = panelConversationId ?? null;
		const created = await createDocumentCopy(conversationId, title, canonical);
		boundArtifactId = created.id;
		versionNumber = created.versionNumber;
		knownBodyHash = created.bodyHash;
		// The new artifact's own tabs are unknown here (`createDocumentCopy`'s
		// response does not carry them) — clearing rather than leaving the OLD
		// document's tab ids/labels on screen, which would point at sections
		// that do not exist in the new row. `Tabs.svelte` treats an empty list
		// as "one section" and simply hides the strip (T9.3), which is exactly
		// what a brand-new copy actually has.
		tabs = [];
		activeTabId = "";
		saveNotice = null;
		isDirty = false;
		bindAutosave(created.id, conversationId);
		onDirtyChange?.(false);
		onBodyChange?.(canonical);
	} catch {
		// The deleted notice and the user's text both stay exactly as they were.
	}
}

/**
 * A generation counter, not a per-closure boolean: `retryLoad` (the "Error"
 * state's button) must be able to call the SAME loading routine the effect
 * below uses, from OUTSIDE that effect, so the two share one `runLoad`
 * rather than the effect rebuilding a fresh closure on every run. Each call
 * captures the token it was started with and checks it after every `await`
 * — a later call (a prop change, or a manual retry) bumps the counter, so a
 * now-stale response can never overwrite a newer one's state.
 */
let loadToken = 0;
/**
 * Guards `runLoad` against firing again for an id it already loaded (or is
 * still loading). This is not just an optimisation: testing-library's
 * `rerender` (and, empirically, some ordinary Svelte prop updates) re-runs
 * an `$effect` whose only tracked read is an unchanged prop value, and
 * without this guard every one of those re-runs would re-fetch and tear
 * down + rebuild a perfectly live editor. `retryLoad` resets it on purpose,
 * since a retry's whole point is to redo a load whose id has NOT changed.
 */
let loadedArtifactId: string | null = null;

async function runLoad(id: string): Promise<void> {
	loadedArtifactId = id;
	const myToken = ++loadToken;
	loadState = "loading";
	saveNotice = null;
	isDirty = false;
	try {
		const conversationId = panelConversationId ?? null;
		const [mod, detail] = await Promise.all([
			loadEditorModule(),
			fetchArtifact(id, conversationId),
		]);
		if (myToken !== loadToken || !editorEl) return;

		readMarkdownFn = mod.readMarkdown;
		setActiveDocumentTabFn = mod.setActiveDocumentTab;
		appendEmptyTabSectionFn = mod.appendEmptyTabSection;
		loadMarkdownFn = mod.loadMarkdown;
		readSelectionContextFn = mod.readSelectionAnchorContext;
		applyAlfyChangesFn = mod.applyAlfyChanges;
		keepChangeFn = mod.keepChange;
		undoChangeFn = mod.undoChange;
		remarkChangeFn = mod.remarkChange;
		changeDocRangeFn = mod.changeDocRange;
		scrollToChangeFn = mod.scrollToChange;
		setChangePillsFn = mod.setChangePills;
		summarizeRefusalsFn = mod.summarizeRefusals;
		refusalReasonI18nKeyFn = mod.refusalReasonI18nKey;
		setCommentAnchorsFn = mod.setCommentAnchors;
		scrollToCommentAnchorFn = mod.scrollToCommentAnchor;
		setAlfyWritingBlockFn = mod.setAlfyWritingBlock;
		setSelectionPendingFn = mod.setSelectionPending;
		setRefusedLinesFn = mod.setRefusedLines;
		blockRectFn = mod.blockRect;
		selectAndScrollToBlockFn = mod.selectAndScrollToBlock;
		// A fresh document (a new id, or a retry of this one) starts with no
		// leftover marks or notice from whatever was open before (the shimmer
		// itself is fully derived by the `alfyActivity` effect above, so it
		// is not reset here — doing so would race that effect on first mount).
		pendingChanges = new Map();
		reviewIndex = 0;
		refusalNotice = null;
		handledActivityKey = "";
		// A stale bubble/composer would otherwise keep pointing at the PREVIOUS
		// document's own block id once this one's editor replaces it.
		clearSelectionBubble();
		changeIdByCommentId = new Map();
		activeCommentId = null;
		focusCommentRequest = null;
		versionNumber = detail.artifact.versionNumber;
		knownBodyHash = detail.artifact.bodyHash;
		tabs = documentTabsFromCardMetadata(detail.artifact.metadata);
		activeTabId = tabs[0]?.id ?? "";
		comments = detail.comments;
		updateBlocksFromMarkdown(detail.artifact.body ?? "");

		editor?.destroy();
		editor = mod.createDocumentEditor({
			element: editorEl,
			markdown: detail.artifact.body ?? "",
			placeholder: $t("artifacts.document.editor.placeholder"),
			onDirty: handleDirty,
			onUpdate: handleUpdate,
			onSelectionUpdate: handleSelectionUpdate,
			changePillCallbacks: {
				onKeep: handleKeepChange,
				onUndo: handleUndoChange,
				onRedo: handleRedoChange,
			},
			onTabIntoSelectionPill: focusSelectionPill,
		});
		// The very first paint already shows only the active tab's section
		// (redesign §5.2) — without this, every section would flash visible
		// until the user's first tab click dispatched the meta transaction.
		setActiveDocumentTabFn(editor, tabs, activeTabId);
		updateActiveActionIds();
		bindAutosave(id, conversationId);

		loadState = "ready";
		// Ruling 61: restored AFTER `loadState = "ready"` — a slow review-state
		// fetch must never hold up the editor becoming interactive. Best-effort
		// (its own try/catch): a failed fetch just means no marks come back for
		// this load, exactly like "no marker yet" (nothing pending) reads.
		// `myToken` guards it the same way the rest of `runLoad` does — a
		// document switched away from before this resolves must not paint
		// marks onto whatever editor is open NOW.
		void restorePendingReview(id, conversationId, myToken);
	} catch (error) {
		if (myToken !== loadToken) return;
		loadState =
			error instanceof ApiError && error.status === 404
				? "not_found"
				: "load_error";
	}
}

function retryLoad(): void {
	loadedArtifactId = null;
	void runLoad(boundArtifactId);
}

$effect(() => {
	const idToLoad = artifactId;
	boundArtifactId = idToLoad;
	if (idToLoad !== loadedArtifactId) {
		void runLoad(idToLoad);
	}
});

// Redesign §3.2, Wave 2.5 Step 7: pushes the rail's own already-resolved
// anchors — and whichever thread is currently linked — into the live
// decoration whenever either changes. `setCommentAnchorsFn` is `null` until
// the lazy editor module resolves; nothing to decorate before that anyway.
$effect(() => {
	const anchors = commentAnchors;
	const active = activeCommentId;
	if (editor && setCommentAnchorsFn) {
		setCommentAnchorsFn(editor, anchors, active);
	}
});

/**
 * Wave 2.5 Step 10: pushes the CURRENT pending/kept/undone list into the
 * editor's own widget-decoration plugin whenever it changes — the one write
 * side `change-pill-decoration.ts` reads from (`setChangePillsFn` is `null`
 * until the lazy editor module resolves; nothing to decorate before that
 * anyway, same guard as the comment-anchor effect above).
 */
$effect(() => {
	const entries: ChangePillEntry[] = [...pendingChanges.entries()].map(
		([changeId, pending]) => ({
			changeId,
			blockId: pending.entry.blockId,
			status: pending.status,
			commentCount: 0,
			fallbackPos: pending.fallbackPos,
		}),
	);
	if (editor && setChangePillsFn) {
		setChangePillsFn(editor, entries);
	}
});

/** Quote button ("goes to the anchor", Wave 2.5 Step 6) — MarginPanel already resolved this thread's own live position; this only asks the editor to scroll to and flash it. */
function handleGotoCommentAnchor(
	blockId: string,
	from: number,
	to: number,
): void {
	if (!editor || !scrollToCommentAnchorFn) return;
	scrollToCommentAnchorFn(editor, blockId, from, to);
}

/** The change chip's own "See change" — the SAME scroll-to-change `handleSeeChange` below already uses for the refusal notice, resolved from whichever changeId this comment's own `@Alfy` reply produced. */
function handleSeeChangeForComment(commentId: string): void {
	const changeId = changeIdByCommentId.get(commentId);
	if (changeId) seeChange(changeId);
}

/**
 * Two-way linking's other direction (Wave 2.5 Step 7): hover/focus on a
 * `.comment-anchor` span links it to its thread's card (`activeCommentId`);
 * clicking or pressing Enter on an OPEN one also asks the rail to scroll to
 * and focus that thread (`focusCommentRequest`, a bumped token so the same
 * word clicked twice still re-triggers it). Plain DOM delegation on
 * `editorEl` — the decoration's own class/data attribute already carries
 * everything this needs, so there is no reason to reach back into
 * `document-editor.ts` for a second, PM-specific event mechanism.
 *
 * `findCommentAnchorTarget` returns the nearest `.comment-anchor` ancestor,
 * but only an INTERACTIVE one — `buildCommentAnchorDecorations` only adds
 * `role="button"` while a thread is open (redesign §3.4: "highlights are
 * focusable only while their thread is open"), and hover/click/keydown all
 * share this one gate rather than each re-deriving resolved state from the
 * DOM its own way.
 */
function findCommentAnchorTarget(event: Event): HTMLElement | null {
	const el = (event.target as HTMLElement | null)?.closest<HTMLElement>(
		".comment-anchor",
	);
	return el?.getAttribute("role") === "button" ? el : null;
}

function handleEditorAnchorHoverIn(event: Event): void {
	const target = findCommentAnchorTarget(event);
	const commentId = target?.getAttribute("data-comment-anchor-id");
	if (commentId) activeCommentId = commentId;
}

function handleEditorAnchorHoverOut(event: Event): void {
	if (findCommentAnchorTarget(event)) activeCommentId = null;
}

let focusCommentRequestToken = 0;

function handleEditorAnchorActivate(event: Event): void {
	const target = findCommentAnchorTarget(event);
	const commentId = target?.getAttribute("data-comment-anchor-id");
	if (!commentId) return;
	event.preventDefault();
	activeCommentId = commentId;
	focusCommentRequestToken += 1;
	focusCommentRequest = { commentId, token: focusCommentRequestToken };
	// Wave 2.5 Step 8: the inline rail is hidden below the container's own
	// 820px threshold, and never rendered at all on a phone — open the
	// overlay so the thread `focusCommentRequest` just named has somewhere to
	// actually appear (`CommentsSheet` renders the SAME `MarginPanel`, which
	// already reacts to `focusCommentRequest` on mount, not just on change).
	if (isPhone || isNarrowPanel) openCommentsOverlay();
}

function handleEditorAnchorKeydown(event: KeyboardEvent): void {
	if (event.key !== "Enter" && event.key !== " ") return;
	if (!findCommentAnchorTarget(event)) return;
	handleEditorAnchorActivate(event);
}

$effect(() => {
	const host = editorEl;
	if (!host) return;
	host.addEventListener("mouseover", handleEditorAnchorHoverIn);
	host.addEventListener("mouseout", handleEditorAnchorHoverOut);
	host.addEventListener("focusin", handleEditorAnchorHoverIn);
	host.addEventListener("focusout", handleEditorAnchorHoverOut);
	host.addEventListener("click", handleEditorAnchorActivate);
	host.addEventListener("keydown", handleEditorAnchorKeydown);
	return () => {
		host.removeEventListener("mouseover", handleEditorAnchorHoverIn);
		host.removeEventListener("mouseout", handleEditorAnchorHoverOut);
		host.removeEventListener("focusin", handleEditorAnchorHoverIn);
		host.removeEventListener("focusout", handleEditorAnchorHoverOut);
		host.removeEventListener("click", handleEditorAnchorActivate);
		host.removeEventListener("keydown", handleEditorAnchorKeydown);
	};
});

onDestroy(() => {
	loadToken += 1;
	void autosave?.flush();
	autosave?.stop();
	autosave = null;
	editor?.destroy();
	editor = null;
	readMarkdownFn = null;
});

function saveNoticeText(notice: SaveNotice): string {
	switch (notice) {
		case "offline":
			return $t("artifacts.document.save.offline");
		case "tooLarge":
			return $t("artifacts.document.save.tooLarge");
		case "conflict":
			return $t("artifacts.document.versions.conflict");
		default:
			return "";
	}
}
</script>

<div class="document-body" bind:this={documentBodyEl}>
	<div class="document-main">
		{#if editorReady}
			<Tabs
				{tabs}
				{activeTabId}
				onActivate={handleTabActivate}
				onChange={handleTabsChange}
				badgeCounts={tabBadgeCounts}
			/>
		{/if}
		<!-- T11: the phone gets its own toolbar (its row stays inside a 48 px
		     budget, `tests/e2e/artifact-document.spec.ts`) instead of the desktop's
		     full row; both are built from `toolbar-actions.ts`'s one action list,
		     and only one is ever visible/reachable at a time. -->
		<div class="hidden md:block">
			<DocumentToolbar
				{activeActionIds}
				disabled={!editorReady}
				saveState={editorReady ? toolbarSaveState : undefined}
				onAction={handleToolbarAction}
			/>
		</div>
		<div class="md:hidden">
			<MobileToolbar
				{activeActionIds}
				disabled={!editorReady}
				onAction={handleToolbarAction}
			/>
		</div>
		<!-- T8 live: the planned-section shimmer while a matching create_artifact/
		     edit_artifact call is in flight, and the refusal notice once a landed
		     call left something untouched. Both sit above the scroll container so
		     neither depends on — or fights with — the editor's own layout. -->
		{#if alfyWritingLabel !== null}
			<AlfyWriting label={alfyWritingLabel} />
		{/if}
		{#if refusalNotice}
			<RefusalNotice
				message={refusalNotice.message}
				items={refusalNotice.items}
				seeChangeLabel={refusalNotice.seeChangeLabel ?? undefined}
				onSeeChange={refusalNotice.seeChangeLabel ? handleSeeChange : undefined}
				askAgainLabel={refusalNotice.refusedBlockIds[0]
					? $t('artifacts.document.comment.askAgain')
					: undefined}
				onAskAgain={refusalNotice.refusedBlockIds[0]
					? handleAskAgainRefusal
					: undefined}
				dismissLabel={$t('artifacts.document.refused.dismiss')}
				onDismiss={dismissRefusalNotice}
			/>
		{/if}
		<!-- Redesign §3.2, Wave 2.5 Step 7: "the comment rail is a 300 px column
		     inside the SAME scroll container as the text" — `.document-content`
		     is that one scroll container (still `contentEl`, unchanged identity,
		     so every `localizePoint`/bubble computation below keeps working
		     untouched — the change pill no longer needs it, Wave 2.5 Step 10: it
		     is a ProseMirror widget decoration now, positioned in DOCUMENT space,
		     not screen space); `.document-content-text` and `.document-content-rail`
		     are its two grid columns. The rail collapses below 820 px (agent
		     3b's own narrow-panel drawer picks up from there — rd3a-brief.md). -->
		<div class="document-content" bind:this={contentEl}>
			<div class="document-content-text">
				{#if loadState === "not_found"}
					<div class="document-notice" role="status">
						<p>{$t('artifacts.document.notFound')}</p>
					</div>
				{:else}
					{#if loadState === "load_error"}
						<div class="document-notice" role="alert">
							<p>{$t('artifacts.document.editor.failedToLoad')}</p>
							<button type="button" class="btn-secondary" onclick={retryLoad}>
								{$t('common.retry')}
							</button>
						</div>
					{:else if saveNotice === 'deleted'}
						<div class="document-notice" role="alert">
							<p>{$t('artifacts.document.deleted')}</p>
							<button type="button" class="btn-primary" onclick={handleSaveCopy}>
								{$t('artifacts.document.deleted.saveCopy')}
							</button>
						</div>
					{/if}
					<div
						class="document-editor-host"
						bind:this={editorEl}
						style:padding-bottom={pendingList.length > 0
							? `calc(1rem + ${reviewBarHeight}px)`
							: undefined}
					></div>
					{#if loadState === 'loading'}
						<div class="document-editor-skeleton" aria-hidden="true">
							<span class="sr-only">{$t('common.loading')}</span>
						</div>
					{/if}
					<!-- T10: the selection bubble, positioned against this same scroll container -->
					{#if selectionBubble}
						<SelectionBubble
							position={selectionBubble}
							quote={selectionBubble.quote}
							onSubmit={async (body, sourceRect) => {
								if (!selectionBubble) return;
								await handleSelectionSubmit(
									selectionBubble.anchor,
									body,
									sourceRect,
								);
							}}
							onDismiss={dismissSelectionBubble}
						/>
					{/if}
					<!-- T12, Wave 2.5 Step 8: the download popover, opened from the
					     panel header's Download action — anchors itself to that
					     button and portals onto <body>, so no wrapping anchor div is
					     needed here any more. -->
					{#if downloadSheetOpen}
						<DownloadSheet
							artifactId={boundArtifactId}
							{title}
							conversationId={panelConversationId}
							onClose={() => (downloadSheetOpen = false)}
						/>
					{/if}
					<!-- RV-1B, T6, Wave 2.5 Step 8: the versions popover, opened from
					     the panel header's version button. A restore changes the
					     stored body out from under the open editor, so it reloads
					     through the same retryLoad() the "load failed, try again" path
					     already uses, rather than a second reload path. -->
					{#if versionsSheetOpen}
						<VersionsSheet
							artifactId={boundArtifactId}
							conversationId={panelConversationId}
							onClose={() => (versionsSheetOpen = false)}
							onRestored={() => {
								versionsSheetOpen = false;
								retryLoad();
							}}
						/>
					{/if}
				{/if}
				<!-- Wave 2.5 Step 10 / Review 2.5 (rd/review-2-5.md:98-108): the
				     review bar, "at the bottom of the text column" (redesign
				     §4.2 item 5, §8). The pill itself is no longer rendered
				     here — Step 10 moved it into the editor's own DOM as a
				     ProseMirror widget decoration (`change-pill-decoration.ts`).
				     Nested INSIDE `.document-content-text` (not a sibling grid
				     item of it) on purpose: `position: sticky` needs to be a
				     normal-flow descendant of the scrolling ancestor
				     (`.document-content`) to stick within its viewport, and
				     nesting it here also confines its width to the text
				     column alone — it used to span both grid columns and cover
				     the rail's last rows (see this class's own CSS comment). -->
				{#if pendingList.length > 0}
					<div
						class="document-review-bar-slot"
						bind:this={reviewBarSlotEl}
						in:reviewBarFly={{ y: 16, duration: MOTION_DURATION.emphasis, easing: cubicOut }}
						out:reviewBarFly={{ y: 16, duration: MOTION_DURATION.standard, easing: cubicIn }}
					>
						<ReviewBar
							pendingCount={pendingList.length}
							refusedCount={refusalNotice?.refusedBlockIds.length ?? 0}
							currentIndex={reviewIndex}
							onPrev={handleReviewPrev}
							onNext={handleReviewNext}
							onKeepAll={handleKeepAllChanges}
							onUndoAll={handleUndoAllChanges}
							onSeeRefused={refusalNotice ? handleSeeChange : undefined}
						/>
					</div>
				{/if}
			</div>
			<!-- T10 / redesign §3.2: the comment rail, the grid's second column
			     (≥820px container width only — see the `@container` rule below). -->
			<aside class="document-content-rail" aria-label={$t('artifacts.document.margin.title')}>
				<MarginPanel
					{comments}
					{blocks}
					{contentEl}
					{tabs}
					{activeTabId}
					changeStateByCommentId={changeChipByCommentId}
					{activeCommentId}
					focusRequest={focusCommentRequest}
					onResolve={handleCommentResolve}
					onSubmitReply={postReply}
					onSeeChange={handleSeeChangeForComment}
					onGotoAnchor={handleGotoCommentAnchor}
					onActiveCommentChange={(id) => (activeCommentId = id)}
					onAnchorsChange={(anchors) => (commentAnchors = anchors)}
					onActivateTab={handleTabActivate}
				/>
			</aside>
			<!-- Wave 2.5 Step 8: the SAME rail, below the container's 820px
			     threshold — a phone sheet or a narrow-panel drawer, opened by the
			     header's Comments button (`registerPanelActions`) or a tapped
			     highlight (`handleEditorAnchorActivate`). -->
			{#if commentsOverlayOpen}
				<CommentsSheet
					presentation={isPhone ? 'sheet' : 'drawer'}
					{comments}
					{blocks}
					{tabs}
					{activeTabId}
					changeStateByCommentId={changeChipByCommentId}
					{activeCommentId}
					focusRequest={focusCommentRequest}
					onResolve={handleCommentResolve}
					onSubmitReply={postReply}
					onSeeChange={handleSeeChangeForComment}
					onGotoAnchor={handleGotoCommentAnchor}
					onActiveCommentChange={(id) => (activeCommentId = id)}
					onAnchorsChange={(anchors) => (commentAnchors = anchors)}
					onActivateTab={handleTabActivate}
					onClose={() => (commentsOverlayOpen = false)}
				/>
			{/if}
		</div>
		{#if saveNotice === 'offline' || saveNotice === 'tooLarge' || saveNotice === 'conflict'}
			<div class="document-save-banner" role="status">
				{saveNoticeText(saveNotice)}
			</div>
		{/if}
	</div>
</div>

<style>
	.document-body {
		display: flex;
		flex-direction: row;
		height: 100%;
		min-height: 0;
		background-color: var(--surface-page);
		border-radius: var(--radius-md);
		/* Wave 2.5 Step 8: `.document-content`/`.document-content-rail` below
		   query THIS element's own rendered width (`@container`), not the
		   viewport's (`@media`) — the panel this body sits inside can be
		   narrower than the window (it is a resizable side panel, not
		   necessarily full-width), which is exactly the "narrow desktop panel"
		   redesign.md §3.2 describes. Matches the same unnamed-container-query
		   shape already used by `StatGrid.svelte`/`SettingsConnectionsTab.svelte`.
		   `NARROW_PANEL_THRESHOLD_PX` in the script is the JS half of this
		   SAME 820px threshold — the two must stay in step. */
		container-type: inline-size;
	}

	/* T10: the toolbar/content/banner column. */
	.document-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	/* Redesign §3.2, Wave 2.5 Step 7: "the comment rail is a 300 px column
	   inside the SAME scroll container as the text" — a two-column grid, one
	   `overflow-y`, so nothing anchored near the end (or the removed-text
	   group) can sit below what the editor lets you scroll to (§3.1 problem
	   6, the old scroll-sync effect's own failure mode). Below a container
	   width of 820px there is no room for a real second column; the rail
	   collapses here and Wave 2.5 Step 8's `CommentsSheet` (a phone sheet or a
	   narrow-panel drawer) picks up from there instead. */
	.document-content {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		/* `flex: 1` (not just `min-height`), same reasoning as the editor host
		   below: this is still a flex CHILD of `.document-main`, and without
		   it this grid sizes to its own content instead of filling whatever
		   vertical room `.document-main` actually has (T11.1: the editor must
		   keep >= 60% of a 390x844 viewport). */
		flex: 1;
		min-height: 240px;
		overflow-y: auto;
	}

	@container (min-width: 820px) {
		.document-content {
			grid-template-columns: minmax(0, 1fr) 300px;
		}
	}

	.document-content-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		/* Review 2.5 Important finding (rd/review-2-5.md:87-97): RV-1B's own
		   `overflow-x: auto` here was meant to give a wide table its own
		   horizontal scrollbar without dragging the rail sideways — but ANY
		   non-visible overflow-x makes the CSS overflow spec coerce this
		   column's unset overflow-y (`visible` by default) into `auto` too,
		   turning `.document-content-text` into a SECOND, independent
		   vertical scroll container nested inside `.document-content`'s
		   intended single one (redesign §3.2: "one scroll"). A real
		   wheel-scroll over the text landed on this INNER scroller first,
		   moving the highlighted text without moving the rail (a sibling
		   grid column that only follows the OUTER `.document-content`) —
		   the rail's cards drifted away from the words they annotate. This
		   column must never independently overflow either axis; a wide
		   table gets its own horizontal scrollbar directly on the `table`
		   element below instead — its own height is always intrinsic
		   (never constrained), so the SAME visible/auto coercion on ITS
		   unset overflow-y is harmless: there is never vertical content to
		   scroll within a table's own box. */
		overflow: visible;
	}

	.document-content-rail {
		display: none;
		min-width: 0;
		border-left: 1px solid var(--border-subtle);
	}

	@container (min-width: 820px) {
		.document-content-rail {
			display: block;
		}
	}

	/* Wave 2.5 Step 10, revised by Review 2.5 (rd/review-2-5.md:98-108): "at
	   the bottom of the text column" (redesign §4.2 item 5, §8). The
	   ORIGINAL `position: absolute` version sat as a direct child of the
	   scrolling `.document-content` on the theory that this "kept it pinned
	   while the text scrolls underneath" — backwards: an absolutely
	   positioned element's containing block is still whatever POSITIONED
	   ancestor it renders inside, and `.document-content` (the SCROLLING
	   element itself) was that ancestor, so the bar scrolled away WITH the
	   text instead of staying pinned, and — being a child of the two-column
	   grid rather than the text column alone — it spanned both columns and
	   covered the rail's last rows. `position: sticky` here (now nested
	   INSIDE `.document-content-text`, a normal-flow child after the editor
	   host — see the markup comment) actually achieves "stays pinned to the
	   bottom of the text column while the text scrolls": it sticks within
	   `.document-content`'s own scrollport (its nearest actual scrolling
	   ancestor) while its box lives in the text column's own normal flow,
	   which is also what confines its width to that column instead of the
	   whole grid. `.document-editor-host`'s own `padding-bottom` (see its
	   `style:padding-bottom` binding) reserves room, measured live from this
	   element's own height, so the last paragraph can fully clear it before
	   the column runs out of content to scroll through — the classic
	   "sticky footer covers the last line" problem a plain `position:
	   sticky` does not solve by itself. */
	.document-review-bar-slot {
		position: sticky;
		left: 1rem;
		right: 1rem;
		bottom: 0.875rem;
		z-index: 5;
	}

	@media (max-width: 480px) {
		.document-review-bar-slot {
			left: 0.5rem;
			right: 0.5rem;
			bottom: 4rem;
		}
	}

	/* `flex: 1` (not just `min-height`) so the editable canvas fills whatever
	   room `.document-content` actually has, even when the document itself is
	   short or empty — otherwise the host hugs its 240px floor and leaves the
	   rest of the panel visually blank below it (T11.1: the editor must keep
	   >= 60% of a 390x844 viewport, `tests/e2e/artifact-document.spec.ts`). */
	.document-editor-host {
		flex: 1;
		min-height: 240px;
		padding: 1rem 1.25rem;
	}

	.document-editor-host :global(.document-content) {
		outline: none;
	}

	/* Artifacts redesign §1/§2.3/§9.2, Step 2.1: the prose layer. Nothing
	   styled the text inside `.document-content` before this (its one rule
	   was the outline-none one above) — headings looked like body text, every
	   checkbox sat above its label, the table had no borders, status chips
	   were raw native selects. This mirrors the mockup's `.prose`/`.doc-page`
	   rules (`docs/design/artifacts-redesign/index.html`) against the REAL
	   Tiptap-rendered DOM: `:global(...)` has to wrap the full descendant
	   selector, not just `.document-content` itself, because everything past
	   that point (h2, p, table, …) is Tiptap-injected markup that never
	   carries this component's own Svelte scoping hash — a bare descendant
	   combinator outside `:global(...)` would silently match nothing. */
	.document-editor-host :global(.document-content) {
		font-family: var(--font-serif);
		font-size: 16px;
		line-height: 1.72;
		color: var(--text-primary);
		max-width: 62ch;
	}

	.document-editor-host :global(.document-content h1),
	.document-editor-host :global(.document-content h2),
	.document-editor-host :global(.document-content h3),
	.document-editor-host :global(.document-content h4),
	.document-editor-host :global(.document-content h5),
	.document-editor-host :global(.document-content h6) {
		font-family: var(--font-sans);
		font-weight: 700;
		color: var(--text-primary);
	}

	.document-editor-host :global(.document-content h1) {
		font-size: 24px;
		line-height: 1.25;
		letter-spacing: 0.005em;
		margin: 0 0 12px;
	}

	.document-editor-host :global(.document-content h2) {
		font-size: 20px;
		line-height: 1.3;
		letter-spacing: 0.005em;
		margin: 0 0 10px;
	}

	.document-editor-host :global(.document-content h3) {
		font-size: 16px;
		letter-spacing: 0.01em;
		margin: 22px 0 6px;
	}

	.document-editor-host :global(.document-content h4),
	.document-editor-host :global(.document-content h5),
	.document-editor-host :global(.document-content h6) {
		font-size: 14px;
		margin: 18px 0 4px;
	}

	.document-editor-host :global(.document-content p) {
		margin: 0 0 12px;
		position: relative;
	}

	.document-editor-host :global(.document-content strong) {
		font-weight: 700;
	}

	.document-editor-host :global(.document-content ul),
	.document-editor-host :global(.document-content ol) {
		margin: 0 0 12px;
		padding-left: 1.375rem;
	}

	.document-editor-host :global(.document-content li) {
		margin: 0.125rem 0;
	}

	.document-editor-host :global(.document-content blockquote) {
		margin: 0.5rem 0 1rem;
		padding: 0.25rem 0 0.25rem 1rem;
		border-left: 3px solid var(--border-default);
		color: var(--text-muted);
		font-style: italic;
	}

	.document-editor-host :global(.document-content code) {
		font-family: var(--font-mono);
		font-size: 0.85em;
		background-color: var(--surface-code);
		border-radius: var(--radius-sm);
		padding: 0.1em 0.3em;
	}

	.document-editor-host :global(.document-content pre) {
		margin: 0.5rem 0 1rem;
		padding: 0.75rem 1rem;
		background-color: var(--surface-code);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		overflow-x: auto;
	}

	.document-editor-host :global(.document-content pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
	}

	/* Inline task items (`@tiptap/extension-list`'s TaskList/TaskItem): the
	   real DOM is `ul[data-type=taskList] > li[data-checked] > (label >
	   input[type=checkbox] + span, div > p)` — no class of its own to hook,
	   so these are tag/attribute selectors rather than the mockup's `.tasks`/
	   `.task`/`.task-box`. `display: flex` on the list item is the actual fix
	   for the bug this step exists to close: without it, the label (holding
	   only the checkbox) and the text `div` are both block-level and stack
	   vertically, putting every checkbox on its own line above its label.
	   Wave 2.5 Step 0: this used to key off `li[data-type='taskItem']`, which
	   never matches — TaskItem renders through a custom Tiptap `addNodeView()`,
	   and a NodeView's HTML attributes come only from each attribute's own
	   `renderHTML` (here just `checked` → `data-checked`); the literal
	   `'data-type': this.name` baked into the node's schema-level `renderHTML()`
	   is a separate code path used only when there is no NodeView, so it never
	   reached the live `<li>` and every rule below was dead. `data-checked` is
	   always rendered (`"true"` or `"false"`), so it is the reliable hook. */
	.document-editor-host :global(.document-content ul[data-type='taskList']) {
		list-style: none;
		margin: 6px 0 16px;
		padding: 0;
		font-family: var(--font-serif);
	}

	.document-editor-host :global(.document-content li[data-checked]) {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 4px 0;
		font-size: 15.5px;
	}

	.document-editor-host :global(.document-content li[data-checked] > label) {
		display: inline-flex;
		flex-shrink: 0;
		margin-top: 0.2em;
	}

	.document-editor-host :global(.document-content li[data-checked] input[type='checkbox']) {
		width: 17px;
		height: 17px;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.document-editor-host :global(.document-content li[data-checked] > div) {
		min-width: 0;
	}

	.document-editor-host :global(.document-content li[data-checked] > div p) {
		margin: 0;
	}

	/* The tracker table (`@tiptap/extension-table`'s TableKit). This styles
	   the bare `table` directly, matching the mockup's `.doc-table` (not
	   `.doc-table-wrap`) — width/border/radius stay here, unchanged. */
	.document-editor-host :global(.document-content table) {
		width: 100%;
		margin: 6px 0 16px;
		border: 1px solid var(--border-default);
		border-radius: 10px;
		border-collapse: collapse;
		overflow: hidden;
		font-family: var(--font-sans);
		font-size: 13.5px;
	}

	/* Review 2.5 (rd/review-2-5.md:87-97): a wide table's horizontal
	   scrollbar belongs on `.tableWrapper` — the LIVE editor's real DOM
	   parent of every `<table>` (`@tiptap/extension-table`'s `TableView`
	   NodeView always wraps one, unconditionally; the `renderWrapper: false`
	   default this file used to describe here only gates the STATIC
	   `renderHTML` path this contenteditable editor never uses — a stale
	   assumption, corrected after this DOM was actually inspected). Putting
	   `overflow-x: auto` on the bare `table` element instead does NOT work:
	   `display: table` boxes compute `overflow` to `visible` regardless of
	   the specified value (confirmed via `getComputedStyle`), which is
	   exactly why `.document-content-text` (a `display: flex` column, not a
	   table) needed to stop being the one holding this rule in the first
	   place — that column must never independently overflow either axis
	   (see its own comment above). */
	.document-editor-host :global(.document-content .tableWrapper) {
		overflow-x: auto;
		max-width: 100%;
	}

	.document-editor-host :global(.document-content th) {
		text-align: left;
		padding: 9px 12px;
		font-size: 10.5px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		background-color: var(--surface-overlay);
		border-bottom: 1px solid var(--border-default);
	}

	.document-editor-host :global(.document-content td) {
		padding: 9px 12px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.document-editor-host :global(.document-content tr:last-child td) {
		border-bottom: 0;
	}

	/* The tracker chip (`extensions.ts`'s `TrackerChip` node): a status chip
	   is a real `<select>` (a listbox) so the toned pill background/text
	   below key off the wrapper span's own `data-chip-value` — the canonical
	   English token `chips.ts` always writes there, never the localized
	   label — so re-colouring never depends on the current UI language. A
	   date chip (`data-chip-kind="date"`) has no fixed vocabulary and no
	   tone; it reads as a plain bordered pill instead. */
	.document-editor-host :global(.document-content .tracker-chip) {
		display: inline-flex;
		align-items: center;
		height: 26px;
		padding: 0 10px;
		border-radius: var(--radius-full);
		background-color: var(--surface-elevated);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 12.5px;
		font-weight: 700;
		letter-spacing: 0.02em;
		vertical-align: middle;
	}

	.document-editor-host :global(.document-content .tracker-chip[data-chip-value='To book']),
	.document-editor-host :global(.document-content .tracker-chip[data-chip-value='Cancelled']) {
		background-color: var(--warning-tint);
		color: var(--warning-text);
	}

	.document-editor-host :global(.document-content .tracker-chip[data-chip-value='Booked']),
	.document-editor-host :global(.document-content .tracker-chip[data-chip-value='Paid']) {
		background-color: var(--success-tint);
		color: var(--success-text);
	}

	.document-editor-host :global(.document-content .tracker-chip[data-chip-kind='date']) {
		background-color: var(--surface-page);
		color: var(--text-primary);
		font-weight: 400;
		border: 1px solid var(--border-default);
	}

	.document-editor-host :global(.document-content .tracker-chip-select) {
		appearance: none;
		border: none;
		background-color: transparent;
		font: inherit;
		color: inherit;
		letter-spacing: inherit;
		padding: 0;
		margin: 0;
		cursor: pointer;
	}

	/* Step 2.2: Alfy's change mark (`marks.ts`'s `AlfyChange` Tiptap mark,
	   T8) — the visible trace of an applied patch (§1/§4), invisible before
	   this (marks.ts emitted the class with no matching CSS anywhere). The
	   2px underline in --accent keeps the change visible after its own tint
	   has settled all the way down to the page. `arrive` plays once, right
	   when the mark is first created — see marks.ts's own comment on why
	   rendering it unconditionally on every render is still safe — settling
	   from the loud --alfy-mark-arrive tint to the quiet resting --alfy-mark
	   tint over --duration-settle. Reduced motion needs no separate rule
	   here: app.css's global `animation-duration` override already collapses
	   any @keyframes animation, including this one, to 0.01ms, landing on
	   the resting state per §7.3 ("no movement... jump to the final state"). */
	.document-editor-host :global(.document-content .alfy-change) {
		background-color: var(--alfy-mark);
		border-radius: 2px;
		box-shadow: inset 0 -2px 0 var(--accent);
	}

	.document-editor-host :global(.document-content .alfy-change.arrive) {
		animation: alfy-change-arrive var(--duration-settle) var(--ease-out);
	}

	@keyframes alfy-change-arrive {
		from {
			background-color: var(--alfy-mark-arrive);
		}
		to {
			background-color: var(--alfy-mark);
		}
	}

	/* Step 2.3: comment-anchor highlight (§1/§2.2/§9.1). Wired up for real in
	   Wave 2.5 Step 7 (`extensions.ts`'s `CommentAnchors` plugin) — this
	   file's own job stays styling only. */
	.document-editor-host :global(.document-content .comment-anchor) {
		background-color: var(--comment-mark);
		border-radius: 2px;
		box-shadow: 0 2px 0 -0.5px var(--comment-rule);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	.document-editor-host :global(.document-content .comment-anchor.is-active) {
		background-color: var(--comment-mark-active);
	}

	/* A resolved thread's anchor, or one whose text survived but is no
	   longer worth drawing attention to — reads as plain text again. */
	.document-editor-host :global(.document-content .comment-anchor.is-resolved) {
		background-color: transparent;
		box-shadow: none;
		cursor: text;
	}

	/* §3.4: "visible focus: 2px --focus-ring, 2px offset, on every button,
	   chip and highlight" — only an OPEN anchor ever carries `tabindex`, so
	   this can never show on a resolved (plain-text) one. */
	.document-editor-host :global(.document-content .comment-anchor:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* Wave 2.5 Step 9/11: the Ask-Alfy chain's own decorations
	   (`alfy-writing-decoration.ts` builds these classes; this file's own job
	   stays styling only, matching the comment-anchor block above). Values
	   mirror the approved mockup's `.writing`/`.w-tag`/`.refused-line`
	   exactly, with `--accent`/`--warning` mapped onto this app's own
	   `--accent-fill`/`--warning-text` tokens. */
	.document-editor-host :global(.document-content .alfy-writing-block) {
		position: relative;
		/* Dims the TEXT only via `color`, never `opacity` on the block itself
		   — opacity would equally dim the gutter bar `::before` below (a
		   sibling-in-spirit pseudo-element of this same element), which the
		   mockup's own two-selector split (`.writing` vs `.writing > .w-text`)
		   keeps at full brightness on purpose. */
		color: color-mix(in srgb, var(--text-primary) 45%, transparent);
	}

	.document-editor-host :global(.document-content .alfy-writing-block::before) {
		content: "";
		position: absolute;
		left: -16px;
		top: 4px;
		bottom: 4px;
		width: 3px;
		border-radius: 3px;
		background: linear-gradient(
			180deg,
			var(--accent-fill) 0%,
			color-mix(in srgb, var(--accent-fill) 20%, transparent) 50%,
			var(--accent-fill) 100%
		);
		background-size: 100% 200%;
		animation: alfy-writing-gutter-bar 1.2s linear infinite;
	}

	@keyframes alfy-writing-gutter-bar {
		from {
			background-position: 0 0;
		}
		to {
			background-position: 0 200%;
		}
	}

	.document-editor-host :global(.document-content .alfy-writing-tag) {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		margin-left: 0.375rem;
		vertical-align: 2px;
		height: 22px;
		padding: 0 0.5rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--accent-tint);
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.document-editor-host :global(.document-content .alfy-writing-tag-icon) {
		font-size: 0.7rem;
	}

	/* Redesign §4.2 "Refusal": "the refused line... gets a dashed amber rule
	   in the gutter". */
	.document-editor-host :global(.document-content .alfy-refused-line) {
		position: relative;
	}

	.document-editor-host :global(.document-content .alfy-refused-line::after) {
		content: "";
		position: absolute;
		left: -16px;
		top: 3px;
		bottom: 3px;
		width: 0;
		border-left: 2px dashed var(--warning-text);
	}

	/* Redesign §4.2 item 2: "the selection keeps a dashed amber 'pending'
	   highlight so you still see what you are asking about" — live only
	   while the selection composer is open. */
	.document-editor-host :global(.document-content .selection-pending) {
		background-color: var(--warning-tint);
		border-bottom: 2px dashed var(--warning-text);
		border-radius: 2px;
	}

	.document-editor-skeleton {
		position: absolute;
		inset: 0;
		background-color: var(--surface-elevated);
		transition: opacity var(--duration-standard) var(--ease-out);
	}


	.document-notice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.625rem;
		margin: 1rem 1.25rem;
		padding: 0.875rem 1rem;
		background-color: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-primary);
	}

	.document-save-banner {
		padding: 0.5rem 1.25rem;
		border-top: 1px solid var(--border-subtle);
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
