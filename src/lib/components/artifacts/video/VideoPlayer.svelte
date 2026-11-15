<script lang="ts">
// The one video player (video plan, slice 3): the card's ready stage and the
// panel's body, so the keyboard map, the loop default and the one-clip rule
// live once.
//
// It starts on the poster (no autoplay). The player is ONE Tab stop and the
// scrubber and its two buttons are the stops inside it; a click on the clip
// focuses the player, so the keyboard map works after a click (the group is not
// a trap: Tab still leaves it). Leaving the page pauses the clip (the unmount
// teardown) and a fresh mount starts on the poster again.
//
// Keys: Space play/pause, ←/→ seek 1 s (Shift 5 s), ↑/↓ volume, M mute,
// L loop, F fullscreen (the same toggle as its button). A click toggles play; a
// double click toggles fullscreen. Nothing here animates a size or a position;
// the one fade is a control's opacity, gone under `prefers-reduced-motion`.
import { Maximize2, Minimize2, Pause, Play } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { videoDurationLabel, videoFileUrl } from "./video-card-view";
import {
	claimPlayback,
	type ClipPlayback,
	releasePlayback,
} from "./video-player-registry";

let {
	fileId,
	posterFileId,
	title,
	conversationId = null,
	testId = "video-player",
}: {
	fileId: string;
	posterFileId: string;
	title: string;
	conversationId?: string | null;
	testId?: string;
} = $props();

/** A click that starts a double click is not also a play toggle. */
const DOUBLE_CLICK_WINDOW_MS = 220;

const helpId = $props.id();

let playerEl = $state<HTMLElement | null>(null);
let videoEl = $state<HTMLVideoElement | null>(null);
let playing = $state(false);
let loop = $state(true);
let muted = $state(false);
/** This player is the document's fullscreen element, kept true by `fullscreenchange`. */
let isFullscreen = $state(false);
/** The clip's clock, its length and how far the browser has buffered, in ms. */
let positionMs = $state(0);
let durationMs = $state(0);
let bufferedMs = $state(0);
/**
 * The last loop/mute change, said once through the sr-only live region below:
 * both keys change something a sighted reader sees and a screen reader cannot.
 */
let announcement = $state("");
let clickTimer: ReturnType<typeof setTimeout> | null = null;

/** This player's own handle in the one-clip registry. */
const self: ClipPlayback = {
	pause() {
		videoEl?.pause();
		playing = false;
		releasePlayback(self);
	},
};

const currentSeconds = $derived(positionMs / 1000);
const durationSeconds = $derived(durationMs / 1000);
const playedPercent = $derived(
	durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0,
);
const bufferedPercent = $derived(
	durationMs > 0 ? Math.min(100, (bufferedMs / durationMs) * 100) : 0,
);
/** The slider's spoken value: "N of M seconds", never a bare number. */
const positionText = $derived(
	$t("artifacts.video.player.positionAt", {
		current: Math.round(currentSeconds),
		duration: Math.round(durationSeconds),
	}),
);
const positionLabel = $derived(videoDurationLabel(Math.round(positionMs)));
const durationLabel = $derived(videoDurationLabel(Math.round(durationMs)));

function clearClickTimer(): void {
	if (clickTimer !== null) {
		clearTimeout(clickTimer);
		clickTimer = null;
	}
}

/** Reads the clip's clock, length and buffered end into the scrubber's state. */
function syncTime(): void {
	const el = videoEl;
	if (!el) return;
	positionMs = Number.isFinite(el.currentTime) ? el.currentTime * 1000 : 0;
	durationMs = Number.isFinite(el.duration) ? el.duration * 1000 : 0;
	try {
		bufferedMs =
			el.buffered.length > 0
				? el.buffered.end(el.buffered.length - 1) * 1000
				: 0;
	} catch {
		bufferedMs = 0;
	}
	// A buffered range never ends before the playhead: the bar must not show a
	// played stretch that is not covered.
	bufferedMs = Math.max(bufferedMs, positionMs);
}

