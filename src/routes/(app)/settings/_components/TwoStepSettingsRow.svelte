<script lang="ts">
import { KeyRound, ShieldCheck } from "@lucide/svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";
import { t } from "$lib/i18n";
import type { TwoStepStatus } from "$lib/client/api/settings";
import {
	disableTwoStep,
	regenerateBackupCodes,
} from "$lib/client/api/settings";
import BackupCodesPanel from "./BackupCodesPanel.svelte";
import TwoStepSetupDialog from "./TwoStepSetupDialog.svelte";
import { codeOrBackupInput, twoStepErrorMessage } from "./two-step-errors";

/**
 * Settings → Profile → Account's two-step row (spec §3.2): Off with Turn on,
 * or On with the date, the codes left and the two actions. The dialogs own
 * their requests; this row only reflects the status it is given, through
 * `onChanged`, so the page's server-loaded value and the screen never
 * disagree about whether it is on.
 */
let {
	status,
	onChanged,
}: {
	status: TwoStepStatus;
	onChanged: (status: TwoStepStatus) => void;
} = $props();

let setupOpen = $state(false);
/** The code prompt: Turn off, or New backup codes. */
let promptMode = $state<"disable" | "newCodes" | null>(null);
let codeInputValue = $state("");
let submitting = $state(false);
let promptError = $state("");
/** The new codes, after New backup codes succeeded. */
let pendingCodes = $state<string[]>([]);

const formatDate = (timestamp: number) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		new Date(timestamp),
	);

const description = $derived(
	status.enabled && status.since !== null
		? $t("profileTab.twoStepOnHelp", {
				date: formatDate(status.since),
				count: status.backupCodesLeft,
				total: 10,
			})
		: $t("profileTab.twoStepOffHelp"),
);

function openPrompt(mode: "disable" | "newCodes") {
	promptMode = mode;
	codeInputValue = "";
	promptError = "";
}

function closePrompt() {
	promptMode = null;
	codeInputValue = "";
	promptError = "";
}

async function submitCode() {
	if (!promptMode || !codeInputValue.trim() || submitting) return;
	submitting = true;
	promptError = "";
	const input = codeOrBackupInput(codeInputValue);
	try {
		if (promptMode === "disable") {
			await disableTwoStep(input);
			onChanged({ enabled: false, since: null, backupCodesLeft: 0 });
			closePrompt();
			return;
		}

		const result = await regenerateBackupCodes(input);
		pendingCodes = result.backupCodes;
		closePrompt();
	} catch (error) {
		promptError = twoStepErrorMessage(error, $t);
	} finally {
		submitting = false;
	}
}

function finishNewCodes() {
	onChanged({
		enabled: true,
		since: status.since ?? Date.now(),
		backupCodesLeft: 10,
	});
	pendingCodes = [];
}

function handleSetupConfirmed() {
	// Step 2 succeeded: the factor is on now, even if the person is still on
	// the last step saving the codes. The dialog stays open until Done.
	onChanged({
		enabled: true,
		since: status.since ?? Date.now(),
		backupCodesLeft: 10,
	});
}
</script>

