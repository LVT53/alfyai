<script lang="ts">
/**
 * The Feature Guide's body, under the route's title: what the page is for, a
 * row of chips that jump to the six sections, the sections themselves and the
 * shortcuts box. The route (`src/routes/(app)/guide/+page.svelte`) draws the
 * title and the frame; what is listed is `guide-content.ts`.
 */
import { t } from "$lib/i18n";
import { prefersReducedMotion } from "$lib/utils/motion";
import {
	GUIDE_SECTION_IDS,
	type GuideSectionId,
	guideSectionKey,
} from "./guide-content";
import GuideSection from "./GuideSection.svelte";
import GuideShortcuts from "./GuideShortcuts.svelte";

// The moment NEW is judged against: the browser's clock, read once, so every
// row of a visit agrees. Nothing is stored per person.
const now = new Date();

// A chip is a real link to its section, so a middle click or a copied address
// still works; a plain click scrolls the page's own scroller there itself, so
// that the motion follows the reader's setting, and moves the keyboard to the
// heading so the next Tab starts in the section.
function jumpTo(event: MouseEvent, id: GuideSectionId) {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	)
		return;
	const section = document.getElementById(`guide-section-${id}`);
	if (!section) return;
	event.preventDefault();
	section.scrollIntoView({
		block: "start",
		behavior: prefersReducedMotion() ? "auto" : "smooth",
	});
	section.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
}
</script>

<div class="guide-page" data-testid="guide-page">
	<p class="guide-page__subtitle">{$t('guide.subtitle')}</p>

	<nav class="guide-chips" aria-label={$t('guide.sectionsLabel')}>
		{#each GUIDE_SECTION_IDS as id (id)}
			<a
				class="guide-chip"
				href="#guide-section-{id}"
				onclick={(event) => jumpTo(event, id)}
			>
				{$t(guideSectionKey(id, 'name'))}
			</a>
		{/each}
	</nav>

	<div class="guide-bands">
		{#each GUIDE_SECTION_IDS as id (id)}
			<GuideSection section={id} {now} />
		{/each}
	</div>

	<GuideShortcuts />
</div>

<style>
	.guide-page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}

	.guide-page__subtitle {
		margin: 0;
		max-width: 44rem;
		font-size: var(--text-md);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.guide-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.guide-chip {
		display: inline-flex;
		align-items: center;
		min-height: 2rem;
		padding: 0 0.875rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-page);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-muted);
		text-decoration: none;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.guide-chip:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.guide-chip:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* The sections answer to the width of this column, not the window's: an
	   open sidebar takes 300 px of a 1024 px window, and two columns need
	   more room than what is left (`GuideSection.svelte`). */
	.guide-bands {
		container-type: inline-size;
		min-width: 0;
	}

	@media (hover: none) and (pointer: coarse) {
		.guide-chip {
			min-height: 2.75rem;
		}
	}
</style>
