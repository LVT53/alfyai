<script lang="ts">
// Providers, the rule about all models (timeout failover), and what a new
// account gets. Timeout failover used to be a card-in-card inside the provider
// list; it is a rule about every model, so it is its own card now.
import type { Snippet } from "svelte";
import { Info } from "@lucide/svelte";
import { t } from "$lib/i18n";
import ModelSelect from "./ModelSelect.svelte";
import SettingRow from "./SettingRow.svelte";
import SystemCard from "./SystemCard.svelte";
import SystemToggle from "./SystemToggle.svelte";
import ValueField from "./ValueField.svelte";
import {
	type ModelOptionGroup,
	flattenModelOptions,
	resolveModelValue,
} from "./model-options";
import "./system.css";

let {
	adminConfig,
	envDefaults = {},
	failoverModelGroups,
	defaultUserModelGroups,
	highlightKey = "",
	isDirty,
	setValue,
	resetValue,
	providerList,
}: {
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	failoverModelGroups: ModelOptionGroup[];
	defaultUserModelGroups: ModelOptionGroup[];
	highlightKey?: string;
	isDirty: (key: string) => boolean;
	setValue: (key: string, value: string) => void;
	resetValue: (key: string) => void;
	providerList: Snippet;
} = $props();

const failoverEnabled = $derived(
	adminConfig.MODEL_TIMEOUT_FAILOVER_ENABLED === "true",
);

const failoverTarget = $derived(
	resolveModelValue(
		failoverModelGroups,
		adminConfig.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL,
		"model2",
	),
);

const failoverTargetLabel = $derived(
	flattenModelOptions(failoverModelGroups).find(
		(option) => option.id === failoverTarget,
	)?.label ?? failoverTarget,
);

const failoverSeconds = $derived(
	Math.round(
		(Number.parseInt(
			adminConfig.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS ||
				envDefaults.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS ||
				"0",
			10,
		) || 0) / 1000,
	),
);

// The reset affordance is offered whenever the row is not already sitting on
// its environment default — a saved override with no pending edit is exactly
// the case an admin needs it for. (`isDirty` alone hid it there.)
function canResetKey(key: string): boolean {
	return isDirty(key) || (adminConfig[key] ?? "") !== (envDefaults[key] ?? "");
}
</script>

<div class="sys-stack" data-testid="system-page-models">
	<section class="sys-card">
		{@render providerList()}
	</section>

	<SystemCard
		title={$t('admin.system.failover.title')}
		description={$t('admin.system.failover.description')}
		testId="system-failover-card"
	>
		<div class="sys-banner sys-banner-accent" style="margin-bottom: 12px">
			<span class="sys-banner-icon">
				<Info size={14} strokeWidth={2} aria-hidden="true" />
			</span>
			<span>
				{#if failoverEnabled}
					{$t('admin.system.failover.summary', {
						seconds: String(failoverSeconds),
						model: failoverTargetLabel,
					})}
				{:else}
					{$t('admin.system.failover.summaryOff')}
				{/if}
			</span>
		</div>

		<div class="sys-rows">
			<SettingRow
				label={$t('admin.system.failover.enabled')}
				meaning={$t('admin.modelTimeoutFailoverDescription')}
				configKey="MODEL_TIMEOUT_FAILOVER_ENABLED"
				dirty={isDirty('MODEL_TIMEOUT_FAILOVER_ENABLED')}
				highlighted={highlightKey === 'MODEL_TIMEOUT_FAILOVER_ENABLED'}
				onReset={() => resetValue('MODEL_TIMEOUT_FAILOVER_ENABLED')}
				canReset={canResetKey('MODEL_TIMEOUT_FAILOVER_ENABLED')}
			>
				{#snippet control()}
					<SystemToggle
						id="MODEL_TIMEOUT_FAILOVER_ENABLED"
						label={$t('admin.modelTimeoutFailoverEnabled')}
						checked={failoverEnabled}
						onchange={(next) =>
							setValue('MODEL_TIMEOUT_FAILOVER_ENABLED', next ? 'true' : 'false')}
					/>
				{/snippet}
			</SettingRow>

			<SettingRow
				label={$t('admin.system.failover.timeout')}
				meaning={$t('admin.system.failover.timeoutMeaning')}
				configKey="MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS"
				controlId="MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS"
				dirty={isDirty('MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS')}
				highlighted={highlightKey === 'MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS'}
				onReset={() => resetValue('MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS')}
				canReset={canResetKey('MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS')}
			>
				{#snippet control()}
					<ValueField
						id="MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS"
						type="number"
						size="sm"
						min={1000}
						unit={$t('admin.system.unit.ms')}
						value={adminConfig.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS ?? ''}
						placeholder={envDefaults.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS ?? ''}
						onchange={(next) => setValue('MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS', next)}
					/>
				{/snippet}
			</SettingRow>

			<SettingRow
				label={$t('admin.system.failover.target')}
				meaning={$t('admin.system.failover.targetMeaning')}
				configKey="MODEL_TIMEOUT_FAILOVER_TARGET_MODEL"
				controlId="MODEL_TIMEOUT_FAILOVER_TARGET_MODEL"
				dirty={isDirty('MODEL_TIMEOUT_FAILOVER_TARGET_MODEL')}
				highlighted={highlightKey === 'MODEL_TIMEOUT_FAILOVER_TARGET_MODEL'}
				onReset={() => resetValue('MODEL_TIMEOUT_FAILOVER_TARGET_MODEL')}
				canReset={canResetKey('MODEL_TIMEOUT_FAILOVER_TARGET_MODEL')}
			>
				{#snippet control()}
					<ModelSelect
						id="MODEL_TIMEOUT_FAILOVER_TARGET_MODEL"
						groups={failoverModelGroups}
						value={failoverTarget}
						onchange={(next) => setValue('MODEL_TIMEOUT_FAILOVER_TARGET_MODEL', next)}
					/>
				{/snippet}
			</SettingRow>
		</div>
	</SystemCard>

	<SystemCard
		title={$t('admin.system.newAccounts.title')}
		description={$t('admin.system.newAccounts.description')}
		testId="system-new-accounts-card"
	>
		<div class="sys-rows">
			<SettingRow
				label={$t('admin.defaultNewUserModel')}
				meaning={$t('admin.system.newAccounts.meaning')}
				configKey="DEFAULT_NEW_USER_MODEL"
				controlId="DEFAULT_NEW_USER_MODEL"
				dirty={isDirty('DEFAULT_NEW_USER_MODEL')}
				highlighted={highlightKey === 'DEFAULT_NEW_USER_MODEL'}
				onReset={() => resetValue('DEFAULT_NEW_USER_MODEL')}
				canReset={canResetKey('DEFAULT_NEW_USER_MODEL')}
			>
				{#snippet control()}
					<ModelSelect
						id="DEFAULT_NEW_USER_MODEL"
						groups={defaultUserModelGroups}
						value={resolveModelValue(
							defaultUserModelGroups,
							adminConfig.DEFAULT_NEW_USER_MODEL || envDefaults.DEFAULT_NEW_USER_MODEL,
						)}
						onchange={(next) => setValue('DEFAULT_NEW_USER_MODEL', next)}
					/>
				{/snippet}
			</SettingRow>
			<p class="sys-help">{$t('admin.defaultNewUserModelDescription')}</p>
		</div>
	</SystemCard>
</div>
