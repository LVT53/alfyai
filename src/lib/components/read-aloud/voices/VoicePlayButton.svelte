<script lang="ts">
/**
 * A ▶ for one sound in Settings or the voice editor (a built-in voice's card, a
 * saved voice's row). It spins while its own sound renders, shows ⏸ while that
 * sound plays, and ▶ otherwise. A press unlocks the preview's element and
 * toggles the sound, with nothing awaited first (iOS keeps the unlock only
 * inside the press).
 */
import { Pause, Play } from "@lucide/svelte";
import {
	getVoicePreview,
	type PreviewSound,
	type VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { voicePreviewView } from "$lib/stores/read-aloud";

let {
	sound,
	label,
	pauseLabel,
	preview = undefined,
}: {
	sound: PreviewSound;
	label: string;
	pauseLabel: string;
	preview?: VoicePreview;
} = $props();

const mine = $derived($voicePreviewView.owner === sound.owner);
const loading = $derived(mine && $voicePreviewView.status === "loading");
const playing = $derived(mine && $voicePreviewView.status === "playing");

function press() {
	const player = preview ?? getVoicePreview();
	player.unlock();
	player.toggle(sound);
}
</script>

<button
	type="button"
	class="voice-play"
	class:on={playing}
	aria-label={playing ? pauseLabel : label}
	onclick={press}
>
	{#if loading}
		<span class="mini-spinner" aria-hidden="true"></span>
	{:else if playing}
		<Pause size={13} strokeWidth={2.5} aria-hidden="true" />
	{:else}
		<Play size={13} strokeWidth={2.5} aria-hidden="true" />
	{/if}
</button>

<style>
	.voice-play {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: 50%;
		background: var(--surface-elevated);
		color: var(--icon-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.voice-play:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.voice-play.on {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.voice-play:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	/* A phone's finger: the same look in a 44 px target. */
	@media (max-width: 639px) {
		.voice-play {
			position: relative;
		}

		.voice-play::after {
			content: "";
			position: absolute;
			inset: -6px;
		}
	}
</style>
