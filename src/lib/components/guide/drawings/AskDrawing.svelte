<script lang="ts">
/**
 * The Ask section's drawing: a chat with the person's message and Alfy's reply
 * (its Sources row and its actions), and the composer with its "+" menu open on
 * Attach file, From your Library, Skills and Atlas report.
 *
 * The spot ids are the guide's `drawingSpot`s for this section
 * (`section-drawing-spots.ts`). The composer's other faces, the menu's Library
 * and Skills rows, are drawn but no row of Ask points at them.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnComposer from "$lib/components/drawings/DrawnComposer.svelte";
import DrawnMenu from "$lib/components/drawings/DrawnMenu.svelte";
import DrawnReply from "$lib/components/drawings/DrawnReply.svelte";
import DrawnUserMessage from "$lib/components/drawings/DrawnUserMessage.svelte";

let { lit = null }: { lit?: string | null } = $props();
</script>

<DrawingFrame>
	<div class="chat">
		<div class="you"><DrawnUserMessage /></div>
		<div class="reply">
			<DrawnReply {lit} spots={{ sources: 'sources', actions: 'replyActions' }} />
		</div>
		<div class="menu">
			<DrawnMenu {lit} spots={{ attach: 'attach', atlas: 'atlas' }} />
		</div>
		<div class="composer">
			<DrawnComposer {lit} menuOpen spots={{ thinking: 'thinking' }} />
		</div>
	</div>
</DrawingFrame>

<style>
	.chat {
		position: absolute;
		inset: 0;
		background: var(--surface-page);
	}

	.you {
		position: absolute;
		top: calc(var(--u) * 8);
		right: calc(var(--u) * 12);
		width: calc(var(--u) * 118);
	}

	.reply {
		position: absolute;
		top: calc(var(--u) * 30);
		right: calc(var(--u) * 30);
		left: calc(var(--u) * 12);
	}

	.menu {
		position: absolute;
		bottom: calc(var(--u) * 46);
		left: calc(var(--u) * 12);
		width: calc(var(--u) * 150);
	}

	.composer {
		position: absolute;
		right: calc(var(--u) * 10);
		bottom: calc(var(--u) * 9);
		left: calc(var(--u) * 10);
	}
</style>
