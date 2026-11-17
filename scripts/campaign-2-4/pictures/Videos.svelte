<script lang="ts">
/**
 * Card 4, videos: the person's message with a photo and a line asking to
 * animate it, and Alfy's clip card under the reply, its More menu open on
 * Download as GIF.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnComposer from "$lib/components/drawings/DrawnComposer.svelte";
import VideoCard from "../parts/VideoCard.svelte";
import { DESIGN_SIZE, type Variant } from "../sizes";

let { variant }: { variant: Variant } = $props();

let phone = $derived(variant === "mobile");
</script>

<DrawingFrame width={DESIGN_SIZE[variant].width} height={DESIGN_SIZE[variant].height} bare>
	<div class="chat" class:phone>
		<div class="you">
			<span class="photo"></span>
			<span class="words">
				<DrawnBar width="88%" />
				{#if phone}<DrawnBar width="56%" />{/if}
			</span>
		</div>
		<div class="reply">
			<span class="dot"></span>
			<span class="text"><DrawnBar width="64%" tone="soft" /></span>
		</div>
		<div class="card"><VideoCard /></div>
		{#if phone}<div class="composer"><DrawnComposer /></div>{/if}
	</div>
</DrawingFrame>

<style>
	.chat {
		position: absolute;
		inset: 0;
		background: var(--surface-page);
	}

	/* The person's message: the photo they attached, then their words. */
	.you {
		position: absolute;
		top: calc(var(--u) * 8);
		right: calc(var(--u) * 26);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: calc(var(--u) * 4);
		width: calc(var(--u) * 104);
	}

	.photo {
		width: calc(var(--u) * 30);
		height: calc(var(--u) * 22);
		border-radius: calc(var(--u) * 5);
		background:
			radial-gradient(circle at 70% 32%, var(--surface-page) 0 9%, transparent 10%),
			linear-gradient(160deg, var(--accent-tint-strong), var(--surface-elevated) 72%);
	}

	.words {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		width: 100%;
		padding: calc(var(--u) * 6) calc(var(--u) * 8);
		border-radius: calc(var(--u) * 9);
		background: var(--surface-message-user);
		box-sizing: border-box;
	}

	.reply {
		position: absolute;
		top: calc(var(--u) * 52);
		left: calc(var(--u) * 26);
		width: calc(var(--u) * 160);
	}

	.dot {
		position: absolute;
		top: 0;
		left: 0;
		width: calc(var(--u) * 9);
		height: calc(var(--u) * 9);
		border-radius: 50%;
		background: var(--accent);
	}

	.text {
		display: flex;
		margin-left: calc(var(--u) * 16);
		padding-top: calc(var(--u) * 2);
	}

	.card {
		position: absolute;
		top: calc(var(--u) * 64);
		left: calc(var(--u) * 42);
		width: calc(var(--u) * 140);
	}

	.phone .you {
		top: calc(var(--u) * 16);
		right: calc(var(--u) * 10);
		width: calc(var(--u) * 116);
	}

	.phone .photo {
		width: calc(var(--u) * 60);
		height: calc(var(--u) * 45);
	}

	.phone .reply {
		top: calc(var(--u) * 104);
		right: calc(var(--u) * 12);
		left: calc(var(--u) * 10);
		width: auto;
	}

	.phone .card {
		top: calc(var(--u) * 118);
		right: calc(var(--u) * 10);
		left: calc(var(--u) * 10);
		width: auto;
	}

	.composer {
		position: absolute;
		right: calc(var(--u) * 8);
		bottom: calc(var(--u) * 10);
		left: calc(var(--u) * 8);
	}
</style>
