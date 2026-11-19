<script lang="ts">
/**
 * Read aloud's floating player above the message box (spec §4.3), with no
 * words of the reply in it: previous sentence, pause, next sentence, the time
 * read, the sentence scrubber with a notch at each sentence's start, the
 * length, "go to where it is reading", the speed and stop. On a desktop it is
 * one row; on a phone two, the scrubber on top.
 */
import { LocateFixed, Pause, SkipBack, SkipForward, X } from "@lucide/svelte";

let {
	phone = false,
	played = 38,
	notches = [17, 38, 61, 80],
	time = "0:09",
	length = "0:24",
	speed = "1×",
}: {
	phone?: boolean;
	/** Where the handle is, in percent of the line. */
	played?: number;
	/** Where the sentences start, in percent of the line. */
	notches?: number[];
	time?: string;
	length?: string;
	speed?: string;
} = $props();
</script>

{#snippet scrubber()}
	<span class="scrubber" style:--played="{played}%">
		<span class="track"></span>
		<span class="fill"></span>
		{#each notches as notch}
			<span class="notch" class:passed={notch <= played} style:left="{notch}%"></span>
		{/each}
		<span class="handle"></span>
	</span>
{/snippet}

{#snippet steps()}
	<span class="button"><span class="drawn-ic" style:--ic="9"><SkipBack size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
	<span class="play"><span class="drawn-ic" style:--ic="9"><Pause size="100%" strokeWidth={2.2} aria-hidden="true" /></span></span>
	<span class="button"><span class="drawn-ic" style:--ic="9"><SkipForward size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
{/snippet}

{#snippet speedChip()}
	<span class="speed">{speed}</span>
{/snippet}

{#snippet locateAndStop()}
	<span class="button"><span class="drawn-ic" style:--ic="9"><LocateFixed size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
	{#if !phone}{@render speedChip()}{/if}
	<span class="button"><span class="drawn-ic" style:--ic="9"><X size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
{/snippet}

<div class="player" class:phone>
	{#if phone}
		<div class="row times">
			<span class="time">{time}</span>
			{@render scrubber()}
			<span class="time">{length}</span>
		</div>
		<div class="row controls">
			{@render speedChip()}
			<span class="middle">{@render steps()}</span>
			<span class="end">{@render locateAndStop()}</span>
		</div>
	{:else}
		<div class="row">
			{@render steps()}
			<span class="time">{time}</span>
			{@render scrubber()}
			<span class="time">{length}</span>
			{@render locateAndStop()}
		</div>
	{/if}
</div>

<style>
	.player {
		display: flex;
		flex-direction: column;
		padding: calc(var(--u) * 3) calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 15);
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		color: var(--icon-muted);
	}

	.player.phone {
		gap: calc(var(--u) * 3);
		padding: calc(var(--u) * 6) calc(var(--u) * 7) calc(var(--u) * 4);
		border-radius: calc(var(--u) * 13);
	}

	.row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
	}

	.controls {
		justify-content: space-between;
	}

	.middle,
	.end {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 4);
	}

	.button {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 16);
		height: calc(var(--u) * 16);
	}

	/* Play and pause: a circle in a soft accent fill, the icon in the accent. */
	.play {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 18);
		height: calc(var(--u) * 18);
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 14%, var(--surface-page));
		color: var(--accent);
	}

	.phone .play {
		width: calc(var(--u) * 22);
		height: calc(var(--u) * 22);
	}

	.time {
		flex: none;
		color: var(--text-secondary);
		font-family: var(--font-mono, monospace);
		font-size: calc(var(--u) * 6.5);
		font-variant-numeric: tabular-nums;
	}

	.scrubber {
		position: relative;
		flex: 1;
		min-width: 0;
		height: calc(var(--u) * 10);
	}

	.track,
	.fill {
		position: absolute;
		top: 50%;
		left: 0;
		height: calc(var(--u) * 1.6);
		border-radius: calc(var(--u) * 1);
		transform: translateY(-50%);
	}

	.track {
		right: 0;
		background: color-mix(in srgb, var(--text-primary) 14%, transparent);
	}

	.fill {
		width: var(--played);
		background: var(--accent);
	}

	/* A sentence's start: a short tick across the line. */
	.notch {
		position: absolute;
		top: 50%;
		width: 1px;
		height: calc(var(--u) * 4.5);
		background: color-mix(in srgb, var(--text-primary) 32%, transparent);
		transform: translate(-50%, -50%);
	}

	/* The played part of the line is one stroke of the accent. */
	.notch.passed {
		display: none;
	}

	.handle {
		position: absolute;
		top: 50%;
		left: var(--played);
		width: calc(var(--u) * 7.5);
		height: calc(var(--u) * 7.5);
		border: calc(var(--u) * 1.6) solid var(--accent);
		border-radius: 50%;
		background: var(--surface-page);
		box-sizing: border-box;
		transform: translate(-50%, -50%);
	}

	.speed {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		min-width: calc(var(--u) * 19);
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 4);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 7);
		color: var(--text-primary);
		font-size: calc(var(--u) * 6.5);
		font-weight: 600;
	}
</style>
