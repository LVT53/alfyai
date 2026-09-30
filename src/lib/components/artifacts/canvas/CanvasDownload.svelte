<script lang="ts">
/**
 * The header's Download for a board (Feature 2 · Artifacts, Slice 3, T7): a
 * popover under the button on desktop, a sheet on phones (`AnchoredPopover`, the
 * same shell the Document's Download and Versions use), offering the board as a
 * PNG. It draws nothing itself: the picture is the controller's (`pictures-
 * controller.svelte.ts`), and its state — drawing, kept, not kept, and which
 * blocks were drawn as a card — is what this shows. The editor keeps the
 * controller and shows the same notice when this is closed, so the answer is not
 * lost with the popover.
 */
import { untrack } from "svelte";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import { handleDownloadAnchorClick } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import type { CanvasPicturesController } from "./_lib/pictures-controller.svelte";

let {
	controller,
	title,
	onClose,
}: {
	controller: CanvasPicturesController;
	title: string;
	onClose: () => void;
} = $props();

/** Read when the popover opens: an empty board has nothing to draw. */
const empty = untrack(() => controller.isEmpty());

let working = $derived(controller.status === "working");
let failed = $derived(controller.status === "error");
let done = $derived(controller.status === "done");
let downloadUrl = $derived(
	controller.fileId
		? `/api/chat/files/${encodeURIComponent(controller.fileId)}/download`
		: null,
);
let failureText = $derived(
	controller.failure === "empty"
		? $t("artifacts.canvas.export.empty")
		: controller.failure === "tooLarge"
			? $t("artifacts.canvas.export.tooLarge")
			: controller.failure === "noConversation"
				? $t("artifacts.canvas.export.noConversation")
				: $t("artifacts.canvas.export.failed"),
);
</script>

<AnchoredPopover
	title={$t("artifacts.canvas.export.title", { title })}
	anchorTestId="artifact-download-button"
	popoverTestId="canvas-download-popover"
	closeLabel={$t("artifacts.canvas.export.close")}
	width={300}
	{onClose}
>
	{#if failed}
		<div class="download__body download__body--column">
			<p class="download__error" role="alert" data-testid="canvas-download-error">{failureText}</p>
			<button type="button" class="btn-secondary" data-testid="canvas-download-retry" onclick={() => controller.reset()}>
				{$t("artifacts.canvas.export.tryAgain")}
			</button>
		</div>
	{:else}
		<div class="download__body">
			<button
				type="button"
				class="btn-secondary download__option"
				data-testid="canvas-download-png"
				disabled={working || empty}
				onclick={() => void controller.downloadPng()}
			>
				<span class="download__option-name">{$t("artifacts.canvas.export.png")}</span>
				<span class="download__option-hint">{$t("artifacts.canvas.export.pngHint")}</span>
			</button>
		</div>
		{#if working}
			<p class="download__status" role="status" data-testid="canvas-download-status">
				{$t("artifacts.canvas.export.preparing")}
			</p>
		{:else if empty}
			<p class="download__status" data-testid="canvas-download-empty">
				{$t("artifacts.canvas.export.empty")}
			</p>
		{:else if done && downloadUrl}
			<p class="download__status" role="status" data-testid="canvas-download-done">
				{$t("artifacts.canvas.export.saved")}
			</p>
			<p class="download__again-row">
				<a
					class="download__again"
					href={downloadUrl}
					download={controller.filename ?? ""}
					data-testid="canvas-download-again"
					onclick={(event) => handleDownloadAnchorClick(event, downloadUrl, controller.filename ?? undefined)}
				>{$t("artifacts.canvas.export.again")}</a>
			</p>
		{/if}
		{#if controller.noticeOpen}
			<p class="download__notice" role="status" data-testid="canvas-download-missing">
				{$t("artifacts.canvas.exportMissingPosters", {
					count: controller.missing.length,
					names: controller.missing.map((block) => block.title).join(", "),
				})}
			</p>
		{/if}
	{/if}
</AnchoredPopover>

<style>
	.download__body {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0 0.875rem 0.875rem;
	}

	.download__body--column {
		flex-direction: column;
		align-items: flex-start;
	}

	.download__option {
		display: flex;
		flex: 1 1 100%;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-height: 44px;
		text-align: left;
	}

	.download__option-hint {
		color: var(--text-muted);
		font-size: var(--text-xs);
		font-weight: 400;
	}

	.download__error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.download__status,
	.download__notice {
		margin: 0;
		padding: 0 0.875rem 0.875rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.download__notice {
		padding-top: 0;
		color: var(--text-primary);
	}

	.download__again-row {
		margin: 0;
		padding: 0 0.875rem 0.875rem;
		font-size: 0.8125rem;
	}

	.download__again {
		color: var(--accent);
		text-decoration: underline;
	}
</style>