async function togglePlay(): Promise<void> {
	const el = videoEl;
	if (!el) return;
	if (playing) {
		el.pause();
		playing = false;
		releasePlayback(self);
		return;
	}
	try {
		await el.play();
		playing = true;
		claimPlayback(self);
	} catch {
		// A browser can refuse (no user gesture, no codec): stay on the poster.
		playing = false;
		releasePlayback(self);
	}
}

function handlePlay(): void {
	playing = true;
	syncTime();
	claimPlayback(self);
}

function handlePause(): void {
	playing = false;
	syncTime();
	releasePlayback(self);
}

function handleEnded(): void {
	syncTime();
	if (loop) return;
	playing = false;
	releasePlayback(self);
}

/** A press on the clip makes the player the keyboard surface; a button keeps its focus. */
function focusPlayer(): void {
	playerEl?.focus();
}

function handleClick(): void {
	if (clickTimer !== null) {
		// The second click of a double click: the dblclick toggles fullscreen.
		clearClickTimer();
		return;
	}
	clickTimer = setTimeout(() => {
		clickTimer = null;
		void togglePlay();
	}, DOUBLE_CLICK_WINDOW_MS);
}

function handleDoubleClick(): void {
	clearClickTimer();
	void toggleFullscreen();
}

/**
 * Enter fullscreen, or leave it. The button says which it will do, and the
 * `fullscreenchange` listener below keeps that true when the person leaves with
 * Escape instead.
 */
async function toggleFullscreen(): Promise<void> {
	try {
		if (document.fullscreenElement) {
			await document.exitFullscreen?.();
			return;
		}
		const el = playerEl;
		if (!el?.requestFullscreen) return;
		await el.requestFullscreen();
	} catch {
		// The browser refused (an iframe's policy): the player stays as it is.
	}
}

function seek(deltaSeconds: number): void {
	const el = videoEl;
	if (!el) return;
	const current = Number.isFinite(el.currentTime) ? el.currentTime : 0;
	const duration = Number.isFinite(el.duration) ? el.duration : null;
	const next = Math.max(0, current + deltaSeconds);
	el.currentTime = duration === null ? next : Math.min(next, duration);
	syncTime();
}

/** The scrubber's own drag/click/keyboard value: the browser handles the pointer. */
function handleScrub(event: Event): void {
	const el = videoEl;
	if (!el) return;
	const value = Number((event.currentTarget as HTMLInputElement).value);
	if (!Number.isFinite(value)) return;
	const max = Number.isFinite(el.duration) ? el.duration : value;
	el.currentTime = Math.min(Math.max(0, value), max);
	syncTime();
}

function changeVolume(delta: number): void {
	const el = videoEl;
	if (!el) return;
	el.volume = Math.min(1, Math.max(0, el.volume + delta));
}

function toggleMute(): void {
	const el = videoEl;
	if (!el) return;
	muted = !muted;
	el.muted = muted;
	announcement = muted
		? $t("artifacts.video.player.muted")
		: $t("artifacts.video.player.unmuted");
}

function toggleLoop(): void {
	const el = videoEl;
	loop = !loop;
	if (el) el.loop = loop;
	announcement = loop
		? $t("artifacts.video.player.loopOn")
		: $t("artifacts.video.player.loopOff");
}

function handleKeydown(event: KeyboardEvent): void {
	// A focused control keeps its own activation keys: Enter AND Space. Eating
	// Space here used to press Fullscreen and play the clip at once, because
	// `preventDefault()` stops the button's own activation but not ours.
	if (
		event.target instanceof HTMLElement &&
		event.target.tagName === "BUTTON" &&
		(event.key === "Enter" || event.key === " " || event.key === "Spacebar")
	) {
		return;
	}
	const key = event.key;
	const handled = () => event.preventDefault();
	switch (key) {
		case " ":
		case "Spacebar":
			handled();
			void togglePlay();
			return;
		case "ArrowLeft":
			handled();
			seek(event.shiftKey ? -5 : -1);
			return;
		case "ArrowRight":
			handled();
			seek(event.shiftKey ? 5 : 1);
			return;
		case "ArrowUp":
			handled();
			changeVolume(0.1);
			return;
		case "ArrowDown":
			handled();
			changeVolume(-0.1);
			return;
		default:
			break;
	}
	switch (key.toLowerCase()) {
		case "m":
			handled();
			toggleMute();
			return;
		case "l":
			handled();
			toggleLoop();
			return;
		case "f":
			handled();
			void toggleFullscreen();
			return;
		default:
			return;
	}
}

