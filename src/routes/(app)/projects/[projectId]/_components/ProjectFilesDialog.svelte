<script lang="ts">
/**
 * The project's Files modal (mockup §M5) — the one place a project's library
 * documents are listed, added, previewed and unlinked.
 *
 * Its whole vocabulary is deliberately about *knowledge*, never about
 * ownership: the row action is unlink, not delete, and the footer says so in
 * the same breath as the count. Uploading from here stores an ordinary library
 * document and links it in the same request (`uploadKnowledgeAttachment`'s
 * `projectId`), so the file is in the library before the project ever knows it.
 *
 * The dialog does not own the list. The route holds it — the quiet line under
 * the composer counts the same list — and every mutation ends with `onRefresh`,
 * so what is rendered is always what the server last said. That is also why
 * the numbers here cannot drift from the chip behind the modal.
 *
 * The list is the project's bundle: its files, and the Documents, Apps and
 * Canvases its chats made. A made item is not a file — it says what it is and
 * which chat made it, and its way in opens the panel on the editor, the one
 * shell every other surface opens it in. It has no unlink when it is here only
 * through its chat, because there is no link to remove.
 */
import {
	Eye,
	Library,
	PanelRightOpen,
	Search,
	Unlink,
	Upload,
} from "@lucide/svelte";
import { ARTIFACT_KIND_ICONS } from "$lib/components/artifacts/kind-icons";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import ScopeToken from "$lib/components/instructions/ScopeToken.svelte";
import { linkProjectFiles, unlinkProjectFile } from "$lib/client/api/projects";
import {
	recordDocumentWorkspaceOpen,
	uploadKnowledgeAttachment,
} from "$lib/client/api/knowledge";
import {
	reduceWorkspaceClose,
	reduceWorkspaceDocumentClose,
	reduceWorkspaceDocumentOpen,
} from "$lib/client/document-workspace-state";
import type { ProjectKnowledgeItem } from "$lib/server/services/knowledge";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { type I18nKey, t } from "$lib/i18n";
import {
	fileExtension,
	getCategory,
	getEntryByFilename,
	getEntryByMimeType,
} from "$lib/shared/file-types";
import { formatByteSize } from "$lib/utils/format";
import { formatRelativeTime } from "$lib/utils/time";
import { untrack } from "svelte";
import DocumentWorkspace from "$lib/components/document-workspace/DocumentWorkspace.svelte";
import AddFromLibraryDialog from "./AddFromLibraryDialog.svelte";

interface Props {
	open: boolean;
	projectId: string;
	projectName: string;
	/**
	 * The project's documents, as the route last read them — or `null` before
	 * its first read has landed. `null` is "not read yet", never "no files": the
	 * list shows a loading line until the read arrives, and only a list that
	 * really is empty says so.
	 */
	files: ProjectKnowledgeItem[] | null;
	/**
	 * True when the route's most recent read never landed and `files` is still
	 * `null` — a first read that failed for good, not one still in flight.
	 * `files` alone cannot say this: it stays `null` in both cases. Left true
	 * only until a read actually lands (see the route's `refreshProjectFiles`),
	 * so a retry that is still pending shows the loading line again, not a
	 * stale error.
	 */
	filesFailed: boolean;
	/** The route re-reads the project's files and updates its own state. */
	onRefresh: () => Promise<void>;
	onClose: () => void;
	/**
	 * Who is reading, named to the panel the items open in: the first-open tours
	 * keep what they were told for the life of the page, and it has to be this
	 * reader's. Also what puts their own picture on a comment they write there.
	 */
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
}

let {
	open,
	projectId,
	projectName,
	files,
	filesFailed,
	onRefresh,
	onClose,
	currentUser = null,
}: Props = $props();

let searchQuery = $state("");
let busyArtifactIds = $state<string[]>([]);
let errorMessage = $state("");
let addFromLibraryOpen = $state(false);
let uploadInput: HTMLInputElement | null = $state(null);

// The preview workspace, owned here: the modal is the surface the user opened,
// so its workspace state has no business outliving it (and nothing here is
// persisted — a chat's workspace has its own storage).
let workspaceDocuments = $state<DocumentWorkspaceItem[]>([]);
let activeWorkspaceDocumentId = $state<string | null>(null);
let workspaceOpen = $state(false);

const visibleFiles = $derived.by(() => {
	const all = files ?? [];
	const query = searchQuery.trim().toLowerCase();
	if (!query) return all;
	return all.filter((file) => file.name.toLowerCase().includes(query));
});

