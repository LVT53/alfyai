<script lang="ts">
/**
 * The side panel with an item open: the header, then the item's body.
 *
 * The header is one row. It holds the way back of `ArtifactPanelHeader.svelte`
 * (`artifacts.panel.crumb`), the title as a grey line, History's clock (that
 * header's button) and the Download and Close of `DocumentWorkspace.svelte`'s
 * header actions. The body is whatever the drawing puts in it.
 */
import { ChevronLeft, Clock, Download, X } from "@lucide/svelte";
import type { Snippet } from "svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";

let {
	lit = null,
	spots = {},
	children = undefined,
}: {
	lit?: string | null;
	/** The spot ids the header's History clock and Download carry. */
	spots?: { history?: string; download?: string };
	/** The item's body. */
	children?: Snippet | undefined;
} = $props();
</script>

<div class="drawn-panel">
	<div class="head">
		<span class="crumb">
			<span class="drawn-ic"><ChevronLeft size="100%" strokeWidth={2.2} aria-hidden="true" /></span>
			<span class="crumb-word">{$t('artifacts.panel.crumb')}</span>
		</span>
		<span class="title"><DrawnBar width="70%" /></span>
		<span
			class="action"
			data-drawing-spot={spots.history}
			class:drawing-spot-lit={isLit(spots.history, lit)}
		>
			<span class="drawn-ic"><Clock size="100%" strokeWidth={2.1} aria-hidden="true" /></span>
		</span>
		<span
			class="action"
			data-drawing-spot={spots.download}
			class:drawing-spot-lit={isLit(spots.download, lit)}
		>
			<span class="drawn-ic"><Download size="100%" strokeWidth={2} aria-hidden="true" /></span>
		</span>
		<span class="action">
			<span class="drawn-ic"><X size="100%" strokeWidth={2.1} aria-hidden="true" /></span>
		</span>
	</div>
	<div class="body">
		{@render children?.()}
	</div>
</div>

<style>
	.drawn-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--surface-page);
	}

	.head {
		display: flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 3);
		height: calc(var(--u) * 28);
		padding: 0 calc(var(--u) * 6) 0 calc(var(--u) * 4);
		border-bottom: 1px solid var(--border-default);
		color: var(--text-muted);
	}

	/* The way back: small capitals on one line, as the real header sets it. */
	.crumb {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 1);
	}

	.crumb-word {
		font-size: calc(var(--u) * 7.5);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.title {
		display: flex;
		flex: 1;
		min-width: 0;
		margin-left: calc(var(--u) * 3);
		padding-left: calc(var(--u) * 6);
		border-left: 1px solid var(--border-default);
	}

	.action {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 17);
		height: calc(var(--u) * 17);
		border-radius: calc(var(--u) * 5);
	}

	.body {
		position: relative;
		flex: 1;
		min-height: 0;
		padding: calc(var(--u) * 12) calc(var(--u) * 14) calc(var(--u) * 10);
	}
</style>
