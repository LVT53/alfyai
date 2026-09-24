<script lang="ts">
import { User } from "@lucide/svelte";
import { untrack } from "svelte";
import ScopeToken from "$lib/components/instructions/ScopeToken.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import {
	INSTRUCTIONS_MAX_CHARS,
	countInstructionChars,
	instructionScopeKey,
	normalizeInstructionText,
	type InstructionScope,
} from "$lib/shared/instructions";

// The one editing surface for both instruction scopes. Slice D opens it with
// a project scope and no changes; the Settings row opens it with a single
// scope and no switch. Nothing is ever saved without the user seeing the full
// text — which is why there is no "accept suggestion" path that writes
// straight to the API.
let {
	open,
	scope,
	scopes,
	initialText,
	appendedLine = null,
	appendedScope,
	onSave,
	onClose,
}: {
	open: boolean;
	/** Scope shown on open. */
	scope: InstructionScope;
	/** Every scope the user may switch to. One entry means no switch is rendered. */
	scopes: InstructionScope[];
	/** Current saved text per scope, keyed "personal" or `project:<id>`. */
	initialText: Record<string, string>;
	/** A new line to append and highlight. */
	appendedLine?: string | null;
	/** Where the appended line starts; switching moves it with the user. */
	appendedScope?: InstructionScope;
	/** Resolves to the saved text, or to a failure the dialog shows without closing. */
	onSave: (payload: {
		scope: InstructionScope;
		text: string;
	}) => Promise<{ ok: true } | { ok: false; error: string }>;
	onClose: () => void;
} = $props();

interface Seed {
	activeKey: string;
	buffer: string;
	texts: Record<string, string>;
	pendingLine: string | null;
	pendingKey: string | null;
}

/**
 * The state the dialog opens in. Pure, so the initial `$state` values and a
 * later re-open edge build the identical thing — an abandoned edit must not
 * survive a Cancel.
 */
function buildSeed(input: {
	scope: InstructionScope;
	scopes: InstructionScope[];
	initialText: Record<string, string>;
	appendedLine: string | null;
	appendedScope?: InstructionScope;
}): Seed {
	const pending = input.appendedLine?.trim() ?? "";
	const pendingLine = pending.length > 0 ? pending : null;
	const activeKey = instructionScopeKey(input.scope);
	const startKey = instructionScopeKey(input.appendedScope ?? input.scope);
	const keys = new Set<string>([
		activeKey,
		startKey,
		...input.scopes.map(instructionScopeKey),
	]);
	const texts: Record<string, string> = {};

	for (const key of keys) {
		const base = (input.initialText[key] ?? "").trim();
		texts[key] =
			pendingLine && key === startKey
				? base
					? `${base}\n${pendingLine}`
					: pendingLine
				: base;
	}

	return {
		activeKey,
		buffer: texts[activeKey] ?? "",
		texts,
		pendingLine,
		pendingKey: pendingLine ? startKey : null,
	};
}

// Captured once on purpose: this is the text the dialog opened with, not a
// live mirror of the parent's copy — the user is editing it from this point.
const seed = untrack(() =>
	buildSeed({ scope, scopes, initialText, appendedLine, appendedScope }),
);

let activeKey = $state(seed.activeKey);
/** The scope on screen. Only this one is ever saved. */
let buffer = $state(seed.buffer);
/** Every scope's text, so switching can put one down and pick one up. */
let texts = $state(seed.texts);
let pendingLine = $state(seed.pendingLine);
let pendingKey = $state(seed.pendingKey);
let errorMessage = $state("");
let saving = $state(false);

// Re-seeded whenever the dialog is opened again. Not reactive state: it is a
// latch for one transition, and making it reactive would put the seeding
// effect at war with the user's typing.
let seededForOpen = untrack(() => open);

let activeScope = $derived(
	scopes.find((entry) => instructionScopeKey(entry) === activeKey) ?? scope,
);
let scopeLabel = $derived(
	activeScope.kind === "project"
		? (activeScope.name ?? "")
		: $t("instructions.scopePersonal"),
);
let description = $derived(
	pendingLine
		? $t("instructions.appendedLine")
		: activeScope.kind === "project"
			? $t("instructions.descriptionProject")
			: $t("instructions.descriptionPersonal"),
);

// Counted through the shared rule, on the trimmed text the server will store —
// never `buffer.length`, which would call "👍" two characters and refuse a
// Hungarian text the server accepts.
let charCount = $derived(
	countInstructionChars(normalizeInstructionText(buffer) ?? ""),
);
let tooLong = $derived(charCount > INSTRUCTIONS_MAX_CHARS);

