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
import { documentTabsFromCardMetadata } from "./card-view";
import {
	createDocumentAutosave,
	type DocumentAutosaveHandle,
	type DocumentAutosaveResult,
} from "./document-autosave";
import type { Editor } from "./document-editor";
import DocumentToolbar from "./DocumentToolbar.svelte";
import DownloadSheet from "./DownloadSheet.svelte";
import MarginPanel from "./MarginPanel.svelte";
import MobileToolbar from "./MobileToolbar.svelte";
import SelectionBubble from "./SelectionBubble.svelte";
import Tabs from "./Tabs.svelte";
import type { DocumentToolbarActionId } from "./toolbar-actions";

let {
	artifactId,
	title,
	conversationId: panelConversationId,
	onDirtyChange,
	onBodyChange,
}: ArtifactBodyProps = $props();

type LoadState = "loading" | "ready" | "load_error" | "not_found";
type SaveNotice = "offline" | "tooLarge" | "conflict" | "deleted" | null;

let loadState = $state<LoadState>("loading");
let saveNotice = $state<SaveNotice>(null);
let versionNumber = $state<number | null>(null);
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
let selectionBubble = $state<{ x: number; y: number; anchor: Anchor } | null>(
	null,
);
let contentEl = $state<HTMLDivElement | undefined>();

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
	const hostRect = contentEl.getBoundingClientRect();
	selectionBubble = {
		x: (context.rect.left + context.rect.right) / 2 - hostRect.left,
		y: context.rect.top - hostRect.top,
		anchor,
	};
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

async function maybeAskAlfy(commentId: string): Promise<void> {
	const conversationId = panelConversationId ?? null;
	try {
		await askAlfyInComment(boundArtifactId, commentId, conversationId);
	} catch {
		// The reply (or refusal) already lives in the thread when the call
		// succeeds; a failed call here just leaves the thread as it was — the
		// next refresh (another comment, a reload) will show the truth again.
	} finally {
		await refreshAfterCommentChange();
	}
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
	if (mentionsAlfy(body)) await maybeAskAlfy(created.id);
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
	if (mentionsAlfy(body)) await maybeAskAlfy(created.id);
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

// ---- T12: the download sheet -----------------------------------------------
let downloadSheetOpen = $state(false);
// ---- end T12 -------------------------------------------------------------

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
	// T12: the one toolbar action that never touches the live editor.
	if (id === "download") {
		downloadSheetOpen = true;
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
		save: (markdown) =>
			saveArtifactBody(id, markdown, versionNumber ?? undefined, conversationId),
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
		versionNumber = detail.artifact.versionNumber;
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
		flex: 1;
		min-height: 240px;
		overflow-y: auto;
	}

	.document-editor-host {
		min-height: 240px;
		padding: 1rem 1.25rem;
	}

	.document-editor-host :global(.document-content) {
		outline: none;
	}

	.document-editor-skeleton {
		position: absolute;
		inset: 0;
		background-color: var(--surface-elevated);
		transition: opacity var(--duration-standard) var(--ease-out);
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
