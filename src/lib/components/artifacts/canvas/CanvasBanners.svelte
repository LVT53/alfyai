<script lang="ts">
/**
 * The notices above a board about its own saving: blocks that could not be read and
 * were left out, blocks where the reader's own version was kept over a newer one, no
 * connection, a save that failed, someone else's change, a board too large to keep. Each is the exception, so they load on demand
 * (`CanvasEditor.svelte` fetches this the first time one is due) and a board that
 * saves quietly never carries the words for any of them.
 */
import { t } from "$lib/i18n";

let {
	banner,
	droppedCount,
	keptCount = 0,
	missingBlocks = [],
	onretry,
	onreload,
	ondismiss,
	ondismisskept,
	ondismissmissing,
}: {
	/** The saving problem the board is in, if any. */
	banner: "offline" | "failed" | "conflict" | "tooLarge" | null;
	/** How many blocks were left out on load (0: none, no notice). */
	droppedCount: number;
	/** How many blocks a newer version of the board and the reader's own step had both changed, the reader's version standing (0: none, no notice). */
	keptCount?: number;
	/** The blocks a picture of the board drew as a card, by name (none: no notice). */
	missingBlocks?: string[];
	onretry: () => void;
	onreload: () => void;
	/** The reader dismissed the notice about blocks left out. */
	ondismiss: () => void;
	/** The reader dismissed the notice about the blocks whose own version was kept. */
	ondismisskept?: () => void;
	/** The reader dismissed the notice about blocks a picture drew as a card. */
	ondismissmissing?: () => void;
} = $props();
</script>

{#if missingBlocks.length > 0}
	<div class="notice notice--warning" role="status" data-testid="canvas-export-missing">
		<span>
			{$t("artifacts.canvas.exportMissingPosters", {
				count: missingBlocks.length,
				names: missingBlocks.join(", "),
			})}
		</span>
		<button type="button" class="notice__button" onclick={ondismissmissing}>
			{$t("artifacts.canvas.dismiss")}
		</button>
	</div>
{/if}
{#if droppedCount > 0}
	<div class="notice notice--warning" role="status" data-testid="canvas-dropped-notice">
		<span>{$t("artifacts.canvas.blockDropped", { count: droppedCount })}</span>
		<button type="button" class="notice__button" onclick={ondismiss}>
			{$t("artifacts.canvas.dismiss")}
		</button>
	</div>
{/if}
{#if keptCount > 0}
	<div class="notice notice--warning" role="status" data-testid="canvas-rebased-notice">
		<span>{$t("artifacts.canvas.rebasedKept", { count: keptCount })}</span>
		<button type="button" class="notice__button" onclick={ondismisskept}>
			{$t("artifacts.canvas.dismiss")}
		</button>
	</div>
{/if}
{#if banner === "offline"}
	<div class="notice notice--warning" role="alert" data-testid="canvas-offline">
		<span>{$t("artifacts.canvas.offline")}</span>
	</div>
{:else if banner === "failed"}
	<div class="notice notice--warning" role="alert" data-testid="canvas-save-failed">
		<span>{$t("artifacts.canvas.saveFailed")}</span>
		<button type="button" class="notice__button" onclick={onretry}>
			{$t("artifacts.canvas.retry")}
		</button>
	</div>
{:else if banner === "conflict"}
	<div class="notice notice--warning" role="alert" data-testid="canvas-conflict">
		<span>{$t("artifacts.canvas.saveConflict")}</span>
		<button type="button" class="notice__button" onclick={onreload}>
			{$t("artifacts.canvas.reload")}
		</button>
	</div>
{:else if banner === "tooLarge"}
	<div class="notice notice--warning" role="alert" data-testid="canvas-too-large">
		<span>{$t("artifacts.canvas.tooLarge")}</span>
	</div>
{/if}

<style>
	.notice {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 6px 10px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		color: var(--text-primary);
		font-size: var(--text-sm);
		pointer-events: auto;
	}

	.notice--warning {
		border-color: color-mix(in srgb, var(--warning) 45%, transparent);
		background: color-mix(in srgb, var(--warning-tint) 100%, var(--surface-page));
		color: var(--warning-text);
	}

	.notice__button {
		flex: none;
		padding: 2px 8px;
		border: 1px solid currentColor;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.notice__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}
</style>
