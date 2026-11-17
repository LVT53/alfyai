<script lang="ts">
/**
 * Alfy's question card (`AskQuestionCard.svelte`): the question and the line
 * under it, the answers to click (one marked Recommended, one under the
 * pointer), the row for your own words, "Decide for me" in the footer and
 * the X. Its words are the card's own keys; the question and the answers are
 * content, so grey lines.
 */
import { PenLine, X } from "@lucide/svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import { t } from "$lib/i18n";
</script>

<article class="ask">
	<div class="body">
		<p class="question"><DrawnBar width="70%" thick /></p>
		<p class="detail"><DrawnBar width="86%" tone="soft" /></p>
		<div class="options">
			<span class="option">
				<span class="dot"></span>
				<span class="answer"><DrawnBar width="44%" /><span class="pick">{$t('chat.ask.recommended')}</span></span>
			</span>
			<span class="option hover">
				<span class="dot"></span>
				<span class="answer"><DrawnBar width="62%" /></span>
			</span>
			<span class="option">
				<span class="dot"></span>
				<span class="answer"><DrawnBar width="36%" /></span>
			</span>
			<span class="option own">
				<span class="drawn-ic" style:--ic="8"><PenLine size="100%" strokeWidth={2} aria-hidden="true" /></span>
				<span class="own-label">{$t('chat.ask.other')}</span>
			</span>
		</div>
	</div>
	<footer class="foot"><span class="quiet">{$t('chat.ask.decideForMe')}</span></footer>
	<span class="x"><span class="drawn-ic" style:--ic="8"><X size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
</article>

<style>
	.ask {
		position: relative;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
	}

	.body {
		padding: calc(var(--u) * 8) calc(var(--u) * 9) calc(var(--u) * 6);
	}

	.question {
		display: flex;
		margin: 0 calc(var(--u) * 20) calc(var(--u) * 4) calc(var(--u) * 1);
	}

	.detail {
		display: flex;
		margin: 0 calc(var(--u) * 20) calc(var(--u) * 6) calc(var(--u) * 1);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 3);
	}

	.option {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 6);
		height: calc(var(--u) * 15);
		padding: 0 calc(var(--u) * 7);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.option.hover {
		border-color: color-mix(in srgb, var(--text-primary) 16%, transparent);
		background: var(--surface-elevated);
	}

	.dot {
		flex: none;
		width: calc(var(--u) * 9);
		height: calc(var(--u) * 9);
		border: calc(var(--u) * 1) solid color-mix(in srgb, var(--text-primary) 32%, transparent);
		border-radius: 50%;
		box-sizing: border-box;
	}

	.answer {
		display: flex;
		flex: 1;
		align-items: center;
		gap: calc(var(--u) * 4);
		min-width: 0;
	}

	.pick {
		flex: none;
		padding: calc(var(--u) * 1) calc(var(--u) * 4.5);
		border-radius: calc(var(--u) * 6);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-size: calc(var(--u) * 5.5);
		font-weight: 600;
		white-space: nowrap;
	}

	.own {
		color: var(--text-muted);
	}

	.own-label {
		font-size: calc(var(--u) * 7);
	}

	.foot {
		display: flex;
		padding: calc(var(--u) * 4) calc(var(--u) * 9);
		border-top: 1px solid var(--border-subtle);
	}

	.quiet {
		color: var(--text-secondary);
		font-size: calc(var(--u) * 7);
		font-weight: 600;
	}

	.x {
		position: absolute;
		top: calc(var(--u) * 6);
		right: calc(var(--u) * 6);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 14);
		height: calc(var(--u) * 14);
		color: var(--icon-muted);
	}
</style>
