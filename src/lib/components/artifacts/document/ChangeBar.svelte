<script lang="ts">
/**
 * The inline "✦ Alfy · Keep · Undo" pill (Feature 2 · Artifacts, Slice 1,
 * T8; redesigned Wave 2.5 Step 10, redesign.md §4.2 item 5/6, §7.2 rows
 * #11/#13/#14, §9.2's own row: "becomes the inline pill... with Redo after
 * Undo"). Purely presentational — no `@tiptap/*` import, so it stays outside
 * the lazy editor boundary (T7.8). `change-pill-decoration.ts` mounts this
 * component (Svelte 5's `mount`) into the ProseMirror widget decoration's own
 * DOM node; that module owns POSITIONING, this component only knows its own
 * three states.
 *
 * `status` covers the pill's whole lifecycle: `"pending"` is the live
 * Keep/Undo choice, `"kept"` fades to nothing after a moment (its caller
 * removes the pill; see `DocumentBody.svelte`'s `handleKeepChange`), and
 * `"undone"` offers Redo for a brief window before the same happens.
 *
 * §4.4: the pill is `role="group"` named "Alfy's change: '…'"
 * (`blockLabel`, already clamped by `blocks.ts`'s own label derivation); its
 * buttons keep short VISIBLE text but a fuller accessible name each.
 */
import { Check, Sparkles, Undo2 } from "@lucide/svelte";
import { t } from "$lib/i18n";
import {
	alfyChangeAriaKeyShortcuts,
	alfyChangeShortcutLabel,
} from "./keyboard-shortcuts";

let {
	status = "pending",
	commentCount = 0,
	blockLabel = "",
	onKeep,
	onUndo,
	onRedo,
}: {
	status?: "pending" | "kept" | "undone";
	commentCount?: number;
	blockLabel?: string;
	onKeep: () => void;
	onUndo: () => void;
	onRedo: () => void;
} = $props();

/**
 * rd/review-2-5.md:210-216: Keep/Undo re-mount this widget under a new
 * `change-pill-decoration.ts` key (`${changeId}:${status}`) — the OLD button
 * that had focus is destroyed with the old DOM node, dropping focus to
 * `<body>`. `status: "undone"` is reachable only by the user's own just-now
 * Undo click (never a fresh load or a live Alfy edit landing — both of those
 * always start `"pending"`), so autofocusing this instance's OWN Redo button
 * on mount is always "focus follows the action just taken", never a
 * surprise steal. `"kept"` has no button left to focus in the pill itself —
 * `DocumentBody.svelte`'s `handleKeepChange` moves focus externally instead
 * (the review bar, or back into the document).
 */
let redoButtonEl = $state<HTMLButtonElement | undefined>();
$effect(() => {
	if (status !== "undone") return;
	// Only when the focus was dropped (the removed button had it, so it fell to
	// `<body>`). An Undo by keyboard chord from the text (G3) leaves the focus
	// where it is — in the text — and a pill must not pull it out of there.
	const focused = document.activeElement;
	if (!focused || focused === document.body) redoButtonEl?.focus();
});
</script>

<div
	class="alfy-change-bar"
	class:is-done={status !== 'pending'}
	data-testid="alfy-change-bar"
	role="group"
	aria-label={$t('artifacts.document.change.groupLabel', { quote: blockLabel })}
