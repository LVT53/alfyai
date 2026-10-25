<script lang="ts">
import { ChevronRight } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { SkillDraftProposal } from "$lib/server/services/skills/types";

let {
	draft,
	busy = false,
	actionError = null,
	onSave = undefined,
	onDismiss = undefined,
}: {
	draft: SkillDraftProposal;
	busy?: boolean;
	actionError?: string | null;
	onSave?: ((draftId: string) => void | Promise<void>) | undefined;
	onDismiss?: ((draftId: string) => void | Promise<void>) | undefined;
} = $props();

// Instructions longer than this fold to a preview of about two lines; the
// drafts the real model writes run 600-900 characters.
const PREVIEW_CHARS = 180;
const MAX_EXAMPLES = 3;

const uid = $props.id();
let expanded = $state(false);

let statusLabel = $derived(
	draft.status === "saved"
		? $t("skillDrafts.saved")
		: draft.status === "dismissed"
			? $t("skillDrafts.dismissed")
			: draft.status === "published"
				? $t("skillDrafts.published")
				: "",
);
// The person decides on what the skill will do, so the card shows it: the
// instructions and the messages that should load it. The draft's policy
// fields (questions, sources, notes, duration) still parse for old rows but
// date from Skill Sessions and are not shown.
let instructions = $derived(draft.instructions.trim());
let compactInstructions = $derived(instructions.replace(/\s+/g, " "));
let isLong = $derived(compactInstructions.length > PREVIEW_CHARS);
let instructionsPreview = $derived.by(() => {
	const cut = compactInstructions.slice(0, PREVIEW_CHARS);
	const lastSpace = cut.lastIndexOf(" ");
	const base = lastSpace > PREVIEW_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
	return `${base.replace(/[\s,;:.!?-]+$/, "")}…`;
});
let examples = $derived(
	(draft.activationExamples ?? []).slice(0, MAX_EXAMPLES),
);
let showsContent = $derived(draft.status !== "dismissed");
let savedSkillHref = $derived(
	draft.status === "saved" && draft.savedSkillId
		? `/settings?section=skills&skill=${encodeURIComponent(draft.savedSkillId)}`
		: null,
);
</script>

<article
	class="skill-draft-card"
	aria-label={$t('skillDrafts.cardLabel', { name: draft.displayName })}
