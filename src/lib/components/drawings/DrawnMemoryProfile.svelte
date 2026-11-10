<script lang="ts">
/**
 * The Memory Profile, as the Knowledge Base's Memory tab stacks it in a narrow
 * column: the portrait card (`PersonaSummaryCard.svelte`'s head, then one
 * category's facts from `MemoryCategorySection.svelte`) and under it the Needs
 * Review card of `KnowledgeMemoryView.svelte` with its three answers: accept,
 * edit, remove. A filled dot is a fact the person said, a ring one Alfy worked
 * out (`MemoryRow.svelte`). The facts are grey lines.
 */
import {
	Check,
	CircleQuestionMark,
	Pencil,
	Trash2,
	User,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";

let {
	lit = null,
	spot = undefined,
}: {
	lit?: string | null;
	/** The spot id the portrait card carries. */
	spot?: string | undefined;
} = $props();

const FACTS = [
	{ width: "74%", stated: true },
	{ width: "58%", stated: false },
	{ width: "66%", stated: true },
] as const;
</script>

<div class="drawn-memory">
	<section
		class="portrait"
		data-drawing-spot={spot}
		class:drawing-spot-lit={isLit(spot, lit)}
	>
		<div class="summary">
			<span class="summary-title">{$t('memoryProfile.summaryTitle')}</span>
			<DrawnBar width="94%" tone="soft" />
			<DrawnBar width="62%" tone="soft" />
		</div>
		<div class="category">
			<span class="category-head">
				<span class="drawn-ic category-icon"><User size="100%" strokeWidth={2} aria-hidden="true" /></span>
				<span class="category-title">{$t('memoryProfile.aboutYou')}</span>
			</span>
			{#each FACTS as fact}
				<span class="fact">
					<span class="dot" class:stated={fact.stated}></span>
					<span class="fact-lines">
						<DrawnBar width={fact.width} />
						<DrawnBar width="34%" tone="soft" />
					</span>
				</span>
			{/each}
		</div>
	</section>

	<section class="review">
		<span class="review-head">
			<span class="drawn-ic review-icon"><CircleQuestionMark size="100%" strokeWidth={2.1} aria-hidden="true" /></span>
			<span class="review-title">{$t('memoryProfile.needsReview')}</span>
			<span class="count"><span class="count-mark"></span></span>
		</span>
		<span class="review-card">
			<span class="review-lines">
				<DrawnBar width="90%" />
				<DrawnBar width="56%" tone="soft" />
			</span>
			<span class="review-actions">
				<span class="action accept"><span class="drawn-ic" style:--ic="7"><Check size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
				<span class="action"><span class="drawn-ic" style:--ic="7"><Pencil size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
				<span class="action remove"><span class="drawn-ic" style:--ic="7"><Trash2 size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
			</span>
		</span>
	</section>
</div>

<style>
	.drawn-memory {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 6);
	}

	.portrait {
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
	}

	.summary {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
		padding: calc(var(--u) * 7);
	}

	.summary-title {
		margin-bottom: calc(var(--u) * 1);
		color: var(--text-primary);
		font-size: calc(var(--u) * 8.5);
		font-weight: 500;
		white-space: nowrap;
	}

	.category {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 6) calc(var(--u) * 7) calc(var(--u) * 7);
		border-top: 1px solid var(--border-default);
	}

	.category-head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
	}

	.category-icon {
		--ic: 9;
		color: var(--accent);
	}

	.category-title {
		color: var(--text-primary);
		font-size: calc(var(--u) * 8);
		font-weight: 600;
		white-space: nowrap;
	}

	.fact {
		display: flex;
		align-items: flex-start;
		gap: calc(var(--u) * 5);
	}

	.dot {
		flex: none;
		box-sizing: border-box;
		width: calc(var(--u) * 5);
		height: calc(var(--u) * 5);
		margin-top: calc(var(--u) * 0.5);
		border: 1px solid var(--accent);
		border-radius: 50%;
	}

	.dot.stated {
		background: var(--accent);
	}

	.fact-lines {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 3);
	}

	/* The card Alfy asks a question in: the accent for a border, and a card
	   inside it with the accent for a rule. */
	.review {
		border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border-default) 72%);
		border-radius: calc(var(--u) * 6);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
	}

	.review-head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		padding: calc(var(--u) * 6) calc(var(--u) * 7) calc(var(--u) * 4);
	}

	.review-icon {
		--ic: 9;
		color: var(--accent);
	}

	.review-title {
		color: var(--accent);
		font-size: calc(var(--u) * 8);
		font-weight: 600;
		white-space: nowrap;
	}

	/* The count: a pill in the accent with a little mark where the number is. */
	.count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: calc(var(--u) * 9);
		padding: 0 calc(var(--u) * 4);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		border-radius: calc(var(--u) * 9);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated) 92%);
	}

	.count-mark {
		width: calc(var(--u) * 3);
		height: calc(var(--u) * 3);
		border-radius: calc(var(--u) * 1);
		background: var(--accent);
	}

	.review-card {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 5) calc(var(--u) * 7) calc(var(--u) * 5) calc(var(--u) * 5);
		border-left: calc(var(--u) * 2) solid var(--accent);
		border-radius: 0 0 calc(var(--u) * 5) calc(var(--u) * 5);
		background: color-mix(in srgb, var(--accent) 6%, var(--surface-page) 94%);
	}

	.review-lines {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 3);
	}

	.review-actions {
		display: flex;
		flex: none;
		gap: calc(var(--u) * 2);
	}

	.action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 12);
		height: calc(var(--u) * 12);
		border: 1px solid transparent;
		border-radius: 50%;
		color: var(--icon-muted);
	}

	/* Accept is the primary tint; remove is the one in the danger colour. */
	.accept {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		background: color-mix(in srgb, var(--accent) 20%, var(--surface-elevated));
		color: var(--accent);
	}

	.remove {
		color: var(--danger);
	}
</style>
