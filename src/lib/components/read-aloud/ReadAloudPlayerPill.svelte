<script lang="ts">
/**
 * The player's pill (spec §4.3): ⏮ ▶ ⏭, the elapsed time, the sentence scrubber
 * and the total. The floating player above the composer draws it with ⌖, the
 * speed chip, ✕ and its "Finished" (`variant="floating"`); the voice editor draws
 * it in its Listen section with none of those (`variant="inline"`, Plan 3's
 * Decision 2): there is nothing to find, a playback speed beside Pace would blur
 * what is being judged, and the dialog has its own ✕.
 *
 * It owns no state: what it shows is the view, and what it does goes to its
 * actions (the reply controller, or the voice preview).
 */
import {
	LocateFixed,
	Pause,
	Play,
	RotateCcw,
	SkipBack,
	SkipForward,
	X,
} from "@lucide/svelte";
import type { ReadAloudPlayerActions } from "$lib/client/read-aloud/controller";
import { t } from "$lib/i18n";
import type { ReadAloudView } from "$lib/stores/read-aloud";
import ReadAloudScrubber from "./ReadAloudScrubber.svelte";
import ReadAloudSpeedMenu from "./ReadAloudSpeedMenu.svelte";

let {
	view,
	actions,
	variant,
}: {
	view: ReadAloudView;
	actions: ReadAloudPlayerActions;
	variant: "floating" | "inline";
} = $props();

const floating = $derived(variant === "floating");
const waiting = $derived(view.status === "waiting");
const stopped = $derived(view.status === "stopped");
const spinning = $derived(
	view.status === "seeking" || view.status === "waiting",
);
/** Nothing to step through: a reading waiting to continue, or a pill with no sentences. */
const stepless = $derived(waiting || view.count === 0);
const playLabel = $derived(
	stopped
		? $t("readAloud.tryAgain")
		: spinning
			? $t("readAloud.player.waiting")
			: view.status === "playing"
				? $t("readAloud.player.pause")
				: $t("readAloud.player.play"),
);

function onPlay() {
	if (stopped) actions.retry();
	else if (!spinning) actions.toggle();
}

/** The phone's two rows: the breakpoint of the CSS below. */
const NARROW_QUERY = "(max-width: 767px)";
const narrowQuery = () =>
	typeof window !== "undefined" && typeof window.matchMedia === "function"
		? window.matchMedia(NARROW_QUERY)
		: null;
let narrow = $state(narrowQuery()?.matches === true);
$effect(() => {
	const query = narrowQuery();
	if (!query || typeof query.addEventListener !== "function") return;
	const update = () => {
		narrow = query.matches;
	};
	update();
	query.addEventListener("change", update);
	return () => query.removeEventListener("change", update);
});
</script>

