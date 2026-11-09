<script lang="ts">
/**
 * The Make section's drawing: the chat beside the side panel open on a
 * Document. The chat holds a Document card and a Picture card; the panel's
 * header has the way back, History's clock and Download; one passage of the
 * page is Alfy's change, with the Keep and Undo it waits on.
 *
 * The spot ids are the guide's `drawingSpot`s for this section
 * (`section-drawing-spots.ts`). The Document is two spots in one: its card in
 * the chat and its page in the panel, so a row about Documents rings both.
 *
 * Keep and Undo are the inline pill's own words and icons (`ChangeBar.svelte`:
 * `artifacts.document.change.keep` and `.undo`, Check and Undo2), so a pill that
 * is reworded rewords its drawing. The review bar's `artifacts.document.review.*`
 * keys belong to another control and are not used here.
 */
import { Check, Undo2 } from "@lucide/svelte";
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnChatCard from "$lib/components/drawings/DrawnChatCard.svelte";
import DrawnPanel from "$lib/components/drawings/DrawnPanel.svelte";
import { isLit } from "$lib/components/drawings/drawing-spot";
import { t } from "$lib/i18n";

let { lit = null }: { lit?: string | null } = $props();
</script>

<DrawingFrame>
	<div class="chat">
		<DrawnBar width="90%" tone="soft" />
		<DrawnBar width="70%" tone="soft" />
		<div class="card"><DrawnChatCard kind="document" {lit} spot="document" /></div>
		<DrawnBar width="84%" tone="soft" />
		<DrawnBar width="60%" tone="soft" />
		<div class="card"><DrawnChatCard kind="image" {lit} spot="picture" /></div>
	</div>
	<div class="panel">
		<DrawnPanel {lit} spots={{ history: 'history', download: 'download' }}>
			<div
				class="page"
				data-drawing-spot="document"
				class:drawing-spot-lit={isLit('document', lit)}
			>
				<span class="title"><DrawnBar width="55%" thick /></span>
				<DrawnBar width="96%" tone="soft" />
				<DrawnBar width="88%" tone="soft" />
				<div class="change">
					<DrawnBar width="92%" tone="change" />
					<DrawnBar width="64%" tone="change" />
					<span class="pill">
						<span class="keep">
							<span class="drawn-ic" style:--ic="8"><Check size="100%" strokeWidth={2.5} aria-hidden="true" /></span>
							<span>{$t('artifacts.document.change.keep')}</span>
						</span>
						<span class="undo">
							<span class="drawn-ic" style:--ic="8"><Undo2 size="100%" strokeWidth={2} aria-hidden="true" /></span>
							<span>{$t('artifacts.document.change.undo')}</span>
						</span>
					</span>
				</div>
				<DrawnBar width="80%" tone="soft" />
			</div>
		</DrawnPanel>
	</div>
</DrawingFrame>

<style>
	.chat {
		position: absolute;
		inset: 0 auto 0 0;
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		box-sizing: border-box;
		width: 36%;
		padding: calc(var(--u) * 10) calc(var(--u) * 9);
		border-right: 1px solid var(--border-default);
		background: var(--surface-page);
	}

	.card {
		margin: calc(var(--u) * 3) 0;
	}

	.panel {
		position: absolute;
		inset: 0 0 0 36%;
	}

	.page {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 6);
		padding: calc(var(--u) * 4);
		border-radius: calc(var(--u) * 6);
	}

	.title {
		display: flex;
		margin-bottom: calc(var(--u) * 3);
	}

	/* The passage Alfy changed, set off by a rule at its side. */
	.change {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 6);
		margin: calc(var(--u) * 2) 0;
		padding-left: calc(var(--u) * 6);
		border-left: calc(var(--u) * 2) solid var(--accent);
	}

	/* The pill under it: Keep as the primary choice, Undo beside it. */
	.pill {
		display: inline-flex;
		align-self: flex-start;
		align-items: center;
		gap: calc(var(--u) * 2);
		padding: calc(var(--u) * 2);
		border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		border-radius: calc(var(--u) * 20);
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		font-size: calc(var(--u) * 8.5);
		font-weight: 700;
		white-space: nowrap;
	}

	.keep,
	.undo {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 3);
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 6);
		border-radius: calc(var(--u) * 20);
	}

	.keep {
		background: var(--accent-fill);
		color: var(--on-accent);
	}

	.undo {
		color: var(--text-primary);
	}
</style>
