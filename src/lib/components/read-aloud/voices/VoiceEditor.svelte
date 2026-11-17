<script lang="ts">
/**
 * The voice editor (spec §4.6; the approved `voice-editor-prototype.html`): start
 * from a built-in voice, pick a style, shape it with five knobs, listen, name it
 * and save. A dialog on desktop, a full sheet on a phone.
 *
 * A change (a voice picked; a knob let go, or a key settled for 400 ms; a style,
 * ↺ or Reset all once its 260 ms animation ends) goes back to "Yours", renews the
 * suggested name until the person types one, and plays the voice when "Play
 * after each change" is on. Yours / Original always plays. Unsaved changes go
 * when it closes, and the sound stops.
 */
import { onMount, untrack } from "svelte";
import { X } from "@lucide/svelte";
import {
	type BuiltInVoiceInfo,
	createReadAloudVoice,
	deleteReadAloudVoice,
	type PersonalVoiceInfo,
	refusalCode,
	updateReadAloudVoice,
	type VoiceChoice,
} from "$lib/client/api/read-aloud-voices";
import {
	getVoicePreview,
	listenSound,
	type VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { suggestVoiceName } from "$lib/client/read-aloud/voice-name";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import {
	clipVoiceName,
	KNOB_KEYS,
	KNOBS,
	type KnobKey,
	type Knobs,
	STYLES,
	type StyleKey,
	VOICE_NAME_MAX,
	ZERO_KNOBS,
} from "$lib/shared/read-aloud/voice-knobs";
import { ownWords } from "$lib/shared/read-aloud/voice-samples";
import { uiLanguage } from "$lib/stores/settings";
import { prefersReducedMotion } from "$lib/utils/motion";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import ReadAloudNote from "../ReadAloudNote.svelte";
import VoiceBasePicker from "./VoiceBasePicker.svelte";
import VoiceKnobSlider from "./VoiceKnobSlider.svelte";
import VoiceListen from "./VoiceListen.svelte";
import VoiceStyleChips from "./VoiceStyleChips.svelte";

let {
	builtIn,
	voice,
	startFrom,
	onClose,
	onSaved,
	onDeleted,
	preview = undefined,
}: {
	builtIn: BuiltInVoiceInfo[];
	voice: PersonalVoiceInfo | null;
	startFrom: string;
	onClose: () => void;
	onSaved: (voice: PersonalVoiceInfo, replacedId: string | null) => void;
	onDeleted: (id: string, choice: VoiceChoice) => void;
	preview?: VoicePreview;
} = $props();

/** A style's knobs move over this long (the prototype's `animateTo`). */
const ANIMATION_MS = 260;
/** A key's change renders once no other key has come for this long (Plan 3, Decision 11). */
const KEY_SETTLE_MS = 400;

const id = $props.id();
const player = () => preview ?? getVoicePreview();

/** The language's first built-in voice: its default (Imogen, Berta). */
function defaultBase(language: "en" | "hu"): string {
	return (
		builtIn.find((entry) => entry.language === language)?.key ??
		builtIn[0]?.key ??
		""
	);
}

// The editor edits a copy: the props are read once, when it opens.
const opened = untrack(() => ({ voice, startFrom }));
// A voice whose base was removed opens on its language's default voice, knobs kept (Decision 14).
let base = $state(
	untrack(() =>
		opened.voice
			? opened.voice.baseMissing ||
				!builtIn.some((entry) => entry.key === opened.voice?.base)
				? defaultBase(opened.voice.language)
				: opened.voice.base
			: opened.startFrom,
	),
);
let knobs = $state<Knobs>(
	opened.voice ? { ...opened.voice.knobs } : { ...ZERO_KNOBS },
);
let name = $state(opened.voice?.name ?? "");
let nameTouched = $state(opened.voice !== null);
let compare = $state<"yours" | "original">("yours");
let playAfterChange = $state(true);
let useOwnWords = $state(false);
let words = $state("");
let saving = $state(false);
let note = $state<null | "saveFailed" | "deleteFailed" | "tooMany">(null);
let lastSave: "update" | "create" = "create";
let confirmingDelete = $state(false);
let isPhone = $state(isPhoneViewport());

const baseInfo = $derived(
	builtIn.find((entry) => entry.key === base) ??
		builtIn[0] ?? { key: base, name: base, language: "en" as const },
);
const suggested = $derived(
	suggestVoiceName({
		voiceName: baseInfo.name,
		knobs,
		t: $t,
		locale: $uiLanguage === "hu" ? "hu" : "en",
	}),
);
const shownName = $derived(nameTouched ? name : suggested);

function currentSound() {
	return listenSound({
		base: baseInfo,
		knobs: { ...knobs },
		compare,
		words: useOwnWords ? ownWords(words) : null,
	});
}

/** A change: back to Yours, and the voice plays when the person asked for that. */
function changed() {
	compare = "yours";
	if (playAfterChange) player().play(currentSound());
}

let animation: number | null = null;
let keyTimer: ReturnType<typeof setTimeout> | null = null;

function cancelAnimation() {
	if (animation !== null) cancelAnimationFrame(animation);
	animation = null;
}

/** Moves the knobs to `target` over 260 ms on the 0.05 grid, eased 1 − (1 − t)³; at once under reduced motion. */
function animateTo(target: Knobs) {
	cancelAnimation();
	if (keyTimer) clearTimeout(keyTimer);
	keyTimer = null;
	if (prefersReducedMotion()) {
		for (const key of KNOB_KEYS) knobs[key] = target[key];
		changed();
		return;
	}
	const from = { ...knobs };
	const started = performance.now();
	const step = (now: number) => {
		const progress = Math.min(1, Math.max(0, (now - started) / ANIMATION_MS));
		const eased = 1 - (1 - progress) ** 3;
		for (const key of KNOB_KEYS)
			knobs[key] =
				Math.round((from[key] + (target[key] - from[key]) * eased) * 20) / 20;
		if (progress < 1) {
			animation = requestAnimationFrame(step);
			return;
		}
		animation = null;
		for (const key of KNOB_KEYS) knobs[key] = target[key];
		changed();
	};
	animation = requestAnimationFrame(step);
}

function pickBase(key: string) {
	base = key;
	changed();
}

function pickStyle(style: StyleKey) {
	const target = STYLES.find((entry) => entry.key === style)?.knobs;
	if (target) animateTo({ ...target });
}

function onKnobInput(key: KnobKey, value: number) {
	cancelAnimation();
	knobs[key] = value;
}

function onKnobCommit(key: KnobKey, value: number, via: "pointer" | "key") {
	cancelAnimation();
	knobs[key] = value;
	if (keyTimer) clearTimeout(keyTimer);
	keyTimer = null;
	if (via === "pointer") {
		changed();
		return;
	}
	keyTimer = setTimeout(() => {
		keyTimer = null;
		changed();
	}, KEY_SETTLE_MS);
}

function onCompare(next: "yours" | "original") {
	compare = next;
	const p = player();
	p.unlock();
	p.play(currentSound());
}

function close() {
	cancelAnimation();
	if (keyTimer) clearTimeout(keyTimer);
	keyTimer = null;
	player().stop();
	onClose();
}

async function save(kind: "update" | "create") {
	if (saving) return;
	saving = true;
	note = null;
	lastSave = kind;
	const draft = {
		name: clipVoiceName(name) || suggested,
		base,
		knobs: { ...knobs },
	};
	if (!nameTouched) draft.name = suggested;
	try {
		const editing = kind === "update" ? opened.voice : null;
		const saved = editing
			? await updateReadAloudVoice(editing.id, draft)
			: await createReadAloudVoice(draft);
		saving = false;
		player().stop();
		onSaved(saved, editing ? editing.id : null);
	} catch (error) {
		saving = false;
		note = refusalCode(error) === "too_many" ? "tooMany" : "saveFailed";
	}
}

async function remove() {
	const editing = opened.voice;
	confirmingDelete = false;
	if (!editing || saving) return;
	saving = true;
	note = null;
	try {
		const choice = await deleteReadAloudVoice(editing.id);
		saving = false;
		player().stop();
		onDeleted(editing.id, choice);
	} catch {
		saving = false;
		note = "deleteFailed";
	}
}

onMount(() => {
	const stopWatching = watchPhoneViewport((phone) => (isPhone = phone));
	return () => {
		stopWatching();
		cancelAnimation();
		if (keyTimer) clearTimeout(keyTimer);
	};
});
</script>

<DialogShell
	title={opened.voice ? $t("readAloud.editor.editTitle") : $t("readAloud.editor.newTitle")}
	onClose={close}
	titleVisuallyHidden
	phonePresentation="fullSheet"
	maxWidthClass="max-w-[600px]"
>
	<!-- The prototype's head: the title and ✕. The shell's own <h2> keeps the
	     accessible name; editing has no Cancel, so ✕ is how a mouse leaves. -->
	<div class="voice-editor-head">
		<span class="voice-editor-title" aria-hidden="true">
			{opened.voice ? $t("readAloud.editor.editTitle") : $t("readAloud.editor.newTitle")}
		</span>
		<button type="button" class="btn-icon-bare voice-editor-close" aria-label={$t("common.close")} onclick={close}>
			<X size={18} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
	<div class="voice-editor">
		<section class="voice-editor-section">
			<h3 class="voice-editor-label">{$t("readAloud.editor.startFrom")}</h3>
			<VoiceBasePicker {builtIn} selected={base} onSelect={pickBase} {preview} />
		</section>

		<section class="voice-editor-section">
			<h3 class="voice-editor-label">{$t("readAloud.editor.style")}</h3>
			<VoiceStyleChips {knobs} onPick={pickStyle} />
		</section>

		<section class="voice-editor-section">
			<div class="voice-editor-label-row">
				<h3 class="voice-editor-label">{$t("readAloud.editor.shape")}</h3>
				<button type="button" class="voice-editor-quiet" onclick={() => animateTo({ ...ZERO_KNOBS })}>
					{$t("readAloud.editor.resetAll")}
				</button>
			</div>
			<div class="voice-editor-knobs">
				{#each KNOBS as spec (spec.key)}
					<VoiceKnobSlider
						{spec}
						value={knobs[spec.key]}
						onInput={(value) => onKnobInput(spec.key, value)}
						onCommit={(value, via) => onKnobCommit(spec.key, value, via)}
						onReset={() => animateTo({ ...knobs, [spec.key]: 0 })}
					/>
				{/each}
			</div>
		</section>

		<section class="voice-editor-section">
			<h3 class="voice-editor-label">{$t("readAloud.editor.listen")}</h3>
			<VoiceListen
				base={baseInfo}
				{knobs}
				{compare}
				{onCompare}
				{playAfterChange}
				onPlayAfterChange={(on) => (playAfterChange = on)}
				{useOwnWords}
				onUseOwnWords={(on) => (useOwnWords = on)}
				{words}
				onWords={(text) => (words = text)}
				{preview}
			/>
		</section>

		<section class="voice-editor-section">
			<label class="voice-editor-label" for="{id}-name">{$t("readAloud.editor.name")}</label>
			<input
				id="{id}-name"
				class="voice-editor-name"
				type="text"
				maxlength={VOICE_NAME_MAX}
				value={shownName}
				oninput={(event) => {
					name = event.currentTarget.value;
					nameTouched = true;
				}}
			/>
		</section>

		{#if note === "saveFailed"}
			<ReadAloudNote
				tone="warn"
				icon="alert"
				text={$t("readAloud.editor.saveFailed")}
				actionLabel={$t("readAloud.tryAgain")}
				onAction={() => save(lastSave)}
				placement="inline"
			/>
		{:else if note === "deleteFailed"}
			<ReadAloudNote
				tone="warn"
				icon="alert"
				text={$t("readAloud.editor.deleteFailed")}
				actionLabel={$t("readAloud.tryAgain")}
				onAction={remove}
				placement="inline"
			/>
		{:else if note === "tooMany"}
			<ReadAloudNote tone="calm" icon="alert" text={$t("readAloud.editor.tooMany")} placement="inline" />
		{/if}
	</div>

	{#snippet footer()}
		{#if opened.voice}
			<button
				type="button"
				class="voice-editor-delete"
				disabled={saving}
				onclick={() => (confirmingDelete = true)}
			>
				{$t("readAloud.editor.delete")}
			</button>
			<span class="voice-editor-actions">
				<button type="button" class="btn-secondary" disabled={saving} onclick={() => save("create")}>
					{$t("readAloud.editor.saveAsNew")}
				</button>
				<button type="button" class="btn-primary" disabled={saving} onclick={() => save("update")}>
					{$t("readAloud.editor.saveChanges")}
				</button>
			</span>
		{:else}
			{#if !isPhone}
				<button type="button" class="btn-secondary" onclick={close}>
					{$t("readAloud.editor.cancel")}
				</button>
			{/if}
			<button type="button" class="btn-primary" disabled={saving} onclick={() => save("create")}>
				{$t("readAloud.editor.save")}
			</button>
		{/if}
	{/snippet}
</DialogShell>

{#if confirmingDelete && opened.voice}
	<ConfirmDialog
		title={$t("readAloud.editor.deleteTitle")}
		message={$t("readAloud.editor.deleteMessage", {
			name: opened.voice.name,
			voice: opened.voice.baseName,
		})}
		confirmText={$t("readAloud.editor.delete")}
		cancelText={$t("readAloud.editor.cancel")}
		confirmVariant="danger"
		initialFocus="cancel"
		onConfirm={remove}
		onCancel={() => (confirmingDelete = false)}
	/>
{/if}

<style>
	/* The head stays at the top while the editor scrolls (the prototype's sticky
	   head): over the centred panel's top padding, or at the sheet body's top. */
	.voice-editor-head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin: 0 -8px 10px 0;
		padding: 6px 0 6px;
		background: var(--surface-page);
	}

	:global(.dialog-shell__panel) .voice-editor-head {
		top: calc(-1 * var(--space-lg));
		margin-top: calc(-1 * var(--space-lg));
		padding-top: calc(var(--space-lg) - 4px);
	}

	.voice-editor-title {
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.4;
	}

	.voice-editor-close {
		flex: none;
	}

	.voice-editor {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding-bottom: 4px;
	}

	.voice-editor-section {
		display: flex;
		flex-direction: column;
	}

	.voice-editor-label {
		margin: 0 0 8px;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.voice-editor-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.voice-editor-quiet {
		margin: -6px -4px 2px 0;
		padding: 6px 4px;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 12.5px;
		cursor: pointer;
	}

	.voice-editor-quiet:hover {
		color: var(--text-primary);
	}

	.voice-editor-quiet:focus-visible,
	.voice-editor-delete:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	.voice-editor-knobs {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.voice-editor-name {
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

	.voice-editor-name:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.voice-editor-delete {
		padding: 6px 4px;
		border: 0;
		background: transparent;
		color: var(--danger);
		font-family: var(--font-sans);
		font-size: 13px;
		cursor: pointer;
	}

	.voice-editor-delete:hover:not(:disabled) {
		color: var(--danger-hover);
	}

	.voice-editor-actions {
		display: flex;
		gap: var(--space-sm, 0.5rem);
	}

	@media (max-width: 639px) {
		.voice-editor-name {
			font-size: 16px;
		}

		.voice-editor-actions {
			flex: 1;
			justify-content: flex-end;
		}
	}
</style>
