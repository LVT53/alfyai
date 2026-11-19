<script lang="ts">
/**
 * The editor's Listen section: the reply player's pill drawn inline (Plan 3,
 * Decision 2), Yours / Original, the sample in quotes or the person's own words,
 * and the two switches. Before the voice has played the pill shows the sample's
 * sentences with an estimated length; while "listen" owns the preview's sound it
 * shows that sound. A failed render of this sound, or of a "Start from" card's,
 * says so here with Try again.
 */
import { tick } from "svelte";
import type { BuiltInVoiceInfo } from "$lib/client/api/read-aloud-voices";
import type { ReadAloudPlayerActions } from "$lib/client/read-aloud/controller";
import { formatClock } from "$lib/client/read-aloud/timeline";
import {
	getVoicePreview,
	listenSound,
	sentenceBubble,
	type VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import Toggle from "$lib/components/ui/Toggle.svelte";
import { t } from "$lib/i18n";
import type { Knobs } from "$lib/shared/read-aloud/voice-knobs";
import {
	OWN_WORDS_MAX,
	ownWords,
	VOICE_SAMPLES,
} from "$lib/shared/read-aloud/voice-samples";
import {
	idleReadAloudView,
	type ReadAloudView,
	voicePreviewView,
} from "$lib/stores/read-aloud";
import ReadAloudNote from "../ReadAloudNote.svelte";
import ReadAloudPlayerPill from "../ReadAloudPlayerPill.svelte";

let {
	base,
	knobs,
	compare,
	onCompare,
	playAfterChange,
	onPlayAfterChange,
	useOwnWords,
	onUseOwnWords,
	words,
	onWords,
	preview = undefined,
}: {
	base: BuiltInVoiceInfo;
	knobs: Knobs;
	compare: "yours" | "original";
	onCompare: (c: "yours" | "original") => void;
	playAfterChange: boolean;
	onPlayAfterChange: (on: boolean) => void;
	useOwnWords: boolean;
	onUseOwnWords: (on: boolean) => void;
	words: string;
	onWords: (text: string) => void;
	preview?: VoicePreview;
} = $props();

/** The editor's estimate of a clip's length before it has played. */
const CHARS_PER_SECOND = 15;

const player = () => preview ?? getVoicePreview();
const sound = $derived(
	listenSound({
		base,
		knobs: { ...knobs },
		compare,
		words: useOwnWords ? ownWords(words) : null,
	}),
);
const owned = $derived($voicePreviewView.owner === "listen");

/** Before it plays: the sentences' notches by their share of the text, and a length at 15 characters a second. */
const idleView = $derived.by((): ReadAloudView => {
	const lengths = sound.sentences.map((text) => text.length);
	const total = lengths.reduce((sum, length) => sum + length, 0);
	let before = 0;
	const notches = lengths.map((length) => {
		const share = total > 0 ? before / total : 0;
		before += length;
		return share;
	});
	return {
		...idleReadAloudView,
		status: "paused",
		count: sound.sentences.length,
		notches,
		total: formatClock(total / CHARS_PER_SECOND),
		totalIsEstimate: true,
	};
});
const view = $derived(owned ? $voicePreviewView.player : idleView);
const failed = $derived(
	$voicePreviewView.status === "failed" &&
		($voicePreviewView.owner === "listen" ||
			($voicePreviewView.owner ?? "").startsWith("base:")),
);

/** Plays this sound from its start, from a press. */
function playNow() {
	const p = player();
	p.unlock();
	p.play(sound);
}

const actions: ReadAloudPlayerActions = {
	toggle: () => {
		const p = player();
		p.unlock();
		p.toggle(sound);
	},
	retry: () => {
		const p = player();
		p.unlock();
		p.retry();
	},
	seek: (i) => {
		if (owned) player().seek(i);
		else playNow();
	},
	beginDrag: () => {
		if (owned) player().beginDrag();
	},
	dragTo: (i) => {
		if (owned) player().dragTo(i);
	},
	endDrag: (i) => {
		if (owned) player().endDrag(i);
	},
	sentencePreview: (i) => sentenceBubble(sound.sentences, i),
};

let wordsField = $state<HTMLInputElement | null>(null);

/** Turned on, the field appears above the switch: focus goes to it, as in the prototype. */
async function setOwnWords(on: boolean) {
	onUseOwnWords(on);
	if (!on) return;
	await tick();
	wordsField?.focus();
}

function onWordsKey(event: KeyboardEvent) {
	if (event.key !== "Enter") return;
	event.preventDefault();
	playNow();
}
</script>

<div class="voice-listen">
	<ReadAloudPlayerPill variant="inline" {view} {actions} />
	<div class="voice-listen-row">
		<div class="voice-compare" role="group" aria-label={$t("readAloud.editor.compare")}>
			<button type="button" aria-pressed={compare === "yours"} onclick={() => onCompare("yours")}>
				{$t("readAloud.editor.yours")}
			</button>
			<button type="button" aria-pressed={compare === "original"} onclick={() => onCompare("original")}>
				{$t("readAloud.editor.original")}
			</button>
		</div>
	</div>
	{#if useOwnWords}
		<input
			bind:this={wordsField}
			class="voice-listen-words"
			type="text"
			maxlength={OWN_WORDS_MAX}
			value={words}
			aria-label={$t("readAloud.editor.ownWordsLabel")}
			placeholder={$t("readAloud.editor.ownWordsPlaceholder")}
			oninput={(event) => onWords(event.currentTarget.value)}
			onkeydown={onWordsKey}
		/>
	{:else}
		<p class="voice-listen-quote">
			{$t("readAloud.editor.quote", { text: VOICE_SAMPLES[base.language].join(" ") })}
		</p>
	{/if}
	<div class="voice-listen-switches">
		<label class="voice-listen-switch">
			<Toggle
				checked={playAfterChange}
				ariaLabel={$t("readAloud.editor.playAfterChange")}
				onChange={onPlayAfterChange}
			/>
			<span>{$t("readAloud.editor.playAfterChange")}</span>
		</label>
		<label class="voice-listen-switch">
			<Toggle
				checked={useOwnWords}
				ariaLabel={$t("readAloud.editor.ownWords")}
				onChange={setOwnWords}
			/>
			<span>{$t("readAloud.editor.ownWords")}</span>
		</label>
	</div>
	{#if failed}
		<ReadAloudNote
			tone="warn"
			icon="alert"
			text={$t("readAloud.editor.sampleFailed")}
			actionLabel={$t("readAloud.tryAgain")}
			onAction={() => player().retry()}
			placement="inline"
		/>
	{/if}
</div>

<style>
	.voice-listen {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--text-primary) 4%, var(--surface-page));
	}

	.voice-listen-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.voice-compare {
		display: inline-flex;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
	}

	.voice-compare button {
		min-height: 32px;
		padding: 6px 12px;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 12.5px;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.voice-compare button[aria-pressed="true"] {
		background: var(--text-primary);
		color: var(--surface-page);
	}

	.voice-compare button:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: -2px;
	}

	.voice-listen-quote {
		margin: 0;
		color: var(--text-primary);
		font-size: 13px;
		line-height: 1.5;
	}

	.voice-listen-words {
		width: 100%;
		min-height: 40px;
		padding: 8px 10px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 13.5px;
	}

	.voice-listen-words:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.voice-listen-switches {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
	}

	.voice-listen-switch {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--text-primary);
		font-size: 12.5px;
		cursor: pointer;
	}

	@media (max-width: 639px) {
		.voice-listen-words {
			font-size: 16px;
		}

		.voice-compare button {
			min-height: 40px;
		}
	}
</style>
