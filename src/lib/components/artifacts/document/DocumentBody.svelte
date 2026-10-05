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
import EmptyState from "$lib/components/artifacts/EmptyState.svelte";
import { emptyStateLine } from "$lib/components/artifacts/empty-state";
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
import { uiLanguage } from "$lib/stores/settings";
import { documentCommentsRailHidden } from "$lib/stores/ui";
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
import { BLOCK_ID_ATTR } from "./block-attrs";
import { COMPOSER_BUBBLE_SIZE, computeBubblePlacement } from "./bubble-placement";
import { documentTabsFromCardMetadata } from "./card-view";
import {
	type AnchorBox,
	commentAnchorTargets,
	commentRailWidth,
	countCommentsByTab,
	pickFollowedComment,
	resolveCommentAnchors,
} from "./comment-threads";
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
	Editor,
} from "./document-editor";
import DocumentToolbar from "./DocumentToolbar.svelte";
import DownloadSheet from "./DownloadSheet.svelte";
import { alfyChangeShortcutFor, historyShortcutFor } from "./keyboard-shortcuts";
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
	onCommentsShownChange,
	onPendingReviewCountChange,
	tourSummary = null,
	onReplayTour,
	currentUser = null,
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
/** Whether the page has no words in it (reported by the editor on every transaction), which is when the empty state shows. */
let documentEmpty = $state(false);
/** What an empty page says: the Document's tour summary, else the dictionary's line (`empty-state.ts`). */
let emptyLine = $derived(
	emptyStateLine(tourSummary, $uiLanguage, $t, "document"),
);

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
let redoChangeFn: typeof DocumentEditorModule.redoChange | null = null;
let remarkChangeFn: typeof DocumentEditorModule.remarkChange | null = null;
let blockContentEndFn: typeof DocumentEditorModule.blockContentEnd | null = null;
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
// Every thread's anchor is resolved ONCE here (`comment-threads.ts`) — the
// editor's highlights need it whether or not any comment surface is showing,
// and the rail/sheet/drawer take the same result as a prop instead of each
// redoing the work on every keystroke. `activeCommentId` is whichever thread
// is currently linked to its words: hover/focus on its card, or on its own
// words in the text (`hoverCommentId`), or — when nothing is hovered — the
// thread whose words are nearest the top of what the reader has scrolled to
// (`followCommentId`). It drives BOTH the rail's `.is-active` card chrome
// and the editor's own decoration. `focusCommentRequest` is a ONE-SHOT signal
// (a bumped token, never just the id) for "scroll the list to and focus THIS
// thread's card"; `revealCommentRequest` is its quieter sibling for "bring it
// into view, leave focus alone" — both kept separate from `activeCommentId`
// on purpose: merely hovering a card must never also yank scroll/keyboard
// focus toward it.
const commentResolutions = $derived(resolveCommentAnchors(comments, blocks));
const commentAnchors = $derived(
	commentAnchorTargets(comments, commentResolutions),
);
let hoverCommentId = $state<string | null>(null);
let followCommentId = $state<string | null>(null);
const activeCommentId = $derived(hoverCommentId ?? followCommentId);
let focusCommentRequest = $state<{ commentId: string; token: number } | null>(
	null,
);
let revealCommentRequest = $state<{
	commentId: string;
	token: number;
	force?: boolean;
} | null>(null);
let revealCommentToken = 0;
let setCommentAnchorsFn:
	| typeof DocumentEditorModule.setCommentAnchors
	| null = null;
let scrollToCommentAnchorFn:
	| typeof DocumentEditorModule.scrollToCommentAnchor
	| null = null;

// ---- Wave 2.5 Step 8: the rail's phone sheet / narrow-panel drawer --------
// One comments surface at a time, decided here from the panel's own measured
// width (`commentRailWidth`, comment-threads.ts): the inline column beside
// the text when there is room for it (its width narrowing before the text
// does), a drawer over the text when there is not, a sheet on a phone. The
// header's Comments button toggles whichever one applies — for the inline
// column that is a per-device choice kept in the UI store; the drawer and the
// sheet just open and close.
let documentBodyEl = $state<HTMLDivElement | undefined>();
let panelContainerWidth = $state(0);
/** The review bar's own live rendered height (Review 2.5, rd/review-2-5.md:98-108) — read by the effect below and used to reserve enough bottom padding under the last paragraph. */
let reviewBarSlotEl = $state<HTMLDivElement | undefined>();
let reviewBarHeight = $state(0);
/** The review bar is flush with the text's bottom edge (`.document-review-bar-slot`'s `bottom: 0`); the drawer stops a small gap above it. */
const REVIEW_BAR_CLEARANCE_PX = 8;
let isPhone = $state(isPhoneViewport());
/** `0` (not measured yet — no ResizeObserver in this environment, e.g. jsdom) gets the full column rather than a false-positive drawer. */
let inlineRailWidth = $derived(commentRailWidth(panelContainerWidth));
let isNarrowPanel = $derived(inlineRailWidth === null);
let commentsOverlayOpen = $state(false);
/** The comment list's own view choices (Open/All, the removed-text fold), held here because the list is unmounted with its column, drawer or sheet and a choice kept inside it was lost every time (G2-B). Open by default (ruling 61); per document body, never persisted. */
let commentFilter = $state<"open" | "all">("open");
let commentOrphanedGroupOpen = $state(false);
/** The inline column beside the text: room for it, not on a phone, and not switched off on this device. */
let commentsRailShown = $derived(
	!isPhone && !isNarrowPanel && !$documentCommentsRailHidden,
);
/** What the header's Comments button reports as pressed: whichever surface applies is showing. */
let commentsShown = $derived(
	isPhone || isNarrowPanel ? commentsOverlayOpen : commentsRailShown,
);
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
	/**
	 * The extra blocks a multi-block change had added (`entry.insertedBlockIds`),
	 * read from `blocks` state at the same moment — Undo deletes them, so this is
	 * the only place their text survives for Redo to put back.
	 */
	appliedInsertedBlocks?: { blockId: string; markdown: string }[];
	/** Captured right before Undo removes the mark structurally — the pill's own fallback anchor while `status` is `"undone"` (`change-pill-decoration.ts`'s own `fallbackPos`). */
	fallbackPos?: number;
}
let alfyWritingLabel = $state<string | null>(null);
/**
 * rd/review-2-5.md:217-222: one shared, visually hidden `aria-live="polite"`
 * region (rendered once, near the top of this component's template),
 * ALWAYS present in the DOM — unlike `ReviewBar.svelte`'s own former
 * `role="status"`, a region that already carries text the moment it mounts
 * is commonly NOT announced; a later text CHANGE on an already-mounted live
 * region is what reliably is. Fed by comment added/resolved, Alfy's own
 * reply landing (the review bar's own "Alfy changed N parts" summary AND an
 * `@Alfy` comment reply), and Keep/Undone — the four events the review
 * named. `ReviewBar.svelte`'s own region is now a plain, non-live
 * `role="region"`; it never announces itself, and a stepper move no longer
 * re-reads the whole bar.
 */
