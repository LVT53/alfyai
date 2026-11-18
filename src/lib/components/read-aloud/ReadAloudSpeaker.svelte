<script lang="ts">
/**
 * The speaker in a finished reply's action row, or in the panel's header over a
 * Document or a standard report (spec §4.1, §4.8, §4.12): it starts and pauses the
 * reading of its reply, Document or report,
 * shows its progress as a ring, and says why it cannot read (a language with no
 * voice, nothing readable) or that the voice is busy or did not answer. It reads
 * `readAloudView` and calls the controller; the press calls `start`
 * synchronously, so the iOS unlock stays in the gesture. In a header its notes
 * open below it (there is no room above) and it names itself with a title, as
 * the header's other buttons do.
 */
import { untrack } from "svelte";
import { Pause, Play, Volume2, VolumeX } from "@lucide/svelte";
import {
	getReadAloud,
	type ReadAloudController,
	type Readability,
	type ReadingTarget,
	readingKey,
} from "$lib/client/read-aloud/controller";
import { languageDisplayName } from "$lib/client/read-aloud/language";
import { t } from "$lib/i18n";
import { readAloudView } from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudNote from "./ReadAloudNote.svelte";

let {
	target,
	contentKey,
	onPinnedChange = undefined,
	placement = "reply",
	controller = undefined,
}: {
	/** The reply or the Document this speaker reads. */
	target: ReadingTarget;
	/** Changes when the words change: readability is asked again. */
	contentKey: string | number;
	/** The reply's action row stays shown while this says so. */
	onPinnedChange?: (pinned: boolean) => void;
	/** A reply's action row (notes above, the row's tooltip), or a panel's header (notes below, a title). */
	placement?: "reply" | "header";
	controller?: ReadAloudController;
} = $props();

const RING_LENGTH = 72.26;
const CANT_START_NOTE_MS = 8000;
const UNKNOWN_RETRY_MS = 300;
const UNKNOWN_RETRIES = 20;

const reader = () => controller ?? getReadAloud();

let wrapper = $state<HTMLDivElement | null>(null);
let button = $state<HTMLButtonElement | null>(null);
let readability = $state<Readability>({ kind: "unknown" });
let seen = $state(false);
let hovered = $state(false);
let focused = $state(false);
let tapped = $state(false);
let cantStartOpen = $state(false);

const view = $derived($readAloudView);
const header = $derived(placement === "header");
const mine = $derived(
	view.key === readingKey(target) && view.status !== "idle",
);
const status = $derived(mine ? view.status : "idle");
const dimmed = $derived(
	!mine && (readability.kind === "noVoice" || readability.kind === "nothing"),
);
/** Getting the voice (spec §4.1): a first start, a switch to this reply or a jump inside its reading. */
const spinning = $derived(status === "opening" || status === "seeking");
/** Paused, or waiting to go on by itself, or stopped: ▶ resumes it. */
const resumable = $derived(
	status === "paused" || status === "waiting" || status === "stopped",
);
/**
 * The ring shows once this reply's audio has come, and fills at the end while
 * "Finished" shows (spec §4.3). A jump inside its reading keeps the ring while
 * it spins; a switch to it spins without one, as a start does. `ringBefore` is
 * what the ring was before the voice was asked for.
 */
let ringBefore = false;
const ringed = $derived.by(() => {
	if (status === "seeking") return ringBefore;
	ringBefore = status === "playing" || status === "finished" || resumable;
	return ringBefore;
});
const label = $derived(
	status === "playing"
		? $t("readAloud.speaker.pause")
		: resumable
			? $t("readAloud.speaker.resume")
			: $t("readAloud.speaker.read"),
);
const busyNote = $derived(mine && status === "opening" && view.busy);
const dimNoteText = $derived.by(() => {
	if (readability.kind === "nothing")
		return target.kind === "document"
			? $t("readAloud.note.nothingDocument")
			: target.kind === "report"
				? $t("readAloud.note.nothingReport")
				: $t("readAloud.note.nothing");
	if (readability.kind !== "noVoice") return "";
	const name = readability.language
		? languageDisplayName(readability.language, $uiLanguage)
		: null;
	return name
		? $t("readAloud.note.noVoice", { language: name })
		: $t("readAloud.note.noVoiceUnknown");
});
const dimNote = $derived(dimmed && (hovered || focused || tapped));
const pinned = $derived(mine || busyNote || cantStartOpen || dimNote);
/** Its label as a tooltip, as its neighbours in the row have, while no note says more. */
const tooltip = $derived(!header && !busyNote && !cantStartOpen && !dimNote);
const notePlacement = $derived(header ? "header" : "speaker");