{#snippet transport()}
	<div class="read-aloud-transport">
		<button
			type="button"
			class="read-aloud-button"
			aria-label={$t("readAloud.player.previous")}
			disabled={stepless}
			onclick={() => actions.seek(view.sentence - 1)}
		>
			<SkipBack size={17} strokeWidth={2} aria-hidden="true" />
		</button>
		<button type="button" class="read-aloud-button read-aloud-play" aria-label={playLabel} onclick={onPlay}>
			{#if stopped}
				<RotateCcw size={17} strokeWidth={2} aria-hidden="true" />
			{:else if spinning}
				<span class="mini-spinner" aria-hidden="true"></span>
			{:else if view.status === "playing"}
				<Pause size={17} strokeWidth={2} aria-hidden="true" />
			{:else}
				<Play size={17} strokeWidth={2} aria-hidden="true" />
			{/if}
		</button>
		<button
			type="button"
			class="read-aloud-button"
			aria-label={$t("readAloud.player.next")}
			disabled={stepless}
			onclick={() => actions.seek(view.sentence + 1)}
		>
			<SkipForward size={17} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
{/snippet}

{#snippet timeline()}
	<div class="read-aloud-timeline">
		<span class="read-aloud-time">{view.elapsed}</span>
		<ReadAloudScrubber
			notches={view.notches}
			progress={view.progress}
			sentence={view.sentence}
			count={view.count}
			disabled={stepless}
			preview={(i) => actions.sentencePreview(i)}
			onDragStart={() => actions.beginDrag()}
			onDragMove={(i) => actions.dragTo(i)}
			onDragEnd={(i) => actions.endDrag(i)}
			onStep={(i) => actions.seek(i)}
		/>
		<!-- The "≈" keeps its place once the total is exact, so nothing moves when it goes. -->
		<span class="read-aloud-time"
			><span class="read-aloud-approx" class:exact={!view.totalIsEstimate} aria-hidden={view.totalIsEstimate ? undefined : "true"}
				>≈</span
			>{view.total}</span
		>
	</div>
{/snippet}

{#snippet locate()}
	<button
		type="button"
		class="read-aloud-button read-aloud-locate"
		aria-label={$t("readAloud.player.locate")}
		onclick={() => actions.locate?.()}
	>
		<LocateFixed size={17} strokeWidth={2} aria-hidden="true" />
	</button>
{/snippet}

{#snippet speedChip()}
	<div class="read-aloud-speed-slot">
		<ReadAloudSpeedMenu speed={view.speed} onSelect={(value) => actions.setSpeed?.(value)} />
	</div>
{/snippet}

{#snippet stop()}
	<button
		type="button"
		class="read-aloud-button read-aloud-stop"
		aria-label={$t("readAloud.player.stop")}
		onclick={() => actions.stop?.()}
	>
		<X size={17} strokeWidth={2} aria-hidden="true" />
	</button>
{/snippet}

<div
	class="read-aloud-pill"
	role="group"
	aria-label={$t("readAloud.player.label")}
	data-read-aloud-player
	data-variant={variant}
	data-failed={stopped ? "" : undefined}
	data-finished={floating && view.status === "finished" ? "" : undefined}
>
	<!-- The controls come in the order they are drawn, so Tab follows the layout
	     (WCAG 2.4.3): one row on a desktop, two on a phone (the CSS below). -->
	{#if narrow}
		{@render timeline()}
		{#if floating}{@render speedChip()}{/if}
		{@render transport()}
		{#if floating}{@render locate()}{@render stop()}{/if}
	{:else}
		{@render transport()}
		{@render timeline()}
		{#if floating}{@render locate()}{@render speedChip()}{@render stop()}{/if}
	{/if}
	{#if floating}
		<span class="read-aloud-finished" aria-hidden={view.status === "finished" ? "false" : "true"}
			>{$t("readAloud.player.finished")}</span
		>
	{/if}
</div>

<style>
	.read-aloud-pill {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		border: 1px solid var(--border-default);
		border-radius: 28px;
		background: var(--surface-elevated);
		transition: border-color var(--duration-standard) var(--ease-out);
	}

	/* The floating pill rises and fades in with its slot (ReadAloudPlayer.svelte opens it). */
	.read-aloud-pill[data-variant="floating"] {
		margin: 2px 0 0;
		box-shadow: var(--shadow-md);
		opacity: 0;
		transform: translateY(8px);
		transition:
			opacity var(--duration-emphasis) var(--ease-emphasis),
			transform var(--duration-emphasis) var(--ease-emphasis),
			border-color var(--duration-standard) var(--ease-out);
	}

	.read-aloud-pill[data-failed] {
		border-color: color-mix(in srgb, var(--warning) 35%, var(--border-subtle));
	}

	.read-aloud-transport,
	.read-aloud-timeline {
		display: flex;
		align-items: center;
	}

	.read-aloud-transport {
		gap: 6px;
		flex: none;
	}

	.read-aloud-timeline {
		flex: 1;
		min-width: 0;
		gap: 10px;
		padding: 0 6px;
	}

	.read-aloud-time {
		flex: none;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.read-aloud-approx.exact {
		visibility: hidden;
	}

	.read-aloud-speed-slot {
		display: flex;
		flex: none;
	}

	.read-aloud-button {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.read-aloud-button:hover:not(:disabled) {
		background: var(--surface-page);
		color: var(--icon-primary);
	}

	.read-aloud-button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.read-aloud-button:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	.read-aloud-play {
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--accent);
	}

	.read-aloud-play:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		color: var(--accent);
	}

	.read-aloud-pill[data-failed] .read-aloud-play {
		background: var(--warning-tint);
		color: var(--warning-text);
	}

	.read-aloud-finished {
		position: absolute;
		inset: 0;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: inherit;
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 13px;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.read-aloud-pill[data-finished] .read-aloud-finished {
		opacity: 1;
	}

	/* The phone: the scrubber row on top, then the speed chip, ⏮ ▶ ⏭ in the middle, ⌖ ✕.
	   A side column is never narrower than its buttons (⌖'s margin is ✕'s room), so on
	   a narrow phone ⏮ ▶ ⏭ moves off the middle instead of under ⌖. */
	@media (max-width: 767px) {
		.read-aloud-pill {
			display: grid;
			grid-template-columns: 1fr auto 1fr;
			/* No gaps between the columns, as in the prototype: at 360 px the row fits. */
			column-gap: 0;
			row-gap: 4px;
			padding: 8px 12px;
			border-radius: 24px;
		}

		.read-aloud-timeline {
			grid-column: 1 / -1;
			grid-row: 1;
			padding: 0 2px;
		}

		.read-aloud-speed-slot {
			grid-column: 1;
			grid-row: 2;
			justify-self: start;
		}

		.read-aloud-transport {
			grid-column: 2;
			grid-row: 2;
			gap: 8px;
		}

		.read-aloud-locate {
			grid-column: 3;
			grid-row: 2;
			justify-self: end;
			margin-right: 48px;
		}

		.read-aloud-stop {
			grid-column: 3;
			grid-row: 2;
			justify-self: end;
		}

		.read-aloud-button {
			width: 44px;
			height: 44px;
		}

		.read-aloud-play {
			width: 52px;
			height: 52px;
		}

		.read-aloud-play :global(svg) {
			width: 20px;
			height: 20px;
		}
	}

	/* Below 360 px the row would not fit at 44 px: 40 px buttons, a 48 px play and
	   tighter gaps, so ✕ stays on the screen at 320 px. */
	@media (max-width: 359px) {
		.read-aloud-pill {
			padding: 8px;
		}

		.read-aloud-transport {
			gap: 4px;
		}

		.read-aloud-button {
			width: 40px;
			height: 40px;
		}

		.read-aloud-play {
			width: 48px;
			height: 48px;
		}

		.read-aloud-locate {
			margin-right: 42px;
		}

		.read-aloud-speed-slot :global(.read-aloud-speed-chip) {
			min-width: 48px;
			padding: 0 8px;
		}
	}
</style>