<div class="two-step-row" data-testid="two-step-row">
	<div class="two-step-text">
		<p class="two-step-title">
			{$t('profileTab.twoStepTitle')}
			{#if status.enabled}
				<span class="two-step-badge" data-testid="two-step-on-badge">
					{$t('profileTab.twoStepOnBadge')}
				</span>
			{/if}
		</p>
		<p class="two-step-help">{description}</p>
		{#if status.enabled && status.backupCodesLeft <= 2}
			<p class="two-step-hint" data-testid="two-step-few-left">
				{$t('profileTab.twoStepFewLeft', { count: status.backupCodesLeft })}
			</p>
		{/if}
	</div>

	<div class="two-step-actions">
		{#if status.enabled}
			<button
				type="button"
				class="btn-secondary"
				onclick={() => openPrompt('newCodes')}
			>
				{$t('profileTab.twoStepNewCodes')}
			</button>
			<button
				type="button"
				class="btn-secondary"
				onclick={() => openPrompt('disable')}
			>
				{$t('profileTab.twoStepTurnOff')}
			</button>
		{:else}
			<button
				type="button"
				class="btn-secondary gap-1.5"
				onclick={() => (setupOpen = true)}
			>
				<ShieldCheck size={14} strokeWidth={2} aria-hidden="true" />
				{$t('profileTab.twoStepTurnOn')}
			</button>
		{/if}
	</div>
</div>

{#if setupOpen}
	<TwoStepSetupDialog
		onClose={() => (setupOpen = false)}
		onConfirmed={handleSetupConfirmed}
	/>
{/if}

{#if promptMode}
	<DialogShell
		title={promptMode === 'disable'
			? $t('profileTab.twoStepDisableTitle')
			: $t('profileTab.twoStepNewCodesTitle')}
		onClose={closePrompt}
		maxWidthClass="max-w-[30rem]"
		zIndexClass="z-[9999]"
		phonePresentation="sheet"
	>
		<form
			class="two-step-prompt"
			onsubmit={(event) => {
				event.preventDefault();
				void submitCode();
			}}
		>
			<p class="two-step-line">
				{promptMode === 'disable'
					? $t('profileTab.twoStepDisableMessage')
					: $t('profileTab.twoStepNewCodesMessage')}
			</p>

			<label class="two-step-label" for="two-step-prompt-code">
				{$t('profileTab.twoStepCodeOrBackup')}
			</label>
			<input
				id="two-step-prompt-code"
				type="text"
				autocomplete="one-time-code"
				spellcheck="false"
				bind:value={codeInputValue}
				oninput={() => (promptError = '')}
				class="two-step-code"
				placeholder="000000"
			/>

			{#if promptError}
				<p class="two-step-error" role="alert">
					{promptError}
				</p>
			{/if}

			<div class="two-step-dialog-actions">
				<button type="button" class="btn-secondary" onclick={closePrompt}>
					{$t('common.cancel')}
				</button>
				<button
					type="submit"
					class="btn-primary gap-1.5"
					disabled={submitting || !codeInputValue.trim()}
				>
					{#if submitting}
						<Spinner size={14} />
					{:else}
						<KeyRound size={14} strokeWidth={2} aria-hidden="true" />
					{/if}
					{$t('common.confirm')}
				</button>
			</div>
		</form>
	</DialogShell>
{/if}

{#if pendingCodes.length > 0}
	<DialogShell
		title={$t('profileTab.twoStepSaveCodesTitle')}
		maxWidthClass="max-w-[38rem]"
		zIndexClass="z-[9999]"
		phonePresentation="sheet"
	>
		<div class="two-step-prompt">
			<p class="two-step-line">{$t('profileTab.twoStepSaveCodesLine')}</p>
			<BackupCodesPanel
				codes={pendingCodes}
				requireSavedAck
				onDone={finishNewCodes}
			/>
		</div>
	</DialogShell>
{/if}

<style>
	.two-step-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		padding: var(--space-md) 0;
	}

	.two-step-text {
		flex: 1 1 18rem;
		min-width: 0;
	}

	.two-step-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.25rem;
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	.two-step-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.05rem 0.45rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--success) 14%, var(--surface-page));
		color: color-mix(in srgb, var(--success) 72%, var(--text-primary));
		font-size: 0.6875rem;
		font-weight: 600;
	}

	.two-step-help {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.two-step-hint {
		margin: 0.35rem 0 0;
		font-size: 0.8125rem;
		color: var(--warning);
	}

	.two-step-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.two-step-prompt {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		max-height: calc(100vh - 6rem);
		overflow-y: auto;
	}

	.two-step-line {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.two-step-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.two-step-code {
		box-sizing: border-box;
		width: 100%;
		min-height: 46px;
		padding: 0.6rem 0.9rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		font-family: var(--font-mono, Menlo, monospace);
		font-size: 1.05rem;
		letter-spacing: 0.16em;
		color: var(--text-primary);
	}

	.two-step-code:focus {
		outline: none;
		border-color: var(--focus-ring);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	.two-step-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.two-step-dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.625rem;
	}
</style>
