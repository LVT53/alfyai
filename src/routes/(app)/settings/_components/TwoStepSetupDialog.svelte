<script lang="ts">
import { Copy, KeyRound } from "@lucide/svelte";
import { onMount } from "svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";
import { t } from "$lib/i18n";
import { confirmTwoStepSetup, setupTwoStep } from "$lib/client/api/settings";
import BackupCodesPanel from "./BackupCodesPanel.svelte";
import { twoStepErrorMessage } from "./two-step-errors";

/**
 * Turning two-step sign-in on, in the three steps spec §3.2 describes: scan
 * the server-drawn QR (or type its key), prove a code from the app works, then
 * save the ten backup codes. Nothing is on until step 2's code works, and the
 * last step cannot be dismissed until the codes are acknowledged — it has no
 * Cancel, no backdrop close and no Escape, only Done.
 */
let {
	onClose,
	onConfirmed,
}: {
	onClose: () => void;
	onConfirmed: (result: {
		backupCodes: string[];
		signedOutOtherDevices: number;
	}) => void;
} = $props();

let step = $state<1 | 2 | 3>(1);
let setup = $state<{ qrSvg: string; key: string } | null>(null);
let setupError = $state("");
let code = $state("");
let confirming = $state(false);
let confirmError = $state("");
let backupCodes = $state<string[]>([]);
let signedOutOtherDevices = $state(0);
let keyCopied = $state(false);
let codeInput = $state<HTMLInputElement | null>(null);

onMount(() => {
	void (async () => {
		try {
			setup = await setupTwoStep();
		} catch (error) {
			setupError = twoStepErrorMessage(error, $t);
		}
	})();
});

$effect(() => {
	if (step !== 2) return;
	void Promise.resolve().then(() => codeInput?.focus());
});

async function copyKey() {
	if (!setup) return;
	try {
		await navigator.clipboard.writeText(setup.key);
		keyCopied = true;
	} catch {
		// Selecting the key by hand still works.
	}
}

async function confirmCode() {
	if (confirming || !/^\d{6}$/.test(code)) return;
	confirming = true;
	confirmError = "";
	try {
		const result = await confirmTwoStepSetup(code);
		backupCodes = result.backupCodes;
		signedOutOtherDevices = result.signedOutOtherDevices;
		step = 3;
		onConfirmed(result);
	} catch (error) {
		confirmError = twoStepErrorMessage(error, $t);
	} finally {
		confirming = false;
	}
}

const title = $derived(
	step === 1
		? $t("profileTab.twoStepSetupTitle")
		: step === 2
			? $t("profileTab.twoStepEnterCodeTitle")
			: $t("profileTab.twoStepSaveCodesTitle"),
);
</script>

<DialogShell
	{title}
	onClose={step === 3 ? undefined : onClose}
	maxWidthClass="max-w-[38rem]"
	zIndexClass="z-[9999]"
	phonePresentation="sheet"
>
	<div class="two-step-dialog">
		<p class="two-step-step" data-testid="two-step-setup-step">
			{$t('profileTab.twoStepStepOf', { step })}
		</p>

		{#if step === 1}
			<p class="two-step-line">{$t('profileTab.twoStepSetupLine')}</p>

			{#if setupError}
				<p class="two-step-error" role="alert">
					{setupError} {$t('profileTab.twoStepSetupFailed')}
				</p>
			{:else if setup}
				<!-- The QR is an SVG drawn by the server (uqr) from the otpauth
				     URI; nothing is fetched to draw it. -->
				<div class="two-step-qr" data-testid="two-step-qr">
					{@html setup.qrSvg}
				</div>

				<p class="two-step-key-label">{$t('profileTab.twoStepCantScan')}</p>
				<div class="two-step-key">
					<code data-testid="two-step-key">{setup.key}</code>
					<button type="button" class="mini-btn gap-1" onclick={copyKey}>
						<Copy size={12} strokeWidth={2} aria-hidden="true" />
						{keyCopied ? $t('profileTab.twoStepCopied') : $t('profileTab.twoStepCopy')}
					</button>
				</div>
			{:else}
				<div class="two-step-loading" aria-live="polite">
					<Spinner size={18} />
					<span>{$t('common.loading')}</span>
				</div>
			{/if}

			<div class="two-step-actions">
				<button type="button" class="btn-secondary" onclick={onClose}>
					{$t('common.cancel')}
				</button>
				<button
					type="button"
					class="btn-primary"
					disabled={!setup}
					onclick={() => (step = 2)}
				>
					{$t('profileTab.twoStepNext')}
				</button>
			</div>
		{:else if step === 2}
			<p class="two-step-line">{$t('profileTab.twoStepEnterCodeLine')}</p>

			<label class="two-step-label" for="two-step-setup-code">
				{$t('login.twoStepCodeLabel')}
			</label>
			<input
				id="two-step-setup-code"
				type="text"
				autocomplete="one-time-code"
				inputmode="numeric"
				pattern="[0-9]*"
				maxlength="6"
				spellcheck="false"
				bind:this={codeInput}
				value={code}
				oninput={(event) => {
					code = (event.currentTarget as HTMLInputElement).value
						.replace(/\D/g, "")
						.slice(0, 6);
					confirmError = '';
				}}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						void confirmCode();
					}
				}}
				class="two-step-code"
				placeholder="000000"
			/>

			{#if confirmError}
				<p class="two-step-error" role="alert" data-testid="two-step-confirm-error">
					{confirmError}
				</p>
			{/if}

			<div class="two-step-actions">
				<button type="button" class="btn-secondary" onclick={onClose}>
					{$t('common.cancel')}
				</button>
				<button
					type="button"
					class="btn-primary gap-1.5"
					disabled={confirming || code.length !== 6}
					onclick={confirmCode}
				>
					{#if confirming}
						<Spinner size={14} />
					{:else}
						<KeyRound size={14} strokeWidth={2} aria-hidden="true" />
					{/if}
					{$t('profileTab.twoStepVerify')}
				</button>
			</div>
		{:else}
			<p class="two-step-line">{$t('profileTab.twoStepSaveCodesLine')}</p>
			<BackupCodesPanel
				codes={backupCodes}
				requireSavedAck
				notice={signedOutOtherDevices > 0
					? $t('profileTab.signedOutOtherDevices')
					: ''}
				onDone={onClose}
			/>
		{/if}
	</div>
</DialogShell>

<style>
	.two-step-dialog {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		max-height: calc(100vh - 6rem);
		overflow-y: auto;
	}

	.two-step-step {
		margin: 0;
		font-size: 0.75rem;
		color: var(--text-faint, var(--text-muted));
	}

	.two-step-line {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.two-step-qr {
		display: flex;
		justify-content: center;
		padding: var(--space-md);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: #fff;
	}

	.two-step-qr :global(svg) {
		width: 168px;
		height: 168px;
	}

	.two-step-key-label {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.two-step-key {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-md);
		background: var(--surface-page);
	}

	.two-step-key code {
		font-family: var(--font-mono, Menlo, monospace);
		font-size: 0.8125rem;
		letter-spacing: 0.04em;
		color: var(--text-primary);
	}

	.two-step-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.two-step-code {
		box-sizing: border-box;
		width: 100%;
		min-height: 48px;
		padding: 0.65rem 0.9rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		font-family: var(--font-mono, Menlo, monospace);
		font-size: 1.3rem;
		letter-spacing: 0.3em;
		text-align: center;
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

	.two-step-loading {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.two-step-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.625rem;
		margin-top: var(--space-sm);
	}
</style>
