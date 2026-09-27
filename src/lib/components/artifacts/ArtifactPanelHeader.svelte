<script lang="ts">
/**
 * The one panel-item header every artifact kind uses (Feature 2 · Artifacts
 * redesign §5.2/§8, Wave 2.5 Step 3): a breadcrumb back to "This chat", the
 * title, and a kind/version/meta line. Knows nothing about Tiptap or any
 * other kind's internals — `DocumentWorkspace.svelte` supplies everything
 * kind-specific (the version count, the meta line's text, and the actions
 * snippet: Download, Expand, Close, and later a kind's own extras such as
 * Slides' Present) so this file is safe for Document, App, File and, later,
 * Canvas and Slides alike.
 *
 * Replaces the old per-kind "ACTIVE DOCUMENT" eyebrow, the "Knowledge Base"
 * source pill, and the disabled History placeholder (redesign §5.1 problems
 * 1–2): there is one History entry now, and it is this header's own version
 * button.
 */
import { ChevronDown, ChevronLeft } from "@lucide/svelte";
import type { Snippet } from "svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { ARTIFACT_KIND_ICONS } from "./kind-icons";

let {
	kind,
	title,
	versionNumber = null,
	onVersions = undefined,
	meta = null,
	itemCount = null,
	onBack,
	actions = undefined,
}: {
	kind: ArtifactKind;
	title: string;
	/** `null`/omitted renders no version segment at all. */
	versionNumber?: number | null;
	/** Opens Versions. Given without a handler, the version renders as plain text instead of a button. */
	onVersions?: (() => void) | undefined;
	/** Already-localised, e.g. "edited 2 min ago" or "You and Alfy · edited 2 min ago". `null`/omitted renders nothing. */
	meta?: string | null;
	/** "What this chat made"'s total count, for the breadcrumb's badge and accessible name. `null`/omitted hides the badge and falls back to the plain "This chat" label. */
	itemCount?: number | null;
	/** The breadcrumb: returns to the list. */
	onBack: () => void;
	/** Header actions (Download, a divider, Expand, Close, …) — entirely caller-supplied so this file never hardcodes a kind-specific action. */
	actions?: Snippet;
} = $props();

let KindIcon = $derived(ARTIFACT_KIND_ICONS[kind]);
let crumbLabel = $derived(
	itemCount != null
		? $t("artifacts.panel.backA11y", { count: itemCount })
		: $t("artifacts.panel.eyebrow"),
);
</script>

<header class="artifact-panel-header">
	<div class="artifact-panel-header-top">
		<button
			type="button"
			class="artifact-panel-header-crumb"
			onclick={onBack}
			aria-label={crumbLabel}
		>
			<ChevronLeft size={14} strokeWidth={2.2} aria-hidden="true" />
			<span>{$t('artifacts.panel.eyebrow')}</span>
			{#if itemCount != null}
				<span class="artifact-panel-header-crumb-count">{itemCount}</span>
			{/if}
		</button>
		<span class="artifact-panel-header-grow"></span>
		{#if actions}
			<div class="artifact-panel-header-actions">
				{@render actions()}
			</div>
		{/if}
	</div>

	<h2 class="artifact-panel-header-title">{title}</h2>

	<div class="artifact-panel-header-meta">
		<span class="artifact-panel-header-kind">
			<KindIcon size={14} strokeWidth={2} aria-hidden="true" />
			<span>{$t(`artifacts.type.${kind}` as I18nKey)}</span>
		</span>
		{#if versionNumber}
			<span class="artifact-panel-header-sep" aria-hidden="true">·</span>
			{#if onVersions}
				<button
					type="button"
					class="artifact-panel-header-version"
					onclick={onVersions}
					aria-haspopup="dialog"
					aria-label={$t('artifacts.card.versionA11y', { n: versionNumber })}
				>
					<span>{$t('artifacts.card.version', { n: versionNumber })}</span>
					<ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
				</button>
			{:else}
				<span class="artifact-panel-header-version-static">
					{$t('artifacts.card.version', { n: versionNumber })}
				</span>
			{/if}
		{/if}
		{#if meta}
			<span class="artifact-panel-header-sep" aria-hidden="true">·</span>
			<span>{meta}</span>
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

	.artifact-panel-header-crumb-count {
		display: inline-grid;
		place-items: center;
		min-width: 1.125rem;
		height: 1.125rem;
		padding: 0 0.3rem;
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
		font-size: 0.66rem;
		letter-spacing: 0;
		text-transform: none;
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

	.artifact-panel-header-version,
	.artifact-panel-header-version-static {
		display: inline-flex;
		align-items: center;
		gap: 0.19rem;
		height: 1.375rem;
		padding: 0 0.375rem 0 0.5rem;
		border-radius: var(--radius-full);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.artifact-panel-header-version {
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-family: var(--font-sans);
		cursor: pointer;
	}

	.artifact-panel-header-version:hover {
		background: var(--accent-tint-strong);
	}

	.artifact-panel-header-version:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.artifact-panel-header-version-static {
		border: 1px solid transparent;
		background: var(--surface-elevated);
		color: var(--text-muted);
	}
</style>