$effect(() => {
	const value = pinned;
	untrack(() => onPinnedChange?.(value));
});

// Readability is asked once the speaker is first seen, in an idle moment, and again
// whenever the reply's words change: Markdown renders asynchronously, so an early
// "unknown" never dims the speaker by mistake.
$effect(() => {
	const target = button;
	if (!target || seen) return;
	if (typeof IntersectionObserver === "undefined") {
		seen = true;
		return;
	}
	const observer = new IntersectionObserver((entries) => {
		if (entries.some((entry) => entry.isIntersecting)) {
			seen = true;
			observer.disconnect();
		}
	});
	observer.observe(target);
	return () => observer.disconnect();
});

$effect(() => {
	if (!seen) return;
	contentKey;
	const current = target;
	let cancelled = false;
	let retry: number | null = null;
	let attempts = 0;
	// The reply's Markdown renders asynchronously: while it has not, the answer is
	// "unknown", so ask again a little later (for about six seconds).
	const assess = () => {
		void reader()
			.assessReadability(current)
			.then((result) => {
				if (cancelled) return;
				readability = result;
				attempts += 1;
				if (result.kind === "unknown" && attempts < UNKNOWN_RETRIES) {
					retry = window.setTimeout(assess, UNKNOWN_RETRY_MS);
				}
			});
	};
	const idle = typeof requestIdleCallback === "function";
	const handle = idle
		? requestIdleCallback(assess, { timeout: 1500 })
		: window.setTimeout(assess, 1);
	return () => {
		cancelled = true;
		if (idle) cancelIdleCallback(handle);
		else window.clearTimeout(handle);
		if (retry !== null) window.clearTimeout(retry);
	};
});

// The can't-start note opens when this reply's start fails, and closes on ✕, on a
// click elsewhere or after 8 s; the speaker itself settles after 3 s (the machine).
let lastStatus: string = "idle";
$effect(() => {
	const current = status;
	if (current === "startFailed" && lastStatus !== "startFailed")
		cantStartOpen = true;
	lastStatus = current;
});

$effect(() => {
	if (!cantStartOpen) return;
	const timer = window.setTimeout(() => {
		cantStartOpen = false;
	}, CANT_START_NOTE_MS);
	return () => window.clearTimeout(timer);
});

$effect(() => {
	if (!cantStartOpen && !tapped) return;
	const onPointerDown = (event: PointerEvent) => {
		if (
			wrapper &&
			event.target instanceof Node &&
			wrapper.contains(event.target)
		)
			return;
		cantStartOpen = false;
		tapped = false;
	};
	document.addEventListener("pointerdown", onPointerDown, true);
	return () => document.removeEventListener("pointerdown", onPointerDown, true);
});

function press() {
	if (dimmed) {
		if (window.matchMedia?.("(pointer: coarse)").matches) tapped = !tapped;
		return;
	}
	cantStartOpen = false;
	reader().start(target);
}

function tryAgain() {
	cantStartOpen = false;
	reader().start(target);
}
</script>

