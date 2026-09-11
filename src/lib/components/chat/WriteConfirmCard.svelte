<script lang="ts">
import { AlertTriangle, Check, Trash2 } from "@lucide/svelte";
import { onMount } from "svelte";
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";

// Issue 7.5 — inline write-confirm card. Mirrors SkillDraftCard's
// prop/busy/error shape: {busy,error} is OWNED by the caller (keyed per
// write id, e.g. `writeActionState[write.id]` in +page.svelte), not
// internal component state — the same "who owns busy/error" split as
// skillDraftActionState. `write` itself always reflects the server's
// authoritative status (fetched via GET .../pending-writes or returned by
// confirm/cancel), so a card for an already-executed/cancelled write
// (e.g. after a reload) renders straight into its terminal state without
// ever showing Confirm/Cancel — never a stale "still pending" view.
//
// Everyday redesign: the card now wears the approved dialog chassis — a
// provider mark, the title, one muted qualifier line, and the decision below
// a hairline with the negative on the LEFT and the positive on the RIGHT.
// The old layout put Confirm first, which is the accidental-confirm the
// MobileSheets board calls out by name.
//
// On a phone a pending write is ALSO raised as a bottom sheet, so the
// decision starts at the thumb and the conversation stays readable behind
// it. Backing out of the sheet (the grabber, or a tap on the page) is not a
// decision: it leaves the write pending and the card in the conversation
// where it was. Only "Don't" cancels.
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

let isPhone = $state(isPhoneViewport());
let sheetDismissed = $state(false);
let asSheet = $derived(isPhone && isActionable && !sheetDismissed);

onMount(() => watchPhoneViewport((phone) => (isPhone = phone)));

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

let providerName = $derived(
	getProviderCatalogEntry(write.provider).displayName,
);
</script>

