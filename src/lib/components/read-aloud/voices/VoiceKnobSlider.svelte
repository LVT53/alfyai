<script lang="ts">
/**
 * One of the five knobs (spec §4.6): a native range input on the 0.05 grid, its
 * track painted underneath with the accent from the normal notch to the handle
 * (the prototype's `paintTrack`), the ends' words under the track, the knob's
 * word on the right, and ↺ once it has moved.
 *
 * `onInput` follows the drag (snapped near normal) and the keys (a step from
 * normal leaves the snap); `onCommit` says how the value was set, because a
 * pointer release renders at once and a held key renders after it settles
 * (Plan 3, Decision 11).
 *
 * Its three parts are the columns of the editor's knob grid (a subgrid), so the
 * names' column fits the longest name of the language and the ranges line up.
 */
import { RotateCcw } from "@lucide/svelte";
import { type I18nKey, t } from "$lib/i18n";
import {
	KNOB_STEP,
	type KnobSpec,
	keyStepKnob,
	knobWordIndex,
	snapKnob,
} from "$lib/shared/read-aloud/voice-knobs";

let {
	spec,
	value,
	onInput,
	onCommit,
	onReset,
}: {
	spec: KnobSpec;
	value: number;
	onInput: (v: number) => void;
	onCommit: (v: number, via: "pointer" | "key") => void;
	onReset: () => void;
} = $props();

let input = $state<HTMLInputElement | null>(null);
/** A pointer pressed the input: the next change is its release. */
let byPointer = false;

const name = $derived($t(`readAloud.knob.${spec.key}`));
const word = $derived(
	$t(`readAloud.knob.${spec.key}.${knobWordIndex(spec.key, value)}` as I18nKey),
);
const moved = $derived(value !== 0);
const span = $derived(spec.max - spec.min);
/** Where normal and the value sit along the track, as shares. */
const zeroShare = $derived((0 - spec.min) / span);
const valueShare = $derived((value - spec.min) / span);

function readValue(target: EventTarget | null): number {
	return snapKnob(spec.key, Number((target as HTMLInputElement).value));
}

function oninput(event: Event) {
	const raw = Number((event.currentTarget as HTMLInputElement).value);
	const next = byPointer
		? snapKnob(spec.key, raw)
		: keyStepKnob(spec.key, value, raw);
	// The thumb follows the snap even when the value the parent holds did not change.
	if (input) input.value = String(next);
	onInput(next);
}

function onchange(event: Event) {
	const via = byPointer ? "pointer" : "key";
	byPointer = false;
	onCommit(readValue(event.currentTarget), via);
}

/** ↺ goes once the knob is normal again, so focus moves to its slider first. */
function reset() {
	input?.focus();
	onReset();
}
</script>

<div
	class="voice-knob"
	data-moved={moved ? "" : undefined}
	style:--from="{Math.min(zeroShare, valueShare) * 100}%"
	style:--to="{Math.max(zeroShare, valueShare) * 100}%"
	style:--zero-share={zeroShare}