// Whether anything in the list was made by a chat rather than uploaded. Once
// something was, the count says "items": "3 files" would be a claim about
// three PDFs.
const hasMadeItems = $derived(
	(files ?? []).some((file) => file.artifactKind !== undefined),
);

// A row offers removal when it has an unlink: every row but a made item that is
// here only through its chat, which has no link to remove.
function isRemovable(file: ProjectKnowledgeItem): boolean {
	return file.linked !== false;
}

// The footer's note is about that unlink, so a list with none promises nothing.
const hasRemovableRows = $derived((files ?? []).some(isRemovable));

const footerLabel = $derived.by(() => {
	// Nothing is counted before the first read lands: "0 files" there would be the
	// same untruth as "No files yet.". A list with nothing on it says so itself.
	if (files === null || files.length === 0) return "";
	if (hasMadeItems) {
		const count = $t("artifacts.bundle.items", { count: files.length });
		return hasRemovableRows
			? `${count} · ${$t("artifacts.bundle.footerNote")}`
			: count;
	}
	return files.length === 1
		? $t("projects.filesFooterOne")
		: $t("projects.filesFooter", { count: files.length });
});

function isBusy(artifactId: string): boolean {
	return busyArtifactIds.includes(artifactId);
}

function setBusy(artifactId: string, busy: boolean): void {
	busyArtifactIds = busy
		? [...busyArtifactIds, artifactId]
		: busyArtifactIds.filter((id) => id !== artifactId);
}

/**
 * The row's type pill. A file is labelled by its own extension, exactly as the
 * library's own table words it (`.htm` shows "HTML", a file with no extension
 * falls back to the registry's canonical one); two places that name a file type
 * must not name it differently. A Document, an App or a Canvas is labelled by
 * the UI's own word for its kind — the same `artifacts.type.*` every other
 * surface prints.
 */
function formatFileType(file: ProjectKnowledgeItem): string {
	if (file.artifactKind) {
		return $t(`artifacts.type.${file.artifactKind}` as I18nKey);
	}
	const extension = fileExtension(file.name);
	if (!extension) {
		const byMime = getEntryByMimeType(file.mimeType);
		return byMime ? byMime.extensions[0].toUpperCase() : "FILE";
	}
	if (getEntryByFilename(file.name)?.preview.kind === "html") return "HTML";
	return extension.toUpperCase();
}

function formatSize(sizeBytes: number | null): string {
	return sizeBytes === null
		? "—"
		: formatByteSize(sizeBytes, { trimWholeUnits: true });
}

function toWorkspaceDocument(
	file: ProjectKnowledgeItem,
): DocumentWorkspaceItem {
	if (file.artifactKind) {
		// The artifact family opens in the panel's own body for its kind, not in
		// the file viewer: the same item the Knowledge page builds for one of its
		// Documents, App or Canvas rows (`kind` is what the panel dispatches on,
		// and it has no file to preview, so no mime type).
		return {
			id: `artifact:${file.artifactId}`,
			source: "knowledge_artifact",
			filename: file.name,
			title: file.name,
			kind: file.artifactKind,
			mimeType: null,
			artifactId: file.artifactId,
			conversationId: file.sourceConversationId ?? null,
		};
	}
	return {
		// The same id shape the knowledge page uses for a library artifact, so
		// the shared workspace treats a project file as what it is.
		id: `artifact:${file.artifactId}`,
		source: "knowledge_artifact",
		filename: file.name,
		title: file.name,
		mimeType: file.mimeType,
		artifactId: file.artifactId,
	};
}

async function preview(file: ProjectKnowledgeItem): Promise<void> {
	const next = reduceWorkspaceDocumentOpen(
		workspaceDocuments,
		toWorkspaceDocument(file),
	);
	workspaceDocuments = next.documents;
	activeWorkspaceDocumentId = next.activeDocumentId;
	workspaceOpen = next.isOpen;
	// "Recently opened" is the library's own record; a project file is a library
	// document, and reading it here is the same act as reading it there.
	recordDocumentWorkspaceOpen(file.artifactId);
}

function closeWorkspaceDocument(documentId: string): void {
	const next = reduceWorkspaceDocumentClose(
		workspaceDocuments,
		documentId,
		activeWorkspaceDocumentId,
	);
	workspaceDocuments = next.documents;
	activeWorkspaceDocumentId = next.activeDocumentId;
	workspaceOpen = next.isOpen;
}

function closeWorkspace(): void {
	const next = reduceWorkspaceClose(
		workspaceDocuments,
		activeWorkspaceDocumentId,
	);
	workspaceDocuments = next.documents;
	activeWorkspaceDocumentId = next.activeDocumentId;
	workspaceOpen = next.isOpen;
}

