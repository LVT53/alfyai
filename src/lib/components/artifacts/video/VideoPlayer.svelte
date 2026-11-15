<script lang="ts">
// The one video player (video plan, slice 3): the card's ready stage and the
// panel's body, so the keyboard map, the loop default and the one-clip rule
// live once.
//
// It starts on the poster (no autoplay) and never moves focus: its two
// controls are the Tab stops (the player itself adds none, so Tab can never be
// trapped), and every key it answers works wherever the focus is inside the
// player. Leaving the page pauses the clip (the unmount teardown) and a fresh
// mount starts on the poster again.
//
// Keys: Space play/pause, ←/→ seek 1 s (Shift 5 s), ↑/↓ volume, M mute,
// L loop, F fullscreen. A click toggles play; a double click goes fullscreen.
// Nothing here animates a size or a position; the one fade is a control's
// opacity, gone under `prefers-reduced-motion`.
import { Maximize2, Pause, Play } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { videoFileUrl } from "./video-card-view";
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

function clearClickTimer(): void {
	if (clickTimer !== null) {
		clearTimeout(clickTimer);
		clickTimer = null;
	}
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
	claimPlayback(self);
}

function handlePause(): void {
	playing = false;
	releasePlayback(self);
}

function handleEnded(): void {
	if (loop) return;
	playing = false;
	releasePlayback(self);
}

function handleClick(): void {
	if (clickTimer !== null) {
		// The second click of a double click: the dblclick goes fullscreen.
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
	void goFullscreen();
}

async function goFullscreen(): Promise<void> {
	const el = playerEl;
	if (!el?.requestFullscreen) return;
	try {
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
			void goFullscreen();
			return;
		default:
			return;
	}
}

// Another clip (Another, a restore): the old one is not playing any more, and
// the new one starts on its poster.
$effect(() => {
	void fileId;
	playing = false;
	releasePlayback(self);
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

<!-- The player is the keyboard surface for its own controls: a labelled group
     whose shortcuts are described, with no focus of its own, so Tab always
     leaves it. The rule's concern (an undiscoverable click surface) does not
     apply. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={playerEl}
	class="video-player"
	class:is-playing={playing}
	data-testid={testId}
	role="group"
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
		onplay={handlePlay}
		onpause={handlePause}
		onended={handleEnded}
		onclick={handleClick}
		ondblclick={handleDoubleClick}
	></video>
	<div class="video-player-controls">
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
			aria-label={$t('artifacts.video.player.fullscreen')}
			onclick={() => void goFullscreen()}
		>
			<Maximize2 size={16} strokeWidth={2} aria-hidden="true" />
		</button>
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

	/* The focus ring is the player's, shown while one of its own controls has
	   the keyboard: the player adds no Tab stop of its own, so Tab leaves it. */
	.video-player:focus-within {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.video-player-media {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: var(--surface-elevated);
	}

	.video-player-controls {
		position: absolute;
		inset: auto 0 0 0;
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem;
		pointer-events: none;
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
