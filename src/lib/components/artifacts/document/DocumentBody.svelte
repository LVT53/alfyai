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
import { onDestroy, untrack } from "svelte";
import {
	askAlfyInComment,
	createArtifactComment,
	createDocumentCopy,
	fetchArtifact,
	resolveArtifactComment,
	saveArtifactBody,
	saveDocumentTabs,
} from "$lib/client/api/artifacts";
import { ApiError } from "$lib/client/api/http";
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";
import RefusalNotice from "$lib/components/artifacts/RefusalNotice.svelte";
import { t } from "$lib/i18n";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import { makeAnchor } from "$lib/shared/artifact-document/anchor";
import {
	type DocumentBlock,
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import {
	reconstructDocumentPatch,
	type DocumentAlfyActivity,
} from "./alfy-activity";
import AlfyWriting from "./AlfyWriting.svelte";
import { computeBubblePlacement, localizePoint } from "./bubble-placement";
import { documentTabsFromCardMetadata } from "./card-view";
import ChangeBar from "./ChangeBar.svelte";
import {
	createDocumentAutosave,
	type DocumentAutosaveHandle,
	type DocumentAutosaveResult,
} from "./document-autosave";
// `DocumentEditorModule` itself (the `typeof import("./document-editor")`
// namespace every `...Fn` closure below is typed against) comes from the
// `<script module>` block above — it is already visible here, and importing
// it a second time in this instance script is a duplicate-identifier error.
import type { AlfyChangeEntry, Editor } from "./document-editor";
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
}: ArtifactBodyProps = $props();

type LoadState = "loading" | "ready" | "load_error" | "not_found";
type SaveNotice = "offline" | "tooLarge" | "conflict" | "deleted" | null;

let loadState = $state<LoadState>("loading");
let saveNotice = $state<SaveNotice>(null);
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
let editorReady = $derived(loadState === "ready");

// ---- T8 live: marks.ts's surface, reached only through document-editor.ts's
// lazy re-exports (never a static "./marks" import from this file). ---------
let applyAlfyChangesFn: typeof DocumentEditorModule.applyAlfyChanges | null =
	null;
let keepChangeFn: typeof DocumentEditorModule.keepChange | null = null;
let undoChangeFn: typeof DocumentEditorModule.undoChange | null = null;
let changeMarkRectFn: typeof DocumentEditorModule.changeMarkRect | null = null;
let scrollToChangeFn: typeof DocumentEditorModule.scrollToChange | null = null;
let summarizeRefusalsFn: typeof DocumentEditorModule.summarizeRefusals | null =
	null;
let refusalReasonI18nKeyFn:
	| typeof DocumentEditorModule.refusalReasonI18nKey
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
	| { x: number; y: number; placement: "above" | "below"; anchor: Anchor }
	| null
>(null);
let contentEl = $state<HTMLDivElement | undefined>();

// ---- T8 live: Alfy's chat-turn edits appear in the open Document ----------
// `alfyWritingLabel` drives the shimmer; `pendingChanges`/`changePositions`
// drive the inline Keep/Undo bars (one per applied op, keyed by `changeId`);
// `refusalNotice` is `null` until a landed call actually refused something.
// `handledActivityKey` guards against reprocessing the SAME settled call
// twice (an unrelated re-render must not re-apply marks or re-open a notice
// that Keep/Undo already resolved) — the "loadedArtifactId" guard above is
// this block's own model.
interface PendingAlfyChange {
	entry: AlfyChangeEntry;
	status: "pending" | "kept" | "undone";
}
let alfyWritingLabel = $state<string | null>(null);
let pendingChanges = $state<Map<string, PendingAlfyChange>>(new Map());
let changePositions = $state<Map<string, { x: number; y: number }>>(
	new Map(),
);
let refusalNotice = $state<{
	message: string;
	items: { label: string; reason: string }[];
	seeChangeLabel: string | null;
	firstAppliedChangeId: string | null;
} | null>(null);
let handledActivityKey = "";
// ---- end T8 live -----------------------------------------------------

