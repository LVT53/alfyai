<script lang="ts">
/**
 * Conversation jump-rail (ADR-0043 Slice 17).
 *
 * A floating, vertically-centered vertical rail on the chat's left edge that
 * gives long-conversation navigation. It:
 *  - mounts only once there are ≥6 assistant turns,
 *  - renders one thin mark per turn (height encodes content length),
 *  - marks the active turn thicker + terracotta,
 *  - reveals a serif snippet of the assistant reply (with a muted, quoted
 *    user-question eyebrow) on hover, accompanied by a cursor-relative
 *    scale + color-sweep wave,
 *  - scrolls to a turn on click,
 *  - hides on the phone tier (reactively on resize),
 *  - honors prefers-reduced-motion (instant mount, no wave/breath).
 *
 * The rail is decorative-ish: the container carries an accessible name and the
 * individual marks are buttons so keyboard/screen-reader users can jump to a
 * turn. No new store — props come from MessageArea.
 */
import { t } from "$lib/i18n";
import { viewportStore } from "$lib/utils/viewport.svelte";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { buildJumpRailTurns, type JumpRailTurn } from "./jump-rail";
import { List, X } from "@lucide/svelte";
import { fade, fly } from "svelte/transition";

let {
	messages,
	scrollToMessage,
	activeTurnId = null,
}: {
	messages: ChatMessage[];
	scrollToMessage: (messageId: string) => void;
	/**
	 * Optional override for the active turn. When null (default) the rail
	 * treats the nearest-to-center assistant turn — or, before any scroll
	 * tracking is available, the last turn — as active. MessageArea may pass
	 * the turn id closest to the viewport center.
	 */
	activeTurnId?: string | null;
} = $props();

const turns = $derived(buildJumpRailTurns(messages));

// Default-active turn = the last assistant turn. Falls back to this when no
// explicit activeTurnId is supplied, which keeps a sensible highlight before
// the user scrolls and on initial mount (no scroll math needed).
const fallbackActiveId = $derived(
	turns.length > 0 ? turns[turns.length - 1].id : null,
);
const activeId = $derived(activeTurnId ?? fallbackActiveId);

// Phone tier hides the rail (reactive via viewportStore — updates on resize).
const isPhone = $derived(viewportStore.tier === "phone");

// Reduced-motion detection. The global app.css override collapses CSS
// animation durations, but the hover wave is JS-driven pointer math that the
// override cannot catch — so we read matchMedia explicitly and gate the wave.
let reducedMotion = $state(false);
$effect(() => {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		reducedMotion = false;
		return;
	}
	const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
	reducedMotion = mql.matches;
	const onChange = () => {
		reducedMotion = mql.matches;
	};
	mql.addEventListener("change", onChange);
	return () => mql.removeEventListener("change", onChange);
});

// Hover state: which mark is currently hovered (by turn id), plus the pointer's
// vertical position within the rail so the wave can originate from it.
let hoveredId = $state<string | null>(null);
let hoverY = $state<number | null>(null);

function handlePointerMove(event: PointerEvent, index: number) {
	if (reducedMotion) return; // skip the wave under reduced-motion
	hoverY = index;
	// mouseX is read for the color-sweep direction; cheap and ignored if null.
	void event;
}

function handleEnter(id: string, index: number) {
	hoveredId = id;
	if (!reducedMotion) hoverY = index;
}

function handleLeave() {
	hoveredId = null;
	hoverY = null;
}

// Per-mark height encodes content length somewhat (mockup varies 1.5/2px).
function markHeight(contentLength: number): "short" | "tall" {
	// Long replies get the slightly taller mark.
	return contentLength > 240 ? "tall" : "short";
}

// Distinct accessible name per mark so screen-reader users can tell turns
// apart when tabbing through the rail. Falls back to the reply snippet when
// there is no preceding user question.
function jumpMarkLabel(turn: JumpRailTurn): string {
	const label = turn.questionEyebrow ?? turn.snippet.slice(0, 60);
	return $t("chat.jumpRailMarkLabel", { label });
}

// Wave intensity for a mark given its distance from the hovered index.
// Decays with distance; 0 when there is no hover or under reduced-motion.
function waveScale(index: number): number {
	if (reducedMotion || hoverY === null) return 1;
	const distance = Math.abs(index - hoverY);
	if (distance > 3) return 1;
	// 0 → +0.5, 1 → +0.35, 2 → +0.2, 3 → +0.08
	const boost = [0.5, 0.35, 0.2, 0.08][distance] ?? 0;
	return 1 + boost;
}

