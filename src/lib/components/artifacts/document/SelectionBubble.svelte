<script lang="ts">
/**
 * The floating "Ask Alfy" / "Comment" pill a text selection raises, and the
 * composer it grows into (redesign.md §4.2 items 1–2, §4.3–4.5, §7.2 #7–9,
 * Wave 2.5 Step 9). Purely presentational and Tiptap-free:
 * `DocumentBody.svelte` computes `position` from the live selection
 * (`document-editor.ts`'s `readSelectionAnchorContext` plus
 * `bubble-placement.ts`'s `computeBubblePlacement`, now sized for the grown
 * composer — `COMPOSER_BUBBLE_SIZE`) and owns the actual
 * `createArtifactComment`/`askAlfyInComment` calls behind `onSubmit`. This
 * file only knows "the user typed this, in this mode, and pressed send" —
 * `onSubmit`'s `body` already carries the `@Alfy` mention Ask mode implies
 * (prefixed here, transparently, exactly like the ORIGINAL prefill trick
 * this redesign replaces — see below) or that Comment mode's own typed text
 * happens to contain, so `DocumentBody.svelte`'s existing `mentionsAlfy(body)`
 * check (unchanged) still decides whether to also run the Ask-Alfy reply.
 *
 * `placement` picks the anchor transform: "above" anchors the bubble's
 * bottom-center at `position`; "below" (no room above) anchors the
 * top-center instead — decided ONCE by the caller from real geometry, only
 * rendered here.
 *
 * Phones get an entirely different presentation (redesign §4.3's "Phone"
 * row): a full-width docked bar instead of the floating pill, and the
 * composer opens in a `DialogShell` sheet instead of growing in place —
 * chosen through `$lib/utils/viewport.svelte.ts`'s own `isPhoneViewport`/
 * `watchPhoneViewport` (purpose-built for exactly this: "a dialog cannot
 * assume anyone has [started tracking]... this attaches its own listeners").
 * Both trigger-button and composer-field markup are shared snippets so the
 * two presentations can never drift into two different flows.
 */
import { MessageSquare, Sparkles } from "@lucide/svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t, type I18nKey } from "$lib/i18n";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";

const QUOTE_MAX_CHARS = 44;

const SUGGESTION_CHIPS: readonly I18nKey[] = [
	"artifacts.document.comment.chipLessList",
	"artifacts.document.comment.chipShorter",
	"artifacts.document.comment.chipFriendlier",
	"artifacts.document.comment.chipHungarian",
];

let {
	position,
	quote,
	onSubmit,
	onDismiss,
}: {
	position: { x: number; y: number; placement?: "above" | "below" };
	/** The raw selected text (`readSelectionAnchorContext`'s own `quote`) — truncated here for display, never by the caller. */
	quote: string;
	/**
	 * `body` already carries the mode's own `@Alfy` semantics (see this
	 * file's header). `sourceRect` is this composer's own on-screen rect at
	 * the moment of sending — `null` on a phone (the sheet has nothing to
	 * travel from) — for the caller's own "composer travels to the margin"
	 * animation (motion #9); reduced motion is the caller's decision, not
	 * this component's.
	 */
	onSubmit: (body: string, sourceRect: DOMRect | null) => void | Promise<void>;
	onDismiss: () => void;
} = $props();

let mode = $state<"pill" | "ask" | "comment">("pill");
let draftText = $state("");
let posting = $state(false);
// Read synchronously at init (never inside an `$effect`) so the very FIRST
// render already picks the right presentation — an effect only runs after
// mount, which would render the desktop pill for one frame on a phone.
let isPhone = $state(isPhoneViewport());
let rootEl = $state<HTMLDivElement | undefined>();
let textareaEl = $state<HTMLTextAreaElement | undefined>();

$effect(() => {
	return watchPhoneViewport((next) => {
		isPhone = next;
	});
});

// Composer: "focus starts in the textarea" (redesign §4.4). The phone sheet's
// own `DialogShell` runs its own focus trap/initial-focus handling, so this
// only drives the desktop inline composer.
$effect(() => {
	if (mode !== "pill" && !isPhone) textareaEl?.focus();
});