async function unlink(file: ProjectKnowledgeItem): Promise<void> {
	if (isBusy(file.artifactId)) return;
	setBusy(file.artifactId, true);
	errorMessage = "";
	try {
		await unlinkProjectFile(projectId, file.artifactId);
		// The workspace is not told to close: the document is still a library
		// document and the user may well be reading it. Only the link is gone.
		await onRefresh();
	} catch {
		errorMessage = $t("projects.filesUnlinkFailed");
	} finally {
		setBusy(file.artifactId, false);
	}
}

function pickFiles(): void {
	uploadInput?.click();
}

async function uploadFiles(selected: FileList | null): Promise<void> {
	const queue = Array.from(selected ?? []);
	if (queue.length === 0) return;
	errorMessage = "";
	for (const file of queue) {
		try {
			await uploadKnowledgeAttachment(file, null, fetch, projectId);
		} catch {
			// The upload either stored the file and linked it, or did neither —
			// intake links strictly after the store. Either way the list is
			// re-read below, so a partial failure never leaves the modal claiming
			// a file that is not there.
			errorMessage = $t("projects.filesUploadFailed");
		}
		await onRefresh();
	}
}

function onUploadInputChange(event: Event): void {
	const input = event.currentTarget as HTMLInputElement;
	void uploadFiles(input.files);
	// Allows re-selecting the same file after a failed attempt.
	input.value = "";
}

async function onLinked(): Promise<void> {
	addFromLibraryOpen = false;
	await onRefresh();
}

// The linked ids the picker greys out. Derived here rather than passed down as
// a second list, so the two dialogs cannot disagree about what is linked.
const linkedArtifactIds = $derived(
	(files ?? []).map((file) => file.artifactId),
);

// A fresh open starts clean: a query left over from last time would hide the
// file the user came back to unlink.
$effect(() => {
	if (!open) return;
	untrack(() => {
		searchQuery = "";
		errorMessage = "";
		addFromLibraryOpen = false;
	});
});
</script>

