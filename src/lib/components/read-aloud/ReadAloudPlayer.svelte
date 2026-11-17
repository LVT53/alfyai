<script lang="ts">
/**
 * The floating player (spec §4.3), in the composer layer above the message box.
 * Its root is a slot that opens by animating `grid-template-rows` (0fr to 1fr),
 * so the layer's measured height grows with it and everything that follows that
 * height (the thread's clearance, the jump-to-latest button) moves too. The pill
 * rises 8 px and fades in; it sinks 6 px and fades out before its room closes.
 * It shows no text of the reply. While the command tray is open it is hushed:
 * invisible, keeping its room, and the reading goes on.
 */
import { onDestroy, untrack } from "svelte";
import {
	LocateFixed,
	Pause,
	Play,
	RotateCcw,
	SkipBack,
	SkipForward,
	X,
} from "@lucide/svelte";
import {
	getReadAloud,
	type ReadAloudController,
} from "$lib/client/read-aloud/controller";
import type { ReadingStatus } from "$lib/client/read-aloud/reading-machine";
import { t } from "$lib/i18n";
import { readAloudView } from "$lib/stores/read-aloud";
import { MOTION_DURATION, prefersReducedMotion } from "$lib/utils/motion";
import ReadAloudNote from "./ReadAloudNote.svelte";
import ReadAloudScrubber from "./ReadAloudScrubber.svelte";
import ReadAloudSpeedMenu from "./ReadAloudSpeedMenu.svelte";

let {
	conversationId,
	hushed,
	controller = undefined,
}: {
	conversationId: string;
	hushed: boolean;
	controller?: ReadAloudController;
} = $props();

const reader = () => controller ?? getReadAloud();

/** The states the player is shown in: the first start keeps it down while the speaker spins. */
const SHOWN: ReadonlySet<ReadingStatus> = new Set([
	"playing",
	"paused",
	"seeking",
	"waiting",
	"stopped",
	"finished",
]);

const view = $derived($readAloudView);
const shown = $derived(SHOWN.has(view.status));

/** The slot is open (its room is there); `leaving` while the pill sinks before the room closes. */
let open = $state(false);
let leaving = $state(false);
let settled = $state(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function later(ms: number, then: () => void) {
	if (timer) clearTimeout(timer);
	timer = null;
	if (prefersReducedMotion()) {
		then();
		return;
	}
	timer = setTimeout(() => {
		timer = null;
		then();
	}, ms);
}

$effect(() => {
	if (shown) {
		untrack(() => {
			leaving = false;
			if (open) return;
			open = true;
			settled = false;
			later(MOTION_DURATION.emphasis, () => (settled = true));
		});
		return;
	}
	untrack(() => {
		if (!open || leaving) return;
		leaving = true;
		settled = false;
		later(MOTION_DURATION.standard, () => {
			leaving = false;
			open = false;
		});
	});
});

// Leaving the chat, or the player going, stops the reading.
let previousConversation = untrack(() => conversationId);
$effect(() => {
	const current = conversationId;
	if (current === previousConversation) return;
	previousConversation = current;
	untrack(() => reader().stop());
});

onDestroy(() => {
	if (timer) clearTimeout(timer);
	reader().stop();
});

const waiting = $derived(view.status === "waiting");
const stopped = $derived(view.status === "stopped");
const spinning = $derived(
	view.status === "seeking" || view.status === "waiting",
);
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
	if (stopped) reader().retry();
	else if (!spinning) reader().toggle();
}
</script>

<div
	class="read-aloud-slot"
	data-open={open ? "" : undefined}
	data-settled={settled ? "" : undefined}
	data-leaving={leaving ? "" : undefined}
	data-hushed={hushed && open ? "" : undefined}