>
	{#if status === 'pending'}
		<span class="alfy-change-bar-who">
			<Sparkles size={12} strokeWidth={2} aria-hidden="true" />
			<span class="alfy-change-bar-label">{$t('artifacts.document.change.alfy')}</span>
			{#if commentCount > 0}
				<span
					class="alfy-change-bar-comments"
					aria-label={$t('artifacts.document.change.commentCountA11y', { count: commentCount })}
				>
					{commentCount}
				</span>
			{/if}
		</span>
		<button
			type="button"
			class="alfy-change-bar-action alfy-change-bar-keep"
			aria-label={$t('artifacts.document.change.keepA11y')}
			onclick={onKeep}
		>
			<Check size={12} strokeWidth={2.5} aria-hidden="true" />
			{$t('artifacts.document.change.keep')}
		</button>
		<button
			type="button"
			class="alfy-change-bar-action alfy-change-bar-undo"
			aria-label={$t('artifacts.document.change.undoA11y')}
			aria-keyshortcuts={alfyChangeAriaKeyShortcuts('undo')}
			title={$t('artifacts.document.change.undoWithShortcut', { shortcut: alfyChangeShortcutLabel('undo') })}
			onclick={onUndo}
		>
			<Undo2 size={12} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.document.change.undo')}
		</button>
	{:else if status === 'kept'}
		<Check size={12} strokeWidth={2.5} class="alfy-change-bar-ok" aria-hidden="true" />
		<span class="alfy-change-bar-notice">{$t('artifacts.document.change.keptNotice')}</span>
	{:else}
		<Undo2 size={12} strokeWidth={2} aria-hidden="true" />
		<span class="alfy-change-bar-notice">{$t('artifacts.document.change.undoneNotice')}</span>
		<button
			bind:this={redoButtonEl}
			type="button"
			class="alfy-change-bar-action alfy-change-bar-undo"
			aria-label={$t('artifacts.document.change.redoA11y')}
			aria-keyshortcuts={alfyChangeAriaKeyShortcuts('redo')}
			title={$t('artifacts.document.change.redoWithShortcut', { shortcut: alfyChangeShortcutLabel('redo') })}
			onclick={onRedo}
		>
			{$t('artifacts.document.change.redo')}
		</button>
	{/if}
</div>

<style>
	/* Redesign §7.2 #11: arrives with the mark, scale 0.92 → 1 and fades in —
	   app.css's global `prefers-reduced-motion` override collapses this to
	   the resting (no-animation) state for free, the same mechanism
	   `DocumentBody.svelte`'s own `.alfy-change.arrive` already relies on. */
	.alfy-change-bar {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		height: 1.625rem;
		padding: 0 0.1875rem 0 0.5rem;
		margin-left: 0.375rem;
		vertical-align: 0.0625rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-page);
		border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		box-shadow: var(--shadow-md);
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
		transform-origin: left center;
		animation: alfy-change-bar-in var(--duration-emphasis) var(--ease-emphasis) both;
	}

	@keyframes alfy-change-bar-in {
		from {
			opacity: 0;
			transform: scale(0.92);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.alfy-change-bar.is-done {
		padding-right: 0.5rem;
		color: var(--text-muted);
		border-color: var(--border-default);
		box-shadow: none;
	}

	.alfy-change-bar-who {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding-right: 0.375rem;
		margin-right: 0.125rem;
		border-right: 1px solid var(--border-default);
	}

	.alfy-change-bar-label {
		font-weight: 700;
		color: var(--text-primary);
	}

	.alfy-change-bar-comments {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1rem;
		height: 1rem;
		padding: 0 0.25rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-elevated);
		font-size: var(--text-2xs, 0.66rem);
	}

	.alfy-change-bar-action {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.25rem;
		padding: 0 0.4375rem;
		border: none;
		border-radius: var(--radius-full, 999px);
		font-family: inherit;
		font-size: 0.71875rem;
		font-weight: 700;
		cursor: pointer;
	}

	.alfy-change-bar-keep {
		background-color: var(--accent-fill);
		color: var(--on-accent);
	}

	.alfy-change-bar-keep:hover {
		filter: brightness(1.08);
	}

	.alfy-change-bar-undo {
		background: none;
		color: var(--text-primary);
	}

	.alfy-change-bar-undo:hover {
		background-color: var(--surface-elevated);
	}

	.alfy-change-bar-action:focus-visible {
		outline: 2px solid var(--focus-ring, var(--border-focus));
		outline-offset: 1px;
	}

	/* Phones: the buttons stay visually compact but get a 44px hit area via
	   an `::after` inset (redesign §4.4: "on phones they get a 44px hit
	   area"), matching the mockup's own `[data-device="mobile"]` rule. */
	@media (max-width: 480px) {
		.alfy-change-bar-action {
			position: relative;
		}

		/* Button is 1.25rem (20px) tall; +0.75rem (12px) on top and bottom
		   reaches the full 44px hit area the button's own visible size stays
		   short of. */
		.alfy-change-bar-action::after {
			content: "";
			position: absolute;
			inset: -0.75rem -0.25rem;
		}
	}

	.alfy-change-bar :global(.alfy-change-bar-ok) {
		color: var(--success-text, var(--success));
	}

	.alfy-change-bar-notice {
		color: var(--text-muted);
	}
</style>