// Another clip (Another, a restore): the old one is not playing any more, and
// the new one starts on its poster and at 0:00.
$effect(() => {
	void fileId;
	playing = false;
	positionMs = 0;
	durationMs = 0;
	bufferedMs = 0;
	releasePlayback(self);
});

// The document's fullscreen element can change behind the button's back (Escape,
// another element): the button's word and icon follow it.
$effect(() => {
	const el = playerEl;
	const sync = () => {
		isFullscreen = el !== null && document.fullscreenElement === el;
	};
	document.addEventListener("fullscreenchange", sync);
	sync();
	return () => document.removeEventListener("fullscreenchange", sync);
});

// Leaving the chat (the card's page or the panel unmounts): stop the clip and
// let go of playback. A fresh mount starts on its poster, never looping by
// itself.
$effect(() => {
	return () => {
		clearClickTimer();
		videoEl?.pause();
		releasePlayback(self);
	};
});

const src = $derived(videoFileUrl(fileId, { conversationId }));
const poster = $derived(
	videoFileUrl(posterFileId, { variant: "poster", conversationId }),
);
</script>

<!-- The player is one labelled group and one Tab stop: a press on the clip
     focuses it, so the keyboard map works straight after a click, while a button
     inside it keeps its own focus and its own Enter/Space. Tab still leaves it. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
<div
	bind:this={playerEl}
	class="video-player"
	class:is-playing={playing}
	data-testid={testId}
	role="group"
	tabindex="0"
	aria-label={$t('artifacts.video.player.label', { title })}
	aria-describedby={helpId}
	onkeydown={handleKeydown}
