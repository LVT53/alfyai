<script lang="ts">
import { untrack } from "svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import type { CampaignType } from "$lib/client/api/campaigns";

let {
	mode,
	name = "",
	type = "first_run_onboarding",
	releaseVersion = "",
	busy = false,
	onConfirm,
	onCancel,
}: {
	mode: "create" | "edit";
	name?: string;
	type?: CampaignType;
	releaseVersion?: string;
	busy?: boolean;
	onConfirm: (values: {
		name: string;
		type: CampaignType;
		releaseVersion: string;
	}) => void;
	onCancel: () => void;
} = $props();

// Seeded once from the props: the dialog is mounted fresh each time it opens,
// and edits are its own until confirmed.
let draftName = $state(untrack(() => name));
let draftType = $state<CampaignType>(untrack(() => type));
let draftRelease = $state(untrack(() => releaseVersion));

let needsRelease = $derived(draftType === "release_update");

function confirm() {
	onConfirm({
		name: draftName,
		type: draftType,
		releaseVersion: draftRelease,
	});
}
</script>

<DialogShell
	title={mode === 'create'
		? $t('admin.campaigns.newCampaign')
		: $t('admin.campaigns.editDetailsTitle')}
	description={$t('admin.campaigns.newCampaignDescription')}
	onClose={onCancel}
	maxWidthClass="max-w-[34rem]"
	zIndexClass="z-[9999]"
>
	<div class="dialog-stack">
		<div>
			<label class="settings-label" for="campaign-dialog-name">{$t('admin.campaigns.name')}</label>
			<input
				id="campaign-dialog-name"
				class="settings-input"
				bind:value={draftName}
				placeholder={$t('admin.campaigns.createNamePlaceholder')}
			/>
		</div>

		<div>
			<p class="settings-label">{$t('admin.campaigns.type')}</p>
			<div class="pill-row">
				{#each ['first_run_onboarding', 'release_update'] as const as option (option)}
					<button
						type="button"
						class="pref-pill"
						class:pref-pill-active={draftType === option}
						onclick={() => (draftType = option)}
					>
						{option === 'first_run_onboarding'
							? $t('admin.campaigns.type.firstRun')
							: $t('admin.campaigns.type.release')}
					</button>
				{/each}
			</div>
			<p class="dialog-help">{$t('admin.campaigns.typeHelp')}</p>
		</div>

		{#if needsRelease}
			<div>
				<label class="settings-label" for="campaign-dialog-release">
					{$t('admin.campaigns.releaseVersion')}
				</label>
				<input
					id="campaign-dialog-release"
					class="settings-input"
					bind:value={draftRelease}
					placeholder="1.0.0"
				/>
			</div>
		{/if}
	</div>

	<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
		<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onCancel}>
			{$t('common.cancel')}
		</button>
		<button
			type="button"
			class="btn-primary w-full whitespace-nowrap sm:w-auto"
			disabled={busy}
			onclick={confirm}
		>
			{mode === 'create' ? $t('admin.campaigns.create') : $t('admin.campaigns.saveDetails')}
		</button>
	</div>
</DialogShell>

<style>
	.dialog-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.pill-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.dialog-help {
		margin-top: 0.4rem;
		font-size: var(--text-2xs);
		line-height: 1.5;
		color: var(--text-muted);
	}
</style>
