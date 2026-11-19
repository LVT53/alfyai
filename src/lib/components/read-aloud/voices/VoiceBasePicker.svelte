<script lang="ts">
/**
 * "Start from": the built-in voices, English then Hungarian. Each card is a
 * select button (its name and description) beside its own ▶, which plays the
 * voice saying its language's sample: two buttons side by side, never one
 * inside the other.
 */
import type { BuiltInVoiceInfo } from "$lib/client/api/read-aloud-voices";
import type {
	PreviewSound,
	VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { type I18nKey, t } from "$lib/i18n";
import { ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import VoicePlayButton from "./VoicePlayButton.svelte";

let {
	builtIn,
	selected,
	onSelect,
	preview = undefined,
}: {
	builtIn: BuiltInVoiceInfo[];
	selected: string;
	onSelect: (key: string) => void;
	preview?: VoicePreview;
} = $props();

const id = $props.id();
const LANGUAGES = ["en", "hu"] as const;

function baseSound(voice: BuiltInVoiceInfo): PreviewSound {
	return {
		owner: `base:${voice.key}`,
		request: { base: voice.key, knobs: { ...ZERO_KNOBS } },
		sentences: VOICE_SAMPLES[voice.language],
	};
}

/** A voice's description ("British woman"), or nothing for a voice the words do not know. */
function describe(key: string): string {
	const wordKey = `readAloud.voice.${key}`;
	const text = $t(wordKey as I18nKey);
	return text === wordKey ? "" : text;
}
</script>

<div class="voice-bases">
	{#each LANGUAGES as language (language)}
		{@const voices = builtIn.filter((voice) => voice.language === language)}
		{#if voices.length > 0}
			<span class="voice-bases-language" id="{id}-{language}">{$t(`readAloud.language.${language}`)}</span>
			<div class="voice-bases-grid" role="group" aria-labelledby="{id}-{language}">
				{#each voices as voice (voice.key)}
					<div class="voice-base" data-selected={selected === voice.key ? "" : undefined}>
						<button
							type="button"
							class="voice-base-pick"
							aria-pressed={selected === voice.key}
							onclick={() => onSelect(voice.key)}
						>
							<span class="voice-base-name">{voice.name}</span>
							<span class="voice-base-description">{describe(voice.key)}</span>
						</button>
						<VoicePlayButton
							sound={baseSound(voice)}
							label={$t("readAloud.voice.play", { name: voice.name })}
							pauseLabel={$t("readAloud.voice.pause", { name: voice.name })}
							{preview}
						/>
					</div>
				{/each}
			</div>
		{/if}
	{/each}
</div>

<style>
	.voice-bases {
		display: flex;
		flex-direction: column;
	}

	.voice-bases-language {
		margin: 2px 0 6px;
		color: var(--text-muted);
		font-size: 11.5px;
	}

	.voice-bases-grid + .voice-bases-language {
		margin-top: 10px;
	}

	.voice-bases-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
	}

	.voice-base {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px 6px 4px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out);
	}

	.voice-base[data-selected] {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.voice-base-pick {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
		padding: 4px 6px 4px 8px;
		border: 0;
		border-radius: calc(var(--radius-md) - 4px);
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		text-align: left;
		cursor: pointer;
	}

	.voice-base-pick:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.voice-base-name {
		font-size: 13.5px;
		font-weight: 600;
	}

	.voice-base-description {
		color: var(--text-muted);
		font-size: 11.5px;
		line-height: 1.35;
	}

	@media (max-width: 639px) {
		.voice-bases-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.voice-base-pick {
			min-height: 44px;
			justify-content: center;
		}
	}
</style>
