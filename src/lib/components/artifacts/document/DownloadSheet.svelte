<script lang="ts">
/**
 * Export through `produce_file` (Feature 2 · Artifacts, Slice 1, T12): PDF,
 * Word and Markdown, offered against the document's own title (never the
 * word "Artifact", ADR-0066). Submits and then gets out of the way — the
 * resulting job is an ordinary produced file, so the File card (retry,
 * progress, download) is what the user watches next, not a second progress
 * UI here (the plan's own rule: "the panel does not poll a second time").
 *
 * Wave 2.5 Step 8 (redesign.md §3.2/§9.2/§9.3): a popover anchored to the
 * panel header's own Download button
 * (`[data-testid="artifact-download-button"]` — `DocumentWorkspace.svelte`'s
 * `artifactHeaderActionsSnippet`) on desktop, a bottom sheet on phones.
 * Polish G1-B: the popover and the sheet are `AnchoredPopover.svelte`, the
 * same shell the Versions popover uses, so the two look and behave alike —
 * same chrome, same placement inside the panel, same Escape and focus return.
 */
import {
	exportArtifactDocument,
	type ExportArtifactDocumentFormat,
} from "$lib/client/api/artifacts";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import { t } from "$lib/i18n";

let {
	artifactId,
	title,
	conversationId = null,
	onClose,
}: {
	artifactId: string;
	title: string;
	conversationId?: string | null;
	onClose: () => void;
} = $props();

type ExportError = "failed" | "tooLarge" | "noConversation";

let submitting = $state(false);
let error = $state<ExportError | null>(null);

function errorText(kind: ExportError): string {
	switch (kind) {
		case "tooLarge":
			return $t("artifacts.document.export.tooLarge");
		case "noConversation":
			return $t("artifacts.document.export.noConversation");
		case "failed":
			return $t("artifacts.document.export.failed");
	}
}

async function download(format: ExportArtifactDocumentFormat): Promise<void> {
	if (submitting) return;
	submitting = true;
	error = null;
	try {
		const result = await exportArtifactDocument(
			artifactId,
			format,
			conversationId,
		);
		if (result.ok) {
			onClose();
			return;
		}
		error =
			result.reason === "source_too_large"
				? "tooLarge"
				: result.reason === "no_conversation"
					? "noConversation"
					: "failed";
	} catch {
		error = "failed";
	} finally {
		submitting = false;
	}
}

function retry(): void {
	error = null;
}
</script>

{#snippet downloadOptions()}
	{#if error}
		<div class="download-popover-options download-popover-options-column">
			<p class="download-popover-error" role="alert">{errorText(error)}</p>
			<button type="button" class="btn-secondary" onclick={retry}>
				{$t('artifacts.document.export.tryAgain')}
			</button>
		</div>
	{:else}
		<div class="download-popover-options">
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
	popoverTestId="document-download-popover"
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
