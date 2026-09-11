<script lang="ts">
/**
 * The three Try suggestions as chips, on their own row directly under the
 * composer box.
 *
 * This is the owner's one change to HomeV4A: the board put the rail inside the
 * composer's footer, sharing one 780px line with attach/accounts/thinking/send,
 * and its own trade-off note called that out — "suggestions competing with the
 * composer's own controls", 33px of slack, a mis-click between turning thinking
 * on and picking a suggestion. The mobile board's closing line reached the same
 * conclusion from the other side: "A's arrangement with B's composer: chips on
 * their own row under the box, not in it." That is what this is. The footer row
 * keeps only the composer's controls.
 *
 * Everything else is the board's: an icon and a short label per chip, the
 * account behind it on hover rather than on the row, a dashed "another" chip
 * pinned outside the scroller at the right so the one control you need when the
 * suggestions are wrong can never scroll out of reach, and a fade at the
 * scroller's right edge saying there is more.
 */
import {
	Atom,
	Brain,
	Calendar,
	CloudUpload,
	Mail,
	MessageSquare,
	RefreshCw,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { HomeSuggestion } from "$lib/client/api/home";

let {
	suggestions = [],
	disabled = false,
	onPick,
}: {
	suggestions?: HomeSuggestion[];
	disabled?: boolean;
	onPick?: (suggestion: HomeSuggestion) => void;
} = $props();

const VISIBLE = 3;

const ICONS = {
	calendar: Calendar,
	files: CloudUpload,
	email: Mail,
	memory: Brain,
	conversation: MessageSquare,
	atlas: Atom,
} as const;

let offset = $state(0);
let trackElement = $state<HTMLDivElement | null>(null);
let fadeVisible = $state(false);

// The fade is drawn only when there is genuinely something past the right edge
// — measured rather than assumed, so one short chip on a phone does not get a
// shadow over nothing, and a third chip pushed out by a long translation on the
// desktop does.
function measureOverflow() {
	const track = trackElement;
	if (!track) {
		fadeVisible = false;
		return;
	}
	const remaining = track.scrollWidth - track.clientWidth - track.scrollLeft;
	fadeVisible = remaining > 2;
}

$effect(() => {
	// Re-measure whenever the rendered chips change.
	void visible;
	const track = trackElement;
	if (!track || typeof ResizeObserver === "undefined") return;
	measureOverflow();
	const observer = new ResizeObserver(() => measureOverflow());
	observer.observe(track);
	return () => observer.disconnect();
});

// The pool can shrink under a rotation (a chip was used, or the summary
// refreshed with fewer candidates); an offset past its end would empty the rail
// rather than wrap it.
const visible = $derived.by(() => {
	if (suggestions.length === 0) return [];
	const start = offset % suggestions.length;
	const window: HomeSuggestion[] = [];
	for (let i = 0; i < Math.min(VISIBLE, suggestions.length); i += 1) {
		const item = suggestions[(start + i) % suggestions.length];
		if (item) window.push(item);
	}
	return window;
});

// "another" deals the next three and wraps. It rotates rather than re-rolls,
// so it is a promise the rail can always keep: with four candidates it still
// advances, and with three it says so by not appearing at all.
const canRotate = $derived(suggestions.length > VISIBLE);

function rotate() {
	if (!canRotate) return;
	offset = (offset + VISIBLE) % suggestions.length;
}
</script>

{#if visible.length > 0}
	<div
		class="home-rail"
		role="group"
		aria-label={$t('home.suggestionsLabel')}
		data-testid="home-suggestion-rail"
	>
		<div class="home-rail-scroller">
			<div
				class="home-rail-track"
				bind:this={trackElement}
				onscroll={measureOverflow}
			>
				{#each visible as suggestion (suggestion.key)}
					{@const Icon = ICONS[suggestion.kind] ?? MessageSquare}
					<button
						type="button"
						class="home-chip"
						{disabled}
						title={$t('home.suggestionSource', { source: suggestion.source })}
						onclick={() => onPick?.(suggestion)}
						data-testid="home-suggestion-chip"
						data-candidate-key={suggestion.key}
						data-source={suggestion.source}
					>
						<span class="home-chip-glyph"><Icon size={12} strokeWidth={1.75} /></span>
						<span class="home-chip-label">{suggestion.label}</span>
					</button>
				{/each}
			</div>
			<span
				class="home-rail-fade"
				class:visible={fadeVisible}
				aria-hidden="true"
			></span>
		</div>
		{#if canRotate}
			<button
				type="button"
				class="home-chip home-chip-ghost"
				{disabled}
				onclick={rotate}
				aria-label={$t('home.anotherLabel')}
				data-testid="home-suggestion-another"
			>
				<span class="home-chip-glyph"><RefreshCw size={11} strokeWidth={1.75} /></span>
				<span class="home-chip-label">{$t('home.another')}</span>
			</button>
		{/if}
	</div>
{/if}

<style>
	.home-rail {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		margin-top: 10px;
		padding: 0 2px;
	}

	.home-rail-scroller {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
	}

	.home-rail-track {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		padding: 3px 0;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
		-ms-overflow-style: none;
		scroll-snap-type: x proximity;
	}

	.home-rail-track::-webkit-scrollbar {
		display: none;
	}

	/* The fade says there is more to the right. It sits on the page ground
	   because the rail is no longer inside the composer's elevated surface. */
	.home-rail-fade {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: 34px;
		pointer-events: none;
		background: linear-gradient(
			to right,
			transparent,
			var(--surface-page) 76%
		);
		opacity: 0;
		transition: opacity 160ms ease;
	}

	.home-rail-fade.visible {
		opacity: 1;
	}

	.home-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 10px;
		border-radius: 9999px;
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-primary);
		font-size: 0.72rem;
		line-height: 1;
		white-space: nowrap;
		flex-shrink: 0;
		scroll-snap-align: start;
		cursor: pointer;
		transition:
			background-color 140ms ease,
			border-color 140ms ease,
			color 140ms ease;
	}

	.home-chip:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page));
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border-default));
	}

	.home-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.home-chip:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.home-chip-ghost {
		border-style: dashed;
		color: var(--text-muted);
		padding: 0 9px;
		flex-shrink: 0;
	}

	.home-chip-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.home-chip:hover:not(:disabled) .home-chip-glyph {
		color: var(--accent);
	}

	.home-chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 22ch;
	}

	/* At 390px the rail always scrolls, and every chip keeps a 44px hit area
	   around its 30px face — the same rule every phone board in this wave
	   follows. The pseudo-element grows the target without growing the ink. */
	@media (max-width: 767px) {
		.home-chip {
			height: 30px;
			position: relative;
		}

		.home-chip::after {
			content: '';
			position: absolute;
			inset: -7px;
			border-radius: 9999px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.home-chip,
		.home-rail-fade {
			transition: none;
		}
	}
</style>
