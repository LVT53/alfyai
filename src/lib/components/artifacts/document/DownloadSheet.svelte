<script lang="ts">
/**
 * Export through `produce_file` (Feature 2 · Artifacts, Slice 1, T12): PDF,
 * Word and Markdown, offered against the document's own title (never the
 * word "Artifact", ADR-0066). Submits and then gets out of the way — the
 * resulting job is an ordinary produced file, so the File card (retry,
 * progress, download) is what the user watches next, not a second progress
 * UI here (the plan's own rule: "the panel does not poll a second time").
 */
import { X } from "@lucide/svelte";
import {
	exportArtifactDocument,
	type ExportArtifactDocumentFormat,
} from "$lib/client/api/artifacts";
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

<div
	class="download-sheet"
	role="dialog"
	aria-label={$t('artifacts.document.export.title', { title })}
>
	<div class="download-sheet-header">
		<h2 class="download-sheet-title">
			{$t('artifacts.document.export.title', { title })}
		</h2>
		<button
			type="button"
			class="btn-icon-bare"
			aria-label={$t('artifacts.document.export.close')}
			onclick={onClose}
		>
			<X size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>

	{#if error}
		<p class="download-sheet-error" role="alert">{errorText(error)}</p>
		<button type="button" class="btn-secondary" onclick={retry}>
			{$t('artifacts.document.export.tryAgain')}
		</button>
	{:else}
		<div class="download-sheet-options">
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
			<p class="download-sheet-status" role="status">
				{$t('artifacts.document.export.preparing')}
			</p>
		{/if}
	{/if}
</div>

<style>
	.download-sheet {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: var(--radius-md);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
	}

	.download-sheet-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.download-sheet-title {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.download-sheet-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.download-sheet-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--status-danger, #c0392b);
	}

	.download-sheet-status {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
