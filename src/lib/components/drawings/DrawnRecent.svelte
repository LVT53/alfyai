<script lang="ts">
/**
 * Home's Recent list (`HomeRecent.svelte`): a hairline with "All
 * conversations" quiet at its right end, a few lines of `title · when · mark`
 * (grey lines, and the chat mark of the message count) and the line a running
 * job adds, with its kicker in the accent, its stage and its progress. The
 * kicker's spinner stands still in a drawing.
 */
import { ChevronRight, LoaderCircle, MessageSquare } from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";

const LINES = [
	{ title: "46%", when: "16%" },
	{ title: "34%", when: "20%" },
] as const;
</script>

<div class="drawn-recent">
	<div class="head">
		<span class="rule"></span>
		<span class="link">
			<span class="link-word">{$t('home.allConversations')}</span>
			<span class="drawn-ic" style:--ic="7"><ChevronRight size="100%" strokeWidth={2.4} aria-hidden="true" /></span>
		</span>
	</div>
	{#each LINES as line}
		<div class="line">
			<DrawnBar width={line.title} />
			<DrawnBar width={line.when} tone="soft" />
			<span class="mark">
				<span class="drawn-ic" style:--ic="7"><MessageSquare size="100%" strokeWidth={1.75} aria-hidden="true" /></span>
				<DrawnBar width="calc(var(--u) * 5)" tone="soft" />
			</span>
		</div>
	{/each}
	<div class="line running">
		<span class="kicker">
			<span class="drawn-ic" style:--ic="8"><LoaderCircle size="100%" strokeWidth={2} aria-hidden="true" /></span>
			<span class="kicker-word">{$t('home.runningNow')}</span>
		</span>
		<DrawnBar width="28%" />
		<span class="progress"><b></b></span>
	</div>
</div>

<style>
	.drawn-recent {
		display: flex;
		flex-direction: column;
	}

	.head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 8);
		margin-bottom: calc(var(--u) * 3);
	}

	.rule {
		flex: 1;
		height: 1px;
		background: var(--border-default);
	}

	.link {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 2);
		color: var(--text-muted);
		font-size: calc(var(--u) * 7);
		white-space: nowrap;
	}

	.line {
		position: relative;
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 7);
		height: calc(var(--u) * 14);
		padding: 0 calc(var(--u) * 4);
	}

	/* The hairline between lines is the line's own top edge. */
	.line + .line::before {
		content: "";
		position: absolute;
		top: 0;
		right: 0;
		left: 0;
		height: 1px;
		background: var(--border-subtle);
	}

	.mark {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 3);
		margin-left: auto;
		color: var(--text-muted);
	}

	.kicker {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: calc(var(--u) * 3);
		color: var(--accent);
	}

	.kicker-word {
		font-size: calc(var(--u) * 7);
		font-weight: 600;
		letter-spacing: 0.03em;
		white-space: nowrap;
	}

	.progress {
		flex: none;
		width: calc(var(--u) * 30);
		height: calc(var(--u) * 3);
		margin-left: auto;
		border-radius: calc(var(--u) * 2);
		background: color-mix(in srgb, var(--text-muted) 18%, transparent);
	}

	.progress b {
		display: block;
		width: 62%;
		height: 100%;
		border-radius: calc(var(--u) * 2);
		background: var(--accent);
	}
</style>
