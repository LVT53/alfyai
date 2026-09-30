<script lang="ts">
/**
 * The notices above a board about its own saving: blocks that could not be read and
 * were left out, no connection, a save that failed, someone else's change, a board
 * too large to keep. Each is the exception, so they load on demand
 * (`CanvasEditor.svelte` fetches this the first time one is due) and a board that
 * saves quietly never carries the words for any of them.
 */
import { t } from "$lib/i18n";

let {
	banner,
	droppedCount,
	onretry,
	onreload,
	ondismiss,
}: {
	/** The saving problem the board is in, if any. */
	banner: "offline" | "failed" | "conflict" | "tooLarge" | null;
	/** How many blocks were left out on load (0: none, no notice). */
	droppedCount: number;
	onretry: () => void;
	onreload: () => void;
	/** The reader dismissed the notice about blocks left out. */
	ondismiss: () => void;
} = $props();
</script>

{#if droppedCount > 0}
	<div class="notice notice--warning" role="status" data-testid="canvas-dropped-notice">
		<span>{$t("artifacts.canvas.blockDropped", { count: droppedCount })}</span>
		<button type="button" class="notice__button" onclick={ondismiss}>
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
