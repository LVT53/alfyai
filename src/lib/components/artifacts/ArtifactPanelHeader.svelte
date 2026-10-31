<script lang="ts">
/**
 * The one panel-item header every artifact kind uses (Feature 2 · Artifacts
 * redesign §5.2/§8, Wave 2.5 Step 3): a breadcrumb back to "This chat" (where
 * the host has a list to go back to), the title, and a kind/version/meta line.
 * Knows nothing about Tiptap or any
 * other kind's internals — `DocumentWorkspace.svelte` supplies everything
 * kind-specific (the version count, the meta line's text, and the actions
 * snippet: Download, Expand, Close, and later a kind's own extras such as
 * Slides' Present) so this file is safe for Document, App, File and, later,
 * Canvas and Slides alike.
 *
 * Replaces the old per-kind "ACTIVE DOCUMENT" eyebrow, the "Knowledge Base"
 * source pill, and the disabled History placeholder (redesign §5.1 problems
 * 1–2): there is one History entry now, and it is this header's own history
 * button. Ruling 76: the button says when the item last changed (a clock and
 * "12 min ago", who did it on hover and to a screen reader), never a version
 * number, and pressing it turns the panel into History (versioning.md §5.1).
 * While History is open the same button says "Close history": it is the way out,
 * in the same place the reader went in.
 */
import { ChevronLeft, Clock, X } from "@lucide/svelte";
import type { Snippet } from "svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { ARTIFACT_KIND_ICONS } from "./kind-icons";
import type { MomentPhrase } from "./history/moment-phrase";

let {
	kind,
	title,
	phrase = null,
	onHistory = undefined,
	historyOpen = false,
	onBack,
	actions = undefined,
}: {
	kind: ArtifactKind;
	title: string;
	/** The latest moment in words ("Changed by Alfy · 12 min ago"), already localised. `null`/omitted renders no moment segment at all: the header says nothing rather than something false. */
	phrase?: MomentPhrase | null;
	/** Turns the panel into History (and back). Given without a handler, the phrase renders as plain text instead of a button: the kind has no History yet. */
	onHistory?: (() => void) | undefined;
	/** History is showing: the button is the way out of it. */
	historyOpen?: boolean;
	/** The breadcrumb: returns to the list. A host with no list (the Knowledge page, a project's Files dialog) passes none, and the header draws no breadcrumb: it would be a button that does nothing. */
	onBack?: (() => void) | undefined;
	/** Header actions (Download, a divider, Expand, Close, …) — entirely caller-supplied so this file never hardcodes a kind-specific action. */
	actions?: Snippet;
} = $props();

let KindIcon = $derived(ARTIFACT_KIND_ICONS[kind]);
</script>

