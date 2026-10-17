<script lang="ts">
import { Check, Copy, Download } from "@lucide/svelte";
import { t } from "$lib/i18n";

/**
 * The ten one-time codes, shown the way the mockup's step 3 draws them: two
 * columns, Copy and Download, and (when it is a fresh set) the checkbox that
 * gates Done. Shared by setup's last step and Settings' New backup codes, so
 * the two screens cannot drift apart.
 */
let {
	codes,
	requireSavedAck = false,
	onDone,
	notice = "",
}: {
	codes: string[];
	requireSavedAck?: boolean;
	onDone?: () => void;
	/** An optional line above the codes, e.g. the other-devices notice. */
	notice?: string;
} = $props();

let copied = $state(false);
let saved = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyCodes() {
	try {
		await navigator.clipboard.writeText(codes.join("\n"));
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
		}, 1600);
	} catch {
		// A browser that refuses clipboard access still offers Download.
	}
}

/** The codes as a plain .txt file, named for what it holds. */
function downloadCodes() {
	const blob = new Blob([`${codes.join("\n")}\n`], {
		type: "text/plain;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = "alfyai-backup-codes.txt";
	anchor.click();
	URL.revokeObjectURL(url);
}
</script>

<div class="backup-codes-panel">
	{#if notice}
		<p class="backup-codes-notice" role="status" data-testid="backup-codes-notice">
			{notice}
		</p>
	{/if}

	<div class="backup-codes" data-testid="backup-codes">
		{#each codes as code (code)}
			<code>{code}</code>
		{/each}
	</div>

	<div class="backup-codes-actions">
		<button type="button" class="btn-secondary gap-1.5" onclick={copyCodes}>
			{#if copied}
				<Check size={14} strokeWidth={2} aria-hidden="true" />
				{$t('profileTab.twoStepCopied')}
			{:else}
				<Copy size={14} strokeWidth={2} aria-hidden="true" />
				{$t('profileTab.twoStepCopy')}
			{/if}
		</button>
		<button
			type="button"
			class="btn-secondary gap-1.5"
			onclick={downloadCodes}
		>
			<Download size={14} strokeWidth={2} aria-hidden="true" />
			{$t('profileTab.twoStepDownload')}
		</button>
	</div>

	{#if requireSavedAck}
		<label class="backup-codes-ack">
			<input type="checkbox" bind:checked={saved} />
			<span>{$t('profileTab.twoStepSavedAck')}</span>
		</label>
	{/if}

	{#if onDone}
		<div class="backup-codes-done">
			<button
				type="button"
				class="btn-primary"
				disabled={requireSavedAck && !saved}
				onclick={onDone}
			>
				{$t('profileTab.twoStepDone')}
			</button>
		</div>
	{/if}
</div>

<style>
	.backup-codes-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.backup-codes-notice {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--success) 8%, var(--surface-page));
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	/* Two columns of five, as the mockup draws them; one column when the
	   dialog is narrow enough that two would crowd a code. */
	.backup-codes {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.625rem 1.5rem;
		padding: 1rem 1.125rem;
		border-radius: var(--radius-md);
		background: var(--surface-page);
		font-family: var(--font-mono, Menlo, monospace);
		font-size: 0.8125rem;
		color: var(--text-primary);
	}

	@media (min-width: 420px) {
		.backup-codes {
			grid-template-columns: 1fr 1fr;
		}
	}

	.backup-codes code {
		font-family: inherit;
		letter-spacing: 0.04em;
	}

	.backup-codes-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.625rem;
	}

	.backup-codes-ack {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		min-height: 44px;
		font-size: 0.875rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.backup-codes-ack input {
		margin-top: 0.15rem;
	}

	.backup-codes-done {
		display: flex;
		justify-content: flex-end;
	}
</style>
