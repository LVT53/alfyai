<script lang="ts">
/**
 * A clip's card in the chat (`VideoCardBody.svelte`): the VIDEO badge, its
 * title as a line and its length; the clip, drawn as the kit draws a picture
 * (a sky tinted by the accent) with the player's Play over it; and its row of
 * actions, Another and More, with More open on Download and Download as GIF.
 */
import { Download, Ellipsis, FileImage, Play, RefreshCw } from "@lucide/svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import { t } from "$lib/i18n";

let { menu = true }: { menu?: boolean } = $props();
</script>

<div class="video-card">
	<div class="head">
		<span class="badge">{$t('artifacts.video.badge')}</span>
		<span class="title"><DrawnBar width="62%" /></span>
		<span class="length">0:05</span>
	</div>
	<div class="clip">
		<span class="play"><span class="drawn-ic" style:--ic="11"><Play size="100%" strokeWidth={2} fill="currentColor" aria-hidden="true" /></span></span>
		<span class="progress"><span class="played"></span></span>
	</div>
	<div class="actions">
		<span class="button">
			<span class="drawn-ic" style:--ic="7"><RefreshCw size="100%" strokeWidth={2} aria-hidden="true" /></span>
			{$t('artifacts.video.card.another')}
		</span>
		<span class="button more" class:open={menu}>
			<span class="drawn-ic" style:--ic="8"><Ellipsis size="100%" strokeWidth={2} aria-hidden="true" /></span>
		</span>
		{#if menu}
			<span class="menu">
				<span class="menu-row">
					<span class="drawn-ic" style:--ic="8"><Download size="100%" strokeWidth={1.75} aria-hidden="true" /></span>
					{$t('artifacts.video.card.download')}
				</span>
				<span class="menu-row hover">
					<span class="drawn-ic" style:--ic="8"><FileImage size="100%" strokeWidth={1.75} aria-hidden="true" /></span>
					{$t('artifacts.video.card.downloadGif')}
				</span>
			</span>
		{/if}
	</div>
</div>

<style>
	.video-card {
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
	}

	.head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 6) calc(var(--u) * 7);
	}

	.badge {
		flex: none;
		color: var(--text-muted);
		font-size: calc(var(--u) * 5.5);
		font-weight: 700;
		letter-spacing: 0.08em;
	}

	.title {
		display: flex;
		flex: 1;
		min-width: 0;
	}

	.length {
		flex: none;
		color: var(--text-muted);
		font-size: calc(var(--u) * 6);
		font-variant-numeric: tabular-nums;
	}

	/* The clip: the kit's picture, a sky tinted by the accent, in 16:9. */
	.clip {
		position: relative;
		aspect-ratio: 16 / 9;
		margin: 0 calc(var(--u) * 6);
		border-radius: calc(var(--u) * 4);
		background:
			radial-gradient(circle at 74% 30%, var(--surface-page) 0 7%, transparent 7.5%),
			linear-gradient(160deg, var(--accent-tint-strong), var(--surface-elevated) 70%);
		overflow: hidden;
	}

	.play {
		position: absolute;
		top: 50%;
		left: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 26);
		height: calc(var(--u) * 26);
		padding-left: calc(var(--u) * 2);
		border-radius: 50%;
		background: color-mix(in srgb, var(--surface-page) 86%, transparent);
		color: var(--text-primary);
		box-shadow: var(--shadow-md);
		box-sizing: border-box;
		transform: translate(-50%, -50%);
	}

	.progress {
		position: absolute;
		right: calc(var(--u) * 6);
		bottom: calc(var(--u) * 5);
		left: calc(var(--u) * 6);
		height: calc(var(--u) * 1.6);
		border-radius: calc(var(--u) * 1);
		background: color-mix(in srgb, var(--surface-page) 60%, transparent);
	}

	.played {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 35%;
		border-radius: inherit;
		background: var(--accent);
	}

	.actions {
		position: relative;
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		padding: calc(var(--u) * 5) calc(var(--u) * 6) calc(var(--u) * 6);
	}

	.button {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 3);
		height: calc(var(--u) * 14);
		padding: 0 calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		color: var(--text-primary);
		font-size: calc(var(--u) * 6.5);
		font-weight: 500;
		white-space: nowrap;
	}

	.more {
		padding: 0 calc(var(--u) * 4);
		color: var(--icon-muted);
	}

	.more.open {
		background: var(--surface-elevated);
	}

	.menu {
		position: absolute;
		top: calc(100% - var(--u) * 4);
		left: calc(var(--u) * 44);
		z-index: 1;
		display: flex;
		flex-direction: column;
		padding: calc(var(--u) * 3);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
	}

	.menu-row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 3.5) calc(var(--u) * 7) calc(var(--u) * 3.5) calc(var(--u) * 5);
		border-radius: calc(var(--u) * 4);
		color: var(--text-primary);
		font-size: calc(var(--u) * 7);
		white-space: nowrap;
	}

	.menu-row.hover {
		background: var(--surface-elevated);
	}
</style>