// --- Mobile "jump to turn" affordance (C5, ADR-0043 O-6) ---
// The desktop wave-rail is hidden on the phone tier (no room for a floating
// left rail). In its place, phones get a compact floating button that opens a
// bottom sheet listing the same turns (reusing buildJumpRailTurns + the snippet
// text), tappable to scroll to a turn. Desktop is untouched.
let mobileSheetOpen = $state(false);

// Refs for focus management on the aria-modal sheet. The FAB is the trigger we
// return focus to on close; the sheet container is focused on open (it carries
// tabindex="-1") and scoped for the Tab trap.
let mobileFabRef = $state<HTMLButtonElement | null>(null);
let mobileSheetRef = $state<HTMLDivElement | null>(null);

function openMobileSheet() {
	mobileSheetOpen = true;
}

function closeMobileSheet() {
	mobileSheetOpen = false;
	// Return focus to the trigger FAB on every close path (Escape, backdrop
	// tap, the close button, or an entry tap) so focus is never left on the
	// now-removed dialog.
	mobileFabRef?.focus();
}

function jumpFromMobile(id: string) {
	scrollToMessage(id);
	closeMobileSheet();
}

// Focus-in on open: move focus INTO the dialog once the sheet mounts. Paired
// with the return-focus in closeMobileSheet, this is the aria-modal focus
// contract. Runs when the sheet opens and its element is bound.
$effect(() => {
	if (mobileSheetOpen && mobileSheetRef) {
		mobileSheetRef.focus();
	}
});

// Escape-to-close + Tab focus trap, active only while the sheet is open. The
// window binding is torn down when the component unmounts; the open guard makes
// it inert whenever the sheet is closed (so it can't hijack app-wide keys).
function handleSheetKeydown(event: KeyboardEvent) {
	if (!mobileSheetOpen) return;

	if (event.key === "Escape") {
		event.preventDefault();
		closeMobileSheet();
		return;
	}

	if (event.key === "Tab" && mobileSheetRef) {
		const focusables = mobileSheetRef.querySelectorAll<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (event.shiftKey) {
			// Wrap backward from the first focusable (or the container itself).
			if (active === first || active === mobileSheetRef) {
				last.focus();
				event.preventDefault();
			}
		} else if (active === last) {
			// Wrap forward from the last focusable.
			first.focus();
			event.preventDefault();
		}
	}
}
</script>

<svelte:window onkeydown={handleSheetKeydown} />