// Shortcut: ⌘/Ctrl+Alt+M opens the Comment composer directly (redesign
// §4.4's "the Google Docs convention"), while a selection (this component's
// own mount) is active.
// Window-level (not just the pill's own `onkeydown`) so Escape dismisses the
// pill/docked bar regardless of where focus actually is — the pill's own
// buttons are never auto-focused (redesign §4.4: focus only moves in on Tab),
// so a local listener alone would miss the common case of the editor itself
// still holding focus while the pill merely floats beside the selection.
$effect(() => {
	function onWindowKeydown(event: KeyboardEvent): void {
		if (mode !== "pill") return;
		if (event.key === "Escape") {
			event.preventDefault();
			onDismiss();
			return;
		}
		if (!(event.metaKey || event.ctrlKey) || !event.altKey) return;
		if (event.key.toLowerCase() !== "m") return;
		event.preventDefault();
		openComment();
	}
	window.addEventListener("keydown", onWindowKeydown);
	return () => window.removeEventListener("keydown", onWindowKeydown);
});

let anchorTransform = $derived(
	position.placement === "below"
		? "translate(-50%, 0%)"
		: "translate(-50%, -100%)",
);

let truncatedQuote = $derived.by(() => {
	const trimmed = quote.trim().replace(/\s+/g, " ");
	return trimmed.length > QUOTE_MAX_CHARS
		? `${trimmed.slice(0, QUOTE_MAX_CHARS).trimEnd()}…`
		: trimmed;
});

/** Comment mode's own "@Alfy switch" (redesign §4.2 item 2: "typing @Alfy turns the button into ✦ Ask Alfy"). */
let mentionsAlfyInDraft = $derived(/@alfy\b/i.test(draftText));

let composerHeaderKey = $derived<I18nKey>(
	mode === "ask"
		? "artifacts.document.comment.askHeader"
		: "artifacts.document.comment.commentHeader",
);
let composerLabel = $derived($t(composerHeaderKey, { quote: truncatedQuote }));

function openAskAlfy(): void {
	draftText = "";
	mode = "ask";
}

function openComment(): void {
	draftText = "";
	mode = "comment";
}

/**
 * Redesign §4.4 (rd/review-2-5.md:198-207): "arrow keys inside the
 * `role="toolbar"`" — a plain horizontal roving-focus pattern between "Ask
 * Alfy" and "Comment" (or however many trigger buttons ever end up here),
 * matching `Tabs.svelte`'s own ArrowLeft/ArrowRight handler for its
 * horizontal strip.
 */
function handleToolbarKeydown(event: KeyboardEvent): void {
	if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
	const toolbar = event.currentTarget as HTMLElement;
	const buttons = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
	);
	const currentIndex = buttons.indexOf(
		document.activeElement as HTMLButtonElement,
	);
	if (currentIndex === -1) return;
	event.preventDefault();
	const step = event.key === "ArrowRight" ? 1 : -1;
	const nextIndex = (currentIndex + step + buttons.length) % buttons.length;
	buttons[nextIndex]?.focus();
}

function cancel(): void {
	mode = "pill";
	draftText = "";
	onDismiss();
}

function applySuggestion(phrase: string): void {
	draftText =
		draftText.trim().length > 0 ? `${draftText.trim()} ${phrase}` : phrase;
}

async function submit(): Promise<void> {
	const text = draftText.trim();
	if (!text || posting) return;
	// Ask mode transparently prefixes the mention so `DocumentBody.svelte`'s
	// existing `mentionsAlfy(body)` gate (unchanged) still routes it through
	// the Ask-Alfy reply — see this file's header comment.
	const body = mode === "ask" ? `@Alfy ${text}` : text;
	const sourceRect = isPhone ? null : (rootEl?.getBoundingClientRect() ?? null);
	posting = true;
	try {
		await onSubmit(body, sourceRect);
	} finally {
		posting = false;
	}
}