// The highlight is a mirror layer behind the textarea. The textarea keeps its
// own text (the mirror's is transparent), so the two must agree on wrapping
// and scroll position.
let markedSuffix = $derived(
	pendingLine && buffer.endsWith(pendingLine) ? pendingLine : null,
);
let markedBare = $derived(
	markedSuffix ? buffer.slice(0, buffer.length - markedSuffix.length) : buffer,
);

let textareaRef: HTMLTextAreaElement | null = $state(null);
let mirrorRef: HTMLDivElement | null = $state(null);
let mirrorWidth = $state(0);

/**
 * The mirror is a sibling, so a scrollbar takes width from the textarea's text
 * and none from the mirror's: without this, one line long enough to scroll and
 * every line after it drifts a whole scrollbar left of its own highlight.
 * `clientWidth` excludes borders, so add the two 1px ones back.
 */
function syncMirrorWidth() {
	if (!textareaRef) return;
	mirrorWidth = textareaRef.clientWidth + 2;
}

function syncMirrorScroll() {
	if (!textareaRef || !mirrorRef) return;
	mirrorRef.scrollTop = textareaRef.scrollTop;
}

/** Grows with the text up to 40vh, then scrolls — the sheet's own limit. */
function syncTextareaHeight() {
	if (!textareaRef || typeof window === "undefined") return;
	textareaRef.style.height = "auto";
	const cap = Math.round(window.innerHeight * 0.4);
	textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, cap)}px`;
}

function syncMirror() {
	syncTextareaHeight();
	syncMirrorWidth();
	syncMirrorScroll();
}

function applySeed() {
	const next = buildSeed({
		scope,
		scopes,
		initialText,
		appendedLine,
		appendedScope,
	});
	activeKey = next.activeKey;
	buffer = next.buffer;
	texts = next.texts;
	pendingLine = next.pendingLine;
	pendingKey = next.pendingKey;
	errorMessage = "";
	saving = false;
}

$effect(() => {
	if (!open) {
		seededForOpen = false;
		return;
	}
	if (seededForOpen) return;
	seededForOpen = true;
	applySeed();
});

$effect(() => {
	// Re-measured when the editor mounts, when the ref binds and on every
	// keystroke. The dependency reads are deliberate; the DOM reads inside
	// `syncMirror` are untracked so the width it writes cannot loop back.
	void open;
	void textareaRef;
	void buffer;
	untrack(() => syncMirror());
});

$effect(() => {
	if (!open) return;
	const onResize = () => syncMirror();
	window.addEventListener("resize", onResize);
	return () => window.removeEventListener("resize", onResize);
});

/**
 * Takes the pending line back out when the user leaves the scope it was
 * appended to, so switching back and forth does not stack copies of it. Text
 * the user typed around it is never touched.
 */
function stripPending(text: string, line: string): string {
	if (text === line) return "";
	if (text.endsWith(`\n${line}`)) {
		return text.slice(0, -(line.length + 1));
	}
	return text;
}

function switchTo(next: InstructionScope) {
	const nextKey = instructionScopeKey(next);
	if (nextKey === activeKey) return;

	const carried = pendingKey === activeKey ? pendingLine : null;
	const leaving = carried ? stripPending(buffer, carried) : buffer;
	const moved = { ...texts, [activeKey]: leaving };
	const base = moved[nextKey] ?? "";
	const target = carried ? (base ? `${base}\n${carried}` : carried) : base;

	texts = { ...moved, [nextKey]: target };
	buffer = target;
	pendingKey = carried ? nextKey : pendingKey;
	activeKey = nextKey;
	errorMessage = "";
}

async function handleSave() {
	if (tooLong || saving) return;
	saving = true;
	errorMessage = "";
	const result = await onSave({ scope: activeScope, text: buffer });
	saving = false;
	if (!result.ok) {
		// Stays open with the text intact: closing would throw away exactly
		// what the user just wrote and could not save.
		errorMessage = result.error || $t("instructions.saveFailed");
	}
}
</script>

{#if open}
	<DialogShell
		title={$t("instructions.title")}
		titleVisuallyHidden
		onClose={onClose}
		maxWidthClass="max-w-[560px]"
		phonePresentation="sheet"
	>
		<!-- The title pairs with the scope token, so the visible heading is
		     drawn here and the shell's own <h2> carries the accessible name. -->
		<div class="instructions-head">
			<!-- Same type as the shell's own <h2>, which this line replaces. -->
			<span class="text-xl font-semibold text-text-primary">{$t("instructions.title")}</span>
			<ScopeToken scope={activeScope} />
		</div>
		<p class="instructions-description">{description}</p>

		{#if scopes.length > 1}
			<div
				class="instructions-switch"
				data-testid="instructions-scope-switch"
				role="group"
				aria-label={$t("instructions.title")}
			>
				{#each scopes as entry (instructionScopeKey(entry))}
					{@const entryKey = instructionScopeKey(entry)}
					<button
						type="button"
						class="instructions-switch__entry"
						class:instructions-switch__entry--active={entryKey === activeKey}
						aria-pressed={entryKey === activeKey}
						onclick={() => switchTo(entry)}
					>
						{#if entry.kind === "project"}
							<ScopeToken scope={entry} />
						{:else}
							<!-- The switch names the scope in full ("Personal"), the token
							     in short ("You") — the mockup's split. The icon takes the
							     entry's own colour, so the selected one carries through. -->
							<User size={14} strokeWidth={1.75} aria-hidden="true" />
							{$t("instructions.scopePersonal")}
						{/if}
					</button>
				{/each}
			</div>
		{/if}

		<div class="instructions-editor">
			<div
				bind:this={mirrorRef}
				class="instructions-mirror instructions-type"
				aria-hidden="true"
				style={`width:${mirrorWidth}px`}
			>{markedBare}{#if markedSuffix}<mark>{markedSuffix}</mark>{/if}</div>
			<textarea
				bind:this={textareaRef}
				bind:value={buffer}
				rows={8}
				class="instructions-input instructions-type"
				data-testid="instructions-textarea"
				aria-label={$t("instructions.scopeA11y", { scope: scopeLabel })}
				onscroll={syncMirrorScroll}
			></textarea>
		</div>

		{#if tooLong}
			<p class="instructions-error" data-testid="instructions-too-long">
				{$t("instructions.tooLong", { max: INSTRUCTIONS_MAX_CHARS })}
			</p>
		{/if}
		{#if errorMessage}
			<p
				class="instructions-error"
				data-testid="instructions-error"
				role="alert"
			>
				{errorMessage}
			</p>
		{/if}

		{#snippet footer()}
			<span class="instructions-counter" data-testid="instructions-counter">
				{$t("instructions.counter", {
					count: charCount,
					max: INSTRUCTIONS_MAX_CHARS,
				})}
			</span>
			<span class="instructions-actions">
				<button type="button" class="btn-secondary" onclick={onClose}>
					{$t("instructions.cancel")}
				</button>
				<button
					type="button"
					class="btn-primary"
					disabled={tooLong || saving}
					onclick={handleSave}
				>
					{$t("instructions.save")}
				</button>
			</span>
		{/snippet}
	</DialogShell>
{/if}

<style>
	.instructions-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.25rem;
	}

	.instructions-description {
		margin: 0 0 var(--space-md, 0.75rem);
		font-size: var(--text-sm);
		line-height: 1.45;
		color: var(--text-muted);
	}

	.instructions-switch {
		display: inline-flex;
		gap: 2px;
		margin-bottom: var(--space-md, 0.75rem);
		padding: 2px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.instructions-switch__entry {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 11px;
		border: 0;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.instructions-switch__entry:hover {
		color: var(--text-primary);
	}

	.instructions-switch__entry:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.instructions-switch__entry--active {
		background: var(--surface-page);
		color: var(--text-primary);
		font-weight: 600;
		box-shadow: 0 0 0 1px var(--border-subtle, var(--border-default));
	}

	/* ── The editor ───────────────────────────────────────────────────
	   One textarea, and behind it a mirror div that draws nothing but the
	   highlight for the pending line. The two share `.instructions-type`, so
	   their font metrics, padding and border are the same declarations rather
	   than two lists that can drift apart. */
	.instructions-editor {
		position: relative;
	}

	.instructions-type {
		box-sizing: border-box;
		margin: 0;
		padding: 12px 14px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.6;
		letter-spacing: normal;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: normal;
		tab-size: 4;
	}

	.instructions-mirror {
		position: absolute;
		inset: 0;
		overflow: hidden;
		background: var(--surface-elevated);
		color: transparent;
		pointer-events: none;
		user-select: none;
	}

	.instructions-mirror :global(mark) {
		border-radius: 3px;
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: transparent;
	}

	.instructions-input {
		position: relative;
		z-index: 1;
		display: block;
		width: 100%;
		min-height: 12.8em;
		max-height: 40vh;
		overflow-y: auto;
		background: transparent;
		color: var(--text-primary);
		resize: none;
	}

	.instructions-input:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.instructions-error {
		margin: var(--space-sm, 0.5rem) 0 0;
		font-size: var(--text-xs);
		color: var(--danger);
	}

	/* ── The footer ───────────────────────────────────────────────────
	   Counter left, buttons right — the shell lays the two children out. */
	.instructions-counter {
		font-size: var(--text-xs);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.instructions-actions {
		display: flex;
		gap: var(--space-sm, 0.5rem);
	}
</style>