{#snippet body()}
	<!-- Connections redesign — the account the change lands in is named by its
	     own mark rather than a generic "PENDING WRITE" eyebrow: which account
	     this touches is the first thing worth knowing. The eyebrow survives as
	     the card's accessible label. -->
	<header class="dialog-head write-confirm-card__header">
		<span class="dialog-head__mark" aria-hidden="true">
			<BrandIcon provider={write.provider} size={13} ariaHidden />
		</span>
		<span class="write-confirm-card__heading">
			<h3 class="dialog-head__title">{write.preview.title}</h3>
			<p class="dialog-head__qualifier">{providerName}</p>
		</span>
		{#if statusLabel}
			<span class="write-confirm-card__status">{statusLabel}</span>
		{/if}
	</header>

	<p class="write-confirm-card__detail">{write.preview.detail}</p>

	<!-- Badges only when they are true, and in the colour they deserve:
	     saving a new file is not irreversible and must not wear the same red
	     as deleting three photos. -->
	{#if write.preview.destructive || !write.preview.reversible}
		<div class="write-confirm-card__badges">
			{#if write.preview.destructive}
				<span class="write-confirm-card__badge write-confirm-card__badge--destructive">
					<AlertTriangle size={10} strokeWidth={2.4} aria-hidden="true" />
					{$t('connections.writeConfirm.destructiveBadge')}
				</span>
			{/if}
			{#if !write.preview.reversible}
				<span
					class="write-confirm-card__badge"
					class:write-confirm-card__badge--destructive={write.preview.destructive}
					class:write-confirm-card__badge--caution={!write.preview.destructive}
				>
					{$t('connections.writeConfirm.notReversibleBadge')}
				</span>
			{/if}
		</div>
	{/if}

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
	{:else if isActionable}
		<p class="write-confirm-card__etag">{$t('writeConfirm.etagPending')}</p>
	{/if}

	{#if isActionable && error}
		<p class="write-confirm-card__error" role="alert">{error}</p>
	{/if}
{/snippet}

{#snippet actions()}
	<!-- Negative left, positive right — one rule, every dialog. The negative
	     is a real word, never an X. -->
	<button
		type="button"
		class="dialog-btn"
		disabled={busy}
		data-testid="write-confirm-decline"
		aria-label={$t('connections.writeConfirm.cancelA11y', { title: write.preview.title })}
		onclick={() => onCancel?.(write.id)}
	>
		{$t('writeConfirm.decline')}
	</button>
	<button
		type="button"
		class="dialog-btn"
		class:dialog-btn--positive={!write.preview.destructive}
		class:dialog-btn--destructive={write.preview.destructive}
		disabled={busy}
		data-testid="write-confirm-approve"
		aria-label={$t('connections.writeConfirm.confirmA11y', { title: write.preview.title })}
		onclick={() => onConfirm?.(write.id)}
	>
		{#if write.preview.destructive}
			<Trash2 size={13} strokeWidth={2} aria-hidden="true" />
		{:else}
			<Check size={13} strokeWidth={2.2} aria-hidden="true" />
		{/if}
		{busy
			? $t('connections.writeConfirm.busy')
			: write.preview.destructive
				? $t('writeConfirm.approveDestructive')
				: $t('writeConfirm.approve')}
	</button>
{/snippet}

{#if asSheet}
	<DialogShell
		title={$t('connections.writeConfirm.cardLabel', { title: write.preview.title })}
		onClose={() => (sheetDismissed = true)}
		phonePresentation="sheet"
		titleVisuallyHidden
		footer={actions}
	>
		<div
			class="write-confirm-card write-confirm-card--sheet"
			class:write-confirm-card--destructive={write.preview.destructive}
			data-testid="write-confirm-sheet"
		>
			{@render body()}
		</div>
	</DialogShell>
{:else}
	<article
		class="write-confirm-card"
		class:write-confirm-card--destructive={write.preview.destructive}
		class:write-confirm-card--terminal={isTerminal}
		aria-label={$t('connections.writeConfirm.cardLabel', { title: write.preview.title })}
	>
		{@render body()}
		{#if isActionable}
			<div class="write-confirm-card__actions">
				{@render actions()}
			</div>
		{/if}
	</article>
{/if}

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

	/* Inside a sheet the shell already owns the ground, the radius and the
	   padding — the card is only the content. */
	.write-confirm-card--sheet {
		margin-top: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		padding: 0;
	}

	/* Only a genuinely destructive write wears the danger border. A benign
	   save keeps the neutral card. */
	.write-confirm-card--destructive {
		border-color: color-mix(in srgb, var(--danger) 42%, var(--border-default) 58%);
		background: color-mix(in srgb, var(--danger) 4%, var(--surface-elevated));
	}

	.write-confirm-card--sheet.write-confirm-card--destructive {
		background: transparent;
	}

	.write-confirm-card--terminal {
		opacity: 0.9;
	}

	.write-confirm-card__header {
		margin-bottom: 0;
	}

	.write-confirm-card__heading {
		flex: 1 1 auto;
		min-width: 0;
	}

	h3,
	p,
	ul {
		margin: 0;
	}

	.write-confirm-card__detail {
		color: var(--text-secondary);
		font-size: var(--text-md);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.write-confirm-card__status {
		flex-shrink: 0;
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
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border-radius: 999px;
		padding: 0.2rem 0.5rem;
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.write-confirm-card__badge--destructive {
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent 55%);
		background: color-mix(in srgb, var(--danger) 12%, var(--surface-page) 88%);
		color: var(--danger);
	}

	/* Irreversible but not destructive — worth flagging, not worth alarming. */
	.write-confirm-card__badge--caution {
		border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent 45%);
		background: color-mix(in srgb, var(--warning) 14%, var(--surface-page) 86%);
		color: var(--warning);
	}

	/* A warning the provider itself cannot undo gets a block, not a bullet:
	   "Immich has no trash on this server" is the whole reason to slow down. */
	.write-confirm-card__warnings {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		border: 1px solid color-mix(in srgb, var(--warning) 42%, transparent 58%);
		border-radius: 6px;
		background: color-mix(in srgb, var(--warning) 10%, var(--surface-page) 90%);
		padding: 0.5rem 0.6rem 0.5rem 1.5rem;
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

	/* The inline card's own hairline + footer. In a sheet the shell draws
	   this instead, with both buttons at 44px. */
	.write-confirm-card__actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.15rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-subtle);
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

	@media (max-width: 520px) {
		.write-confirm-card {
			gap: 0.65rem;
			margin-top: 0.6rem;
			padding: 0.75rem;
		}

		.write-confirm-card--sheet {
			margin-top: 0;
			padding: 0;
		}

		.write-confirm-card__status {
			align-self: flex-start;
		}

		/* Still side by side, still negative-left: the single stacked column
		   is where the accidental confirm came from. */
		.write-confirm-card__actions :global(.dialog-btn) {
			flex: 1 1 0;
			min-height: 44px;
		}
	}
</style>
