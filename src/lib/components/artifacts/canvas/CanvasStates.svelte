<script lang="ts">
/**
 * What the panel body says when a board cannot be shown: it did not load, it is not
 * the reader's, or it was deleted while it was open. Rare, and loaded on demand
 * (`CanvasEditor.svelte` fetches it the first time one of them is the case), so an
 * editor that opens a board never carries the words for a board it could not open.
 */
import { t } from "$lib/i18n";

let {
	state,
	onretry,
}: {
	state: "load_error" | "no_access" | "deleted";
	/** Try to load the board again (only the first state offers it). */
	onretry: () => void;
} = $props();
</script>

{#if state === "load_error"}
	<div class="canvas-editor__state" role="alert" data-testid="canvas-load-error">
		<p>{$t("artifacts.canvas.loadFailed")}</p>
		<button type="button" class="btn-secondary" onclick={onretry}>
			{$t("artifacts.canvas.retry")}
		</button>
	</div>
{:else if state === "no_access"}
	<div class="canvas-editor__state" role="status" data-testid="canvas-no-access">
		<p>{$t("artifacts.canvas.noAccess")}</p>
	</div>
{:else}
	<div class="canvas-editor__state" role="alert" data-testid="canvas-deleted">
		<p>{$t("artifacts.canvas.deletedWhileOpen")}</p>
	</div>
{/if}

<style>
	.canvas-editor__state {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		padding: var(--space-lg);
		text-align: center;
		color: var(--text-secondary);
	}

	.canvas-editor__state p {
		margin: 0;
		max-width: 28rem;
	}
</style>
