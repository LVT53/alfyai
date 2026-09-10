<script lang="ts">
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import {
	ALLOWED_SETUP_CONTROLS,
	type SlideMenuAttention,
	type SlideMenuItem,
} from "./campaign-checklist";
import type { I18nKey } from "$lib/i18n";

let {
	slideNumber,
	kind,
	semanticRole,
	setupControls = [],
	campaignType,
	editable = true,
	attention,
	focus = "layout",
	onChangeKind,
	onChangeRole,
	onChangeSetupControls,
	onClose,
}: {
	slideNumber: number;
	kind: string;
	semanticRole: string | null | undefined;
	setupControls?: string[];
	campaignType: string;
	editable?: boolean;
	attention: SlideMenuAttention;
	focus?: SlideMenuItem;
	onChangeKind: (kind: "setup" | "standard") => void;
	onChangeRole: (role: "feature" | "data_disclosure") => void;
	onChangeSetupControls: (controls: string[]) => void;
	onClose: () => void;
} = $props();

const SETUP_CONTROL_LABELS: Record<string, string> = {
	ui_language: "admin.campaigns.setupControl.uiLanguage",
	theme: "admin.campaigns.setupControl.theme",
	model_default: "admin.campaigns.setupControl.modelDefault",
	ai_style: "admin.campaigns.setupControl.aiStyle",
};

// Setup controls are only legal on the setup slide of a first-run campaign —
// the same rule the server enforces, stated here instead of only failing.
let setupControlsAllowed = $derived(
	campaignType === "first_run_onboarding" && kind === "setup",
);
// Controls left behind by a slide that used to be a first-run setup slide.
// They still block publishing, so unchecking has to stay reachable even
// though checking does not — otherwise the only way out is deleting the
// slide.
let strayControls = $derived(!setupControlsAllowed && setupControls.length > 0);

function toggleControl(control: string, checked: boolean) {
	const next = new Set(setupControls);
	if (checked) next.add(control);
	else next.delete(control);
	onChangeSetupControls([...next]);
}
</script>

<DialogShell
	title={$t('admin.campaigns.slideOptionsTitle', { number: slideNumber })}
	description={$t('admin.campaigns.slideOptionsDescription')}
	onClose={onClose}
	maxWidthClass="max-w-[34rem]"
	zIndexClass="z-[9999]"
>
	<div class="option-stack">
		<section class:focused={focus === 'layout'}>
			<p class="option-label">
				{$t('admin.campaigns.slideLayout')}
				{#if attention.layout}
					<span class="attention-dot" aria-hidden="true"></span>
				{/if}
			</p>
			<div class="pill-row">
				{#each ['standard', 'setup'] as const as option (option)}
					<button
						type="button"
						class="pref-pill"
						class:pref-pill-active={kind === option}
						disabled={!editable}
						onclick={() => onChangeKind(option)}
					>
						{option === 'setup'
							? $t('admin.campaigns.slideKind.setup')
							: $t('admin.campaigns.slideKind.standard')}
					</button>
				{/each}
			</div>
			<p class="option-help">{$t('admin.campaigns.slideLayoutHelp')}</p>
		</section>

		<section class:focused={focus === 'purpose'}>
			<p class="option-label">
				{$t('admin.campaigns.slidePurpose')}
				{#if attention.purpose}
					<span class="attention-dot" aria-hidden="true"></span>
				{/if}
			</p>
			<div class="pill-row">
				{#each ['feature', 'data_disclosure'] as const as option (option)}
					<button
						type="button"
						class="pref-pill"
						class:pref-pill-active={semanticRole === option}
						disabled={!editable}
						onclick={() => onChangeRole(option)}
					>
						{option === 'feature'
							? $t('admin.campaigns.purpose.feature')
							: $t('admin.campaigns.purpose.dataDisclosure')}
					</button>
				{/each}
			</div>
			<p class="option-help">{$t('admin.campaigns.slidePurposeHelp')}</p>
		</section>

		<section class:focused={focus === 'setupControls'}>
			<p class="option-label">
				{$t('admin.campaigns.setupControls')}
				{#if attention.setupControls}
					<span class="attention-dot" aria-hidden="true"></span>
				{/if}
			</p>
			<div class="check-grid">
				{#each ALLOWED_SETUP_CONTROLS as control (control)}
					<label class="check-row">
						<input
							type="checkbox"
							checked={setupControls.includes(control)}
							disabled={!editable ||
								(!setupControlsAllowed && !setupControls.includes(control))}
							onchange={(event) => toggleControl(control, event.currentTarget.checked)}
						/>
						<span>{$t(SETUP_CONTROL_LABELS[control] as I18nKey)}</span>
					</label>
				{/each}
			</div>
			<p class="option-help" class:option-help-warn={strayControls}>
				{#if setupControlsAllowed}
					{$t('admin.campaigns.setupControlsHelp')}
				{:else if strayControls}
					{$t('admin.campaigns.setupControlsStray')}
				{:else}
					{$t('admin.campaigns.setupControlsUnavailable')}
				{/if}
			</p>
		</section>
	</div>

	<div class="mt-6 flex justify-end">
		<button type="button" class="btn-primary" onclick={onClose}>{$t('common.close')}</button>
	</div>
</DialogShell>

<style>
	.option-stack {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
	}

	.option-label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.4rem;
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.attention-dot {
		width: 6px;
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--accent);
	}

	.focused .option-label {
		color: var(--accent);
	}

	.pill-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.option-help {
		margin-top: 0.4rem;
		font-size: var(--text-2xs);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.option-help-warn {
		color: var(--danger);
	}

	.check-grid {
		display: grid;
		gap: 0.4rem;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.check-row {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: var(--text-2xs);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.check-row input {
		accent-color: var(--accent);
	}

	.check-row input:disabled {
		cursor: not-allowed;
	}
</style>
