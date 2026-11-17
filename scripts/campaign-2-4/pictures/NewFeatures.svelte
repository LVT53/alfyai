<script lang="ts">
/**
 * Card 5, other new features: a long chat whose ruler is open on its list of
 * turns (on a phone, the "11 / 30" capsule instead), a reply with the strip of
 * files it found in Nextcloud, and the message box editing a sent message,
 * which steps back in the thread while it is edited.
 */
import { ChevronDown } from "@lucide/svelte";
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnUserMessage from "$lib/components/drawings/DrawnUserMessage.svelte";
import EditingComposer from "../parts/EditingComposer.svelte";
import FilesStrip from "../parts/FilesStrip.svelte";
import JumpRuler from "../parts/JumpRuler.svelte";
import { DESIGN_SIZE, type Variant } from "../sizes";

let { variant }: { variant: Variant } = $props();

let phone = $derived(variant === "mobile");
</script>

<DrawingFrame width={DESIGN_SIZE[variant].width} height={DESIGN_SIZE[variant].height} bare>
	<div class="chat" class:phone>
		<div class="you"><DrawnUserMessage lines={phone ? ['88%', '50%'] : ['84%']} /></div>
		<div class="reply">
			<span class="dot"></span>
			<div class="text">
				<DrawnBar width="92%" tone="soft" />
				<DrawnBar width="66%" tone="soft" />
				<span class="strip"><FilesStrip /></span>
			</div>
		</div>
		{#if phone}
			<span class="capsule">
				<span class="where"><b>11</b><span class="of">/ 30</span></span>
				<span class="latest"><span class="drawn-ic" style:--ic="8"><ChevronDown size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
			</span>
		{:else}
			<div class="ruler"><JumpRuler /></div>
		{/if}
		<div class="composer"><EditingComposer /></div>
	</div>
</DrawingFrame>

<style>
	.chat {
		position: absolute;
		inset: 0;
		background: var(--surface-page);
	}

	/* The message being edited steps back while the box holds it. */
	.you {
		position: absolute;
		top: calc(var(--u) * 12);
		right: calc(var(--u) * 24);
		width: calc(var(--u) * 112);
		opacity: 0.45;
	}

	.reply {
		position: absolute;
		top: calc(var(--u) * 42);
		right: calc(var(--u) * 24);
		left: calc(var(--u) * 140);
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
		flex-direction: column;
		gap: calc(var(--u) * 5);
		margin-left: calc(var(--u) * 16);
		padding-top: calc(var(--u) * 2);
	}

	.strip {
		display: flex;
		margin-top: calc(var(--u) * 4);
	}

	.ruler {
		position: absolute;
		top: calc(var(--u) * 20);
		left: calc(var(--u) * 8);
	}

	.composer {
		position: absolute;
		right: calc(var(--u) * 22);
		bottom: calc(var(--u) * 9);
		left: calc(var(--u) * 22);
	}

	.capsule {
		position: absolute;
		right: calc(var(--u) * 12);
		bottom: calc(var(--u) * 66);
		display: inline-flex;
		align-items: stretch;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 10);
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
	}

	.where {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 2.5);
		padding: calc(var(--u) * 3) calc(var(--u) * 6);
		font-size: calc(var(--u) * 7);
	}

	.where b {
		font-weight: 700;
	}

	.of {
		color: var(--text-muted);
	}

	.latest {
		display: inline-flex;
		align-items: center;
		padding: 0 calc(var(--u) * 5);
		border-left: 1px solid var(--border-default);
		color: var(--icon-muted);
	}

	.phone .you {
		top: calc(var(--u) * 18);
		right: calc(var(--u) * 10);
		width: calc(var(--u) * 116);
	}

	.phone .reply {
		top: calc(var(--u) * 76);
		right: calc(var(--u) * 12);
		left: calc(var(--u) * 10);
	}

	.phone .composer {
		right: calc(var(--u) * 8);
		bottom: calc(var(--u) * 10);
		left: calc(var(--u) * 8);
	}
</style>
