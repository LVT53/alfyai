<script lang="ts">
/**
 * The personal voice editor (`read-aloud/voices/VoiceEditor.svelte`): the
 * built-in voices to start from, grouped by language, each with its own ▶;
 * the styles as chips; the five knobs with the word of their value at the
 * right, in the accent once moved, and ↺; Cancel and Save voice. Berta is
 * chosen with the Bedtime style, so the knobs stand where Bedtime puts them.
 *
 * Words are the editor's own keys, and the knobs, the styles and the word of a
 * value come from `voice-knobs.ts`, as the editor reads them.
 */
import { Play, RotateCcw, X } from "@lucide/svelte";
import { type I18nKey, t } from "$lib/i18n";
import {
	KNOBS,
	knobWordIndex,
	STYLES,
} from "$lib/shared/read-aloud/voice-knobs";

let { phone = false }: { phone?: boolean } = $props();

/** The built-in voices by language (`BUILT_IN_VOICES`, server-side). */
const GROUPS = [
	{
		language: "en",
		voices: [
			["imogen", "Imogen"],
			["rupert", "Rupert"],
			["savannah", "Savannah"],
			["wyatt", "Wyatt"],
		],
	},
	{
		language: "hu",
		voices: [
			["berta", "Berta"],
			["imre", "Imre"],
		],
	},
] as const;

const CHOSEN_VOICE = "berta";
const CHOSEN_STYLE = "bedtime";
const knobs =
	STYLES.find((style) => style.key === CHOSEN_STYLE)?.knobs ?? STYLES[0].knobs;

function share(min: number, max: number, value: number): number {
	return ((value - min) / (max - min)) * 100;
}
</script>

