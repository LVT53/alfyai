<script lang="ts">
/**
 * A finished reply's row of actions as `MessageBubble.svelte` draws it
 * (regenerate, fork, copy), with read aloud's speaker after Copy (spec §4.1):
 * Lucide `Volume2` while ready, and while reading a pause inside a thin ring
 * that fills with what has been read.
 */
import { Copy, GitBranch, Pause, RefreshCw, Volume2 } from "@lucide/svelte";

let {
	reading = false,
	progress = 40,
}: {
	reading?: boolean;
	/** How much of the reply has been read, in percent: the ring's fill. */
	progress?: number;
} = $props();
</script>

<span class="reply-actions">
	<span class="drawn-ic"><RefreshCw size="100%" strokeWidth={2} aria-hidden="true" /></span>
	<span class="drawn-ic"><GitBranch size="100%" strokeWidth={2} aria-hidden="true" /></span>
	<span class="drawn-ic"><Copy size="100%" strokeWidth={2} aria-hidden="true" /></span>
	{#if reading}
		<span class="speaker reading" style:--progress="{progress}%">
			<span class="ring"></span>
			<span class="drawn-ic" style:--ic="7"><Pause size="100%" strokeWidth={2.4} aria-hidden="true" /></span>
		</span>
	{:else}
		<span class="speaker">
			<span class="drawn-ic"><Volume2 size="100%" strokeWidth={2} aria-hidden="true" /></span>
		</span>
	{/if}
</span>

<style>
	.reply-actions {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 8);
		color: var(--icon-muted);
	}

	.speaker {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 15);
		height: calc(var(--u) * 15);
	}

	.reading {
		color: var(--accent);
	}

	/* The thin ring that fills as it reads: what has been read in the accent,
	   the rest in the border's grey, cut to a ring by a radial mask. */
	.ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: conic-gradient(
			var(--accent) 0 var(--progress),
			color-mix(in srgb, var(--text-primary) 14%, transparent) var(--progress) 100%
		);
		mask: radial-gradient(
			farthest-side,
			transparent calc(100% - var(--u) * 1.6),
			black calc(100% - var(--u) * 1.6)
		);
	}
</style>