<header class="artifact-panel-header">
	<div class="artifact-panel-header-top">
		{#if onBack}
			<button
				type="button"
				class="artifact-panel-header-crumb"
				onclick={onBack}
				aria-label={$t('artifacts.panel.backA11y')}
			>
				<ChevronLeft size={14} strokeWidth={2.2} aria-hidden="true" />
				<span>{$t('artifacts.panel.crumb')}</span>
			</button>
		{/if}
		<span class="artifact-panel-header-grow"></span>
		{#if actions}
			<div class="artifact-panel-header-actions">
				{@render actions()}
			</div>
		{/if}
	</div>

	<h2
		class="artifact-panel-header-title"
		data-testid="artifact-panel-title"
		tabindex="-1"
	>
		{title}
	</h2>

	<div class="artifact-panel-header-meta">
		<span class="artifact-panel-header-kind">
			<KindIcon size={14} strokeWidth={2} aria-hidden="true" />
			<span>{$t(`artifacts.type.${kind}` as I18nKey)}</span>
		</span>
		{#if onHistory && (phrase || historyOpen)}
			<span class="artifact-panel-header-sep" aria-hidden="true">·</span>
			<!-- The old test id stays on the button's own wrapper for one release
			     (ruling 76's build brief): the wrapper is as big as the button, so
			     a click on it lands on it. -->
			<span class="artifact-panel-header-history-wrap" data-testid="artifact-version-pill">
				<button
					type="button"
					class="artifact-panel-header-history"
					class:is-open={historyOpen}
					data-testid="artifact-history-button"
					onclick={onHistory}
					aria-haspopup="true"
					aria-label={historyOpen ? $t('artifacts.history.close') : phrase?.a11y}
					title={historyOpen ? $t('artifacts.history.close') : phrase?.text}
				>
					{#if historyOpen}
						<X size={13} strokeWidth={2.2} aria-hidden="true" />
						<span class="artifact-panel-header-history-when" aria-hidden="true">{$t('artifacts.history.close')}</span>
					{:else}
						<Clock size={13} strokeWidth={2.1} aria-hidden="true" />
						<span class="artifact-panel-header-history-when" aria-hidden="true">{phrase?.when ?? phrase?.headline}</span>
					{/if}
				</button>
			</span>
		{:else if phrase}
			<span class="artifact-panel-header-sep" aria-hidden="true">·</span>
			<span
				class="artifact-panel-header-history-static"
				data-testid="artifact-version-pill"
				title={phrase.text}
			>
				<Clock size={13} strokeWidth={2.1} aria-hidden="true" />
				<span class="artifact-panel-header-history-when">{phrase.when ?? phrase.headline}</span>
			</span>
		{/if}
	</div>
</header>

<style>
	.artifact-panel-header {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.625rem 0.875rem 0.75rem 1.25rem;
		border-bottom: 1px solid var(--border-default);
	}

	.artifact-panel-header-top {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-height: 2rem;
	}

	.artifact-panel-header-crumb {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: -0.5rem;
		height: 1.75rem;
		padding: 0 0.56rem 0 0.3rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		/* One line, always: a wrapped way back ("EZ A / BESZÉLGETÉS") was two lines of small capitals (F28). */
		white-space: nowrap;
		flex-shrink: 0;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.artifact-panel-header-crumb:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.artifact-panel-header-crumb:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.artifact-panel-header-grow {
		flex: 1;
	}

	.artifact-panel-header-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}

	.artifact-panel-header-title {
		margin: 0;
		overflow-wrap: break-word;
		font-family: var(--font-serif);
		font-size: 1.375rem;
		font-weight: 400;
		line-height: 1.25;
		color: var(--text-primary);
		text-wrap: balance;
	}

	.artifact-panel-header-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.artifact-panel-header-kind {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--text-primary);
	}

	.artifact-panel-header-kind :global(svg) {
		color: var(--accent-text);
	}

	.artifact-panel-header-sep {
		opacity: 0.55;
	}

	/* The history button: a clock and a time, quiet until it is wanted. Its
	   visible box is 24px; the hit area is 32px on a desktop and 44px on a phone
	   (an `::after` inset, as the breadcrumb has). While History is open it takes
	   the accent: it is the way out, and it must be found without looking for it. */
	.artifact-panel-header-history-wrap {
		display: inline-flex;
		min-width: 0;
		max-width: 100%;
	}

	.artifact-panel-header-history,
	.artifact-panel-header-history-static {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-width: 0;
		max-width: 100%;
		height: 1.5rem;
		padding: 0 0.4rem;
		border-radius: var(--radius-full);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.artifact-panel-header-history {
		position: relative;
		border: 0;
		background: transparent;
		font-family: var(--font-sans);
		cursor: pointer;
	}

	.artifact-panel-header-history::after {
		content: "";
		position: absolute;
		/* 24px visible + 2 * 4px = 32px. */
		inset: -0.25rem -0.125rem;
	}

	.artifact-panel-header-history:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.artifact-panel-header-history.is-open,
	.artifact-panel-header-history.is-open:hover {
		background: var(--accent-tint-strong);
		color: var(--accent-text);
		font-weight: 600;
	}

	.artifact-panel-header-history:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.artifact-panel-header-history-when {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Phones: the breadcrumb (1.75rem/28px) and the history button
	   (1.5rem/24px) stay visually compact but get a 44px hit area via an
	   `::after` inset, exactly like ChangeBar.svelte's own phone rule for the
	   Keep/Undo buttons (redesign §5.4: "44 px hit area" for header controls). */
	@media (max-width: 639px) {
		.artifact-panel-header-crumb {
			position: relative;
		}

		.artifact-panel-header-crumb::after {
			content: "";
			position: absolute;
			/* 28px visible height + 2*8px = 44px. */
			inset: -0.5rem -0.25rem;
		}

		.artifact-panel-header-history::after {
			/* 24px visible height + 2*10px = 44px. */
			inset: -0.625rem -0.25rem;
		}
	}
</style>
