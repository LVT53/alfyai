<script lang="ts">
/**
 * The board's zoom, in the corner where a reader looks for it: out, the level,
 * in, and fit-to-view. Inside the flow's own panel, so nothing the library draws
 * in that corner can sit on top of it. Plain buttons: the wheel and a pinch
 * remain the way most readers zoom.
 */
import { Minus, Plus, Scan } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	zoom,
	onzoomin,
	onzoomout,
	onfit,
}: {
	zoom: number;
	onzoomin: () => void;
	onzoomout: () => void;
	onfit: () => void;
} = $props();
</script>

<div class="zoom" role="group" aria-label={$t("artifacts.canvas.zoom")} data-testid="canvas-zoom">
	<button
		type="button"
		class="zoom__button"
		aria-label={$t("artifacts.canvas.zoomOut")}
		title={$t("artifacts.canvas.zoomOut")}
		data-testid="canvas-zoom-out"
		onclick={onzoomout}
	>
		<Minus size={14} strokeWidth={2} aria-hidden="true" />
	</button>
	<span class="zoom__level" aria-live="off" data-testid="canvas-zoom-level">{Math.round(zoom * 100)}%</span>
	<button
		type="button"
		class="zoom__button"
		aria-label={$t("artifacts.canvas.zoomIn")}
		title={$t("artifacts.canvas.zoomIn")}
		data-testid="canvas-zoom-in"
		onclick={onzoomin}
	>
		<Plus size={14} strokeWidth={2} aria-hidden="true" />
	</button>
	<button
		type="button"
		class="zoom__button"
		aria-label={$t("artifacts.canvas.fitView")}
		title={$t("artifacts.canvas.fitView")}
		data-testid="canvas-fit"
		onclick={onfit}
	>
		<Scan size={14} strokeWidth={2} aria-hidden="true" />
	</button>
</div>

<style>
	.zoom {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 2px 4px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.zoom__level {
		min-width: 3.2em;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.zoom__button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.zoom__button:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.zoom__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.zoom__button {
			width: 44px;
			height: 44px;
		}
	}
</style>