function updateBlocksFromMarkdown(markdown: string): void {
	blocks = parseDocument(markdown, { mint: false }).blocks;
}

function updateSelectionBubble(): void {
	if (!editor || !readSelectionContextFn || !contentEl) {
		selectionBubble = null;
		return;
	}
	const context = readSelectionContextFn(editor);
	if (!context) {
		selectionBubble = null;
		return;
	}
	const anchor = makeAnchor(context);
	if (!anchor) {
		selectionBubble = null;
		return;
	}
	// `computeBubblePlacement` (bubble-placement.ts) converts the selection's
	// VIEWPORT rect into this scroll container's own local coordinate space —
	// scroll offset included — and clamps/flips it into the container's
	// currently visible window. `null` means the selection has scrolled fully
	// out of view: hide the bubble rather than pin it to nothing visible.
	const hostRect = contentEl.getBoundingClientRect();
	const placement = computeBubblePlacement(context.rect, {
		hostRect,
		scrollLeft: contentEl.scrollLeft,
		scrollTop: contentEl.scrollTop,
		clientWidth: contentEl.clientWidth,
		clientHeight: contentEl.clientHeight,
	});
	if (!placement) {
		selectionBubble = null;
		return;
	}
	selectionBubble = { ...placement, anchor };
}

function dismissSelectionBubble(): void {
	selectionBubble = null;
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
	const nextPositions = new Map(changePositions);
	for (const entry of entries) {
		nextPending.set(entry.changeId, { entry, status: "pending" });
		const rect = changeMarkRectFn?.(editor, entry.changeId);
		if (rect && contentEl) {
			// Same scroll container, same viewport-to-local conversion the
			// selection bubble needs (bubble-placement.ts's own header comment) —
			// this one omitted the container's own scroll offset too.
			const hostRect = contentEl.getBoundingClientRect();
			nextPositions.set(
				entry.changeId,
				localizePoint(
					{ x: rect.left, y: rect.bottom },
					{
						hostRect,
						scrollLeft: contentEl.scrollLeft,
						scrollTop: contentEl.scrollTop,
					},
				),
			);
		}
	}
	pendingChanges = nextPending;
	changePositions = nextPositions;
}

async function postComment(anchor: Anchor, body: string): Promise<void> {
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
		const nextPositions = new Map(changePositions);
		for (const entry of entries) {
			nextPending.set(entry.changeId, { entry, status: "pending" });
			const rect = changeMarkRectFn?.(editor, entry.changeId);
			if (rect && contentEl) {
				// Same scroll container, same viewport-to-local conversion the
				// selection bubble needs (bubble-placement.ts's own header comment) —
				// this one omitted the container's own scroll offset too.
				const hostRect = contentEl.getBoundingClientRect();
				nextPositions.set(
					entry.changeId,
					localizePoint(
						{ x: rect.left, y: rect.bottom },
						{
							hostRect,
							scrollLeft: contentEl.scrollLeft,
							scrollTop: contentEl.scrollTop,
						},
					),
				);
			}
		}
		pendingChanges = nextPending;
		changePositions = nextPositions;

		const summary = summarizeRefusalsFn?.(reconstructed) ?? null;
		if (summary && refusalReasonI18nKeyFn) {
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
			};
		} else {
			refusalNotice = null;
		}
	} catch {
		// Best-effort, mirroring `refreshAfterCommentChange`: the panel shows
		// slightly stale state until the next successful refresh rather than
		// surfacing a second, unrelated error path here.
	}
}

/** Keep: clears exactly this change's mark, leaves the text. */
function handleKeepChange(changeId: string): void {
	if (!editor || !keepChangeFn) return;
	keepChangeFn(editor, changeId);
	const pending = pendingChanges.get(changeId);
	if (!pending) return;
	pendingChanges = new Map(pendingChanges).set(changeId, {
		...pending,
		status: "kept",
	});
	setTimeout(() => removePendingChange(changeId), 1500);
}