>
	<div class="read-aloud-inner">
		{#if open}
			<div class="read-aloud-stage">
				{#if stopped}
					<ReadAloudNote
						tone="warn"
						icon="alert"
						text={$t("readAloud.note.stopped")}
						actionLabel={$t("readAloud.tryAgain")}
						onAction={() => reader().retry()}
						placement="player"
					/>
				{:else if waiting && view.failure === "offline"}
					<ReadAloudNote tone="calm" icon="wifi" text={$t("readAloud.note.offline")} placement="player" />
				{:else if waiting}
					<ReadAloudNote tone="calm" icon="clock" text={$t("readAloud.note.updating")} placement="player" />
				{/if}
				<div
					class="read-aloud-pill"
					role="group"
					aria-label={$t("readAloud.player.label")}
					data-read-aloud-player
					data-failed={stopped ? "" : undefined}
					data-finished={view.status === "finished" ? "" : undefined}
				>
					<div class="read-aloud-transport">
						<button
							type="button"
							class="read-aloud-button"
							aria-label={$t("readAloud.player.previous")}
							disabled={waiting}
							onclick={() => reader().seek(view.sentence - 1)}
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
							disabled={waiting}
							onclick={() => reader().seek(view.sentence + 1)}
						>
							<SkipForward size={17} strokeWidth={2} aria-hidden="true" />
						</button>
					</div>
					<div class="read-aloud-timeline">
						<span class="read-aloud-time">{view.elapsed}</span>
						<ReadAloudScrubber
							notches={view.notches}
							progress={view.progress}
							sentence={view.sentence}
							count={view.count}
							disabled={waiting}
							preview={(i) => reader().sentencePreview(i)}
							onDragStart={() => reader().beginDrag()}
							onDragMove={(i) => reader().dragTo(i)}
							onDragEnd={(i) => reader().endDrag(i)}
							onStep={(i) => reader().seek(i)}
						/>
						<span class="read-aloud-time">{view.totalIsEstimate ? "≈" : ""}{view.total}</span>
					</div>
					<button
						type="button"
						class="read-aloud-button read-aloud-locate"
						aria-label={$t("readAloud.player.locate")}
						onclick={() => reader().locate()}
					>
						<LocateFixed size={17} strokeWidth={2} aria-hidden="true" />
					</button>
					<div class="read-aloud-speed-slot">
						<ReadAloudSpeedMenu speed={view.speed} onSelect={(value) => reader().setSpeed(value)} />
					</div>
					<button
						type="button"
						class="read-aloud-button read-aloud-stop"
						aria-label={$t("readAloud.player.stop")}
						onclick={() => reader().stop()}
					>
						<X size={17} strokeWidth={2} aria-hidden="true" />
					</button>
					<span class="read-aloud-finished" aria-hidden={view.status === "finished" ? "false" : "true"}
						>{$t("readAloud.player.finished")}</span
					>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	/* The slot: a closed one takes no room (the negative margin cancels the shell's gap). */
	.read-aloud-slot {
		display: grid;
		grid-template-rows: 0fr;
		margin-top: -0.75rem;
		transition: grid-template-rows var(--duration-emphasis) var(--ease-emphasis);
		pointer-events: none;
	}

	.read-aloud-slot[data-open] {
		grid-template-rows: 1fr;
		margin-top: 0;
		pointer-events: auto;
	}

	.read-aloud-slot[data-leaving] {
		grid-template-rows: 1fr;
	}

	.read-aloud-inner {
		min-height: 0;
		overflow: hidden;
		display: flex;
		justify-content: center;
		padding: 0 2px;
	}

	.read-aloud-slot[data-settled] .read-aloud-inner {
		overflow: visible;
	}

	.read-aloud-stage {
		position: relative;
		display: flex;
		justify-content: center;
		width: min(620px, 100%);
	}

	.read-aloud-pill {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		margin: 2px 0 0;
		padding: 6px 10px;
		border: 1px solid var(--border-default);
		border-radius: 28px;
		background: var(--surface-elevated);
		box-shadow: var(--shadow-md);
		opacity: 0;
		transform: translateY(8px);
		transition:
			opacity var(--duration-emphasis) var(--ease-emphasis),
			transform var(--duration-emphasis) var(--ease-emphasis),
			border-color var(--duration-standard) var(--ease-out);
	}

	.read-aloud-slot[data-open] .read-aloud-pill {
		opacity: 1;
		transform: none;
	}

	.read-aloud-slot[data-leaving] .read-aloud-pill {
		opacity: 0;
		transform: translateY(6px);
		transition:
			opacity var(--duration-standard) var(--ease-in),
			transform var(--duration-standard) var(--ease-in);
	}

	.read-aloud-slot[data-hushed] .read-aloud-stage {
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--duration-micro) var(--ease-out);
	}

	.read-aloud-stage {
		transition: opacity var(--duration-micro) var(--ease-out);
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

	/* The phone: the scrubber row on top, then the speed chip, ⏮ ▶ ⏭ in the middle, ⌖ ✕. */
	@media (max-width: 767px) {
		.read-aloud-pill {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
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
	}
</style>
