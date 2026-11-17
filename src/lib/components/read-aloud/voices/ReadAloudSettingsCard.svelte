<script lang="ts">
/**
 * The Read aloud card in Settings (spec §4.6, §4.7): which voice reads each
 * language, the speed every reading starts at, and the person's own voices,
 * each with ▶ and Edit, and "New voice". It loads its own data (Plan 3,
 * Decision 15) and saves each choice when it changes; a failed save puts the
 * select back and says so. It is drawn only while read aloud is on.
 */
import { onDestroy, untrack } from "svelte";
import { Plus, TriangleAlert } from "@lucide/svelte";
import {
	fetchReadAloudVoices,
	type PersonalVoiceInfo,
	type ReadAloudVoiceSettings,
	saveReadAloudChoice,
	type VoiceChoice,
} from "$lib/client/api/read-aloud-voices";
import {
	disposeVoicePreview,
	getVoicePreview,
	type PreviewSound,
	type VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { type I18nKey, t } from "$lib/i18n";
import {
	READING_SPEEDS,
	summaryKnobs,
	knobWordIndex,
	ZERO_KNOBS,
} from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import { readAloudAvailable } from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudNote from "../ReadAloudNote.svelte";
import VoiceEditor from "./VoiceEditor.svelte";
import VoicePlayButton from "./VoicePlayButton.svelte";

let { preview = undefined }: { preview?: VoicePreview } = $props();

const LANGUAGES = ["en", "hu"] as const;
type Language = (typeof LANGUAGES)[number];

let settings = $state<ReadAloudVoiceSettings | null>(null);
let loading = $state(false);
let loadFailed = $state(false);
/** The save that failed, to send again from Try again. */
let failedSave = $state<{
	en?: string;
	hu?: string;
	defaultSpeed?: number;
} | null>(null);
let editor = $state<{
	voice: PersonalVoiceInfo | null;
	startFrom: string;
} | null>(null);
function player(): VoicePreview {
	return preview ?? getVoicePreview();
}

async function load() {
	loading = true;
	loadFailed = false;
	try {
		settings = await fetchReadAloudVoices();
	} catch {
		loadFailed = true;
	} finally {
		loading = false;
	}
}

// Loads once read aloud is on (the shell seeds it on mount).
$effect(() => {
	if (!$readAloudAvailable) return;
	untrack(() => {
		if (!settings && !loading) void load();
	});
});

// Leaving Settings stops whatever ▶ started (a voice's row, the editor) and frees the
// kept renders. The app's preview is freed only if something made it.
onDestroy(() => {
	if (preview) preview.dispose();
	else disposeVoicePreview();
});

const builtInOf = (language: Language) =>
	settings?.builtIn.filter((voice) => voice.language === language) ?? [];
const voicesOf = (language: Language) =>
	settings?.voices.filter((voice) => voice.language === language) ?? [];

/** A voice's description ("British woman"), or nothing for a voice the words do not know. */
function describe(key: string): string {
	const wordKey = `readAloud.voice.${key}`;
	const text = $t(wordKey as I18nKey);
	return text === wordKey ? "" : text;
}

function optionLabel(name: string, key: string): string {
	const description = describe(key);
	return description
		? $t("readAloud.voice.option", { name, description })
		: name;
}

/** The language's default built-in voice (Imogen, Berta). */
function defaultBase(language: Language): string {
	return builtInOf(language)[0]?.key ?? "";
}

/** "slower, a little fuller, very calm, softer", or "unchanged". */
function summary(voice: PersonalVoiceInfo): string {
	const moved = summaryKnobs(voice.knobs);
	if (moved.length === 0) return $t("readAloud.settings.unchanged");
	return moved
		.map((key) =>
			$t(
				`readAloud.knob.${key}.${knobWordIndex(key, voice.knobs[key])}` as I18nKey,
			).toLocaleLowerCase($uiLanguage),
		)
		.join(", ");
}

/** A saved voice saying its language's sample; one whose base is gone plays its language's default, plainly. */
function voiceSound(voice: PersonalVoiceInfo): PreviewSound {
	return {
		owner: `voice:${voice.id}`,
		request: voice.baseMissing
			? { base: defaultBase(voice.language), knobs: { ...ZERO_KNOBS } }
			: { base: voice.base, knobs: { ...voice.knobs } },
		sentences: VOICE_SAMPLES[voice.language],
	};
}

function formatSpeed(speed: number): string {
	return `${new Intl.NumberFormat($uiLanguage).format(speed)}×`;
}

async function save(next: { en?: string; hu?: string; defaultSpeed?: number }) {
	if (!settings) return;
	const before = {
		choice: { ...settings.choice },
		defaultSpeed: settings.defaultSpeed,
	};
	failedSave = null;
	if (next.en !== undefined) settings.choice.en = next.en;
	if (next.hu !== undefined) settings.choice.hu = next.hu;
	if (next.defaultSpeed !== undefined)
		settings.defaultSpeed = next.defaultSpeed;
	try {
		const saved = await saveReadAloudChoice(next);
		if (!settings) return;
		settings.choice = saved.choice;
		settings.defaultSpeed = saved.defaultSpeed;
	} catch {
		if (!settings) return;
		// Put back only what this save changed: a later save may have changed the rest.
		if (next.en !== undefined) settings.choice.en = before.choice.en;
		if (next.hu !== undefined) settings.choice.hu = before.choice.hu;
		if (next.defaultSpeed !== undefined)
			settings.defaultSpeed = before.defaultSpeed;
		failedSave = next;
	}
}

/** A new voice starts from the base of the person's voice for the UI language (Plan 3, Decision 9). */
function newVoiceBase(): string {
	const language: Language = $uiLanguage === "hu" ? "hu" : "en";
	const chosen = settings?.choice[language] ?? "";
	if (builtInOf(language).some((voice) => voice.key === chosen)) return chosen;
	const own = settings?.voices.find((voice) => voice.id === chosen);
	if (own && !own.baseMissing) return own.base;
	return defaultBase(language);
}

function openNew() {
	player().unlock();
	editor = { voice: null, startFrom: newVoiceBase() };
}

function openEdit(voice: PersonalVoiceInfo) {
	player().unlock();
	editor = { voice, startFrom: voice.base };
}

function onSaved(voice: PersonalVoiceInfo, replacedId: string | null) {
	if (settings) {
		settings.voices = replacedId
			? settings.voices.map((entry) =>
					entry.id === replacedId ? voice : entry,
				)
			: [...settings.voices, voice];
	}
	editor = null;
}

function onDeleted(id: string, choice: VoiceChoice) {
	if (settings) {
		settings.voices = settings.voices.filter((entry) => entry.id !== id);
		settings.choice = choice;
	}
	editor = null;
}
</script>

{#if $readAloudAvailable}
	<section class="settings-card read-aloud-card" id="settings-section-read-aloud">
		<div class="settings-card-head">
			<div class="settings-card-head-text">
				<h2 class="settings-card-title">{$t("readAloud.settings.title")}</h2>
				<p class="settings-card-desc">{$t("readAloud.settings.desc")}</p>
			</div>
		</div>

		{#if loadFailed}
			<ReadAloudNote
				tone="warn"
				icon="alert"
				text={$t("readAloud.settings.loadFailed")}
				actionLabel={$t("readAloud.tryAgain")}
				onAction={load}
				placement="inline"
			/>
		{:else}
			<div class="settings-rows">
				{#each LANGUAGES as language (language)}
					{@const label = $t(
						language === "en" ? "readAloud.settings.englishVoice" : "readAloud.settings.hungarianVoice",
					)}
					<div class="settings-row settings-row--stack">
						<div class="settings-row-text">
							<p class="settings-row-label">{label}</p>
						</div>
						<div class="settings-row-control">
							<select
								class="settings-select"
								aria-label={label}
								disabled={!settings}
								value={settings?.choice[language] ?? ""}
								onchange={(event) => save({ [language]: event.currentTarget.value })}
							>
								{#if settings}
									<optgroup label={$t("readAloud.settings.builtIn")}>
										{#each builtInOf(language) as voice (voice.key)}
											<option value={voice.key}>{optionLabel(voice.name, voice.key)}</option>
										{/each}
									</optgroup>
									{#if voicesOf(language).length > 0}
										<optgroup label={$t("readAloud.settings.yours")}>
											{#each voicesOf(language) as voice (voice.id)}
												<option value={voice.id}>{voice.name}</option>
											{/each}
										</optgroup>
									{/if}
								{:else}
									<option value=""></option>
								{/if}
							</select>
						</div>
					</div>
				{/each}
				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t("readAloud.settings.defaultSpeed")}</p>
						<p class="settings-row-help">{$t("readAloud.settings.defaultSpeedHelp")}</p>
					</div>
					<div class="settings-row-control">
						<select
							class="settings-select"
							aria-label={$t("readAloud.settings.defaultSpeed")}
							disabled={!settings}
							value={String(settings?.defaultSpeed ?? 1)}
							onchange={(event) => save({ defaultSpeed: Number(event.currentTarget.value) })}
						>
							{#each READING_SPEEDS as speed (speed)}
								<option value={String(speed)}>{formatSpeed(speed)}</option>
							{/each}
						</select>
					</div>
				</div>
			</div>

			{#if failedSave}
				{@const retry = failedSave}
				<ReadAloudNote
					tone="warn"
					icon="alert"
					text={$t("readAloud.settings.saveFailed")}
					actionLabel={$t("readAloud.tryAgain")}
					onAction={() => save(retry)}
					placement="inline"
				/>
			{/if}

			<div class="read-aloud-voices">
				<div class="read-aloud-voices-head">
					<h3 class="read-aloud-voices-title">{$t("readAloud.settings.yourVoices")}</h3>
					<button type="button" class="btn-secondary read-aloud-new" disabled={!settings} onclick={openNew}>
						<Plus size={14} strokeWidth={2} aria-hidden="true" />
						{$t("readAloud.settings.newVoice")}
					</button>
				</div>
				{#if settings && settings.voices.length === 0}
					<p class="read-aloud-voices-empty">{$t("readAloud.settings.empty")}</p>
				{:else if settings}
					<ul class="read-aloud-voice-list">
						{#each settings.voices as voice (voice.id)}
							<li class="read-aloud-voice">
								<div class="read-aloud-voice-row">
									<VoicePlayButton
										sound={voiceSound(voice)}
										label={$t("readAloud.voice.play", { name: voice.name })}
										pauseLabel={$t("readAloud.voice.pause", { name: voice.name })}
										{preview}
									/>
									<div class="read-aloud-voice-text">
										<span class="read-aloud-voice-name">{voice.name}</span>
										<span class="read-aloud-voice-from"
											>{$t("readAloud.settings.from", { voice: voice.baseName })} · {summary(voice)}</span
										>
									</div>
									<button
										type="button"
										class="btn-ghost read-aloud-voice-edit"
										aria-label={$t("readAloud.settings.editVoice", { name: voice.name })}
										onclick={() => openEdit(voice)}
									>
										{$t("readAloud.settings.edit")}
									</button>
								</div>
								{#if voice.baseMissing}
									<p class="read-aloud-voice-missing">
										<TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
										<span
											>{$t(
												voice.language === "hu"
													? "readAloud.settings.baseMissingHu"
													: "readAloud.settings.baseMissingEn",
												{ voice: voice.baseName },
											)}</span
										>
									</p>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</section>

	{#if editor && settings}
		<VoiceEditor
			builtIn={settings.builtIn}
			voice={editor.voice}
			startFrom={editor.startFrom}
			onClose={() => (editor = null)}
			{onSaved}
			{onDeleted}
			{preview}
		/>
	{/if}
{/if}

<style>
	.read-aloud-voices {
		display: flex;
		flex-direction: column;
		margin-top: 4px;
		padding-top: 12px;
		border-top: 1px solid var(--border-subtle);
	}

	.read-aloud-voices-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 6px;
	}

	.read-aloud-voices-title {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 13.5px;
		font-weight: 600;
	}

	.read-aloud-new {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.read-aloud-voices-empty {
		margin: 0;
		padding: 6px 0 4px;
		color: var(--text-muted);
		font-size: 12.5px;
		line-height: 1.5;
	}

	.read-aloud-voice-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.read-aloud-voice + .read-aloud-voice {
		border-top: 1px dashed var(--border-subtle);
	}

	.read-aloud-voice-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 0;
	}

	.read-aloud-voice-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	.read-aloud-voice-name {
		overflow: hidden;
		color: var(--text-primary);
		font-size: 13.5px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.read-aloud-voice-from {
		color: var(--text-muted);
		font-size: 12px;
	}

	.read-aloud-voice-missing {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: -2px 0 8px 42px;
		color: var(--warning-text);
		font-size: 12px;
		line-height: 1.45;
	}

	.read-aloud-voice-missing :global(svg) {
		flex: none;
		margin-top: 1px;
	}

	@media (max-width: 639px) {
		.read-aloud-voice-row {
			min-height: 52px;
		}

		.read-aloud-voice-missing {
			margin-left: 0;
		}
	}
</style>
