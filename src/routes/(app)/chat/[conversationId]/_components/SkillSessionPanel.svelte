<script lang="ts">
	import { t } from "$lib/i18n";
	import type { SkillSession } from "$lib/types";

	interface Props {
		session: SkillSession;
		busy?: boolean;
		error?: string | null;
		onFinish: () => void | Promise<void>;
		onDismiss: () => void | Promise<void>;
	}

	let { session, busy = false, error = null, onFinish, onDismiss }: Props = $props();

	const statusLabel = $derived($t(`skillSessions.status.${session.status}`));
	const sourceScopeLabel = $derived($t(`skills.source.${session.sourceScope === "selected_sources_only" ? "selectedSourcesOnly" : "currentConversation"}`));
	const notesPolicyLabel = $derived($t(`skills.notes.${session.notesPolicy === "create_private_notes" ? "createPrivate" : "none"}`));
	const latestNoteFailure = $derived(
		session.milestones
			.filter((milestone) => milestone.kind === "failed_note")
			.at(-1),
	);
	const latestNoteFailureMessage = $derived(
		typeof latestNoteFailure?.messageParams.errorMessage === "string"
			? latestNoteFailure.messageParams.errorMessage
			: $t("skillSessions.noteFailureFallback"),
	);
</script>

<section class="skill-session-panel" aria-label={$t("skillSessions.panelLabel")}>
	<div class="skill-session-panel__main">
		<div>
			<p class="skill-session-panel__eyebrow">{$t("skillSessions.activeLabel")}</p>
			<h2>{session.skillDisplayName}</h2>
		</div>
		<span class:paused={session.status === "paused"}>{statusLabel}</span>
	</div>

	<p class="skill-session-panel__next">
		{$t("skillSessions.expectedNextAction")}
	</p>
	<p class="skill-session-panel__meta">
		{sourceScopeLabel} · {notesPolicyLabel}
	</p>

	{#if latestNoteFailure}
		<p class="skill-session-panel__note-failure" role="status">
			{$t("skillSessions.noteFailure")}: {latestNoteFailureMessage}
		</p>
	{/if}

	{#if error}
		<p class="skill-session-panel__error" role="alert">{error}</p>
	{/if}

	<div class="skill-session-panel__actions">
		<button type="button" onclick={onFinish} disabled={busy}>
			{$t("skillSessions.finish")}
		</button>
		<button type="button" class="secondary" onclick={onDismiss} disabled={busy}>
			{$t("skillSessions.dismiss")}
		</button>
	</div>
</section>

<style>
	.skill-session-panel {
		border: 1px solid var(--border, #d7dde7);
		border-radius: 8px;
		padding: 0.875rem 1rem;
		background: var(--surface, #ffffff);
		color: var(--text, #101828);
	}

	.skill-session-panel__main {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.skill-session-panel__eyebrow,
	.skill-session-panel__meta {
		margin: 0;
		font-size: 0.75rem;
		color: var(--muted-text, #667085);
	}

	h2 {
		margin: 0.125rem 0 0;
		font-size: 0.95rem;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	span {
		border-radius: 999px;
		background: #ecfdf3;
		color: #027a48;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.2rem 0.55rem;
		white-space: nowrap;
	}

	span.paused {
		background: #fff7ed;
		color: #c2410c;
	}

	.skill-session-panel__next {
		margin: 0.65rem 0 0.2rem;
		font-size: 0.875rem;
	}

	.skill-session-panel__error {
		margin: 0.65rem 0 0;
		font-size: 0.8125rem;
		color: #b42318;
	}

	.skill-session-panel__note-failure {
		margin: 0.65rem 0 0;
		border-left: 3px solid #f97316;
		padding-left: 0.55rem;
		font-size: 0.8125rem;
		color: #9a3412;
	}

	.skill-session-panel__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	button {
		border: 1px solid #1f2937;
		border-radius: 6px;
		background: #1f2937;
		color: white;
		font: inherit;
		font-size: 0.8125rem;
		font-weight: 600;
		padding: 0.4rem 0.7rem;
		cursor: pointer;
	}

	button.secondary {
		background: transparent;
		color: #1f2937;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}

	@media (max-width: 640px) {
		.skill-session-panel {
			padding: 0.7rem 0.75rem;
		}

		.skill-session-panel__main {
			gap: 0.65rem;
		}

		.skill-session-panel__next {
			margin-top: 0.45rem;
			font-size: 0.8125rem;
		}

		.skill-session-panel__actions {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}

		button {
			min-height: 36px;
			padding: 0.4rem 0.55rem;
		}
	}
</style>
