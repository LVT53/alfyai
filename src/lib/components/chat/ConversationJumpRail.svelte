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
import type { ChatMessage } from "$lib/types";
import { buildJumpRailTurns, type JumpRailTurn } from "./jump-rail";

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
</script>

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
					class="jr-mark"
					class:jr-mark--active={turn.id === activeId}
					class:jr-mark--short={markHeight(turn.contentLength) === "short"}
					class:jr-mark--tall={markHeight(turn.contentLength) === "tall"}
					style="--jr-scale: {waveScale(i)};"
					aria-label={jumpMarkLabel(turn)}
					tabindex={isPhone ? -1 : 0}
					onpointerenter={() => handleEnter(turn.id, i)}
					onpointermove={(e) => handlePointerMove(e, i)}
					onclick={() => scrollToMessage(turn.id)}
				></button>

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

	.jr-mark {
		width: 14px;
		border: none;
		padding: 0;
		margin: 0;
		border-radius: 1.5px;
		background: color-mix(in srgb, var(--text-primary) 16%, transparent);
		/* height encodes content length somewhat; kept thick enough to be an
		   easy mouse target (was 1.5–2px, too thin to reliably click). */
		cursor: pointer;
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
	   in script. */
	.jr-mark:hover {
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
</style>
