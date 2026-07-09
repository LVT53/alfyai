<script lang="ts">
import { t } from "$lib/i18n";
import type { PendingWrite } from "$lib/types";

// Issue 7.5 — inline write-confirm card. Mirrors SkillDraftCard's
// prop/busy/error shape: {busy,error} is OWNED by the caller (keyed per
// write id, e.g. `writeActionState[write.id]` in +page.svelte), not
// internal component state — the same "who owns busy/error" split as
// skillDraftActionState. `write` itself always reflects the server's
// authoritative status (fetched via GET .../pending-writes or returned by
// confirm/cancel), so a card for an already-executed/cancelled write
// (e.g. after a reload) renders straight into its terminal state without
// ever showing Confirm/Cancel — never a stale "still pending" view.
let {
	write,
	busy = false,
	error = null,
	onConfirm = undefined,
	onCancel = undefined,
}: {
	write: PendingWrite;
	busy?: boolean;
	error?: string | null;
	onConfirm?: ((id: string) => void | Promise<void>) | undefined;
	onCancel?: ((id: string) => void | Promise<void>) | undefined;
} = $props();

// "pending" is the only actionable state — everything else (executing,
// already claimed by a confirm in flight; executed/cancelled/failed, all
// terminal) renders read-only.
let isActionable = $derived(write.status === "pending");
let isTerminal = $derived(
	write.status === "executed" ||
		write.status === "cancelled" ||
		write.status === "failed",
);

let statusLabel = $derived(
	write.status === "executed"
		? $t("connections.writeConfirm.status.executed")
		: write.status === "cancelled"
			? $t("connections.writeConfirm.status.cancelled")
			: write.status === "failed"
				? $t("connections.writeConfirm.status.failed")
				: write.status === "executing"
					? $t("connections.writeConfirm.status.executing")
					: "",
);
</script>

<article
	class="write-confirm-card"
	class:write-confirm-card--destructive={write.preview.destructive}
	class:write-confirm-card--terminal={isTerminal}
	aria-label={$t('connections.writeConfirm.cardLabel', { title: write.preview.title })}
>
	<div class="write-confirm-card__header">
		<div>
			<div class="write-confirm-card__eyebrow">{$t('connections.writeConfirm.eyebrow')}</div>
			<h3>{write.preview.title}</h3>
		</div>
		{#if statusLabel}
			<span class="write-confirm-card__status">{statusLabel}</span>
		{/if}
	</div>

	<p class="write-confirm-card__detail">{write.preview.detail}</p>

	<div class="write-confirm-card__badges">
		{#if write.preview.destructive}
			<span class="write-confirm-card__badge write-confirm-card__badge--destructive">
				{$t('connections.writeConfirm.destructiveBadge')}
			</span>
		{/if}
		{#if !write.preview.reversible}
			<span class="write-confirm-card__badge write-confirm-card__badge--destructive">
				{$t('connections.writeConfirm.notReversibleBadge')}
			</span>
		{/if}
	</div>

	{#if write.preview.warnings.length > 0}
		<ul class="write-confirm-card__warnings" role="status" aria-live="polite">
			{#each write.preview.warnings as warning}
				<li>{warning}</li>
			{/each}
		</ul>
	{/if}

	{#if write.status === "executed" && write.etag}
		<p class="write-confirm-card__etag">
			{$t('connections.writeConfirm.etag', { etag: write.etag })}
		</p>
	{/if}

	{#if isActionable}
		{#if error}
			<p class="write-confirm-card__error" role="alert">{error}</p>
		{/if}
		<div class="write-confirm-card__actions">
			<button
				type="button"
				class="write-confirm-card__primary"
				disabled={busy}
				aria-label={$t('connections.writeConfirm.confirmA11y', { title: write.preview.title })}
				onclick={() => onConfirm?.(write.id)}
			>
				{busy ? $t('connections.writeConfirm.busy') : $t('connections.writeConfirm.confirm')}
			</button>
			<button
				type="button"
				class="write-confirm-card__secondary"
				disabled={busy}
				aria-label={$t('connections.writeConfirm.cancelA11y', { title: write.preview.title })}
				onclick={() => onCancel?.(write.id)}
			>
				{$t('connections.writeConfirm.cancel')}
			</button>
		</div>
	{/if}
</article>

<style>
	.write-confirm-card {
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

	.write-confirm-card--destructive {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border-default) 45%);
	}

	.write-confirm-card--terminal {
		opacity: 0.9;
	}

	.write-confirm-card__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.write-confirm-card__header > div {
		min-width: 0;
	}

	.write-confirm-card__eyebrow {
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

	.write-confirm-card__detail {
		color: var(--text-secondary);
		font-size: var(--text-md);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.write-confirm-card__status {
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.2rem 0.5rem;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.write-confirm-card__badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.write-confirm-card__badge {
		border-radius: 999px;
		padding: 0.2rem 0.5rem;
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.write-confirm-card__badge--destructive {
		border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent 45%);
		background: color-mix(in srgb, var(--warning) 16%, var(--surface-page) 84%);
		color: var(--warning);
	}

	.write-confirm-card__warnings {
		display: grid;
		gap: 0.35rem;
		padding-left: 1.1rem;
		color: var(--warning);
		font-size: var(--text-sm);
		line-height: 1.4;
		font-weight: 600;
	}

	.write-confirm-card__etag {
		color: var(--text-muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.write-confirm-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.write-confirm-card__error {
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

	.write-confirm-card__primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.write-confirm-card__secondary {
		border-color: color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		background: color-mix(in srgb, var(--surface-page) 78%, var(--surface-elevated) 22%);
		color: var(--text-primary);
	}

	button:hover:not(:disabled),
	button:focus-visible:not(:disabled) {
		transform: translateY(-1px);
	}

	.write-confirm-card__primary:hover:not(:disabled),
	.write-confirm-card__primary:focus-visible:not(:disabled) {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
	}

	.write-confirm-card__secondary:hover:not(:disabled),
	.write-confirm-card__secondary:focus-visible:not(:disabled) {
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
		.write-confirm-card {
			gap: 0.65rem;
			margin-top: 0.6rem;
			padding: 0.75rem;
		}

		.write-confirm-card__header {
			flex-direction: column;
			gap: 0.45rem;
		}

		.write-confirm-card__status {
			align-self: flex-start;
		}

		.write-confirm-card__actions {
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
