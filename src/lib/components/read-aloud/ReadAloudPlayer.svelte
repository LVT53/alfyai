<script lang="ts">
/**
 * The floating player (spec §4.3), in the composer layer above the message box.
 * Its root is a slot that opens by animating `grid-template-rows` (0fr to 1fr),
 * so the layer's measured height grows with it and everything that follows that
 * height (the thread's clearance, the jump-to-latest button) moves too. The pill
 * rises 8 px and fades in; it sinks 6 px and fades out before its room closes.
 * It shows no text of the reply. While the command tray is open it is hushed:
 * invisible, keeping its room, and the reading goes on.
 *
 * A Document panel draws one too, at its foot (`placement="panel"`), for its own
 * Document's reading where no composer shows it: on a phone, where the panel
 * covers the chat, in an expanded panel, and on a page with no chat. It then
 * says so (`readAloudPlayerInPanel`) and the composer's player leaves that
 * reading to it. Leaving the chat stops a reading; a panel's player going does
 * not (the reading stops when the Document it reads is no longer drawn).
 */
import { onDestroy, tick, untrack } from "svelte";
import {
	getReadAloud,
	type ReadAloudController,
} from "$lib/client/read-aloud/controller";
import type { ReadingStatus } from "$lib/client/read-aloud/reading-machine";
import { t } from "$lib/i18n";
import { readAloudPlayerInPanel, readAloudView } from "$lib/stores/read-aloud";
import { MOTION_DURATION, prefersReducedMotion } from "$lib/utils/motion";
import ReadAloudNote from "./ReadAloudNote.svelte";
import ReadAloudPlayerPill from "./ReadAloudPlayerPill.svelte";

let {
	conversationId = null,
	hushed = false,
	placement = "composer",
	readingKey = null,
	controller = undefined,
}: {
	/** The chat above whose composer it sits: leaving it stops the reading. */
	conversationId?: string | null;
	hushed?: boolean;
	/** Above the chat's composer, or at a Document panel's foot. */
	placement?: "composer" | "panel";
	/** A panel's player: the key of the Document whose reading it shows. */
	readingKey?: string | null;
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
const inPanel = $derived(placement === "panel");
/** Whose reading this player shows: a panel, its Document's; the composer, any but a Document's its panel shows. */
const ours = $derived(
	inPanel
		? view.key !== null && view.key === readingKey
		: !(view.target === "document" && $readAloudPlayerInPanel),
);
const shown = $derived(SHOWN.has(view.status) && ours);

/**
 * What the pill shows: the reading's view, and while it leaves, the last view
 * it showed, so its controls never reset under its fade (the end keeps
 * "Finished" over the end's time; ✕ keeps the sentence it stopped at).
 */
let lastShown = untrack(() => $readAloudView);
const pillView = $derived.by(() => {
	if (shown) lastShown = view;
	return shown ? view : lastShown;
});

/**
 * `mounted`: the pill is in the page, from one drawn frame before its room
 * opens (so it rises and fades in from its own start) until its room has
 * closed (so the room closes around it and the thread follows it down).
 * `open`: its room is there. `leaving`: it sinks and fades before the room closes.
 */
let slot = $state<HTMLDivElement | null>(null);
let mounted = $state(false);
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

function openRoom() {
	open = true;
	settled = false;
	later(MOTION_DURATION.emphasis, () => (settled = true));
}

$effect(() => {
	if (shown) {
		untrack(() => {
			leaving = false;
			if (open) {
				// Shown again while it sank: it rises back where it is.
				if (!settled) later(MOTION_DURATION.emphasis, () => (settled = true));
				return;
			}
			if (mounted || prefersReducedMotion()) {
				// Its room was closing (or nothing moves): it opens again at once.
				mounted = true;
				openRoom();
				return;
			}
			mounted = true;
			// Its first frame is drawn closed (faded out, 8 px down): the style is
			// worked out here, so opening the room next is a change it animates.
			void tick().then(() => {
				if (!shown || open || !mounted) return;
				void slot?.offsetHeight;
				openRoom();
			});
		});
		return;
	}
	untrack(() => {
		if (!mounted || leaving) return;
		if (!open) {
			// Gone before its room opened: nothing was seen.
			if (!timer) mounted = false;
			return;
		}
		leaving = true;
		settled = false;
		later(MOTION_DURATION.standard, () => {
			leaving = false;
			open = false;
			later(MOTION_DURATION.emphasis, () => (mounted = false));
		});
	});
});

// Leaving the chat, or the composer's player going, stops the reading.
let previousConversation = untrack(() => conversationId);
$effect(() => {
	const current = conversationId;
	if (inPanel || current === previousConversation) return;
	previousConversation = current;
	untrack(() => reader().stop());
});

onDestroy(() => {
	if (timer) clearTimeout(timer);
	if (!inPanel) reader().stop();
});

const waiting = $derived(view.status === "waiting");
const stopped = $derived(view.status === "stopped");
</script>

<div
	bind:this={slot}
	class="read-aloud-slot"
	data-placement={placement}
	data-open={open ? "" : undefined}
	data-settled={settled ? "" : undefined}
	data-leaving={leaving ? "" : undefined}
	data-hushed={hushed && open ? "" : undefined}
>
	<div class="read-aloud-inner">
		{#if mounted}
			<div class="read-aloud-stage" inert={!open}>
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
				<ReadAloudPlayerPill variant="floating" view={pillView} actions={reader()} />
			</div>
		{/if}
	</div>
</div>

<style>
	/* The slot: a closed one takes no room (the negative margin cancels the shell's gap).
	   The margin moves with the room, so nothing above it jumps as it opens or closes. */
	.read-aloud-slot {
		display: grid;
		grid-template-rows: 0fr;
		margin-top: -0.75rem;
		transition:
			grid-template-rows var(--duration-emphasis) var(--ease-emphasis),
			margin-top var(--duration-emphasis) var(--ease-emphasis);
		pointer-events: none;
	}

	.read-aloud-slot[data-open] {
		grid-template-rows: 1fr;
		margin-top: 0;
		pointer-events: auto;
	}

	/* At a Document panel's foot: no composer shell's gap to cancel, and the pill
	   keeps the panel's edges and the phone's home bar clear while it is open. */
	.read-aloud-slot[data-placement="panel"] {
		margin-top: 0;
	}

	.read-aloud-slot[data-placement="panel"][data-open] .read-aloud-inner {
		padding: 0.5rem 0.75rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
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
