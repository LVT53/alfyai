<script lang="ts">
/**
 * The speaker in a finished reply's action row (spec §4.1, §4.8): it starts and
 * pauses the reading of its reply, shows its progress as a ring, and says why it
 * cannot read (a language with no voice, nothing readable) or that the voice is
 * busy or did not answer. It reads `readAloudView` and calls the controller; the
 * press calls `start` synchronously, so the iOS unlock stays in the gesture.
 */
import { untrack } from "svelte";
import { Pause, Play, Volume2, VolumeX } from "@lucide/svelte";
import {
	getReadAloud,
	type ReadAloudController,
	type Readability,
} from "$lib/client/read-aloud/controller";
import { languageDisplayName } from "$lib/client/read-aloud/language";
import { t } from "$lib/i18n";
import { readAloudView } from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudNote from "./ReadAloudNote.svelte";

let {
	conversationId,
	messageId,
	segmentIds,
	contentKey,
	onPinnedChange,
	controller = undefined,
}: {
	conversationId: string;
	messageId: string;
	segmentIds: readonly string[];
	contentKey: string;
	onPinnedChange: (pinned: boolean) => void;
	controller?: ReadAloudController;
} = $props();

const RING_LENGTH = 72.26;
const CANT_START_NOTE_MS = 8000;

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
const mine = $derived(view.messageId === messageId && view.status !== "idle");
const status = $derived(mine ? view.status : "idle");
const dimmed = $derived(
	!mine && (readability.kind === "noVoice" || readability.kind === "nothing"),
);
const ringed = $derived(
	status === "playing" ||
		status === "paused" ||
		status === "seeking" ||
		status === "waiting" ||
		status === "stopped",
);
const label = $derived(
	status === "playing"
		? $t("readAloud.speaker.pause")
		: ringed
			? $t("readAloud.speaker.resume")
			: $t("readAloud.speaker.read"),
);
const busyNote = $derived(mine && status === "opening" && view.busy);
const dimNoteText = $derived.by(() => {
	if (readability.kind === "nothing") return $t("readAloud.note.nothing");
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

$effect(() => {
	const value = pinned;
	untrack(() => onPinnedChange(value));
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
	const ids = [...segmentIds];
	let cancelled = false;
	const assess = () => {
		void reader()
			.assessReadability(ids)
			.then((result) => {
				if (!cancelled) readability = result;
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
	reader().start({ conversationId, messageId, segmentIds: [...segmentIds] });
}

function tryAgain() {
	cantStartOpen = false;
	reader().start({ conversationId, messageId, segmentIds: [...segmentIds] });
}
</script>

<div class="read-aloud-speaker-wrap" bind:this={wrapper}>
	<button
		bind:this={button}
		type="button"
		class="btn-icon-bare action-icon-btn read-aloud-speaker"
		class:dimmed
		class:failed={status === "startFailed"}
		aria-label={label}
		aria-disabled={dimmed ? "true" : undefined}
		data-testid="read-aloud-speaker"
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
		{#if status === "opening"}
			<span class="mini-spinner" aria-hidden="true"></span>
		{:else if status === "playing"}
			<Pause size={12} strokeWidth={2.5} aria-hidden="true" />
		{:else if ringed}
			<Play size={12} strokeWidth={2.5} aria-hidden="true" />
		{:else if status === "startFailed"}
			<VolumeX size={15} strokeWidth={2} aria-hidden="true" />
		{:else}
			<Volume2 size={15} strokeWidth={2} aria-hidden="true" />
		{/if}
	</button>
	{#if busyNote}
		<ReadAloudNote tone="calm" icon="clock" text={$t("readAloud.note.busy")} placement="speaker" />
	{:else if cantStartOpen}
		<ReadAloudNote
			tone="warn"
			icon="alert"
			text={$t("readAloud.note.cantStart")}
			actionLabel={$t("readAloud.tryAgain")}
			onAction={tryAgain}
			onDismiss={() => (cantStartOpen = false)}
			placement="speaker"
		/>
	{:else if dimNote}
		<ReadAloudNote tone="calm" icon="alert" text={dimNoteText} placement="speaker" />
	{/if}
</div>

<style>
	.read-aloud-speaker-wrap {
		position: relative;
	}

	.read-aloud-speaker {
		position: relative;
	}

	.read-aloud-speaker.dimmed {
		opacity: 0.38;
		cursor: default;
	}

	.read-aloud-speaker.dimmed:hover {
		background-color: transparent;
		color: var(--icon-muted);
	}

	.read-aloud-speaker.failed {
		color: var(--warning-text);
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