>
	<div class="skill-draft-card__header">
		<div>
			<div class="skill-draft-card__eyebrow">{$t('skillDrafts.eyebrow')}</div>
			<h3>{draft.displayName}</h3>
		</div>
		{#if statusLabel}
			<span class="skill-draft-card__status">{statusLabel}</span>
		{/if}
	</div>

	{#if draft.description}
		<p class="skill-draft-card__description">{draft.description}</p>
	{/if}

	{#if showsContent && instructions}
		<div class="skill-draft-card__section">
			<p class="skill-draft-card__label">{$t('skillDrafts.instructionsLabel')}</p>
			<p class="skill-draft-card__instructions" id="{uid}-instructions">{isLong && !expanded ? instructionsPreview : instructions}</p>
			{#if isLong}
				<button
					type="button"
					class="skill-draft-card__toggle"
					aria-expanded={expanded}
					aria-controls="{uid}-instructions"
					onclick={() => (expanded = !expanded)}
				>
					{expanded ? $t('skillDrafts.showLess') : $t('skillDrafts.showMore')}
				</button>
			{/if}
		</div>
	{/if}

	{#if showsContent && examples.length > 0}
		<div class="skill-draft-card__section">
			<p class="skill-draft-card__label">{$t('skillDrafts.examplesLabel')}</p>
			<ul class="skill-draft-card__examples">
				{#each examples as example, index (index)}
					<li>{example}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if draft.status === "proposed"}
		{#if actionError}
			<p class="skill-draft-card__error" role="alert">{actionError}</p>
		{/if}
		<div class="skill-draft-card__actions">
			<button type="button" class="skill-draft-card__primary" disabled={busy} onclick={() => onSave?.(draft.id)}>
				{$t('skillDrafts.save')}
			</button>
			<button type="button" class="skill-draft-card__secondary" disabled={busy} onclick={() => onDismiss?.(draft.id)}>
				{$t('skillDrafts.dismiss')}
			</button>
		</div>
	{:else if savedSkillHref}
		<a class="skill-draft-card__link" href={savedSkillHref}>
			{$t('skillDrafts.openSaved')}
			<ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
		</a>
	{/if}
</article>

<style>
	.skill-draft-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-elevated);
		padding: 0.9rem;
		font-family: var(--font-sans);
		color: var(--text-primary);
	}

	.skill-draft-card__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.skill-draft-card__header > div {
		min-width: 0;
	}

	.skill-draft-card__eyebrow {
		font-size: var(--text-xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	h3,
	p,
	ul {
		margin: 0;
	}

	h3 {
		font-size: var(--text-base);
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.skill-draft-card__description {
		color: var(--text-secondary);
		font-size: var(--text-md);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.skill-draft-card__status {
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.2rem 0.5rem;
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.skill-draft-card__section {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.3rem;
	}

	.skill-draft-card__label {
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
	}

	.skill-draft-card__instructions {
		font-size: var(--text-sm);
		line-height: 1.5;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.skill-draft-card__examples {
		display: grid;
		gap: 0.25rem;
		padding-left: 1.1rem;
		list-style: disc;
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.skill-draft-card__examples li::marker {
		color: var(--text-muted);
	}

	.skill-draft-card__toggle,
	.skill-draft-card__link {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		border: none;
		border-radius: 4px;
		background: none;
		padding: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
		cursor: pointer;
	}

	.skill-draft-card__link {
		align-self: flex-start;
	}

	.skill-draft-card__toggle:hover,
	.skill-draft-card__link:hover {
		text-decoration: underline;
	}

	.skill-draft-card__toggle:focus-visible,
	.skill-draft-card__link:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent 64%);
		outline: none;
	}

	.skill-draft-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.skill-draft-card__error {
		border: 1px solid var(--danger);
		border-radius: 8px;
		background: var(--danger-surface, rgba(180, 35, 24, 0.08));
		padding: 0.45rem 0.6rem;
		color: var(--danger);
		font-size: var(--text-sm);
		line-height: 1.4;
	}

	.skill-draft-card__actions button {
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		padding: 0.45rem 0.65rem;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.skill-draft-card__actions button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.skill-draft-card__actions .skill-draft-card__primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.skill-draft-card__actions .skill-draft-card__secondary {
		border-color: color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		background: color-mix(in srgb, var(--surface-page) 78%, var(--surface-elevated) 22%);
		color: var(--text-primary);
	}

	.skill-draft-card__actions button:hover:not(:disabled),
	.skill-draft-card__actions button:focus-visible:not(:disabled) {
		transform: translateY(-1px);
	}

	.skill-draft-card__actions .skill-draft-card__primary:hover:not(:disabled),
	.skill-draft-card__actions .skill-draft-card__primary:focus-visible:not(:disabled) {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
	}

	.skill-draft-card__actions .skill-draft-card__secondary:hover:not(:disabled),
	.skill-draft-card__actions .skill-draft-card__secondary:focus-visible:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border-default) 58%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
	}

	.skill-draft-card__actions button:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent 64%);
		outline: none;
	}

	.skill-draft-card__actions button:active:not(:disabled) {
		transform: translateY(0);
	}

	@media (max-width: 520px) {
		.skill-draft-card {
			gap: 0.65rem;
			margin-top: 0.6rem;
			padding: 0.75rem;
		}

		.skill-draft-card__header {
			flex-direction: column;
			gap: 0.45rem;
		}

		.skill-draft-card__status {
			align-self: flex-start;
		}

		.skill-draft-card__actions {
			display: grid;
			grid-template-columns: 1fr;
		}

		.skill-draft-card__actions button {
			width: 100%;
			min-height: 38px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skill-draft-card__actions button {
			transition: none;
		}
	}
</style>
