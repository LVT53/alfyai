<script lang="ts">
/**
 * Delete, asked once and named (polish G2-A): "Delete this document?" with
 * what goes with it and "This can't be undone." — an anchored popover on
 * desktop and a sheet on phones through `AnchoredPopover.svelte`, the same
 * shell the Versions and Download popovers use, so it is focus-trapped,
 * closes on Escape and returns focus to its trigger.
 *
 * Two entrances share it. The panel header's trash button opens it straight
 * on the confirm; a list row's overflow opens it as a one-item menu whose
 * "Delete …" leads to that same confirm inside the same popover (no second
 * layer). The component does not delete anything itself: `onConfirm` does,
 * and this waits for it — working state on the button, a failed delete stays
 * open and says so, a finished one closes.
 */
import { Trash2 } from "@lucide/svelte";
import { untrack } from "svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import AnchoredPopover from "./AnchoredPopover.svelte";

let {
	kind,
	title,
	anchorTestId,
	initialStage = "confirm",
	onConfirm,
	onClose,
}: {
	kind: ArtifactKind;
	/** The item's own title, named in the confirm. */
	title: string;
	/** `data-testid` of the trigger button the popover hangs from. */
	anchorTestId: string;
	initialStage?: "confirm" | "menu";
	/** Does the delete. Resolves when the item is gone; rejects when it is not. */
	onConfirm: () => Promise<void>;
	onClose: () => void;
} = $props();

let stage = $state<"confirm" | "menu">(untrack(() => initialStage));
let busy = $state(false);
let failed = $state(false);
let cancelButton = $state<HTMLButtonElement | undefined>(undefined);

let heading = $derived(
	stage === "menu" ? title : $t(`artifacts.delete.title.${kind}` as I18nKey),
);

// Moving from the menu to the confirm unmounts the item that had focus:
// land on the safe choice rather than on nothing.
$effect(() => {
	if (stage === "confirm" && untrack(() => initialStage) === "menu") {
		cancelButton?.focus();
	}
});

async function confirm(): Promise<void> {
	if (busy) return;
	busy = true;
	failed = false;
	try {
		await onConfirm();
		onClose();
	} catch {
		failed = true;
	} finally {
		busy = false;
	}
}
</script>

<AnchoredPopover
	title={heading}
	{anchorTestId}
	popoverTestId="artifact-delete-popover"
	closeLabel={$t('common.close')}
	width={320}
	{onClose}
>
	{#if stage === 'menu'}
		<ul class="artifact-delete-menu" role="menu">
			<li role="none">
				<button
					type="button"
					role="menuitem"
					class="artifact-delete-menuitem"
					onclick={() => (stage = 'confirm')}
				>
					<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
					{$t(`artifacts.delete.button.${kind}` as I18nKey)}
				</button>
			</li>
		</ul>
	{:else}
		<div class="artifact-delete-confirm">
			<p class="artifact-delete-body">
				{$t(`artifacts.delete.body.${kind}` as I18nKey, { title })}
			</p>
			{#if failed}
				<p class="artifact-delete-error" role="alert">{$t('artifacts.delete.failed')}</p>
			{/if}
			<div class="artifact-delete-actions">
				<button
					type="button"
					class="btn-secondary btn-sm"
					bind:this={cancelButton}
					onclick={onClose}
				>
					{$t('common.cancel')}
				</button>
				<button
					type="button"
					class="btn-danger btn-sm"
					disabled={busy}
					onclick={confirm}
				>
					{busy ? $t('artifacts.delete.busy') : $t('common.delete')}
				</button>
			</div>
		</div>
	{/if}
</AnchoredPopover>

<style>
	.artifact-delete-confirm {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0 0.875rem 0.875rem;
	}

	.artifact-delete-body {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.artifact-delete-error {
		margin: 0;
		color: var(--danger);
		font-size: 0.8125rem;
	}

	.artifact-delete-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.artifact-delete-menu {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0 0.375rem 0.5rem;
		list-style: none;
	}

	.artifact-delete-menuitem {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2.25rem;
		padding: 0 0.625rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--danger);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.artifact-delete-menuitem:hover {
		background: var(--surface-elevated);
	}

	.artifact-delete-menuitem:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring) inset;
	}

	@media (hover: none) and (pointer: coarse) {
		.artifact-delete-menuitem {
			min-height: 44px;
		}
	}

	/* On a phone this content sits in the sheet, which already insets it: the
	   popover's own side padding would push it in a second time, out of line
	   with the sheet's heading. */
	@media (max-width: 639.98px) {
		.artifact-delete-confirm {
			padding-left: 0;
			padding-right: 0;
		}

		.artifact-delete-menu {
			padding-left: 0;
			padding-right: 0;
		}
	}
</style>
