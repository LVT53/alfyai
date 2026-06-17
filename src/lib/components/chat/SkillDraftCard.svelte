<script lang="ts">
import { t } from "$lib/i18n";
import type { SkillDraftProposal } from "$lib/types";

let {
	draft,
	canPublishSystem = false,
	busy = false,
	actionError = null,
	onSave = undefined,
	onDismiss = undefined,
	onPublish = undefined,
}: {
	draft: SkillDraftProposal;
	canPublishSystem?: boolean;
	busy?: boolean;
	actionError?: string | null;
	onSave?: ((draftId: string) => void | Promise<void>) | undefined;
	onDismiss?: ((draftId: string) => void | Promise<void>) | undefined;
	onPublish?: ((draftId: string) => void | Promise<void>) | undefined;
} = $props();

let isFinal = $derived(draft.status !== "proposed");
let statusLabel = $derived(
	draft.status === "saved"
		? $t("skillDrafts.saved")
		: draft.status === "dismissed"
			? $t("skillDrafts.dismissed")
			: draft.status === "published"
				? $t("skillDrafts.published")
				: "",
);
let durationLabel = $derived(
	draft.durationPolicy === "session"
		? $t("skillDrafts.duration.session")
		: $t("skillDrafts.duration.nextMessage"),
);
let questionLabel = $derived(
	draft.questionPolicy === "ask_when_needed"
		? $t("skillDrafts.question.askWhenNeeded")
		: $t("skillDrafts.question.none"),
);
let notesLabel = $derived(
	draft.notesPolicy === "create_private_notes"
		? $t("skillDrafts.notes.createPrivate")
		: $t("skillDrafts.notes.none"),
);
let sourceLabel = $derived(
	draft.sourceScope === "current_conversation"
		? $t("skillDrafts.source.currentConversation")
		: $t("skillDrafts.source.selectedSourcesOnly"),
);
let warnings = $derived([
	...(draft.notesPolicy === "create_private_notes"
		? [$t("skillDrafts.warning.notes")]
		: []),
	draft.sourceScope === "current_conversation"
		? $t("skillDrafts.warning.currentConversation")
		: $t("skillDrafts.warning.selectedSources"),
]);
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

	<div class="skill-draft-card__policies" aria-label={$t('skillDrafts.policyTitle')}>
		<span>{durationLabel}</span>
		<span>{questionLabel}</span>
		<span>{notesLabel}</span>
		<span>{sourceLabel}</span>
	</div>

	<ul class="skill-draft-card__warnings">
		{#each warnings as warning}
			<li>{warning}</li>
		{/each}
	</ul>

	{#if !isFinal}
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
			{#if canPublishSystem}
				<button type="button" class="skill-draft-card__secondary" disabled={busy} onclick={() => onPublish?.(draft.id)}>
					{$t('skillDrafts.publish')}
				</button>
			{/if}
		</div>
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

	.skill-draft-card__policies {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.skill-draft-card__policies span,
	.skill-draft-card__status {
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.2rem 0.5rem;
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.skill-draft-card__warnings {
		display: grid;
		gap: 0.35rem;
		padding-left: 1.1rem;
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: 1.4;
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

	button {
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

	button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.skill-draft-card__primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.skill-draft-card__secondary {
		border-color: color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		background: color-mix(in srgb, var(--surface-page) 78%, var(--surface-elevated) 22%);
		color: var(--text-primary);
	}

	button:hover:not(:disabled),
	button:focus-visible:not(:disabled) {
		transform: translateY(-1px);
	}

	.skill-draft-card__primary:hover:not(:disabled),
	.skill-draft-card__primary:focus-visible:not(:disabled) {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
	}

	.skill-draft-card__secondary:hover:not(:disabled),
	.skill-draft-card__secondary:focus-visible:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border-default) 58%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
	}

	button:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent 64%);
		outline: none;
	}

	button:active:not(:disabled) {
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

		button {
			width: 100%;
			min-height: 38px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		button {
			transition: none;
		}
	}
</style>