<div class="read-aloud-speaker-wrap" data-placement={placement} bind:this={wrapper}>
	<!-- The button and its tooltip, which sits outside it: the row's hover fades the
	     button (opacity 0.78), and a child cannot undo its parent's opacity. -->
	<span class="read-aloud-speaker-anchor">
	<button
		bind:this={button}
		type="button"
		class="btn-icon-bare read-aloud-speaker"
		class:action-icon-btn={!header}
		class:dimmed
		class:failed={status === "startFailed"}
		aria-label={label}
		title={header ? label : undefined}
		aria-busy={spinning ? "true" : undefined}
		aria-disabled={dimmed ? "true" : undefined}
		data-testid={header ? "read-aloud-speaker-header" : "read-aloud-speaker"}
		onclick={press}
		onpointerenter={() => (hovered = true)}
		onpointerleave={() => (hovered = false)}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
	>
		{#if ringed}
			<svg class="read-aloud-ring" viewBox="0 0 26 26" aria-hidden="true">
				<circle class="read-aloud-ring-track" cx="13" cy="13" r="11.5" fill="none" stroke-width="1.6" />
				<circle
					class="read-aloud-ring-progress"
					cx="13"
					cy="13"
					r="11.5"
					fill="none"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-dasharray={String(RING_LENGTH)}
					stroke-dashoffset={String(RING_LENGTH * (1 - Math.min(1, Math.max(0, view.progress))))}
				/>
			</svg>
		{/if}
		{#if spinning}
			<span class="mini-spinner" aria-hidden="true"></span>
		{:else if status === "playing"}
			<Pause size={header ? 14 : 12} strokeWidth={2.5} aria-hidden="true" />
		{:else if resumable}
			<Play size={header ? 14 : 12} strokeWidth={2.5} aria-hidden="true" />
		{:else if status === "startFailed"}
			<VolumeX size={header ? 18 : 15} strokeWidth={2} aria-hidden="true" />
		{:else}
			<Volume2 size={header ? 18 : 15} strokeWidth={2} aria-hidden="true" />
		{/if}
	</button>
	{#if tooltip}
		<!-- The button's name says it already: this is for the eye. -->
		<span class="read-aloud-speaker-tooltip" aria-hidden="true">{label}</span>
	{/if}
	</span>
	{#if busyNote}
		<ReadAloudNote tone="calm" icon="clock" text={$t("readAloud.note.busy")} placement={notePlacement} />
	{:else if cantStartOpen}
		<ReadAloudNote
			tone="warn"
			icon="alert"
			text={$t("readAloud.note.cantStart")}
			actionLabel={$t("readAloud.tryAgain")}
			onAction={tryAgain}
			onDismiss={() => (cantStartOpen = false)}
			placement={notePlacement}
		/>
	{:else if dimNote}
		<ReadAloudNote tone="calm" icon="alert" text={dimNoteText} placement={notePlacement} />
	{/if}
</div>

<style>
	/* Not positioned: the speaker's notes anchor to the action row around it, whose left
	   edge keeps them on a phone's screen (the speaker is the row's last button). */
	.read-aloud-speaker-wrap {
		display: inline-flex;
	}

	/* In a header the notes open below the speaker, from its right edge: it is positioned. */
	.read-aloud-speaker-wrap[data-placement="header"] {
		position: relative;
	}

	/* A header's button is the size of its neighbours: the ring grows with it. */
	.read-aloud-speaker-wrap[data-placement="header"] .read-aloud-ring {
		width: 30px;
		height: 30px;
		margin: -15px 0 0 -15px;
	}

	.read-aloud-speaker {
		position: relative;
	}

	.read-aloud-speaker.dimmed {
		opacity: 0.38;
		cursor: default;
	}

	/* Dimmed, it takes no hover or tap fill. Through its wrapper, so it outweighs the
	   row's own hover rule (`.copy-action-row .action-icon-btn:hover`, as specific
	   as `.read-aloud-speaker.dimmed:hover` and later in the page). */
	.read-aloud-speaker-wrap .read-aloud-speaker.dimmed:hover {
		background-color: transparent;
		color: var(--icon-muted);
	}

	.read-aloud-speaker.failed {
		color: var(--warning-text);
	}

	/* The row's tooltips (MessageBubble's `.action-tooltip`), drawn here. */
	.read-aloud-speaker-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		z-index: 50;
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		visibility: hidden;
		transform: translateX(-50%) translateY(4px);
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
	}

	.read-aloud-speaker-anchor {
		position: relative;
		display: inline-flex;
	}

	.read-aloud-speaker:hover + .read-aloud-speaker-tooltip,
	.read-aloud-speaker:focus-visible + .read-aloud-speaker-tooltip {
		opacity: 1;
		visibility: visible;
		transform: translateX(-50%) translateY(0);
	}

	.read-aloud-ring {
		position: absolute;
		inset: 50% auto auto 50%;
		width: 26px;
		height: 26px;
		margin: -13px 0 0 -13px;
		transform: rotate(-90deg);
		pointer-events: none;
	}

	.read-aloud-ring-track {
		stroke: color-mix(in srgb, var(--text-primary) 14%, transparent);
	}

	.read-aloud-ring-progress {
		stroke: var(--accent);
		transition: stroke-dashoffset var(--duration-standard) var(--ease-out);
	}
</style>
