<script lang="ts">
/**
 * Add from library (mockup §M5) — pick documents the library already holds.
 *
 * The list is the library's own list, read through the library's own call: a
 * project does not get a second, project-shaped view of the library, because
 * then the two would drift about what exists. Linking copies nothing, so the
 * picker never renames, moves or re-uploads anything — it only records that
 * the project knows the document.
 *
 * A document the project already knows is *shown*, greyed and marked rather
 * than hidden: hiding it would make "where is my file?" the reaction to a list
 * that silently omits things, and a checkbox that silently does nothing is
 * worse than a disabled one that says why.
 */
import { Library, Search } from "@lucide/svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import ScopeToken from "$lib/components/instructions/ScopeToken.svelte";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { fetchKnowledgeLibrary } from "$lib/client/api/knowledge";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { t } from "$lib/i18n";
import { getCategory } from "$lib/shared/file-types";
import { untrack } from "svelte";

interface Props {
	open: boolean;
	projectName: string;
	/** Ids the project already knows — shown, marked and not selectable. */
	linkedArtifactIds: string[];
	/** Adds the selection. Rejects on failure; the dialog reports it. */
	onLink: (artifactIds: string[]) => Promise<unknown>;
	/** The link is written: the caller refreshes and closes this dialog. */
	onLinked: () => void | Promise<void>;
	onClose: () => void;
}

let { open, projectName, linkedArtifactIds, onLink, onLinked, onClose }: Props =
	$props();

let searchQuery = $state("");
let documents = $state<KnowledgeDocumentItem[] | null>(null);
let loadState = $state<"loading" | "ready" | "failed">("loading");
let selectedIds = $state<string[]>([]);
let linking = $state(false);
let errorMessage = $state("");

const linkedIds = $derived(new Set(linkedArtifactIds));

const visibleDocuments = $derived.by(() => {
	const all = documents ?? [];
	const query = searchQuery.trim().toLowerCase();
	if (!query) return all;
	return all.filter((document) => document.name.toLowerCase().includes(query));
});

const selectedCount = $derived(selectedIds.length);
const confirmLabel = $derived(
	selectedCount === 1
		? $t("projects.filesAddCountOne")
		: $t("projects.filesAddCount", { count: selectedCount }),
);

function isSelected(artifactId: string): boolean {
	return selectedIds.includes(artifactId);
}

function toggle(artifactId: string, checked: boolean): void {
	if (linkedIds.has(artifactId)) return;
	selectedIds = checked
		? [...selectedIds, artifactId]
		: selectedIds.filter((id) => id !== artifactId);
}

async function loadLibrary(): Promise<void> {
	loadState = "loading";
	errorMessage = "";
	try {
		const library = await fetchKnowledgeLibrary();
		documents = library.documents;
		loadState = "ready";
	} catch {
		documents = null;
		loadState = "failed";
	}
}

async function confirm(): Promise<void> {
	if (selectedCount === 0 || linking) return;
	linking = true;
	errorMessage = "";
	try {
		await onLink([...selectedIds]);
		await onLinked();
	} catch {
		errorMessage = $t("projects.filesLinkFailed");
	} finally {
		linking = false;
	}
}

// Opened afresh each time: a selection or a query left over from the last open
// would add documents nobody chose this time.
$effect(() => {
	if (!open) return;
	untrack(() => {
		searchQuery = "";
		selectedIds = [];
		errorMessage = "";
	});
	void loadLibrary();
});
</script>

{#if open}
	<DialogShell
		title={$t("projects.filesAddFromLibrary")}
		titleVisuallyHidden
		onClose={onClose}
		maxWidthClass="max-w-[560px]"
		zIndexClass="z-[100]"
		phonePresentation="sheet"
	>
		<div class="picker-head">
			<span class="text-xl font-semibold text-text-primary"
				>{$t("projects.filesAddFromLibrary")}</span
			>
			<ScopeToken scope={{ kind: "project", name: projectName }} />
		</div>

		<div class="picker-search">
			<Search size={14} strokeWidth={1.9} aria-hidden="true" />
			<input
				type="search"
				data-testid="add-from-library-search"
				bind:value={searchQuery}
				placeholder={$t("projects.filesSearch")}
				aria-label={$t("projects.filesSearch")}
			/>
		</div>

		<div class="picker-list">
			{#if loadState === "loading"}
				<p class="picker-empty">{$t("common.loading")}</p>
			{:else if loadState === "failed"}
				<!-- A read that failed is not an empty library, and the list says so
				     rather than claiming there is nothing to add. -->
				<p class="picker-empty" role="alert">
					{$t("projects.filesLoadFailed")}
				</p>
			{:else if visibleDocuments.length === 0}
				<p class="picker-empty">{$t("projects.filesEmpty")}</p>
			{:else}
				{#each visibleDocuments as document (document.id)}
					{@const alreadyLinked = linkedIds.has(document.displayArtifactId)}
					<label
						class="picker-row"
						class:picker-row--linked={alreadyLinked}
						data-testid="add-from-library-row"
					>
						<input
							type="checkbox"
							data-testid="add-from-library-checkbox"
							disabled={alreadyLinked}
							checked={isSelected(document.displayArtifactId)}
							onchange={(event) =>
								toggle(
									document.displayArtifactId,
									(event.currentTarget as HTMLInputElement).checked,
								)}
						/>
						<span class="picker-icon">
							<FileTypeIcon
								category={getCategory(document.name, document.mimeType)}
								size={16}
							/>
						</span>
						<span class="picker-name">{document.name}</span>
						{#if alreadyLinked}
							<span class="picker-tag"
								>{$t("projects.filesAlreadyAdded")}</span
							>
						{/if}
					</label>
				{/each}
			{/if}
		</div>

		{#if errorMessage}
			<p class="picker-error" role="alert">{errorMessage}</p>
		{/if}

		{#snippet footer()}
			<button type="button" class="dialog-btn" onclick={onClose}
				>{$t("common.cancel")}</button
			>
			<button
				type="button"
				class="dialog-btn dialog-btn--positive"
				data-testid="add-from-library-confirm"
				disabled={selectedCount === 0 || linking}
				onclick={() => void confirm()}
			>
				<Library size={14} strokeWidth={1.9} aria-hidden="true" />
				{confirmLabel}
			</button>
		{/snippet}
	</DialogShell>
{/if}

<style>
	.picker-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}

	.picker-search {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 11px;
		margin-bottom: 12px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	.picker-search input {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 13px;
		outline: none;
	}

	.picker-list {
		max-height: 46vh;
		border: 1px solid var(--border-default);
		border-radius: 14px;
		background: var(--surface-elevated);
		overflow-y: auto;
	}

	.picker-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		font-size: 13.5px;
		color: var(--text-primary);
		cursor: pointer;
	}

	.picker-row + .picker-row {
		border-top: 1px solid var(--border-subtle);
	}

	.picker-row--linked {
		color: var(--text-muted);
		cursor: default;
	}

	.picker-row input[type="checkbox"] {
		flex: none;
		width: 15px;
		height: 15px;
		accent-color: var(--accent);
	}

	.picker-icon {
		display: inline-flex;
		color: var(--text-muted);
	}

	.picker-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.picker-tag {
		font-size: 11px;
		color: var(--text-muted);
	}

	.picker-empty {
		margin: 0;
		padding: 18px 12px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.picker-error {
		margin: 10px 0 0;
		font-size: 12.5px;
		color: var(--danger);
	}
</style>
