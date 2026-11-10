<script lang="ts">
/**
 * The Your things section's drawing: four places in a grid. At the top, the
 * Knowledge Base's Documents tab beside Settings > Connections. Under them, at
 * the left, the chat's "+" menu open on Attach file and From your Library, and
 * at the right the "Needs your OK" card Alfy asks on before it changes anything
 * in an account.
 *
 * The spot ids are the guide's `drawingSpot`s for this section
 * (`section-drawing-spots.ts`): `library` is the Documents view (the chips and
 * the list), `connections` the Connections tab's content, `fromLibrary` the
 * menu's row and `okCard` the card. Show me rings the Documents tab and the
 * Connections tab's content; the drawing lights the Documents view the tab opens.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnComposer from "$lib/components/drawings/DrawnComposer.svelte";
import DrawnConnections from "$lib/components/drawings/DrawnConnections.svelte";
import DrawnDocuments from "$lib/components/drawings/DrawnDocuments.svelte";
import DrawnMenu from "$lib/components/drawings/DrawnMenu.svelte";
import DrawnSpot from "$lib/components/drawings/DrawnSpot.svelte";
import DrawnSwitcher from "$lib/components/drawings/DrawnSwitcher.svelte";
import DrawnWriteCard from "$lib/components/drawings/DrawnWriteCard.svelte";

let { lit = null }: { lit?: string | null } = $props();
</script>

<DrawingFrame>
	<div class="knowledge">
		<DrawnSwitcher items={[{ word: 'memory.title' }, { word: 'knowledge.documents' }]} active={1} />
		<DrawnSpot spot="library" {lit}><DrawnDocuments /></DrawnSpot>
	</div>
	<div class="settings">
		<DrawnSwitcher items={[{ word: 'settingsProfile' }, { word: 'settingsConnections' }]} active={1} />
		<DrawnSpot spot="connections" {lit}><DrawnConnections /></DrawnSpot>
	</div>
	<div class="menu-chat">
		<div class="menu">
			<DrawnMenu {lit} rows={['attach', 'library']} spots={{ library: 'fromLibrary' }} />
		</div>
		<div class="composer">
			<DrawnComposer menuOpen />
		</div>
	</div>
	<div class="card-chat">
		<div class="reply">
			<span class="mark"></span>
			<span class="lines">
				<DrawnBar width="88%" />
				<DrawnBar width="60%" tone="soft" />
			</span>
		</div>
		<DrawnSpot spot="okCard" {lit} radius={8}><DrawnWriteCard /></DrawnSpot>
	</div>
</DrawingFrame>

<style>
	/* The top row is two pages, as the other drawings set theirs side by side;
	   the bottom row is two pieces of the chat. Every cell is its own box, split
	   by a line at the middle and one under the pages. */
	.knowledge,
	.settings,
	.menu-chat,
	.card-chat {
		position: absolute;
		box-sizing: border-box;
		background: var(--surface-page);
	}

	.knowledge,
	.settings {
		top: 0;
		height: calc(var(--u) * 112);
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 8) calc(var(--u) * 9) 0;
	}

	.knowledge,
	.menu-chat {
		left: 0;
		width: 50%;
		border-right: 1px solid var(--border-default);
	}

	.settings,
	.card-chat {
		right: 0;
		left: 50%;
	}

	.menu-chat,
	.card-chat {
		top: calc(var(--u) * 112);
		bottom: 0;
		border-top: 1px solid var(--border-default);
	}

	.menu {
		position: absolute;
		bottom: calc(var(--u) * 46);
		left: calc(var(--u) * 10);
		width: calc(var(--u) * 118);
	}

	.composer {
		position: absolute;
		right: calc(var(--u) * 10);
		bottom: calc(var(--u) * 9);
		left: calc(var(--u) * 10);
	}

	.card-chat {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: calc(var(--u) * 7);
		padding: calc(var(--u) * 10);
	}

	/* The start of Alfy's reply, as the Ask drawing sets it: a dot and lines. */
	.reply {
		display: flex;
		align-items: flex-start;
		gap: calc(var(--u) * 6);
		margin-bottom: calc(var(--u) * 1);
	}

	.mark {
		flex: none;
		width: calc(var(--u) * 9);
		height: calc(var(--u) * 9);
		border-radius: 50%;
		background: var(--accent);
	}

	.lines {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		padding-top: calc(var(--u) * 0.5);
	}
</style>