let announcement = $state("");
function announce(message: string): void {
	announcement = message;
}
let pendingChanges = $state<Map<string, PendingAlfyChange>>(new Map());
/**
 * Re-check "New breakage": `pendingChanges` above starts empty on every
 * load, so the reporting effect below used to fire with `0` the instant
 * this component mounted — before `restorePendingReview`'s own network
 * round trip ever confirmed the true pending set, flashing the chat card/
 * list row/count-button dot to "Reviewed" for ~100-300ms. Gates that effect
 * until THIS load's restore has settled successfully; a failed restore
 * leaves this `false` for the rest of the load, so nothing overwrites the
 * persisted count with a guessed `0`. Reset alongside `pendingChanges`
 * itself on every new `runLoad`.
 */
let pendingReviewRestoreSettled = $state(false);
/** The review bar's own stepper position (0-based) into the CURRENTLY pending entries, in Map-insertion order. */
let reviewIndex = $state(0);
/** Keyed by changeId — cleared by Redo (cancels the pending removal) or by `removePendingChange` itself; a plain Map, never `$state`, since it drives no render on its own. */
const undoSettleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The change Undo ran on last — which "Undone · Redo" pill Redo's chord brings back when several are showing at once. */
let lastUndoneChangeId: string | null = null;
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
 * THREADS (root comments, never replies) are still open. The counting itself
 * is `countCommentsByTab` (comment-threads.ts) — the SAME one the rail's
 * "in other tabs" rows and its header count use, so the number on a tab and
 * the number in the rail can never disagree — recomputed here (rather than
 * read back out of the editor's decoration) because this needs to run
 * whenever `comments` changes too, not just `tabs`/`blocks`.
 */
function computeTabBadgeCounts(
	docBlocks: DocumentBlock[],
	docComments: ArtifactComment[],
	docTabs: DocumentTab[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [tabId, own] of countCommentsByTab(
		docComments,
		docBlocks,
		docTabs,
	)) {
		if (own.open > 0) counts[tabId] = own.open;
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
		announce($t("artifacts.document.announce.alfyReplied"));
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
	announce($t("artifacts.document.announce.commentAdded"));
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
	// The new card belongs in view whether or not it flies there: ask the
	// inline column (if it is showing) to bring it in, past its "the reader is
	// using the list" guard — the reader is in the text, having just written it.
	if (createdId && commentsRailShown) {
		revealCommentToken += 1;
		revealCommentRequest = {
			commentId: createdId,
			token: revealCommentToken,
			force: true,
		};
	}
	if (!sourceRect || prefersReducedMotion() || !documentBodyEl) return;
	await tick();
	const target = documentBodyEl.querySelector(
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
	announce($t("artifacts.document.announce.commentAdded"));
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
		announce(
			resolved
				? $t("artifacts.document.announce.commentResolved")
				: $t("artifacts.document.announce.commentReopened"),
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
/**
 * Final polish D2: an activity that had already settled when THIS body mounted
 * happened before it. The persisted review state (`restorePendingReview`, ruling
 * 61) is the only source of what it changed — landing it live on top of that
 * counts the change twice (one entry keyed by the op, one by the block), and the
 * copy survives Undo and comes back after Keep. The panel builds a body again on
 * every later open of the Document, and hands each one the panel's latest
 * activity, so the once-only rule belongs here: a call is applied live by the
 * body that was mounted while it was still running (or before it began), and by
 * no body built after it settled. Captured once, at mount; `runLoad` resets
 * `handledActivityKey` on every (re)load, which is why that cannot stand in for
 * it.
 */
const settledActivityKeyAtMount = untrack(() =>
	alfyActivity && alfyActivity.status !== "running" ? alfyActivity.key : null,
);
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
	// Settled before this body existed: the server's review state owns it.
	if (activity.key === settledActivityKeyAtMount) return;

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
 * rd/review-2-5.md:210-216: Keep's OWN resulting "kept" pill state renders no
 * button at all (just a checkmark and a notice), unlike Undo's own "undone"
 * state (which keeps a Redo button `ChangeBar.svelte` autofocuses itself) —
 * so the Keep button that had focus is destroyed by the widget's own remount
 * with nothing inside the pill left to take its place, dropping focus to
 * `<body>`. Moves it to the review bar's own first button when one is still
 * showing (more pending changes remain after this one), or back into the
 * document itself when Keep just emptied the pending list entirely (the
 * review bar unmounts, per `DocumentBody.svelte`'s own `{#if pendingList.length
 * > 0}`).
 */
async function focusAfterKeep(): Promise<void> {
	await tick();
	// `pendingList.length` (the reactive truth), never bare DOM presence: the
	// review bar's own OUT transition keeps its element (and its never-
	// disabled Keep-all/Undo-all buttons) in the DOM for a moment after
	// `pendingList` already reads empty, so querying the DOM alone would
	// focus a control that is already on its way out, no better than losing
	// focus once ITS OWN removal completes moments later.
	// `:not([disabled])` — the stepper's own Prev/Next are disabled with only
	// one pending change left (nothing to step to), which a plain "first
	// button" query would still hand back; a disabled button silently
	// refuses focus, so that would look identical to the original bug.
	const reviewBarButton =
		pendingList.length > 0
			? reviewBarSlotEl?.querySelector<HTMLButtonElement>(
					"button:not([disabled])",
				)
			: null;
	if (reviewBarButton) {
		reviewBarButton.focus();
		return;
	}
	editor?.view.focus();
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
	announce($t("artifacts.document.change.keptNotice"));
	void acknowledgeReview([pending.entry.blockId]);
	void focusAfterKeep();
	setTimeout(() => {
		if (editor && keepChangeFn) keepChangeFn(editor, changeId);
		removePendingChange(changeId);
	}, KEEP_SETTLE_MS);
}

/**
 * Undo: restores exactly this change's pre-edit text and treats that as a
 * USER edit — scheduled through the normal autosave path (T8's own rule),
 * not a second, silent write. Unlike Keep, the mark is gone the instant this
 * runs (`undoAlfyChange` replaces the whole node), so the pill's own fallback
 * anchor for the "Undone · Redo" window (redesign §7.2 #14) is the end of the
 * restored block — read AFTER Undo, since the restored text can be shorter
 * than what the mark covered and an earlier position would then point into
 * the next block. `appliedMarkdown` is captured first (from `blocks` state,
 * still showing the pre-undo, Alfy-applied text) — Redo's own restore
 * target, since nothing else keeps what Undo is about to overwrite.
 */
function handleUndoChange(changeId: string): void {
	if (!editor || !undoChangeFn) return;
	const pending = pendingChanges.get(changeId);
	if (!pending) return;
	const appliedMarkdown = blocks.find(
		(b) => b.id === pending.entry.blockId,
	)?.markdown;
	const appliedInsertedBlocks = (pending.entry.insertedBlockIds ?? []).flatMap(
		(blockId) => {
			const block = blocks.find((b) => b.id === blockId);
			return block ? [{ blockId, markdown: block.markdown }] : [];
		},
	);
	undoChangeFn(editor, {
		...pending.entry,
		isNewBlock: pending.isNewBlock,
	});
	const fallbackPos =
		blockContentEndFn?.(editor, pending.entry.blockId) ?? undefined;
	lastUndoneChangeId = changeId;
	pendingChanges = new Map(pendingChanges).set(changeId, {
		...pending,
		status: "undone",
		fallbackPos,
		appliedMarkdown,
		appliedInsertedBlocks,
	});
	announce($t("artifacts.document.change.undoneNotice"));
	const canonical = currentCanonicalMarkdown();
	if (canonical !== null) {
		// Spec §4.2 item 6: "a version is recorded (\"Undid Alfy's change\")" —
		// its own summary, not another anonymous "Edited".
		autosave?.schedule(canonical, { summaryKind: "undid_alfy_change" });
		updateBlocksFromMarkdown(canonical);
	}
	void acknowledgeReview([pending.entry.blockId]);
	const timer = setTimeout(() => removePendingChange(changeId), UNDO_SETTLE_MS);
	undoSettleTimers.set(changeId, timer);
}

/**
 * Redo: reverses Undo within its own settle window — `redoChangeFn` sets the
 * block back to the captured `appliedMarkdown` and puts back the extra blocks
 * a multi-block change had added (`appliedInsertedBlocks`, captured by
 * `handleUndoChange` before Undo deleted them), then the block is re-marked
 * under the SAME `changeId` so the pill goes back to `"pending"`.
 */
function handleRedoChange(changeId: string): void {
	if (!editor || !redoChangeFn || !remarkChangeFn) return;
	const pending = pendingChanges.get(changeId);
	if (!pending || pending.status !== "undone") return;
	// A Redo pressed on the pill itself: its button is about to be replaced by
	// the pending pill's, and the focus it had would fall to <body>.
	const focusWasOnPill = !!document.activeElement?.closest("[data-change-id]");
	const timer = undoSettleTimers.get(changeId);
	if (timer !== undefined) {
		clearTimeout(timer);
		undoSettleTimers.delete(changeId);
	}
	if (pending.appliedMarkdown !== undefined) {
		redoChangeFn(editor, {
			blockId: pending.entry.blockId,
			appliedMarkdown: pending.appliedMarkdown,
			insertedBlocks: pending.appliedInsertedBlocks,
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
	if (focusWasOnPill) void focusPillUndo(changeId);
}

/**
 * After a Redo pressed on the pill itself (Enter or Space on its button): the
 * pill is a fresh "pending" one and the focus fell to <body>. Puts it on the
 * new Undo — the button the reader had just pressed — so Undo and Redo can be
 * toggled from the keyboard without losing the place.
 */
async function focusPillUndo(changeId: string): Promise<void> {
	await tick();
	for (const pill of documentBodyEl?.querySelectorAll<HTMLElement>(
		"[data-change-id]",
	) ?? []) {
		if (pill.dataset.changeId !== changeId) continue;
		pill.querySelector<HTMLButtonElement>(".alfy-change-bar-undo")?.focus();
		return;
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

// ---- G3: keyboard ----------------------------------------------------------
// Two families of keys, kept apart (`keyboard-shortcuts.ts` explains why):
// the reader's own text history — ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z, ⌘/Ctrl+Y — which
// the editor itself claims while the text has the focus (`document-editor.ts`)
// and which this body claims for a focus that is anywhere else in the panel
// (a toolbar button, a tab, a pill, the review bar); and Alfy's change — the
// pill's own Undo and Redo, ⌘/Ctrl+Alt+Z and the same with Shift — which is
// not in the text history and so has chords of its own.

/** A field that has an undo of its own (a comment or reply box): the keys stay the browser's there. */
const TEXT_FIELD_SELECTOR =
	"textarea, input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']):not([type='range']):not([type='file'])";

/**
 * The top-level block the caret is in, by its block id; `null` with no caret.
 * Read from the browser's own selection first: ProseMirror learns of a click
 * on the next `selectionchange`, so a chord pressed right after one would still
 * find the previous position in the editor's state. The state is the fallback.
 */
function caretBlockId(): string | null {
	const view = editor?.view;
	const selection = window.getSelection?.();
	let caret = editor?.state.selection.$from;
	if (
		view?.dom &&
		typeof view.posAtDOM === "function" &&
		selection?.anchorNode &&
		view.dom.contains(selection.anchorNode)
	) {
		try {
			caret = view.state.doc.resolve(
				view.posAtDOM(selection.anchorNode, selection.anchorOffset),
			);
		} catch {
			// A position the document no longer has: the editor's own state stands.
		}
	}
	if (!caret || caret.depth < 1) return null;
	const id = caret.node(1)?.attrs?.[BLOCK_ID_ATTR];
	return typeof id === "string" ? id : null;
}

/**
 * Which change an Alfy-change chord acts on: the one whose pill has the focus,
 * else the one in the block the caret is in, else the one the review bar is
 * showing (Undo) or the one Undo ran on last (Redo), else the first. Only
 * changes in the state the chord needs — a pending change to undo, an undone
 * one (inside its "Undone · Redo" window) to redo — count.
 */
function changeForChord(
	status: "pending" | "undone",
	target: HTMLElement | null,
): string | null {
	const matching = [...pendingChanges].filter(([, p]) => p.status === status);
	if (matching.length === 0) return null;
	const ids = new Set(matching.map(([id]) => id));
	const pillId = target?.closest<HTMLElement>("[data-change-id]")?.dataset
		.changeId;
	if (pillId && ids.has(pillId)) return pillId;
	const caretBlock = caretBlockId();
	const atCaret = caretBlock
		? matching.find(([, p]) => p.entry.blockId === caretBlock)
		: undefined;
	if (atCaret) return atCaret[0];
	if (status === "pending") return pendingList[reviewIndex]?.[0] ?? matching[0][0];
	if (lastUndoneChangeId && ids.has(lastUndoneChangeId)) {
		return lastUndoneChangeId;
	}
	return matching[matching.length - 1][0];
}

/** `true` when there was a change for the chord to act on. */
function runAlfyChangeShortcut(
	action: "undo" | "redo",
	target: HTMLElement | null,
): boolean {
	const changeId = changeForChord(
		action === "undo" ? "pending" : "undone",
		target,
	);
	if (!changeId) return false;
	if (action === "undo") handleUndoChange(changeId);
	else handleRedoChange(changeId);
	return true;
}

/**
 * Keys pressed anywhere inside the panel bubble up here. The editor has
 * already handled its own (it marks them `defaultPrevented`); this is for the
 * rest. A key from a text field keeps that field's own behaviour.
 */
function handleBodyKeydown(event: KeyboardEvent): void {
	if (event.defaultPrevented || !editor) return;
	const target = event.target instanceof HTMLElement ? event.target : null;
	if (target?.closest(TEXT_FIELD_SELECTOR)) return;

	const alfyChange = alfyChangeShortcutFor(event);
	if (alfyChange) {
		if (runAlfyChangeShortcut(alfyChange, target)) event.preventDefault();
		return;
	}

	const history = historyShortcutFor(event);
	// In the text the editor claimed the key itself. A control that lives
	// inside the editor's DOM (a pill's button, a chip select, a task
	// checkbox) is not the text: those come here.
	const inText =
		!!target?.closest(".ProseMirror") &&
		!target.closest("button, select, input, .ProseMirror-widget");
	if (history && !inText) {
		// Focus is on a button, a tab or a pill: the same undo the toolbar's own
		// button runs (which also brings the focus back into the text).
		event.preventDefault();
		handleToolbarAction(history);
	}
}
// ---- end G3: keyboard -------------------------------------------------------

/**
 * "See what Alfy did" / a comment's own change chip / the review bar's
 * stepper — scrolls to one already-applied change's own mark. rd/review-2-5.md:122-129:
 * a change living in a tab other than the active one sits inside a
 * `display:none` section (ruling 61's "tabs show only their own section"),
 * so scrolling straight to it did nothing visible — this switches to the
 * change's own tab FIRST (via the same `handleTabActivate` a click on the
 * tab strip uses) and waits a `tick()` for that section to actually become
 * visible before scrolling. The changeId → blockId lookup goes through
 * `pendingChanges` (the same map every change pill/the review bar itself
 * reads) rather than searching the live document, since every caller here
 * only ever names a changeId that is (or very recently was) one of its
 * entries.
 */
async function seeChange(changeId: string): Promise<void> {
	if (!editor || !scrollToChangeFn) return;
	const blockId = pendingChanges.get(changeId)?.entry.blockId;
	if (blockId) {
		const targetTabId = mapBlocksToTabs(blocks, tabs).get(blockId);
		if (targetTabId && targetTabId !== activeTabId) {
			handleTabActivate(targetTabId);
			await tick();
		}
	}
	scrollToChangeFn(editor, changeId);
}

function handleSeeChange(): void {
	if (refusalNotice?.firstAppliedChangeId) {
		void seeChange(refusalNotice.firstAppliedChangeId);
	}
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
// Wave 2.5 review (F1): the ONE call this body makes into the shell's own
// persisted-count plumbing (see `ArtifactBodyProps.onPendingReviewCountChange`'s
// own doc comment) — so the chat card, the list row and the count-button dot
// all reflect Keep/Undo/Keep-all the instant they happen, without a reload.
// Gated on `pendingReviewRestoreSettled` (see its own doc comment) so the
// pre-restore empty `Map` is never mistaken for a confirmed "nothing
// pending" — only a settled restore, or a later genuine mutation (Keep,
// Undo, Keep all, a new Alfy edit, a user edit that acknowledges a block),
// reports from here on.
$effect(() => {
	if (!pendingReviewRestoreSettled) return;
	onPendingReviewCountChange?.(pendingList.length);
});
// rd/review-2-5.md:217-222: the review bar's own "Alfy changed N parts"
// summary used to rely on `role="status"` announcing itself on mount — most
// screen readers do not, since the region already carries text the moment
// it appears. Re-announced through the shared announcer instead, on any
// INCREASE (the bar first appearing, or a further Alfy edit landing while it
// is already showing) — never on a decrease, which is Keep/Undo's own
// announcement's job, not this one's.
let previousPendingCount = 0;
$effect(() => {
	const count = pendingList.length;
	if (count > previousPendingCount) {
		announce($t("artifacts.document.review.summary", { count }));
	}
	previousPendingCount = count;
});

function handleReviewPrev(): void {
	if (pendingList.length === 0) return;
	reviewIndex = (reviewIndex - 1 + pendingList.length) % pendingList.length;
	const [changeId] = pendingList[reviewIndex];
	void seeChange(changeId);
}

function handleReviewNext(): void {
	if (pendingList.length === 0) return;
	reviewIndex = (reviewIndex + 1) % pendingList.length;
	const [changeId] = pendingList[reviewIndex];
	void seeChange(changeId);
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
		// as "no marker yet": nothing pending. Deliberately does NOT set
		// `pendingReviewRestoreSettled` — see the re-check "New breakage": a
		// failed fetch must not be reported as a confirmed zero, so the
		// reporting effect stays gated and the persisted count stands.
		return;
	}
	if (myToken !== loadToken) return;
	// The server gave a definitive answer for THIS load — safe to report
	// from here on, whether or not there turns out to be anything pending.
	pendingReviewRestoreSettled = true;
	if (!editor || pending.length === 0) return;

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
async function handleAskAgainRefusal(): Promise<void> {
	const blockId = refusalNotice?.refusedBlockIds[0];
	if (!blockId || !editor || !selectAndScrollToBlockFn) return;
	// The card is listed wherever its line's tab is not showing too: a line
	// in a section that is hidden cannot be selected until its tab is.
	const targetTabId = mapBlocksToTabs(blocks, tabs).get(blockId);
	if (targetTabId && targetTabId !== activeTabId) {
		handleTabActivate(targetTabId);
		await tick();
	}
	selectAndScrollToBlockFn(editor, blockId);
	dismissRefusalNotice();
}
// The refusal card's own data for the comment list: "your words win" reads as
// one of the comment family, at its line's position (a sheet or drawer lists
// it first) — no longer a banner above the text.
const marginRefusal = $derived(
	refusalNotice
		? {
				blockId: refusalNotice.refusedBlockIds[0] ?? null,
				message: refusalNotice.message,
				items: refusalNotice.items,
				seeChangeLabel: refusalNotice.seeChangeLabel ?? undefined,
				onSeeChange: refusalNotice.seeChangeLabel ? handleSeeChange : undefined,
				askAgainLabel: refusalNotice.refusedBlockIds[0]
					? $t("artifacts.document.comment.askAgain")
					: undefined,
				onAskAgain: refusalNotice.refusedBlockIds[0]
					? handleAskAgainRefusal
					: undefined,
				dismissLabel: $t("artifacts.document.refused.dismiss"),
				onDismiss: dismissRefusalNotice,
			}
		: null,
);
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

/**
 * Ruling 61: "a user's own edit to such a block acknowledges it" — server-side
 * this was already true after a reload (`document-ops.ts`'s own
 * `computePendingReviewBlocks` treats a later user-authored version as the
 * block's most recent change, which excludes it), but nothing told the LIVE
 * session the same thing: the pill and the review bar's own count kept
 * showing a change the user had, in effect, already resolved by typing over
 * it, and Undo would then restore the PRE-ALFY text, throwing the user's own
 * edit away with it (rd/review-2-5.md:141-148).
 *
 * Compares every still-pending block's hash before/after this update (`blocks`
 * state is still the PRE-update value here — the caller reassigns it right
 * after this returns); a block whose hash changed (edited) or that no longer
 * exists (deleted) is dropped from the live `pendingChanges` map — the same
 * `setChangePills` effect that renders the pills reacts to this — and its
 * mark cleared exactly as Keep does, immediately rather than through Keep's
 * own 1.4s settle window: there is no "Kept" feedback to show, since the user
 * never clicked anything.
 */
function acknowledgePendingBlocksTouchedByUserEdit(
	nextBlocks: DocumentBlock[],
): void {
	if (pendingChanges.size === 0) return;
	const previousHashById = new Map(blocks.map((b) => [b.id, b.hash]));
	const nextHashById = new Map(nextBlocks.map((b) => [b.id, b.hash]));

	const touchedChangeIds: string[] = [];
	const touchedBlockIds: string[] = [];
	for (const [changeId, pending] of pendingChanges) {
		if (pending.status !== "pending") continue;
		const blockId = pending.entry.blockId;
		const before = previousHashById.get(blockId);
		if (before === undefined) continue; // nothing to compare against yet
		if (nextHashById.get(blockId) === before) continue; // untouched
		touchedChangeIds.push(changeId);
		touchedBlockIds.push(blockId);
	}
	if (touchedChangeIds.length === 0) return;

	const next = new Map(pendingChanges);
	for (const changeId of touchedChangeIds) next.delete(changeId);
	pendingChanges = next;

	if (editor && keepChangeFn) {
		for (const changeId of touchedChangeIds) keepChangeFn(editor, changeId);
	}
	void acknowledgeReview(touchedBlockIds);
}

function handleUpdate(): void {
	updateActiveActionIds();
	const canonical = currentCanonicalMarkdown();
	if (canonical !== null) {
		autosave?.schedule(canonical);
		const nextBlocks = parseDocument(canonical, { mint: false }).blocks;
		acknowledgePendingBlocksTouchedByUserEdit(nextBlocks);
		// Keeps the margin's anchor resolution live as the user types, not just
		// after the next full reload.
		blocks = nextBlocks;
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

/** A tapped highlight's own fallback (`handleEditorAnchorActivate` below): the drawer or sheet, opened where the inline column is not an option. */
function openCommentsOverlay(): void {
	commentsOverlayOpen = true;
}

/**
 * The header's Comments button (`registerPanelActions`): ONE toggle for
 * whichever comments surface applies — it never opens a second copy beside
 * the one already showing. The inline column is switched off/on for this
 * device (the UI store remembers it); the drawer and the sheet just open and
 * close.
 */
function toggleComments(): void {
	if (isPhone || isNarrowPanel) {
		commentsOverlayOpen = !commentsOverlayOpen;
		return;
	}
	documentCommentsRailHidden.update((hidden) => !hidden);
}

// Wave 2.5 Step 3: hands the panel header the sheet triggers above, so
// `ArtifactPanelHeader.svelte`/`DocumentWorkspace.svelte` can open them
// without knowing anything about Tiptap or this body's own state — see
// `ArtifactBodyProps.registerPanelActions`. No dependency this effect reads
// ever changes (the functions are stable closures over local `$state`
// setters), so this runs once, after mount, like `onMount`. That is enough
// because the panel mounts one body per open item (final polish D1): a swap
// to another item builds a new body, which registers here for itself.
$effect(() => {
	registerPanelActions?.({
		openVersions: openVersionsSheet,
		openDownload: openDownloadSheet,
		toggleComments,
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
	onCommentsShownChange?.(commentsShown);
});

$effect(() => {
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
	return stopWatchingViewport;
});

// Tracks this body's own rendered width: `commentRailWidth` decides from it
// whether the inline column fits beside the text (and how wide it is) or the
// comments are a drawer. Read once straight away so the very first paint
// already has the right surface, then kept live. Guarded: jsdom (this
// component's own tests) has no ResizeObserver, and the panel must render
// correctly without one.
$effect(() => {
	const el = documentBodyEl;
	if (!el || typeof ResizeObserver === "undefined") return;
	panelContainerWidth = el.getBoundingClientRect().width;
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
// (a window/panel resize wide enough for the inline column) — otherwise the
// drawer would float uselessly ALONGSIDE it, a second copy of the comments.
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
	// The thread the reader was on belongs to the section just left.
	followCommentId = null;
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
		save: (markdown, saveOptions) =>
			saveArtifactBody(
				id,
				markdown,
				versionNumber ?? undefined,
				conversationId,
				undefined,
				{
					baseHash: knownBodyHash ?? undefined,
					// An Undo of Alfy's change records its own version summary.
					...(saveOptions?.summaryKind
						? { summaryKind: saveOptions.summaryKind }
						: {}),
				},
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
		redoChangeFn = mod.redoChange;
		remarkChangeFn = mod.remarkChange;
		blockContentEndFn = mod.blockContentEnd;
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
		pendingReviewRestoreSettled = false;
		reviewIndex = 0;
		refusalNotice = null;
		handledActivityKey = "";
		// A stale bubble/composer would otherwise keep pointing at the PREVIOUS
		// document's own block id once this one's editor replaces it.
		clearSelectionBubble();
		changeIdByCommentId = new Map();
		hoverCommentId = null;
		followCommentId = null;
		focusCommentRequest = null;
		revealCommentRequest = null;
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
			onEmptyChange: (empty) => {
				documentEmpty = empty;
			},
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

// Scroll-follow (the owner's walk-through: the comment list stays in view
// while the text scrolls): as the reader scrolls the text, the thread whose
// words are nearest the top of the reading area becomes the active one —
// its words deepen, its card takes the active look — and the inline column
// is asked to bring its card into view. Reads only (one rectangle per open
// highlight, batched into a frame), and only while the inline column is
// showing: nothing else has a list to keep in step. `MarginPanel` leaves its
// scroll alone while the reader is using the list itself.
$effect(() => {
	const scroller = contentEl;
	const host = editorEl;
	if (!scroller || !host || !commentsRailShown) return;
	let frame = 0;

	function follow(): void {
		frame = 0;
		const open = new Set<string>();
		for (const anchor of commentAnchors) {
			if (!anchor.resolved) open.add(anchor.commentId);
		}
		// One pass over the text's highlights, in document order: a thread's
		// words can be several spans (a mark in the middle splits one), so each
		// thread's box is the union of its spans' line boxes. A span in a hidden
		// section has no line boxes at all and adds nothing.
		const boxes = new Map<string, AnchorBox>();
		for (const span of host?.querySelectorAll("[data-comment-anchor-id]") ??
			[]) {
			const commentId = span.getAttribute("data-comment-anchor-id");
			if (!commentId || !open.has(commentId)) continue;
			for (const rect of span.getClientRects()) {
				const box = boxes.get(commentId);
				if (box) {
					box.top = Math.min(box.top, rect.top);
					box.bottom = Math.max(box.bottom, rect.bottom);
				} else {
					boxes.set(commentId, {
						commentId,
						top: rect.top,
						bottom: rect.bottom,
					});
				}
			}
		}
		const bounds = scroller?.getBoundingClientRect();
		if (!bounds) return;
		const next = pickFollowedComment([...boxes.values()], {
			top: bounds.top,
			bottom: bounds.bottom,
		});
		if (next === followCommentId) return;
		followCommentId = next;
		if (next) {
			revealCommentToken += 1;
			revealCommentRequest = { commentId: next, token: revealCommentToken };
		}
	}

	function onScroll(): void {
		if (!frame) frame = requestAnimationFrame(follow);
	}

	scroller.addEventListener("scroll", onScroll, { passive: true });
	return () => {
		scroller.removeEventListener("scroll", onScroll);
		if (frame) cancelAnimationFrame(frame);
	};
});

// Redesign §3.2, Wave 2.5 Step 7: pushes every thread's resolved anchor —
// and whichever thread is currently linked — into the live decoration
// whenever either changes, whether or not any comment surface is showing.
// `setCommentAnchorsFn` is `null` until the lazy editor module resolves;
// nothing to decorate before that anyway.
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
			blockLabel: pending.entry.blockLabel,
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
	if (changeId) void seeChange(changeId);
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
	if (commentId) hoverCommentId = commentId;
}

function handleEditorAnchorHoverOut(event: Event): void {
	if (findCommentAnchorTarget(event)) hoverCommentId = null;
}

let focusCommentRequestToken = 0;

function handleEditorAnchorActivate(event: Event): void {
	const target = findCommentAnchorTarget(event);
	const commentId = target?.getAttribute("data-comment-anchor-id");
	if (!commentId) return;
	event.preventDefault();
	hoverCommentId = commentId;
	focusCommentRequestToken += 1;
	const token = focusCommentRequestToken;
	focusCommentRequest = { commentId, token };
	// The thread the request just named needs somewhere to appear: the
	// drawer or sheet where the inline column is not an option, or the
	// inline column itself when this device had switched it off. Whichever
	// surface it is reacts to `focusCommentRequest` on mount, not just on
	// change.
	if (isPhone || isNarrowPanel) openCommentsOverlay();
	else if ($documentCommentsRailHidden) documentCommentsRailHidden.set(false);
	// A request left in place would be replayed by the NEXT surface that
	// mounts (the column toggled off and on again): drop it once whichever
	// surface was going to act on it has.
	void tick().then(() =>
		setTimeout(() => {
			if (focusCommentRequest?.token === token) focusCommentRequest = null;
		}, 0),
	);
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="document-body" bind:this={documentBodyEl} onkeydown={handleBodyKeydown}>
	<!-- rd/review-2-5.md:217-222: the one shared announcer — see its own
	     `announce()` doc comment above. Always mounted, regardless of load
	     state, so a text change here is reliably picked up by screen readers
	     from the very first thing this component ever announces. -->
	<div class="sr-only" role="status" aria-live="polite" data-testid="document-announcer">
		{announcement}
	</div>
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
		     edit_artifact call is in flight. It sits above the content row so it
		     neither depends on — nor fights with — the editor's own layout. (The
		     refusal notice used to sit here too; it is a card in the comment
		     list now, beside the line it is about.) -->
		{#if alfyWritingLabel !== null}
			<AlfyWriting label={alfyWritingLabel} />
		{/if}
		<!-- The text and its comments, side by side. `.document-content` is a
		     plain row that does not scroll; the TEXT column inside it is the one
		     scroller (`contentEl` — every `localizePoint`/bubble computation
		     below measures it), and the comment column beside it never scrolls
		     away with the text: it keeps its own place and its own list scroll
		     ("the comments themselves should scroll with the viewport, not just
		     the section title" — the owner's words, on a version that laid both
		     columns in one scroller). The change pill no longer needs `contentEl`
		     (Wave 2.5 Step 10: a ProseMirror widget decoration, positioned in
		     DOCUMENT space). Whether the column shows at all — and how wide it
		     is — is `commentRailWidth`'s call from this body's own measured
		     width; on a narrow panel or a phone the same list is a drawer/sheet
		     instead, never both. -->
		<div class="document-content">
			<div class="document-content-text" bind:this={contentEl}>
				<!-- One flow column inside the scroller, at least as tall as the scroller and
				     as tall as the text: the review bar is `position: sticky` inside it, and a
				     sticky element can only travel within its PARENT's box — the scroller's
				     own box is only as tall as the viewport, so pinning the bar to it would
				     let the bar scroll away with the text. -->
				<div class="document-content-flow">
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
						<!-- Slice 6 T6: an empty page says what the Document's tour says, and
						     offers the tour again. Zero-height anchor ahead of the host, with the
						     block laid just under the first line, so the text's own column does not
						     move when the first word is typed (the block goes, nothing shifts). -->
						{#if editorReady && documentEmpty}
							<div class="document-empty-anchor">
								<div class="document-empty">
									<EmptyState line={emptyLine} testId="document-empty" {onReplayTour} />
								</div>
							</div>
						{/if}
						<div
							class="document-editor-host"
							bind:this={editorEl}
							role={tabs.length > 1 ? 'tabpanel' : undefined}
							id={tabs.length > 1 ? `document-tabpanel-${activeTabId}` : undefined}
							aria-labelledby={tabs.length > 1 ? `document-tab-${activeTabId}` : undefined}
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
								currentUserId={currentUser?.id ?? null}
								currentUserName={currentUser?.displayName ?? null}
								currentUserProfilePicture={currentUser?.profilePicture ?? null}
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
								docked
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
			</div>
			<!-- T10 / redesign §3.2: the comment column, beside the text. Its width
			     narrows (300 → 240 px) before the text column drops below
			     480 px; below that there is no column, the header's Comments
			     button opens the drawer instead. Switched off per device by the
			     same button. -->
			{#if commentsRailShown}
				<aside
					class="document-content-rail"
					style:width={inlineRailWidth ? `${inlineRailWidth}px` : undefined}
					aria-label={$t('artifacts.document.margin.title')}
				>
					<MarginPanel
						{comments}
						{blocks}
						filter={commentFilter}
						onFilterChange={(next) => (commentFilter = next)}
						orphanedGroupOpen={commentOrphanedGroupOpen}
						onOrphanedGroupOpenChange={(open) => (commentOrphanedGroupOpen = open)}
						resolutions={commentResolutions}
						{tabs}
						{activeTabId}
						refusal={marginRefusal}
						changeStateByCommentId={changeChipByCommentId}
						{activeCommentId}
						focusRequest={focusCommentRequest}
						revealRequest={revealCommentRequest}
						onResolve={handleCommentResolve}
						onSubmitReply={postReply}
						onSeeChange={handleSeeChangeForComment}
						onGotoAnchor={handleGotoCommentAnchor}
						onActiveCommentChange={(id) => (hoverCommentId = id)}
						onActivateTab={handleTabActivate}
						currentUserId={currentUser?.id ?? null}
						currentUserName={currentUser?.displayName ?? null}
						currentUserProfilePicture={currentUser?.profilePicture ?? null}
					/>
				</aside>
			{/if}
			<!-- Wave 2.5 Step 8: the same comments where the inline column is not
			     an option — a phone sheet or a drawer inside the panel, opened by
			     the header's Comments button (`registerPanelActions`) or a tapped
			     highlight (`handleEditorAnchorActivate`). -->
			{#if commentsOverlayOpen}
				<CommentsSheet
					presentation={isPhone ? 'sheet' : 'drawer'}
					{comments}
					{blocks}
					filter={commentFilter}
					onFilterChange={(next) => (commentFilter = next)}
					orphanedGroupOpen={commentOrphanedGroupOpen}
					onOrphanedGroupOpenChange={(open) => (commentOrphanedGroupOpen = open)}
					resolutions={commentResolutions}
					{tabs}
					{activeTabId}
					refusal={marginRefusal}
					changeStateByCommentId={changeChipByCommentId}
					{activeCommentId}
					focusRequest={focusCommentRequest}
					onResolve={handleCommentResolve}
					onSubmitReply={postReply}
					onSeeChange={handleSeeChangeForComment}
					onGotoAnchor={handleGotoCommentAnchor}
					onActiveCommentChange={(id) => (hoverCommentId = id)}
					onActivateTab={handleTabActivate}
					onClose={() => (commentsOverlayOpen = false)}
					bottomInset={pendingList.length > 0
						? reviewBarHeight + REVIEW_BAR_CLEARANCE_PX
						: 0}
					currentUserId={currentUser?.id ?? null}
					currentUserName={currentUser?.displayName ?? null}
					currentUserProfilePicture={currentUser?.profilePicture ?? null}
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
		/* Wave 2.5 Step 8: this element's own rendered width is what decides
		   whether the comment column fits beside the text (`commentRailWidth`,
		   measured by a ResizeObserver in the script) — the panel this body
		   sits inside can be narrower than the window (it is a resizable side
		   panel, not necessarily full-width). `inline-size` containment also
		   makes this the containing block for anything positioned inside it. */
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

	/* The text and its comments, side by side (the owner's walk-through:
	   "the comments themselves should scroll with the viewport, not just the
	   section title"). This row does not scroll: the text column is the one
	   scroller, and the comment column next to it keeps its place and scrolls
	   its own list, so however far the reader has scrolled the text, the
	   comments stay in view. `overflow: hidden` also clips the drawer's slide
	   in from the panel's own edge. */
	.document-content {
		position: relative;
		display: flex;
		flex-direction: row;
		/* `flex: 1` (not just `min-height`), same reasoning as the editor host
		   below: this is a flex CHILD of `.document-main`, and without it this
		   row sizes to its own content instead of filling whatever vertical
		   room `.document-main` actually has (T11.1: the editor must keep >=
		   60% of a 390x844 viewport). */
		flex: 1;
		min-width: 0;
		min-height: 240px;
		overflow: hidden;
	}

	/* THE reading scroller (`contentEl`): the text, its selection bubble and
	   the sticky review bar. `position: relative` is the selection bubble's
	   positioning context, so it scrolls with the words it points at.
	   Review 2.5's nested-scroller fix (rd/review-2-5.md:87-97) still holds
	   inside it: nothing WITHIN the text column may become a second vertical
	   scroller — a wide table scrolls sideways on Tiptap's own `.tableWrapper`
	   (below), never by putting `overflow-x` on this column's children. */
	.document-content-text {
		position: relative;
		flex: 1 1 0;
		min-width: 0;
		overflow-y: auto;
	}

	.document-content-flow {
		display: flex;
		flex-direction: column;
		min-height: 100%;
	}

	/* The comment column: its own height, its own scrolling list
	   (`MarginPanel`'s `.margin-panel-list`), a hairline between it and the
	   text. Its width is set inline from `commentRailWidth`. */
	.document-content-rail {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		width: 300px;
		min-width: 0;
		min-height: 0;
		border-left: 1px solid var(--border-subtle);
		background-color: var(--surface-page);
	}

	/* Wave 2.5 Step 10, revised by Review 2.5 (rd/review-2-5.md:98-108): "at
	   the bottom of the text column" (redesign §4.2 item 5, §8). It was once
	   `position: absolute` in a scroller shared with the comment column, so it
	   scrolled away with the text and spanned both columns; `position:
	   sticky` as the last child of `.document-content-flow` (the column
	   inside the text scroller, as tall as the text — a sticky element only
	   travels within its parent's box) pins it to the bottom of the visible
	   text while it scrolls, and its box only ever spans the text, never the
	   comment column beside it. `.document-editor-host`'s own `padding-bottom` (see its
	   `style:padding-bottom` binding) reserves room, measured live from this
	   element's own height, so the last paragraph can fully clear it before
	   the column runs out of content to scroll through — the classic
	   "sticky footer covers the last line" problem a plain `position:
	   sticky` does not solve by itself.

	   G2-B: `bottom: 0` (it floated 14px above the edge, with text showing
	   under it), full width of the text column, and `ReviewBar`'s `docked`
	   look: flat, a rule on top. G3: a phone gets exactly the same — it used
	   to keep a rounded card floating 64px up (`bottom: 4rem`, side insets),
	   with the text showing beneath it in a long document, though nothing
	   sits in that strip on the phone shell (the toolbar is at the top). */
	.document-review-bar-slot {
		position: sticky;
		bottom: 0;
		z-index: 5;
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

	/* The empty state (Slice 6 T6): a zero-height anchor ahead of the host and
	   the block laid under the page's first, empty line (the host's top padding,
	   then one line of the prose layer's 16px at 1.72), left-aligned with the
	   text and no wider than its column. It lets every click through to the page
	   but its own link, and goes the moment the first word is typed. */
	.document-empty-anchor {
		position: relative;
		height: 0;
	}

	.document-empty {
		position: absolute;
		top: calc(1rem + 1.72 * 16px + 0.5rem);
		left: 1.25rem;
		right: 1.25rem;
		z-index: 1;
		max-width: 62ch;
		pointer-events: none;
		align-items: flex-start;
		text-align: start;
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

	/* The editor stores every task item as its own block, so a checklist is a
	   run of one-item lists, each with its own `margin: 6px 0 16px` — which
	   made every row ~20px looser than the mockup's one `<ul class="tasks">`
	   (review 251-255). Only the run's first list keeps the top margin and its
	   last list the bottom one; the space between two lists in a run is none. */
	.document-editor-host :global(.document-content ul[data-type='taskList'] + ul[data-type='taskList']) {
		margin-top: 0;
	}

	.document-editor-host :global(.document-content ul[data-type='taskList']:has(+ ul[data-type='taskList'])) {
		margin-bottom: 0;
	}

	/* The mockup's `.task`: 15.5px at 1.45 with 4px above and below, and no
	   outer margin (the generic `li` rule's 2px would open a gap between rows),
	   a 30.5px row rhythm. */
	.document-editor-host :global(.document-content li[data-checked]) {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 0;
		padding: 4px 0;
		font-size: 15.5px;
		line-height: 1.45;
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

	/* The mockup's `.task[aria-checked="true"] .task-label` (redesign §7.2 #27):
	   a ticked item's words are muted and struck through, so a finished list
	   reads as finished, not just a filled box. Only the item's OWN paragraphs
	   (`> div > p`): a task list nested under a ticked item has states of its own,
	   and a line-through set on the whole `div` could not be undone by them.
	   The line takes the muted colour of the text. The mockup draws it in left to
	   right with a background-size trick that only strikes one line of a wrapped
	   item, so this uses the real text decoration and lets the colour ease in;
	   reduced motion collapses that (app.css). */
	.document-editor-host :global(.document-content li[data-checked] > div > p) {
		transition: color var(--duration-standard) var(--ease-out);
	}

	.document-editor-host :global(.document-content li[data-checked='true'] > div > p) {
		color: var(--text-muted);
		text-decoration: line-through;
		text-decoration-thickness: 1px;
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

	/* A cell holds a real paragraph, which kept the prose's 12px bottom
	   margin: every row was ~12px taller than the mockup's 45px (37px header)
	   and its content sat high in it. The cell's own padding is the spacing; a
	   second paragraph in one cell still gets a small gap. */
	.document-editor-host :global(.document-content td > p),
	.document-editor-host :global(.document-content th > p) {
		margin: 0;
	}

	.document-editor-host :global(.document-content td > p + p),
	.document-editor-host :global(.document-content th > p + p) {
		margin-top: 6px;
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
		/* A select is as wide as its longest option by default, which left
		   "Kifizetve" with an empty tail the width of "Lefoglalandó" (review
		   251-255). Sized to the chosen value it hugs its own text. Engines
		   without `field-sizing` keep the longest-option width. */
		field-sizing: content;
	}

	/* Phones: the tick and the chip keep the mockup's look and grow the
	   finger's area to 44px (redesign §5.4; review 233-238). The tick's area is
	   an invisible `::after` on the `<label>` that wraps it, exactly as the
	   change pill does for its buttons — a tap on it reaches the box through
	   the label. It extends 17px to the left (the editor's own side padding is
	   free room), 10px to the right (the text starts 10px from the box) and
	   6.75px above / 20.25px below the 17px box: rows are 30.5px apart, so each
	   row's area ends where the next row's begins, halfway between the two
	   boxes, and a tap always reaches the nearest tick (a symmetric area would
	   hand everything below a box to the row under it). The box itself sits
	   above its own area so it keeps its own mousedown handling. The chip's
	   select is its own 44px target: taller than the 26px pill, pulled back
	   into it by equal negative margins so the line does not grow. */
	@media (max-width: 767px) {
		.document-editor-host :global(.document-content li[data-checked] > label) {
			position: relative;
		}

		.document-editor-host :global(.document-content li[data-checked] > label::after) {
			content: '';
			position: absolute;
			inset: -6.75px -10px -20.25px -17px;
		}

		.document-editor-host :global(.document-content li[data-checked] input[type='checkbox']) {
			position: relative;
			z-index: 1;
		}

		.document-editor-host :global(.document-content .tracker-chip-select) {
			min-width: 44px;
			min-height: 44px;
			margin: -9px -8px;
			padding: 0 8px;
		}
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