{#if open}
	<DialogShell
		title={$t("projects.filesTitle")}
		titleVisuallyHidden
		onClose={onClose}
		maxWidthClass="max-w-[700px]"
		phonePresentation="sheet"
	>
		<div class="files-dialog-head">
			<span class="text-xl font-semibold text-text-primary"
				>{$t("projects.filesTitle")}</span
			>
			<ScopeToken scope={{ kind: "project", name: projectName }} />
		</div>
		<p class="files-dialog-description">{$t("projects.filesDescription")}</p>

		<div class="files-toolbar" data-testid="project-files-toolbar">
			<div class="files-search">
				<Search size={14} strokeWidth={1.9} aria-hidden="true" />
				<input
					type="search"
					data-testid="project-files-search"
					bind:value={searchQuery}
					placeholder={$t("projects.filesSearch")}
					aria-label={$t("projects.filesSearch")}
				/>
			</div>
			<button
				type="button"
				class="dialog-btn"
				onclick={() => (addFromLibraryOpen = true)}
			>
				<Library size={14} strokeWidth={1.9} aria-hidden="true" />
				{$t("projects.filesAddFromLibrary")}
			</button>
			<button
				type="button"
				class="dialog-btn dialog-btn--positive"
				onclick={pickFiles}
			>
				<Upload size={14} strokeWidth={1.9} aria-hidden="true" />
				{$t("projects.filesUpload")}
			</button>
			<input
				bind:this={uploadInput}
				type="file"
				multiple
				class="files-upload-input"
				onchange={onUploadInputChange}
				tabindex="-1"
				aria-hidden="true"
			/>
		</div>

		<div class="files-table">
			<div class="files-row files-row--head" aria-hidden="true">
				<span></span>
				<span class="files-th">{$t("projects.filesColumnName")}</span>
				<span class="files-th">{$t("projects.filesColumnType")}</span>
				<span class="files-th files-th--right">{$t("projects.filesColumnSize")}</span>
				<span class="files-th">{$t("projects.filesColumnAdded")}</span>
				<span></span>
			</div>

			{#if filesFailed}
				<!-- The read did not just start; it ran and lost. Checked before the
				     `files === null` branch below, because a failed read leaves
				     `files` exactly as `null` as a read still in flight does — this
				     is what tells the two apart. -->
				<div class="files-empty files-load-error" data-testid="project-files-error">
					<p role="alert">{$t("projects.filesReadFailed")}</p>
					<button
						type="button"
						class="dialog-btn"
						onclick={() => void onRefresh()}
					>
						{$t("projects.filesRetry")}
					</button>
				</div>
			{:else if files === null}
				<!-- The route's first read has not landed. Not an empty project: the
				     list says it is still being read rather than guessing. -->
				<p class="files-empty" data-testid="project-files-loading" role="status">
					{$t("common.loading")}
				</p>
			{:else if visibleFiles.length === 0}
				<p class="files-empty" data-testid="project-files-empty">
					{#if files.length === 0}
						{$t("projects.filesEmpty")}
					{:else}
						<!-- The project has files; the query hid all of them. The search
						     field's own label is not an answer to it. -->
						{$t("projects.filesNoMatch")}
					{/if}
				</p>
			{:else}
				{#each visibleFiles as file (file.artifactId)}
					{@const KindIcon = file.artifactKind
						? ARTIFACT_KIND_ICONS[file.artifactKind]
						: null}
					{@const openLabel = file.artifactKind
						? $t("artifacts.card.openA11y", { title: file.name })
						: $t("projects.filesPreviewA11y", { name: file.name })}
					<div
						class="files-row"
						class:files-row--made={KindIcon !== null}
						data-testid="project-file-row"
						data-artifact-id={file.artifactId}
						data-artifact-kind={file.artifactKind}
					>
						<span class="files-icon">
							{#if KindIcon}
								<KindIcon size={16} strokeWidth={1.9} aria-hidden="true" />
							{:else}
								<FileTypeIcon
									category={getCategory(file.name, file.mimeType)}
									size={16}
								/>
							{/if}
						</span>
						<span class="files-name-cell">
							<span class="files-name" data-testid="project-file-name"
								>{file.name}</span
							>
							{#if file.artifactKind && file.sourceConversationTitle}
								<!-- Which chat made it: what tells "the Document I asked for in
								     this chat" from "the file I uploaded into this project". The
								     time is the Added column's. -->
								<span
									class="files-origin"
									data-testid="project-file-origin"
									title={$t("artifacts.bundle.fromChat", {
										title: file.sourceConversationTitle,
									})}
									>{$t("artifacts.bundle.fromChat", {
										title: file.sourceConversationTitle,
									})}</span
								>
							{/if}
						</span>
						<span class="files-type">
							<span class="files-pill" data-testid="project-file-type"
								>{formatFileType(file)}</span
							>
						</span>
						<span class="files-size">{formatSize(file.sizeBytes)}</span>
						<span class="files-added">
							{formatRelativeTime(file.linkedAt, { t: $t })}
						</span>
						<span class="files-actions">
							<button
								type="button"
								class="files-action"
								data-testid="project-file-preview"
								title={openLabel}
								aria-label={openLabel}
								onclick={() => void preview(file)}
							>
								{#if file.artifactKind}
									<PanelRightOpen size={15} strokeWidth={1.9} aria-hidden="true" />
								{:else}
									<Eye size={15} strokeWidth={1.9} aria-hidden="true" />
								{/if}
							</button>
							{#if isRemovable(file)}
								<button
									type="button"
									class="files-action"
									data-testid="project-file-unlink"
									title={$t("projects.filesUnlinkA11y", { name: file.name })}
									aria-label={$t("projects.filesUnlinkA11y", {
										name: file.name,
									})}
									disabled={isBusy(file.artifactId)}
									onclick={() => void unlink(file)}
								>
									<Unlink size={15} strokeWidth={1.9} aria-hidden="true" />
								</button>
							{:else}
								<!-- Keeps the way in on one line down the column, with or
								     without an unlink beside it. -->
								<span
									class="files-action files-action--spacer"
									aria-hidden="true"
								></span>
							{/if}
						</span>
					</div>
				{/each}
			{/if}
		</div>

		{#if errorMessage}
			<p class="files-error" role="alert">{errorMessage}</p>
		{/if}

		{#snippet footer()}
			<span class="files-footer-count" data-testid="project-files-footer"
				>{footerLabel}</span
			>
			<button type="button" class="dialog-btn" onclick={onClose}
				>{$t("projects.filesDone")}</button
			>
		{/snippet}
	</DialogShell>

	<AddFromLibraryDialog
		open={addFromLibraryOpen}
		projectName={projectName}
		linkedArtifactIds={linkedArtifactIds}
		onLink={(artifactIds) => linkProjectFiles(projectId, artifactIds)}
		onLinked={onLinked}
		onClose={() => (addFromLibraryOpen = false)}
	/>

	<!-- Above the dialog, so `overDialog`: while the panel is open it is a layer
	     of the dialog stack, and the dialog's own Tab trap and Escape stand down
	     for as long as it is there. After the dialog in the template on purpose:
	     the stack is ordered by when a layer registers, and the dialog has to be
	     the one underneath. -->
	<DocumentWorkspace
		open={workspaceOpen}
		presentation="expanded"
		overDialog
		returnToDockedOnExpandedClose={false}
		showPresentationToggle={false}
		documents={workspaceDocuments}
		activeDocumentId={activeWorkspaceDocumentId}
		onSelectDocument={(documentId) => (activeWorkspaceDocumentId = documentId)}
		onCloseDocument={closeWorkspaceDocument}
		onCloseWorkspace={closeWorkspace}
		{currentUser}
	/>
{/if}

<style>
	.files-dialog-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
	}

	.files-dialog-description {
		margin: 0 0 12px;
		font-size: var(--text-xs, 0.8rem);
		color: var(--text-muted);
	}

	.files-toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: 10px;
		margin-bottom: 12px;
		border: 1px solid var(--border-default);
		border-radius: 14px;
		background: var(--surface-elevated);
	}

	.files-search {
		display: flex;
		flex: 1 1 160px;
		align-items: center;
		gap: 6px;
		min-width: 160px;
		padding: 6px 10px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		color: var(--text-muted);
	}

	.files-search input {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 13px;
		outline: none;
	}

	.files-upload-input {
		display: none;
	}

	.files-table {
		border: 1px solid var(--border-default);
		border-radius: 14px;
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.files-row {
		display: grid;
		/* The type column is wide enough for the longest kind word ("Alkalmazás"
		   at the pill's size), which an extension never needed. */
		grid-template-columns: 22px minmax(0, 1fr) 86px 64px 78px 58px;
		align-items: center;
		gap: 10px;
		padding: 11px 12px;
		font-size: 13.5px;
	}

	.files-row + .files-row {
		border-top: 1px solid var(--border-subtle);
	}

	.files-row--head {
		padding-bottom: 8px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.files-th {
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.files-th--right {
		text-align: right;
	}

	.files-icon {
		display: inline-flex;
		color: var(--text-muted);
	}

	.files-name-cell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 2px;
	}

	.files-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	/* The line under a made item's name: which chat made it. */
	.files-origin {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--text-muted);
	}

	/* A made item has no size: the cell keeps its place in the grid on a wide
	   screen and is not drawn where the facts stack. */
	.files-row--made .files-size {
		visibility: hidden;
	}

	.files-type {
		display: inline-flex;
	}

	.files-pill {
		padding: 1px 6px;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		font-family: var(--font-sans);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.files-size {
		text-align: right;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.files-added {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.files-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	.files-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		min-height: 28px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.files-action:hover:not(:disabled),
	.files-action:focus-visible {
		color: var(--accent);
	}

	.files-action:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.files-action--spacer {
		visibility: hidden;
		pointer-events: none;
	}

	.files-empty {
		margin: 0;
		padding: 18px 12px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.files-load-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}

	.files-load-error p {
		margin: 0;
		color: var(--danger);
	}

	.files-error {
		margin: 10px 0 0;
		font-size: 12.5px;
		color: var(--danger);
	}

	.files-footer-count {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	/* The mockup's six columns do not fit a phone. Below the stylesheet's own
	   breakpoint the row becomes two lines: what the file is, then its facts. */
	@media (max-width: 639px) {
		.files-row {
			/* Room for two 44px targets side by side: the buttons stay drawn at 28px
			   and their hit areas (below) reach 44px, so the column has to leave
			   their centres 44px apart. */
			grid-template-columns: 22px minmax(0, 1fr) 72px;
			row-gap: 4px;
		}

		.files-row--head {
			display: none;
		}

		.files-name-cell {
			grid-column: 2;
		}

		.files-type,
		.files-size,
		.files-added {
			grid-column: 2;
		}

		.files-row--made .files-size {
			display: none;
		}

		.files-type {
			grid-row: 2;
		}

		.files-size {
			grid-row: 3;
			text-align: left;
		}

		.files-added {
			grid-row: 4;
		}

		/* There is room under the name on a phone: the chat that made an item
		   reads whole instead of being cut at the buttons. */
		.files-origin {
			white-space: normal;
			overflow-wrap: anywhere;
		}

		/* A made item has no size line, so its facts close the gap. */
		.files-row--made .files-added {
			grid-row: 3;
		}

		.files-actions {
			grid-column: 3;
			grid-row: 1 / span 4;
			align-self: center;
			gap: 16px;
		}

		/* A finger needs 44px. The button is not redrawn; its hit area grows. */
		.files-action {
			position: relative;
		}

		.files-action::after {
			content: "";
			position: absolute;
			inset: -8px;
		}
	}
</style>