>
	<video
		bind:this={videoEl}
		class="video-player-media"
		data-testid="video-player-media"
		{src}
		{poster}
		loop={loop}
		muted={muted}
		playsinline
		preload="metadata"
		aria-label={title}
		onpointerdown={focusPlayer}
		onplay={handlePlay}
		onpause={handlePause}
		onended={handleEnded}
		onloadedmetadata={syncTime}
		ondurationchange={syncTime}
		ontimeupdate={syncTime}
		onprogress={syncTime}
		onseeked={syncTime}
		onclick={handleClick}
		ondblclick={handleDoubleClick}
	></video>
	<div class="video-player-controls">
		<!-- The scrubber is always visible: a click or a drag seeks, the browser's
		     own range input carries the touch/keyboard behaviour, and the track
		     under it shows the position and the buffered range. -->
		<div
			class="video-player-scrubber"
			data-testid="video-player-scrubber-row"
			style:--played="{playedPercent}%"
			style:--buffered="{bufferedPercent}%"
		>
			<div class="video-player-slider">
				<div class="video-player-track" aria-hidden="true">
					<span class="video-player-buffered" data-testid="video-player-buffered"
					></span>
					<span class="video-player-played" data-testid="video-player-played"
					></span>
				</div>
				<span class="video-player-thumb" aria-hidden="true"></span>
				<input
					class="video-player-range"
					type="range"
					min="0"
					max={durationSeconds}
					step="0.01"
					value={currentSeconds}
					disabled={durationMs <= 0}
					aria-label={$t('artifacts.video.player.position')}
					aria-valuetext={positionText}
					data-testid="video-player-scrubber"
					oninput={handleScrub}
				/>
			</div>
			<span class="video-player-time" data-testid="video-player-time" aria-hidden="true"
				>{positionLabel} / {durationLabel}</span
			>
		</div>
		<div class="video-player-buttons">
			<button
				type="button"
				class="video-player-button"
				data-testid="video-player-toggle"
				aria-label={playing
					? $t('artifacts.video.player.pause')
					: $t('artifacts.video.player.play')}
				onclick={() => void togglePlay()}
			>
				{#if playing}
					<Pause size={16} strokeWidth={2} aria-hidden="true" />
				{:else}
					<Play size={16} strokeWidth={2} aria-hidden="true" />
				{/if}
			</button>
			<span class="video-player-grow"></span>
			<button
				type="button"
				class="video-player-button"
				data-testid="video-player-fullscreen"
				aria-label={isFullscreen
					? $t('artifacts.video.player.exitFullscreen')
					: $t('artifacts.video.player.fullscreen')}
				onclick={() => void toggleFullscreen()}
			>
				{#if isFullscreen}
					<Minimize2 size={16} strokeWidth={2} aria-hidden="true" />
				{:else}
					<Maximize2 size={16} strokeWidth={2} aria-hidden="true" />
				{/if}
			</button>
		</div>
	</div>
	<span class="sr-only" role="status" aria-atomic="true" data-testid="video-player-status"
		>{announcement}</span
	>
	<span class="sr-only" id={helpId}>{$t('artifacts.video.player.keys')}</span>
</div>

<style>
	.video-player {
		position: relative;
		display: block;
		width: 100%;
		height: 100%;
		overflow: hidden;
		border-radius: inherit;
		background: var(--surface-elevated);
	}

	/* The focus ring is the player's, shown while the player itself or one of its
	   controls has the keyboard; Tab still leaves it. */
	.video-player:focus-visible {
		outline: none;
	}

	.video-player:focus-within {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.video-player-media {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: var(--surface-elevated);
		cursor: pointer;
	}

	.video-player-controls {
		position: absolute;
		inset: auto 0 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.5rem;
		pointer-events: none;
	}

	.video-player-scrubber {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.video-player-slider {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1 1 auto;
		min-width: 0;
		height: 1.5rem;
	}

	/* The always-visible bar. The buffered stretch is the quiet layer under the
	   played one; the thumb sits on the playhead. */
	.video-player-track {
		position: relative;
		width: 100%;
		height: 4px;
		overflow: hidden;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--text-muted) 30%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface-page) 55%, transparent);
	}

	.video-player-buffered,
	.video-player-played {
		position: absolute;
		inset-block: 0;
		left: 0;
	}

	.video-player-buffered {
		width: var(--buffered, 0%);
		background: color-mix(in srgb, var(--text-muted) 55%, transparent);
	}

	.video-player-played {
		width: var(--played, 0%);
		background: var(--accent);
	}

	.video-player-thumb {
		position: absolute;
		top: 50%;
		left: var(--played, 0%);
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
		background: var(--accent);
		box-shadow: var(--shadow-sm);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	/* The browser's range input is the hit area: 44 px tall on every pointer so a
	   phone gets a real target, transparent so the track above draws. Its own
	   arrows/Home/End work natively; the player's map intercepts ←/→ first. */
	.video-player-range {
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		width: 100%;
		height: 44px;
		margin: 0;
		padding: 0;
		background: transparent;
		opacity: 0;
		appearance: none;
		cursor: pointer;
		pointer-events: auto;
		touch-action: none;
		transform: translateY(-50%);
	}

	.video-player-range:disabled {
		cursor: default;
	}

	.video-player-slider:has(.video-player-range:focus-visible) .video-player-track {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.video-player-time {
		flex: 0 0 auto;
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-full);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.video-player-buttons {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.video-player-grow {
		flex: 1 1 auto;
	}

	.video-player-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		cursor: pointer;
		pointer-events: auto;
		opacity: 0.92;
		transition: opacity var(--duration-fast) var(--ease-out);
	}

	.video-player-button:hover {
		opacity: 1;
	}

	.video-player-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@media (hover: none) and (pointer: coarse) {
		.video-player-button {
			width: 44px;
			height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.video-player-button {
			transition: none;
		}
	}
</style>
