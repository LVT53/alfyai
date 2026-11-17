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
	getReadAloud,
	type ReadAloudController,
} from "$lib/client/read-aloud/controller";
import type { ReadingStatus } from "$lib/client/read-aloud/reading-machine";
import { t } from "$lib/i18n";
import { readAloudView } from "$lib/stores/read-aloud";
import { MOTION_DURATION, prefersReducedMotion } from "$lib/utils/motion";
import ReadAloudNote from "./ReadAloudNote.svelte";
import ReadAloudPlayerPill from "./ReadAloudPlayerPill.svelte";

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
				<ReadAloudPlayerPill variant="floating" {view} actions={reader()} />
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

	/* The pill (ReadAloudPlayerPill.svelte) rises 8 px and fades in with the slot; it sinks 6 px and fades out first. */
	.read-aloud-slot[data-open] :global(.read-aloud-pill) {
		opacity: 1;
		transform: none;
	}

	.read-aloud-slot[data-leaving] :global(.read-aloud-pill) {
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
</style>