/**
 * rd/review-2-5.md:229-232: on the DESKTOP composer's own wrapping
 * `role="dialog"` (not just the textarea, which is where this used to live
 * alone) so Escape — and ⌘/Ctrl+Enter — work from a suggestion chip or the
 * Cancel/Send buttons too, not only while focus happens to be in the
 * textarea itself. The phone sheet needs no equivalent: `DialogShell`'s own
 * `focusTrap` already owns Escape there (`onClose={cancel}`, window-level,
 * independent of which descendant currently has focus).
 */
function handleComposerKeydown(event: KeyboardEvent): void {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		void submit();
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		cancel();
	}
}
</script>

{#snippet triggerButtons()}
	<button type="button" class="selection-bubble-action" onclick={openAskAlfy}>
		<Sparkles size={14} strokeWidth={2} aria-hidden="true" />
		{$t('artifacts.document.comment.ask')}
	</button>
	<button type="button" class="selection-bubble-action" onclick={openComment}>
		<MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
		{$t('artifacts.document.comment.add')}
	</button>
{/snippet}

{#snippet composerFields()}
	<div class="selection-bubble-composer-header">
		{#if mode === 'ask'}
			<Sparkles size={14} strokeWidth={2} aria-hidden="true" />
		{:else}
			<MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
		{/if}
		<span>{composerLabel}</span>
	</div>
	<textarea
		bind:this={textareaEl}
		class="selection-bubble-textarea"
		placeholder={mode === 'ask'
			? $t('artifacts.document.comment.askPlaceholder')
			: $t('artifacts.document.comment.placeholder')}
		bind:value={draftText}
		disabled={posting}
	></textarea>
	{#if mode === 'ask'}
		<div class="selection-bubble-chips">
			{#each SUGGESTION_CHIPS as chipKey (chipKey)}
				<button
					type="button"
					class="selection-bubble-chip"
					onclick={() => applySuggestion($t(chipKey))}
				>
					{$t(chipKey)}
				</button>
			{/each}
		</div>
		<p class="selection-bubble-effect">{$t('artifacts.document.comment.askEffect')}</p>
	{:else}
		<p class="selection-bubble-effect">{$t('artifacts.document.comment.mentionHint')}</p>
	{/if}
	<div class="selection-bubble-composer-actions">
		<button type="button" class="btn-secondary" onclick={cancel} disabled={posting}>
			{$t('artifacts.document.comment.cancel')}
		</button>
		<button
			type="button"
			class="btn-primary"
			onclick={submit}
			disabled={posting || !draftText.trim()}
		>
			{mode === 'ask' || mentionsAlfyInDraft
				? $t('artifacts.document.comment.ask')
				: $t('artifacts.document.comment.add')}
		</button>
	</div>
{/snippet}

{#if isPhone}
	{#if mode === 'pill'}
		<div
			class="selection-docked-bar"
			data-testid="selection-bubble"
			role="toolbar"
			tabindex="-1"
			aria-label={$t('artifacts.document.comment.selectionToolbar')}
			onkeydown={handleToolbarKeydown}
		>
			{@render triggerButtons()}
		</div>
	{:else}
		<!-- zIndexClass: this sheet opens from the docked bar INSIDE
		     `DocumentWorkspace.svelte`'s mobile shell, whose own
		     `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's
		     default `z-50` renders behind it (found by `elementFromPoint`, not
		     any role/text query: the sheet is still genuinely "visible" to
		     Testing Library/Playwright, just painted under the backdrop). Same
		     fix, same value, same reasoning as `CommentsSheet.svelte`/
		     `MobileToolbar.svelte`'s own phone sheets. -->
		<DialogShell
			title={composerLabel}
			onClose={cancel}
			phonePresentation="sheet"
			zIndexClass="z-[150]"
		>
			<div class="selection-bubble-sheet-fields">
				{@render composerFields()}
			</div>
		</DialogShell>
	{/if}
{:else}
	<div
		bind:this={rootEl}
		class="selection-bubble"
		class:selection-bubble-composing={mode !== 'pill'}
		data-testid="selection-bubble"
		style="left: {position.x}px; top: {position.y}px; transform: {anchorTransform};"
	>
		{#if mode === 'pill'}
			<div
				class="selection-bubble-toolbar"
				role="toolbar"
				tabindex="-1"
				aria-label={$t('artifacts.document.comment.selectionToolbar')}
				onkeydown={handleToolbarKeydown}
			>
				{@render triggerButtons()}
			</div>
		{:else}
			<div
				class="selection-bubble-composer"
				role="dialog"
				tabindex="-1"
				aria-label={composerLabel}
				onkeydown={handleComposerKeydown}
			>
				{@render composerFields()}
			</div>
		{/if}
	</div>
{/if}

<style>
	.selection-bubble {
		position: absolute;
		z-index: 20;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-lg, var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18)));
		/* `transform` is set inline (script's `anchorTransform`) so it can flip
		   between anchoring above vs. below the selection. */
		width: 13.5rem;
		transition:
			width var(--duration-emphasis, 250ms) var(--ease-emphasis, ease),
			height var(--duration-emphasis, 250ms) var(--ease-emphasis, ease);
	}

	.selection-bubble-composing {
		width: 21.25rem; /* 340px — redesign §4.2 item 2. */
	}

	.selection-bubble-toolbar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.375rem;
		height: 2.375rem; /* 38px — redesign §4.2 item 1. */
	}

	.selection-bubble-action {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		color: var(--text-primary);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		white-space: nowrap;
	}

	.selection-bubble-action:hover {
		background-color: var(--surface-elevated);
	}

	.selection-bubble-action:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.selection-bubble-composer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.625rem;
		/* Contents fade in after the box has started morphing (motion #8:
		   "contents fade in after 80ms"); the global reduced-motion override
		   collapses this to an instant, held-open state. */
		animation: selection-bubble-content-in var(--duration-standard, 150ms)
			var(--ease-out, ease) 80ms both;
	}

	@keyframes selection-bubble-content-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.selection-bubble-composer-header {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		color: var(--accent-text);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.selection-bubble-textarea {
		min-height: 4.5rem;
		padding: 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background-color: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		resize: vertical;
	}

	.selection-bubble-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.selection-bubble-chip {
		padding: 0.25rem 0.625rem;
		border-radius: var(--radius-full, 999px);
		border: 1px solid var(--border-default);
		background-color: var(--surface-page);
		color: var(--text-primary);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.selection-bubble-chip:hover {
		background-color: var(--surface-elevated);
	}

	.selection-bubble-chip:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.selection-bubble-effect {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.selection-bubble-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	/* Phone: a docked bar above the toolbar (redesign §4.3's "Phone" row),
	   sticky to the bottom of the scrolling text column rather than a
	   viewport-fixed overlay — no extra JS rect math, and it never drifts out
	   from under an on-screen keyboard the way `position: fixed` can. */
	/* `position: fixed` to the viewport, not `sticky` to the scroll pane: this
	   sits alongside the (potentially very tall) editor content in normal
	   flow, so a `sticky` bottom offset only holds true near the END of that
	   flow — once a long document is scrolled deep, the "natural" position
	   sticky measures from has already scrolled past, and the bar stops
	   tracking the viewport (confirmed against a real 40-paragraph document:
	   scrolled fully off-screen). `fixed` has no such dependency on where
	   this happens to sit in the DOM. */
	.selection-docked-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.75rem;
		border-top: 1px solid var(--border-subtle);
		background-color: var(--surface-overlay);
		box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
	}

	.selection-docked-bar .selection-bubble-action {
		flex: 1;
		justify-content: center;
		min-height: 44px; /* redesign §4.4: "on phones they get a 44px hit area". */
	}

	.selection-bubble-sheet-fields {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.selection-bubble-sheet-fields .selection-bubble-textarea {
		min-height: 6rem;
	}

	.selection-bubble-sheet-fields .selection-bubble-composer-actions button {
		min-height: 44px;
	}

	/* No `prefers-reduced-motion` override needed here: `src/app.css`'s
	   global rule already collapses every `transition`/`animation` duration
	   to 0.01ms with `!important` (motion.ts's own doc comment), covering
	   both the width/height morph above and the content fade-in. */
</style>
