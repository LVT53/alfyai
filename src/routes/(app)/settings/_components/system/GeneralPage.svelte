<script lang="ts">
import { t } from "$lib/i18n";
import SettingRow from "./SettingRow.svelte";
import SystemCard from "./SystemCard.svelte";
import SystemToggle from "./SystemToggle.svelte";
import ValueField from "./ValueField.svelte";
import "./system.css";

let {
	adminConfig,
	envDefaults = {},
	highlightKey = "",
	isDirty,
	setValue,
	resetValue,
}: {
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	highlightKey?: string;
	isDirty: (key: string) => boolean;
	setValue: (key: string, value: string) => void;
	resetValue: (key: string) => void;
} = $props();
</script>

<SystemCard
	title={$t('admin.system.general.title')}
	description={$t('admin.system.general.description')}
	testId="system-page-general"
>
	<div class="sys-rows">
		<SettingRow
			label={$t('admin.composerCommandRegistryEnabled')}
			meaning={$t('admin.composerCommandRegistryDescription')}
			configKey="COMPOSER_COMMAND_REGISTRY_ENABLED"
			dirty={isDirty('COMPOSER_COMMAND_REGISTRY_ENABLED')}
			highlighted={highlightKey === 'COMPOSER_COMMAND_REGISTRY_ENABLED'}
			onReset={() => resetValue('COMPOSER_COMMAND_REGISTRY_ENABLED')}
			canReset={isDirty('COMPOSER_COMMAND_REGISTRY_ENABLED')}
		>
			{#snippet control()}
				<SystemToggle
					id="COMPOSER_COMMAND_REGISTRY_ENABLED"
					label={$t('admin.composerCommandRegistryEnabled')}
					checked={adminConfig.COMPOSER_COMMAND_REGISTRY_ENABLED === 'true'}
					onchange={(next) =>
						setValue('COMPOSER_COMMAND_REGISTRY_ENABLED', next ? 'true' : 'false')}
				/>
			{/snippet}
		</SettingRow>

		<SettingRow
			label={$t('admin.appVersionOverride')}
			meaning={$t('admin.appVersionOverrideDescription')}
			configKey="APP_VERSION_OVERRIDE"
			controlId="APP_VERSION_OVERRIDE"
			dirty={isDirty('APP_VERSION_OVERRIDE')}
			highlighted={highlightKey === 'APP_VERSION_OVERRIDE'}
			onReset={() => resetValue('APP_VERSION_OVERRIDE')}
			canReset={isDirty('APP_VERSION_OVERRIDE')}
		>
			{#snippet control()}
				<ValueField
					id="APP_VERSION_OVERRIDE"
					value={adminConfig.APP_VERSION_OVERRIDE ?? ''}
					placeholder={envDefaults.APP_VERSION_OVERRIDE ?? ''}
					onchange={(next) => setValue('APP_VERSION_OVERRIDE', next)}
				/>
			{/snippet}
		</SettingRow>
	</div>
</SystemCard>