/**
 * Undo: restores exactly this change's pre-edit text and treats that as a
 * USER edit — scheduled through the normal autosave path (T8's own rule),
 * not a second, silent write.
 */
function handleUndoChange(changeId: string): void {
	if (!editor || !undoChangeFn) return;
	const pending = pendingChanges.get(changeId);
	if (!pending) return;
	undoChangeFn(editor, pending.entry);
	pendingChanges = new Map(pendingChanges).set(changeId, {
		...pending,
		status: "undone",
	});
	const canonical = currentCanonicalMarkdown();
	if (canonical !== null) {
		autosave?.schedule(canonical);
		updateBlocksFromMarkdown(canonical);
	}
	setTimeout(() => removePendingChange(changeId), 1500);
}

function removePendingChange(changeId: string): void {
	const nextPending = new Map(pendingChanges);
	nextPending.delete(changeId);
	pendingChanges = nextPending;
	const nextPositions = new Map(changePositions);
	nextPositions.delete(changeId);
	changePositions = nextPositions;
}

/** "See what Alfy did" — scrolls to the first change the same patch actually applied. */
function handleSeeChange(): void {
	if (!editor || !scrollToChangeFn || !refusalNotice?.firstAppliedChangeId) {
		return;
	}
	scrollToChangeFn(editor, refusalNotice.firstAppliedChangeId);
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

function handleToolbarAction(id: DocumentToolbarActionId): void {
	// T12/T6: the two toolbar actions that never touch the live editor
	// directly — they open a sheet instead.
	if (id === "download") {
		// Both sheets anchor to the same top-right corner (T12/T6): only one
		// may be open at a time, or they would visually overlap.
		versionsSheetOpen = false;
		downloadSheetOpen = true;
		return;
	}
	if (id === "history") {
		downloadSheetOpen = false;
		versionsSheetOpen = true;
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

/** Switching the active tab is a pure UI notification — it never touches the editor (T9.1). */
function handleTabActivate(tabId: string): void {
	activeTabId = tabId;
}

/**
 * Persists an add/rename/delete from `Tabs.svelte` through the SAME body
 * route every other edit uses (`saveDocumentTabs`, one write path — T9.2/
 * T9.7), carrying the editor's current canonical text along unchanged so a
 * tab-list edit is never mistaken for a text edit. The strip already updated
 * itself optimistically (it renders straight from its own `tabs` prop
 * change); on a refusal it is simply overwritten by the next successful
 * load rather than rolled back, matching this body's existing "keep the
 * user's text, surface the notice" failure shape for every other save.
 */
async function handleTabsChange(next: DocumentTab[]): Promise<void> {
	tabs = next;
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
	try {
		const conversationId = panelConversationId ?? null;
		const [mod, detail] = await Promise.all([
			loadEditorModule(),
			fetchArtifact(id, conversationId),
		]);
		if (myToken !== loadToken || !editorEl) return;

		readMarkdownFn = mod.readMarkdown;
		loadMarkdownFn = mod.loadMarkdown;
		readSelectionContextFn = mod.readSelectionAnchorContext;
		applyAlfyChangesFn = mod.applyAlfyChanges;
		keepChangeFn = mod.keepChange;
		undoChangeFn = mod.undoChange;
		changeMarkRectFn = mod.changeMarkRect;
		scrollToChangeFn = mod.scrollToChange;
		summarizeRefusalsFn = mod.summarizeRefusals;
		refusalReasonI18nKeyFn = mod.refusalReasonI18nKey;
		// A fresh document (a new id, or a retry of this one) starts with no
		// leftover marks or notice from whatever was open before (the shimmer
		// itself is fully derived by the `alfyActivity` effect above, so it
		// is not reset here — doing so would race that effect on first mount).
		pendingChanges = new Map();
		changePositions = new Map();
		refusalNotice = null;
		handledActivityKey = "";
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
		});
		updateActiveActionIds();
		bindAutosave(id, conversationId);

		loadState = "ready";
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

<div class="document-body">
	<div class="document-main">
		{#if editorReady}
			<Tabs
				{tabs}
				{activeTabId}
				onActivate={handleTabActivate}
				onChange={handleTabsChange}
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
			/>
		{/if}
		<div class="document-content" bind:this={contentEl}>
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
				<div class="document-editor-host" bind:this={editorEl}></div>
				{#if loadState === 'loading'}
					<div class="document-editor-skeleton" aria-hidden="true">
						<span class="sr-only">{$t('common.loading')}</span>
					</div>
				{/if}
				<!-- T10: the selection bubble, positioned against this same scroll container -->
				{#if selectionBubble}
					<SelectionBubble
						position={selectionBubble}
						onSubmit={async (body) => {
							if (!selectionBubble) return;
							await postComment(selectionBubble.anchor, body);
							selectionBubble = null;
						}}
						onDismiss={dismissSelectionBubble}
					/>
				{/if}
				<!-- T12: the download sheet, opened from the toolbar's download action -->
				{#if downloadSheetOpen}
					<div class="document-download-anchor">
						<DownloadSheet
							artifactId={boundArtifactId}
							{title}
							conversationId={panelConversationId}
							onClose={() => (downloadSheetOpen = false)}
						/>
					</div>
				{/if}
				<!-- RV-1B, T6: the versions sheet, opened from the toolbar's history
				     action (previously unreachable — see toolbar-actions.ts). A
				     restore changes the stored body out from under the open editor,
				     so it reloads through the same retryLoad() the "load failed, try
				     again" path already uses, rather than a second reload path. -->
				{#if versionsSheetOpen}
					<div class="document-versions-anchor">
						<VersionsSheet
							artifactId={boundArtifactId}
							conversationId={panelConversationId}
							onClose={() => (versionsSheetOpen = false)}
							onRestored={() => {
								versionsSheetOpen = false;
								retryLoad();
							}}
						/>
					</div>
				{/if}
				<!-- T8 live: one inline Keep/Undo bar per applied change, positioned
				     at that change's own mark (never all bunched at a fixed spot —
				     several ops across different blocks each get their own bar). -->
				{#each [...pendingChanges.entries()] as [changeId, pending] (changeId)}
					{@const position = changePositions.get(changeId)}
					<div
						class="document-change-anchor"
						style={position
							? `left: ${position.x}px; top: ${position.y}px;`
							: "left: 0.75rem; top: 0.5rem;"}
					>
						<ChangeBar
							status={pending.status}
							onKeep={() => handleKeepChange(changeId)}
							onUndo={() => handleUndoChange(changeId)}
						/>
					</div>
				{/each}
			{/if}
		</div>
		{#if saveNotice === 'offline' || saveNotice === 'tooLarge' || saveNotice === 'conflict'}
			<div class="document-save-banner" role="status">
				{saveNoticeText(saveNotice)}
			</div>
		{/if}
	</div>
	<!-- T10: the comment margin -->
	<div class="document-margin">
		<MarginPanel
			{comments}
			{blocks}
			{contentEl}
			onResolve={handleCommentResolve}
			onSubmitReply={postReply}
		/>
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
	}

	/* T10: the toolbar/content/banner column, unchanged in substance — only
	   wrapped so the margin can sit beside it rather than inside it. */
	.document-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	/* T10: the comment margin. A fixed-ish column, collapsing to nothing on
	   narrow viewports rather than squeezing the document (the mobile
	   toolbar's own budget is T11's, not this one's to spend). */
	.document-margin {
		display: none;
		width: 18rem;
		flex-shrink: 0;
		border-left: 1px solid var(--border-subtle);
		overflow-y: auto;
	}

	@media (min-width: 900px) {
		.document-margin {
			display: block;
		}
	}

	.document-content {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 240px;
		overflow-y: auto;
		/* RV-1B: explicit rather than relying on the CSS spec's "overflow-y
		   auto computes overflow-x to auto too" quirk (real, and already
		   holding — `tests/e2e/artifact-document.spec.ts`'s "a wide table does
		   not force horizontal page scroll" passes today — but undocumented
		   and one `overflow-y` edit away from silently breaking). A wide table
		   (§2.3's table block) gets its own horizontal scrollbar here instead
		   of forcing the whole page to scroll sideways at 390 px. */
		overflow-x: auto;
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
	   real DOM is `ul[data-type=taskList] > li[data-type=taskItem] > (label >
	   input[type=checkbox] + span, div > p)` — no class of its own to hook,
	   so these are tag/attribute selectors rather than the mockup's `.tasks`/
	   `.task`/`.task-box`. `display: flex` on the list item is the actual fix
	   for the bug this step exists to close: without it, the label (holding
	   only the checkbox) and the text `div` are both block-level and stack
	   vertically, putting every checkbox on its own line above its label. */
	.document-editor-host :global(.document-content ul[data-type='taskList']) {
		list-style: none;
		margin: 6px 0 16px;
		padding: 0;
		font-family: var(--font-serif);
	}

	.document-editor-host :global(.document-content li[data-type='taskItem']) {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 4px 0;
		font-size: 15.5px;
	}

	.document-editor-host :global(.document-content li[data-type='taskItem'] > label) {
		display: inline-flex;
		flex-shrink: 0;
		margin-top: 0.2em;
	}

	.document-editor-host :global(.document-content li[data-type='taskItem'] input[type='checkbox']) {
		width: 17px;
		height: 17px;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.document-editor-host :global(.document-content li[data-type='taskItem'] > div) {
		min-width: 0;
	}

	.document-editor-host :global(.document-content li[data-type='taskItem'] > div p) {
		margin: 0;
	}

	/* The tracker table (`@tiptap/extension-table`'s TableKit, configured
	   with `renderWrapper: false` — see `extensions.ts` — so this styles the
	   bare `table` directly rather than the mockup's `.doc-table-wrap` +
	   `.doc-table` pair, which wraps a `<div>` this DOM does not have). */
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

	/* Step 2.3: comment-anchor highlight (§1/§2.2/§9.1). Styles only — there
	   is no comment-anchor decoration in extensions.ts yet (MarginPanel's
	   quote today renders only inside its own margin card, never inside the
	   document text), so nothing applies these classes in the DOM yet. They
	   exist so agent 3 has real, working styles the moment it adds that
	   decoration plus the click <-> thread wiring and the rail, per the
	   redesign build plan's own split between this step and that one — see
	   this component's hand-off notes for the exact class names. */
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

	.document-editor-skeleton {
		position: absolute;
		inset: 0;
		background-color: var(--surface-elevated);
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	/* T8 live: one change's own mark position, computed via
	   `changeMarkRect`/`getBoundingClientRect` in script and applied through
	   an inline style — the position is per-change data, not something a
	   static class can express. */
	.document-change-anchor {
		position: absolute;
		z-index: 15;
		transform: translateY(0.25rem);
	}

	/* T12: anchored under the toolbar's download button, at the top of the
	   same scroll container the selection bubble uses. */
	.document-download-anchor {
		position: absolute;
		top: 0.5rem;
		right: 0.75rem;
		z-index: 20;
		min-width: 12rem;
	}

	/* RV-1B, T6: same corner as the download anchor — handleToolbarAction
	   ensures only one of the two is ever open at once. */
	.document-versions-anchor {
		position: absolute;
		top: 0.5rem;
		right: 0.75rem;
		z-index: 20;
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