{#if turns.length >= 6}
	<nav
		data-testid="conversation-jump-rail"
		class="jr-rail"
		class:is-phone={isPhone}
		class:is-reduced={reducedMotion}
		aria-label={$t("chat.jumpRailA11yLabel")}
		aria-hidden={isPhone}
		onpointerleave={handleLeave}
	>
		{#each turns as turn, i (turn.id)}
			<div class="jr-mark-wrap">
				<button
					type="button"
					data-testid="jump-rail-mark"
					data-active={turn.id === activeId ? "" : undefined}
					class="jr-mark-hit"
					aria-label={jumpMarkLabel(turn)}
					tabindex={isPhone ? -1 : 0}
					onpointerenter={() => handleEnter(turn.id, i)}
					onpointermove={(e) => handlePointerMove(e, i)}
					onclick={() => scrollToMessage(turn.id)}
				></button>
				<span
					class="jr-mark"
					class:jr-mark--active={turn.id === activeId}
					class:jr-mark--short={markHeight(turn.contentLength) === "short"}
					class:jr-mark--tall={markHeight(turn.contentLength) === "tall"}
					style="--jr-scale: {waveScale(i)};"
					aria-hidden="true"
				></span>

				{#if hoveredId === turn.id}
					<div class="jr-snippet" role="tooltip">
						{#if turn.questionEyebrow}
							<div class="jr-snippet-eyebrow">{turn.questionEyebrow}</div>
						{/if}
						<div class="jr-snippet-body">{turn.snippet}</div>
					</div>
				{/if}
			</div>
		{/each}
	</nav>
{/if}

<!-- Mobile jump-to-turn affordance (C5): only on the phone tier, in place of
     the hidden desktop rail. A floating button opens a bottom sheet of turns. -->
{#if turns.length >= 6 && isPhone}
	<button
		type="button"
		data-testid="jump-rail-mobile-button"
		class="jr-mobile-fab"
		bind:this={mobileFabRef}
		aria-label={$t("chat.jumpRailMobileOpen")}
		aria-haspopup="dialog"
		aria-expanded={mobileSheetOpen}
		onclick={openMobileSheet}
	>
		<List size={20} strokeWidth={2} aria-hidden="true" />
	</button>

	{#if mobileSheetOpen}
		<div
			class="jr-mobile-backdrop"
			data-testid="jump-rail-mobile-backdrop"
			transition:fade={{ duration: reducedMotion ? 0 : 150 }}
			onclick={closeMobileSheet}
			role="presentation"
		></div>
		<div
			class="jr-mobile-sheet"
			data-testid="jump-rail-mobile-sheet"
			bind:this={mobileSheetRef}
			role="dialog"
			aria-modal="true"
			aria-label={$t("chat.jumpRailMobileTitle")}
			tabindex="-1"
			transition:fly={{
				y: reducedMotion ? 0 : 240,
				duration: reducedMotion ? 0 : 220,
			}}
		>
			<div class="jr-mobile-sheet-header">
				<span class="jr-mobile-sheet-title">{$t("chat.jumpRailMobileTitle")}</span>
				<button
					type="button"
					class="jr-mobile-sheet-close"
					aria-label={$t("common.close")}
					onclick={closeMobileSheet}
				>
					<X size={18} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
			<ul class="jr-mobile-list">
				{#each turns as turn (turn.id)}
					<li>
						<button
							type="button"
							data-testid="jump-rail-mobile-entry"
							class="jr-mobile-entry"
							class:jr-mobile-entry--active={turn.id === activeId}
							onclick={() => jumpFromMobile(turn.id)}
						>
							{#if turn.questionEyebrow}
								<span class="jr-mobile-entry-eyebrow">{turn.questionEyebrow}</span>
							{/if}
							<span class="jr-mobile-entry-body">{turn.snippet}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
{/if}

<style>
	.jr-rail {
		position: absolute;
		left: var(--space-md);
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 7px;
		padding: 10px 4px;
		z-index: 5;
		pointer-events: auto;
		/* Fade-in: 0.6s ease-out, 6px slide from the left. A short delay keeps
		   it from feeling laggy (the mockup's 1.2s is too slow in-product). */
		animation: jr-fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both;
	}

	/* Phone tier: hidden entirely (no floating-left collision on narrow
	   viewports). Reactive via viewportStore, so the rail appears/disappears
	   as the viewport crosses the phone/tablet boundary. */
	.jr-rail.is-phone {
		display: none;
	}

	/* Reduced-motion: instant mount. The global app.css override already
	   collapses animation durations, but we also gate the JS wave above; this
	   rule is belt-and-suspenders and stops the slide offset. */
	.jr-rail.is-reduced {
		animation: none;
	}

	.jr-mark-wrap {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* Invisible hit target, sized well beyond the visible mark and centered
	   on it via absolute positioning — so it doesn't add to the wrap's own
	   flex-layout height and can't shift the marks' spacing (the rendered
	   rail looks identical to before). It's this box, not the thin visible
	   bar, that owns the click/hover/pointer handling, and it overlaps into
	   the gap on either side so the pointer never lands in dead space
	   between two marks. */
	.jr-mark-hit {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 28px;
		height: 13px;
		border: none;
		padding: 0;
		margin: 0;
		background: transparent;
		cursor: pointer;
	}

	.jr-mark {
		width: 14px;
		border: none;
		padding: 0;
		margin: 0;
		border-radius: 1.5px;
		background: color-mix(in srgb, var(--text-primary) 16%, transparent);
		/* height encodes content length somewhat; kept thick enough to be an
		   easy mouse target (was 1.5–2px, too thin to reliably click). */
		pointer-events: none;
		transform: scaleX(var(--jr-scale, 1));
		transition: transform 0.18s ease-out, background-color 0.18s ease-out;
	}

	.jr-mark--short {
		height: 3px;
	}

	.jr-mark--tall {
		height: 4px;
	}

	/* Hover: the hovered mark scales up + shifts toward the accent color. This
	   is a hover affordance (state), kept in BOTH motion modes so a hovered
	   mark is always visibly highlighted. The scaleX stacks with the JS wave
	   boost (--jr-scale, 1 under reduced-motion), so under reduced-motion a
	   hovered mark still scales to 1.4 and snaps with no transition. The
	   cursor-relative WAVE (decay to nearby marks via JS) is gated separately
	   in script. The hit target (not the mark itself, which ignores pointer
	   events) is what actually receives :hover; it's the mark's preceding
	   sibling in markup, so the adjacent-sibling combinator reaches it. */
	.jr-mark-hit:hover + .jr-mark {
		background: color-mix(in srgb, var(--accent) 60%, var(--text-primary) 40%);
		transform: scaleX(calc(var(--jr-scale, 1) * 1.4));
	}

	.jr-rail.is-reduced .jr-mark {
		transition: none;
	}

	/* Active line: thicker (5px) + terracotta. This is STATE, not motion — it
	   stays colored/thicker under reduced-motion; only the breath pauses. */
	.jr-mark--active {
		width: 17px;
		height: 6px;
		background: var(--accent);
		animation: jr-breath 3s ease-in-out infinite;
	}

	.jr-rail.is-reduced .jr-mark--active {
		animation: none;
	}

	/* Hover snippet card: small, serif, with a muted quoted user-question
	   eyebrow. */
	.jr-snippet {
		position: absolute;
		left: 22px;
		top: 50%;
		transform: translateY(-50%);
		width: 200px;
		max-width: max-content;
		background: var(--surface-elevated, #f4f3ee);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		padding: var(--space-sm) 11px;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-primary);
		box-shadow: var(--shadow-md);
		line-height: 1.4;
		pointer-events: none;
		z-index: 10;
	}

	.jr-snippet-eyebrow {
		font-weight: 600;
		font-size: var(--text-2xs);
		color: var(--text-secondary);
		letter-spacing: 0.02em;
		margin-bottom: 3px;
	}

	.jr-snippet-body {
		font-family: var(--font-serif);
		color: var(--text-secondary);
	}

	@keyframes jr-fade-in {
		0% {
			opacity: 0;
			transform: translate(-6px, -50%);
		}
		100% {
			opacity: 1;
			transform: translate(0, -50%);
		}
	}

	@keyframes jr-breath {
		0%,
		100% {
			opacity: 0.85;
		}
		50% {
			opacity: 1;
		}
	}

	/* --- Mobile jump-to-turn affordance (C5) --- */
	.jr-mobile-fab {
		position: fixed;
		right: var(--space-md);
		bottom: calc(var(--space-md) + env(safe-area-inset-bottom, 0px) + 4.75rem);
		z-index: 40;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-elevated);
		color: var(--text-secondary);
		box-shadow: var(--shadow-md);
		cursor: pointer;
	}

	.jr-mobile-fab:active {
		background: var(--surface-page);
	}

	.jr-mobile-fab:focus-visible {
		outline: none;
		box-shadow:
			var(--shadow-md),
			0 0 0 2px var(--focus-ring);
	}

	.jr-mobile-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: color-mix(in srgb, var(--text-primary) 45%, transparent);
	}

	.jr-mobile-sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 51;
		display: flex;
		flex-direction: column;
		max-height: 70vh;
		padding: var(--space-sm) var(--space-md)
			calc(var(--space-md) + env(safe-area-inset-bottom, 0px));
		border-top-left-radius: var(--radius-lg, 1rem);
		border-top-right-radius: var(--radius-lg, 1rem);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-lg);
	}

	.jr-mobile-sheet-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-xs) 0 var(--space-sm);
	}

	.jr-mobile-sheet-title {
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.jr-mobile-sheet-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.jr-mobile-sheet-close:active {
		background: var(--surface-page);
	}

	.jr-mobile-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.jr-mobile-entry {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		min-height: 44px;
		padding: var(--space-sm) var(--space-xs);
		border: none;
		border-bottom: 1px solid var(--border-subtle, var(--border-default));
		background: transparent;
		text-align: left;
		cursor: pointer;
	}

	.jr-mobile-entry:active {
		background: var(--surface-page);
	}

	.jr-mobile-entry--active {
		box-shadow: inset 3px 0 0 var(--accent);
	}

	.jr-mobile-entry-eyebrow {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 600;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.jr-mobile-entry-body {
		font-family: var(--font-serif);
		font-size: var(--text-sm);
		color: var(--text-primary);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>
