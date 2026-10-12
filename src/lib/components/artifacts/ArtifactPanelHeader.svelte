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
 * button. Ruling 76: the button says what happened last ("Changed by Alfy ·
 * 12 min ago"), never a version number, and pressing it turns the panel into
 * History (versioning.md §5.1).
 */
import { ChevronDown, ChevronLeft, ChevronUp, History } from "@lucide/svelte";
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
	/** History is showing: the button reads as pressed. */
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
		{#if phrase}
			<span class="artifact-panel-header-sep" aria-hidden="true">·</span>
			{#if onHistory}
				<!-- The old test id stays on the button's own wrapper for one release
				     (ruling 76's build brief): the wrapper is as big as the button, so
				     a click on it lands on it. -->
				<span class="artifact-panel-header-history-wrap" data-testid="artifact-version-pill">
					<button
						type="button"
						class="artifact-panel-header-history"
						data-testid="artifact-history-button"
						onclick={onHistory}
						aria-haspopup="true"
						aria-pressed={historyOpen}
						aria-label={phrase.a11y}
					>
						<History size={13} strokeWidth={2.1} aria-hidden="true" />
						<span class="artifact-panel-header-history-text" aria-hidden="true">
							<span class="artifact-panel-header-history-headline">{phrase.headline}</span>
							{#if phrase.when}
								<span class="artifact-panel-header-history-dot">·</span>
								<span class="artifact-panel-header-history-when">{phrase.when}</span>
							{/if}
						</span>
						{#if historyOpen}
							<ChevronUp size={12} strokeWidth={2.2} aria-hidden="true" />
						{:else}
							<ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
						{/if}
					</button>
				</span>
			{:else}
				<span
					class="artifact-panel-header-history-static"
					data-testid="artifact-version-pill"
				>
					{phrase.text}
				</span>
			{/if}
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

	/* The history button: a pill that says what happened last. Its visible box
	   is 24px; the hit area is 32px on a desktop and 44px on a phone (an
	   `::after` inset, as the breadcrumb has), and the headline is the part that
	   gives way to a narrow header, never the time. */
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
		padding: 0 0.4rem 0 0.5rem;
		border-radius: var(--radius-full);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.artifact-panel-header-history {
		position: relative;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-family: var(--font-sans);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.artifact-panel-header-history::after {
		content: "";
		position: absolute;
		/* 24px visible + 2 * 4px = 32px. */
		inset: -0.25rem -0.125rem;
	}

	.artifact-panel-header-history:hover {
		background: var(--accent-tint-strong);
	}

	.artifact-panel-header-history[aria-pressed="true"] {
		background: var(--accent-tint-strong);
		border-color: var(--accent);
	}

	.artifact-panel-header-history:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.artifact-panel-header-history-text {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
		min-width: 0;
	}

	.artifact-panel-header-history-headline {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.artifact-panel-header-history-dot {
		opacity: 0.6;
	}

	.artifact-panel-header-history-when {
		flex-shrink: 0;
		font-weight: 600;
		white-space: nowrap;
	}

	.artifact-panel-header-history-static {
		border: 1px solid transparent;
		background: var(--surface-elevated);
		color: var(--text-muted);
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
