<script lang="ts">
import { t } from "$lib/i18n";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import { uiLanguage } from "$lib/stores/settings";
import ToolActivityRow from "./ToolActivityRow.svelte";
import WriteConfirmActions from "./WriteConfirmActions.svelte";
import WriteConfirmContent from "./WriteConfirmContent.svelte";
import WriteConfirmDetails from "./WriteConfirmDetails.svelte";
import {
	buildSettledWriteItem,
	buildWriteCardView,
	settledWriteNote,
} from "./write-card-view";

// Issue 7.5 — the permission card in the reply: Alfy asks before it changes
// anything in a connected account. It wears ArtifactCard's shell, because it
// sits in the same column as one. {busy,error} is OWNED by the caller (keyed per
// write id, e.g. `writeActionState[write.id]` in +page.svelte), not internal
// state, the same split as skillDraftActionState, and `write` always reflects
// the server's authoritative status, so a write settled before a reload never
// shows its buttons again.
//
// Once decided it stops being a question: it folds into the row every tool call
// draws, with what it was one press away. On a phone a pending write is also
// raised in WriteConfirmSheet, one at a time; this card stays where it is.
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

const view = $derived(buildWriteCardView(write, $t, $uiLanguage));
// "executing" is claimed by a confirm in flight: still this card, not answerable.
const isSettled = $derived(
	write.status !== "pending" && write.status !== "executing",
);
const note = $derived(settledWriteNote(write, $t));
const item = $derived(buildSettledWriteItem(write, view, $t));

// What went wrong stays in sight, so a failed or expired write opens by itself.
// The person can fold it away; a settled row that is only a record stays folded.
let userOpen = $state<boolean | null>(null);
const open = $derived(userOpen ?? note !== null);
</script>

{#if isSettled}
	<div class="write-settled" data-testid="write-confirm-settled" data-status={write.status}>
		<ToolActivityRow {item} {open} onToggle={() => (userOpen = !open)}>
			{#snippet bodyContent()}
				<WriteConfirmDetails {view} {note} settled />
			{/snippet}
		</ToolActivityRow>
	</div>
{:else}
	<article
		class="write-card"
		aria-label={$t('connections.writeConfirm.cardLabel', { title: view.subject })}
	>
		<div class="write-card__content">
			<WriteConfirmContent {view} provider={write.provider} error={error ?? null} />
		</div>
		<footer class="write-card__actions">
			<WriteConfirmActions
				{view}
				busy={busy || write.status === "executing"}
				onApprove={() => onConfirm?.(write.id)}
				onDecline={() => onCancel?.(write.id)}
			/>
		</footer>
	</article>
{/if}

<style>
	/* ArtifactCard's shell. */
	.write-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 12px);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		overflow: hidden;
		font-family: var(--font-sans);
	}

	.write-card__content {
		padding: 0.75rem 0.875rem;
	}

	.write-card__actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.625rem 0.875rem;
		border-top: 1px solid var(--border-subtle);
	}

	.write-settled {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
		overflow: visible;
	}

	/* Still side by side, still negative-left: the single stacked column is
	   where the accidental confirm came from. */
	@media (max-width: 520px) {
		.write-card__actions :global(.dialog-btn) {
			flex: 1 1 0;
			min-height: 44px;
		}
	}
</style>
