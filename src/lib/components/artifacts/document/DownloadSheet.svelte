<script lang="ts">
/**
 * The header's Download for a Document (Feature 2 · Artifacts, Slice 1, T12) and
 * for an App: PDF, Word and Markdown against the document's own title, the App's
 * one `.html` file (never the word "Artifact", ADR-0066). The file is made through
 * `produce_file` (the one export engine), and this follows the job to its end:
 * "Preparing your file…" while it runs, the browser's own download of the file
 * when it is ready (`downloadProducedFile`, on the canonical
 * `/api/chat/files/[id]/download`), and a notice with Try again when it did not
 * work. The export belongs to no reply and shows no card of its own (friction
 * audit F1): a download is delivery, not something the chat made, so the panel's
 * list does not grow with every press either.
 *
 * Wave 2.5 Step 8 (redesign.md §3.2/§9.2/§9.3): a popover anchored to the
 * panel header's own Download button
 * (`[data-testid="artifact-download-button"]` — `DocumentWorkspace.svelte`'s
 * `artifactHeaderActionsSnippet`) on desktop, a bottom sheet on phones.
 * Polish G1-B: the popover and the sheet are `AnchoredPopover.svelte`, the
 * same shell the Versions popover uses, so the two look and behave alike —
 * same chrome, same placement inside the panel, same Escape and focus return.
 */
import { onDestroy } from "svelte";
import {
	downloadAppAsHtml,
	exportArtifactDocument,
	type ExportArtifactDocumentFormat,
} from "$lib/client/api/artifacts";
import { downloadProducedFile } from "$lib/client/downloads";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import { t } from "$lib/i18n";
import {
	exportFailureKey,
	exportFailureOf,
	type ExportFailure,
} from "./download-failures";

let {
	artifactId,
	title,
	conversationId = null,
	kind = "document",
	onClose,
}: {
	artifactId: string;
	title: string;
	conversationId?: string | null;
	/** An App offers its one `.html` file; a Document, its three formats. */
	kind?: "document" | "app";
	onClose: () => void;
} = $props();

let submitting = $state(false);
let error = $state<ExportFailure | null>(null);
// A reader may close the popover while their file is being made; the download
// still starts when it is ready (they asked for it), but a closed popover has
// nothing to update and nothing to close.
let open = true;
onDestroy(() => {
	open = false;
});

async function download(
	format: ExportArtifactDocumentFormat | "html",
): Promise<void> {
	if (submitting) return;
	submitting = true;
	error = null;
	const result = await downloadProducedFile(() =>
		format === "html"
			? downloadAppAsHtml(artifactId, conversationId)
			: exportArtifactDocument(artifactId, format, conversationId),
	);
	if (!open) return;
	submitting = false;
	if (result.ok) {
		onClose();
		return;
	}
	error = exportFailureOf(result.reason);
}

function retry(): void {
	error = null;
}
</script>

{#snippet downloadOptions()}
	{#if error}
		<div class="download-popover-options download-popover-options-column">
			<p class="download-popover-error" role="alert">{$t(exportFailureKey(error, kind))}</p>
			<button type="button" class="btn-secondary" onclick={retry}>
				{$t('artifacts.document.export.tryAgain')}
			</button>
		</div>
	{:else}
		<div class="download-popover-options">
			{#if kind === 'app'}
				<button
					type="button"
					class="btn-secondary"
					disabled={submitting}
					onclick={() => download('html')}
				>
					{$t('artifacts.app.export.html')}
				</button>
			{:else}
				<button
					type="button"
					class="btn-secondary"
					disabled={submitting}
					onclick={() => download('pdf')}
				>
					{$t('artifacts.document.export.pdf')}
				</button>
				<button
					type="button"
					class="btn-secondary"
					disabled={submitting}
					onclick={() => download('docx')}
				>
					{$t('artifacts.document.export.docx')}
				</button>
				<button
					type="button"
					class="btn-secondary"
					disabled={submitting}
					onclick={() => download('markdown')}
				>
					{$t('artifacts.document.export.markdown')}
				</button>
			{/if}
		</div>
		{#if submitting}
			<p class="download-popover-status" role="status">
				{$t('artifacts.document.export.preparing')}
			</p>
		{/if}
	{/if}
{/snippet}

<AnchoredPopover
	title={$t('artifacts.document.export.title', { title })}
	anchorTestId="artifact-download-button"
	popoverTestId={kind === 'app' ? 'app-download-popover' : 'document-download-popover'}
	closeLabel={$t('artifacts.document.export.close')}
	width={300}
	{onClose}
>
	{@render downloadOptions()}
</AnchoredPopover>

<style>
	.download-popover-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0 0.875rem 0.875rem;
	}

	.download-popover-options-column {
		flex-direction: column;
		align-items: flex-start;
	}

	.download-popover-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.download-popover-status {
		margin: 0;
		padding: 0 0.875rem 0.875rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