<div class="editor" class:phone>
	<header class="head">
		<span class="title">{$t('readAloud.editor.newTitle')}</span>
		<span class="drawn-ic close" style:--ic="10"><X size="100%" strokeWidth={2} aria-hidden="true" /></span>
	</header>
	<div class="body">
		<p class="section">{$t('readAloud.editor.startFrom')}</p>
		{#each GROUPS as group}
			<p class="group">{$t(`readAloud.language.${group.language}` as I18nKey)}</p>
			<div class="voices">
				{#each group.voices as [key, name]}
					<span class="voice" class:chosen={key === CHOSEN_VOICE}>
						<span class="who">
							<span class="name">{name}</span>
							<span class="kind">{$t(`readAloud.voice.${key}` as I18nKey)}</span>
						</span>
						<span class="listen"><span class="drawn-ic" style:--ic="6"><Play size="100%" strokeWidth={2} fill="currentColor" aria-hidden="true" /></span></span>
					</span>
				{/each}
			</div>
		{/each}
		<p class="section">{$t('readAloud.editor.style')}</p>
		<div class="styles">
			{#each STYLES as style}
				<span class="style" class:chosen={style.key === CHOSEN_STYLE}>{$t(`readAloud.style.${style.key}` as I18nKey)}</span>
			{/each}
		</div>
		<div class="section-row">
			<p class="section">{$t('readAloud.editor.shape')}</p>
			<span class="reset">{$t('readAloud.editor.resetAll')}</span>
		</div>
		{#each KNOBS as spec}
			{@const value = knobs[spec.key]}
			{@const normal = share(spec.min, spec.max, 0)}
			{@const at = share(spec.min, spec.max, value)}
			{@const moved = value !== 0}
			<div class="slider-row">
				<span class="label">
					{$t(`readAloud.knob.${spec.key}` as I18nKey)}
					{#if moved}<span class="drawn-ic" style:--ic="6"><RotateCcw size="100%" strokeWidth={2.2} aria-hidden="true" /></span>{/if}
				</span>
				<span class="slider">
					<span class="line">
						<span class="track"></span>
						<span class="fill" style:left="{Math.min(normal, at)}%" style:width="{Math.abs(at - normal)}%"></span>
						<span class="notch" style:left="{normal}%"></span>
						<span class="handle" style:left="{at}%"></span>
					</span>
					<span class="ends">
						<span>{$t(`readAloud.knob.${spec.key}.low` as I18nKey)}</span>
						<span>{$t(`readAloud.knob.${spec.key}.high` as I18nKey)}</span>
					</span>
				</span>
				<span class="word" class:moved>{$t(`readAloud.knob.${spec.key}.${knobWordIndex(spec.key, value)}` as I18nKey)}</span>
			</div>
		{/each}
	</div>
	<footer class="foot">
		{#if !phone}<span class="button">{$t('readAloud.editor.cancel')}</span>{/if}
		<span class="button primary">{$t('readAloud.editor.save')}</span>
	</footer>
</div>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 9);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
	}

	.head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		padding: calc(var(--u) * 7) calc(var(--u) * 11) calc(var(--u) * 1);
	}

	.title {
		font-size: calc(var(--u) * 9.5);
		font-weight: 700;
	}

	.close {
		color: var(--icon-muted);
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 0 calc(var(--u) * 11);
	}

	.section {
		margin: calc(var(--u) * 4.5) 0 calc(var(--u) * 2);
		color: var(--text-muted);
		font-size: calc(var(--u) * 5.5);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.group {
		margin: calc(var(--u) * 1) 0 calc(var(--u) * 1.5);
		color: var(--text-muted);
		font-size: calc(var(--u) * 5.5);
	}

	.voices {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: calc(var(--u) * 4);
	}

	.voice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--u) * 3);
		min-width: 0;
		padding: calc(var(--u) * 3) calc(var(--u) * 4) calc(var(--u) * 3) calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 5);
		background: var(--surface-elevated);
	}

	.voice.chosen {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		background: var(--accent-tint);
	}

	.who {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 0.5);
		min-width: 0;
	}

	.name {
		font-size: calc(var(--u) * 7);
		font-weight: 700;
	}

	.kind {
		color: var(--text-muted);
		font-size: calc(var(--u) * 5.5);
		white-space: nowrap;
	}

	.listen {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 13);
		height: calc(var(--u) * 13);
		border: 1px solid var(--border-default);
		border-radius: 50%;
		background: var(--surface-page);
		color: var(--text-primary);
	}

	.styles {
		display: flex;
		flex-wrap: wrap;
		gap: calc(var(--u) * 2.5);
	}

	.style {
		display: inline-flex;
		align-items: center;
		height: calc(var(--u) * 11);
		padding: 0 calc(var(--u) * 4.5);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		font-size: calc(var(--u) * 6);
		white-space: nowrap;
	}

	.style.chosen {
		border-color: var(--text-primary);
		background: var(--text-primary);
		color: var(--surface-page);
	}

	.section-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.reset {
		color: var(--text-secondary);
		font-size: calc(var(--u) * 6);
	}

	.slider-row {
		display: grid;
		grid-template-columns: calc(var(--u) * 52) 1fr calc(var(--u) * 50);
		align-items: center;
		gap: calc(var(--u) * 6);
		margin-bottom: calc(var(--u) * 1.5);
	}

	.label {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 2.5);
		font-size: calc(var(--u) * 7);
		font-weight: 600;
		white-space: nowrap;
	}

	.label .drawn-ic {
		color: var(--text-muted);
	}

	.slider {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 1.5);
	}

	.line {
		position: relative;
		height: calc(var(--u) * 9);
	}

	.track,
	.fill {
		position: absolute;
		top: 50%;
		height: calc(var(--u) * 1.6);
		border-radius: calc(var(--u) * 1);
		transform: translateY(-50%);
	}

	.track {
		right: 0;
		left: 0;
		background: color-mix(in srgb, var(--text-primary) 14%, transparent);
	}

	.fill {
		background: var(--accent);
	}

	.notch {
		position: absolute;
		top: 50%;
		width: 1px;
		height: calc(var(--u) * 5);
		background: color-mix(in srgb, var(--text-primary) 40%, transparent);
		transform: translate(-50%, -50%);
	}

	.handle {
		position: absolute;
		top: 50%;
		width: calc(var(--u) * 8);
		height: calc(var(--u) * 8);
		border: calc(var(--u) * 1.5) solid var(--accent);
		border-radius: 50%;
		background: var(--surface-page);
		box-sizing: border-box;
		transform: translate(-50%, -50%);
	}

	.ends {
		display: flex;
		justify-content: space-between;
		color: var(--text-muted);
		font-size: calc(var(--u) * 5);
	}

	.word {
		color: var(--text-secondary);
		font-size: calc(var(--u) * 6.5);
		text-align: right;
		white-space: nowrap;
	}

	.word.moved {
		color: var(--accent);
		font-weight: 700;
	}

	.foot {
		display: flex;
		flex: none;
		justify-content: flex-end;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 5) calc(var(--u) * 11);
		border-top: 1px solid var(--border-subtle);
		background: var(--surface-page);
	}

	.button {
		display: inline-flex;
		align-items: center;
		height: calc(var(--u) * 15);
		padding: 0 calc(var(--u) * 9);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 8);
		font-size: calc(var(--u) * 7);
		font-weight: 600;
	}

	.button.primary {
		border-color: var(--accent-fill);
		background: var(--accent-fill);
		color: var(--on-accent);
	}

	/* A phone: a full-height sheet, the voices two to a row, the footer's one
	   button the width of the sheet (✕ closes, so Cancel goes). */
	.phone {
		border-radius: calc(var(--u) * 10) calc(var(--u) * 10) 0 0;
	}

	.phone .voices {
		grid-template-columns: repeat(2, 1fr);
	}

	.phone .section {
		margin: calc(var(--u) * 6) 0 calc(var(--u) * 3);
	}

	.phone .style {
		height: calc(var(--u) * 12);
		padding: 0 calc(var(--u) * 5.5);
		font-size: calc(var(--u) * 6.5);
	}

	.phone .slider-row {
		grid-template-columns: 1fr calc(var(--u) * 52);
		gap: calc(var(--u) * 1) calc(var(--u) * 6);
		margin-bottom: calc(var(--u) * 5);
	}

	.phone .label {
		grid-column: 1;
	}

	.phone .slider {
		grid-column: 1 / -1;
		grid-row: 2;
	}

	.phone .word {
		grid-column: 2;
		grid-row: 1;
	}

	.phone .button.primary {
		flex: 1;
		justify-content: center;
	}
</style>