>
	<span class="voice-knob-name">
		{name}
		{#if moved}
			<button
				type="button"
				class="voice-knob-reset"
				aria-label={$t("readAloud.editor.reset", { knob: name })}
				onclick={reset}
			>
				<RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
			</button>
		{:else}
			<!-- ↺'s room, kept so the names' column never changes width as knobs move. -->
			<span class="voice-knob-reset-room" aria-hidden="true"></span>
		{/if}
	</span>
	<span class="voice-knob-range">
		<span class="voice-knob-notch" aria-hidden="true"></span>
		<input
			bind:this={input}
			type="range"
			min={spec.min}
			max={spec.max}
			step={KNOB_STEP}
			{value}
			aria-label={name}
			aria-valuetext={word}
			{oninput}
			{onchange}
			onpointerdown={() => (byPointer = true)}
			onkeydown={() => (byPointer = false)}
		/>
		<span class="voice-knob-ends" aria-hidden="true">
			<span>{$t(`readAloud.knob.${spec.key}.low`)}</span>
			<span>{$t(`readAloud.knob.${spec.key}.high`)}</span>
		</span>
	</span>
	<span class="voice-knob-word">{word}</span>
</div>

<style>
	/* The editor's knob grid owns the columns (VoiceEditor.svelte's `.voice-editor-knobs`). */
	.voice-knob {
		--thumb: 9px;
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
	}

	.voice-knob-name {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--text-primary);
		font-size: 13.5px;
		font-weight: 600;
		white-space: nowrap;
	}

	.voice-knob-reset-room {
		flex: none;
		width: 24px;
		height: 24px;
	}

	.voice-knob-reset {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.voice-knob-reset:hover {
		color: var(--accent);
	}

	.voice-knob-reset:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.voice-knob-word {
		color: var(--text-muted);
		font-size: 12.5px;
		text-align: right;
		white-space: nowrap;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.voice-knob[data-moved] .voice-knob-word {
		color: var(--accent-text);
		font-weight: 600;
	}

	.voice-knob-range {
		position: relative;
		height: 40px;
	}

	/* The track and the change from normal, under the native input (whose own track is transparent). */
	.voice-knob-range::before {
		content: "";
		position: absolute;
		top: 12px;
		right: var(--thumb);
		left: var(--thumb);
		z-index: 0;
		height: 4px;
		border-radius: 4px;
		background: linear-gradient(
			to right,
			var(--border-default) 0,
			var(--border-default) var(--from),
			var(--accent) var(--from),
			var(--accent) var(--to),
			var(--border-default) var(--to),
			var(--border-default) 100%
		);
		pointer-events: none;
	}

	/* Normal: a 2 × 16 px notch where the thumb's centre sits at 0. */
	.voice-knob-notch {
		position: absolute;
		top: 6px;
		left: calc(var(--thumb) + (100% - 2 * var(--thumb)) * var(--zero-share));
		width: 2px;
		height: 16px;
		border-radius: 1px;
		background: color-mix(in srgb, var(--text-primary) 25%, transparent);
		transform: translateX(-1px);
		pointer-events: none;
	}

	.voice-knob-ends {
		position: absolute;
		top: 27px;
		right: 0;
		left: 0;
		display: flex;
		justify-content: space-between;
		color: var(--text-muted);
		font-size: 10.5px;
		pointer-events: none;
	}

	input[type="range"] {
		position: relative;
		z-index: 1;
		display: block;
		width: 100%;
		height: 28px;
		margin: 0;
		background: transparent;
		appearance: none;
		-webkit-appearance: none;
		cursor: pointer;
	}

	input[type="range"]::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 4px;
		background: transparent;
	}

	input[type="range"]::-moz-range-track {
		height: 4px;
		border-radius: 4px;
		background: transparent;
	}

	input[type="range"]::-webkit-slider-thumb {
		width: 18px;
		height: 18px;
		margin-top: -7px;
		border: 2px solid var(--accent);
		border-radius: 50%;
		background: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
		-webkit-appearance: none;
		appearance: none;
	}

	input[type="range"]::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border: 2px solid var(--accent);
		border-radius: 50%;
		background: var(--surface-elevated);
	}

	input[type="range"]:focus-visible {
		outline: none;
	}

	input[type="range"]:focus-visible::-webkit-slider-thumb {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	input[type="range"]:focus-visible::-moz-range-thumb {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	/* A phone: the name and the word share a line, the range sits below, the thumb is 24 px. */
	@media (max-width: 639px) {
		.voice-knob {
			--thumb: 12px;
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas:
				"name word"
				"range range";
			column-gap: 12px;
			row-gap: 2px;
		}

		.voice-knob-name {
			grid-area: name;
		}

		.voice-knob-word {
			grid-area: word;
		}

		.voice-knob-range {
			grid-area: range;
			height: 50px;
		}

		.voice-knob-range::before {
			top: 16px;
		}

		.voice-knob-notch {
			top: 10px;
		}

		.voice-knob-ends {
			top: 35px;
		}

		input[type="range"] {
			height: 36px;
		}

		input[type="range"]::-webkit-slider-thumb {
			width: 24px;
			height: 24px;
			margin-top: -10px;
		}

		input[type="range"]::-moz-range-thumb {
			width: 20px;
			height: 20px;
		}
	}
</style>
