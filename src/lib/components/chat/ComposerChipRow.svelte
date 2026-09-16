<script lang="ts">
// The ONE chip row (chips redesign, owner-approved boards 2026-09-15).
//
// Before this, the composer grew a list per feature: one for attachments,
// one for linked Library documents, one for the pending skill, one for the
// web switch, one for Atlas — five stacked <ul>s, 355px of chrome before a
// word was typed. They are now a single wrapping row with a 6px gap, sitting
// between the textarea and the action row, in a stable reading order:
// behaviour chips (skill, web, Atlas) lead, material (files, images, quotes,
// linked documents) follows, so removing one chip does not move another.
//
// On a phone the row stops wrapping and scrolls sideways, one line high,
// under a fade in the composer's own fill. A `+N` counter pins to the right
// edge outside the fade; tapping it wraps the row open to full height so
// nothing is permanently hidden, and tapping it again collapses it. The
// behaviour chips being FIRST is what makes that safe: the expensive,
// turn-changing ones are the chips you can always see without scrolling.
import type { Snippet } from "svelte";
import { t } from "$lib/i18n";

let {
	children,
	counter,
	scrollOnPhone = false,
	label,
	testId = "composer-chip-row",
}: {
	children: Snippet;
	/** Right-aligned slot — today the over-length counter. */
	counter?: Snippet | undefined;
	/** True at phone width: side-scroll instead of wrapping. */
	scrollOnPhone?: boolean;
	label: string;
	testId?: string;
} = $props();

let railElement = $state<HTMLUListElement | null>(null);
let expanded = $state(false);
let hiddenCount = $state(0);

let collapsed = $derived(scrollOnPhone && !expanded);

// How many chips the rail is currently hiding. Measured rather than guessed:
// a chip's width depends on its label, so nothing short of comparing each
// child's right edge against the rail's own can answer this honestly. Re-run
// on scroll too: a chip the user has dragged into view is no longer hidden.
function measure() {
	const rail = railElement;
	if (!rail || !collapsed) {
		hiddenCount = 0;
		return;
	}
	const railRight = rail.getBoundingClientRect().right;
	let hidden = 0;
	for (const child of Array.from(rail.children)) {
		// 72px of fade sits over the rail's right edge; a chip under it is
		// not readable, so it counts as hidden.
		if (child.getBoundingClientRect().right > railRight - 56) hidden += 1;
	}
	hiddenCount = hidden;
}

$effect(() => {
	const rail = railElement;
	if (!rail || typeof ResizeObserver === "undefined") return;
	// Re-read whenever the rail resizes OR its children change (a chip added
	// or removed), which is every case that can change the hidden count. The
	// two need different observers: in a nowrap rail whose items do not
	// shrink, appending a chip resizes neither the rail nor the chips already
	// in it, so only a childList mutation sees it arrive — and the new child
	// must then be observed for resizes of its own (a label that ellipsises
	// later, say).
	const observer = new ResizeObserver(() => measure());
	const observeChildren = () => {
		for (const child of Array.from(rail.children)) observer.observe(child);
	};
	observer.observe(rail);
	observeChildren();
	const mutations =
		typeof MutationObserver === "undefined"
			? null
			: new MutationObserver(() => {
					observeChildren();
					measure();
				});
	mutations?.observe(rail, { childList: true });
	measure();
	return () => {
		observer.disconnect();
		mutations?.disconnect();
	};
});

// Collapsing again re-measures; expanding clears the count by construction.
$effect(() => {
	void collapsed;
	measure();
});
</script>

<div class="composer-chip-rail" class:composer-chip-rail--scroll={collapsed} data-testid={testId}>
	<ul
		bind:this={railElement}
		class="composer-chip-row"
		class:composer-chip-row--scroll={collapsed}
		aria-label={label}
		onscroll={measure}
	>
		{@render children()}
	</ul>
	{#if collapsed && hiddenCount > 0}
		<span class="composer-chip-rail__fade" aria-hidden="true"></span>
		<button
			type="button"
			class="composer-chip-rail__more"
			data-testid="composer-chip-row-more"
			aria-expanded={expanded}
			onclick={() => (expanded = true)}
		>
			{$t('composerChips.more', { count: hiddenCount })}
		</button>
	{:else if scrollOnPhone && expanded}
		<button
			type="button"
			class="composer-chip-rail__more composer-chip-rail__more--on"
			data-testid="composer-chip-row-more"
			aria-expanded={expanded}
			onclick={() => (expanded = false)}
		>
			{$t('composerChips.collapse')}
		</button>
	{/if}
	{#if counter}
		<span class="composer-chip-rail__counter">{@render counter()}</span>
	{/if}
</div>

<style lang="postcss">
	.composer-chip-rail {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.composer-chip-row {
		display: flex;
		flex: 1 1 auto;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 2px 6px 8px;
		list-style: none;
	}

	.composer-chip-row--scroll {
		flex-wrap: nowrap;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
		-webkit-overflow-scrolling: touch;
	}

	.composer-chip-row--scroll::-webkit-scrollbar {
		display: none;
	}

	/* A flex item shrinks by default, so in the nowrap rail every label
	   collapsed to a letter and an ellipsis instead of the rail scrolling —
	   and `measure()` above, comparing chips against the rail's right edge,
	   counted a squashed chip as hidden. The rail owns this rule (the items
	   arrive through a snippet, so the composer's own scoped CSS cannot see
	   this parent): each item keeps its own width — the pill caps itself at
	   280px — and the overflow is what scrolls. */
	.composer-chip-row--scroll > :global(*) {
		flex: 0 0 auto;
	}

	.composer-chip-rail__fade {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 8px;
		width: 72px;
		pointer-events: none;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%) 0%,
			color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%) 100%
		);
		mask-image: linear-gradient(90deg, transparent 0%, #000 78%);
		-webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 78%);
	}

	/* The `+N` disclosure. It pins outside the fade so it is always legible,
	   and keeps a 44px touch target without growing past the 28px pill. */
	.composer-chip-rail__more {
		position: absolute;
		top: 2px;
		right: 6px;
		display: inline-grid;
		place-items: center;
		height: 28px;
		min-width: 44px;
		padding: 0 10px;
		border: 1px dashed color-mix(in srgb, var(--text-muted) 34%, var(--border-default) 66%);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.composer-chip-rail__more--on {
		position: static;
		margin-bottom: 6px;
		border-style: solid;
		border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
		background: color-mix(in srgb, var(--text-muted) 14%, var(--surface-page) 86%);
		color: var(--text-primary);
	}

	.composer-chip-rail__more:hover {
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--text-muted) 14%, var(--surface-page) 86%);
		color: var(--text-primary);
	}

	.composer-chip-rail__more:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* The over-length counter, moved off the page margin (where it sat
	   outside the composer's border, next to nothing) into the chip row —
	   the one place the eye is already looking before it presses send. */
	.composer-chip-rail__counter {
		flex: 0 0 auto;
		margin-left: auto;
		padding-right: 4px;
		padding-bottom: 6px;
		white-space: nowrap;
	}
</style>
