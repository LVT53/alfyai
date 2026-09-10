<script lang="ts">
// Every secret in the product, in one place and one idiom. Two of these — the
// VAPID keys — used to live inside the Atlas card, which they never belonged to.
import { t } from "$lib/i18n";
import SecretField from "./SecretField.svelte";
import SettingRow from "./SettingRow.svelte";
import SystemCard from "./SystemCard.svelte";
import ValueField from "./ValueField.svelte";
import "./system.css";

let {
	adminConfig,
	envDefaults = {},
	secretChangedAt = {},
	highlightKey = "",
	isDirty,
	setValue,
	resetValue,
	revertValue,
}: {
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	/** Key → formatted date the override was last written. */
	secretChangedAt?: Record<string, string>;
	highlightKey?: string;
	isDirty: (key: string) => boolean;
	setValue: (key: string, value: string) => void;
	/** Explicit "Reset to default": writes "" so the override row is deleted. */
	resetValue: (key: string) => void;
	/** Cancel a pending edit: puts the value back to what was last saved. */
	revertValue: (key: string) => void;
} = $props();
</script>

<SystemCard
	title={$t('admin.system.integrations.title')}
	description={$t('admin.system.integrations.description')}
	testId="system-page-integrations"
>
	<span class="sys-eyebrow">{$t('admin.system.integrations.webResearch')}</span>
	<div class="sys-rows">
		<SettingRow
			label={$t('admin.parallelApiKey')}
			meaning={$t('admin.parallelApiKeyDescription')}
			configKey="PARALLEL_API_KEY"
			dirty={isDirty('PARALLEL_API_KEY')}
			highlighted={highlightKey === 'PARALLEL_API_KEY'}
			onReset={() => resetValue('PARALLEL_API_KEY')}
			canReset={isDirty('PARALLEL_API_KEY')}
		>
			{#snippet control()}
				<SecretField
					inputId="PARALLEL_API_KEY"
					label={$t('admin.parallelApiKey')}
					value={adminConfig.PARALLEL_API_KEY ?? ''}
					lastChanged={secretChangedAt.PARALLEL_API_KEY ?? ''}
					onchange={(next) => setValue('PARALLEL_API_KEY', next)}
					onCancelReplace={() => revertValue('PARALLEL_API_KEY')}
				/>
			{/snippet}
		</SettingRow>

		<SettingRow
			label={$t('admin.braveSearchApiKey')}
			meaning={$t('admin.braveSearchApiKeyDescription')}
			configKey="BRAVE_SEARCH_API_KEY"
			dirty={isDirty('BRAVE_SEARCH_API_KEY')}
			highlighted={highlightKey === 'BRAVE_SEARCH_API_KEY'}
			onReset={() => resetValue('BRAVE_SEARCH_API_KEY')}
			canReset={isDirty('BRAVE_SEARCH_API_KEY')}
		>
			{#snippet control()}
				<SecretField
					inputId="BRAVE_SEARCH_API_KEY"
					label={$t('admin.braveSearchApiKey')}
					value={adminConfig.BRAVE_SEARCH_API_KEY ?? ''}
					lastChanged={secretChangedAt.BRAVE_SEARCH_API_KEY ?? ''}
					onchange={(next) => setValue('BRAVE_SEARCH_API_KEY', next)}
					onCancelReplace={() => revertValue('BRAVE_SEARCH_API_KEY')}
				/>
			{/snippet}
		</SettingRow>
	</div>

	<hr class="sys-hr" />
	<span class="sys-eyebrow">{$t('admin.system.integrations.documentExtraction')}</span>
	<div class="sys-rows">
		<SettingRow
			label={$t('admin.mineruApiUrl')}
			meaning={$t('admin.mineruApiDescription')}
			configKey="MINERU_API_URL"
			controlId="MINERU_API_URL"
			dirty={isDirty('MINERU_API_URL')}
			highlighted={highlightKey === 'MINERU_API_URL'}
			onReset={() => resetValue('MINERU_API_URL')}
			canReset={isDirty('MINERU_API_URL')}
		>
			{#snippet control()}
				<ValueField
					id="MINERU_API_URL"
					mono
					value={adminConfig.MINERU_API_URL ?? ''}
					placeholder={envDefaults.MINERU_API_URL ?? ''}
					onchange={(next) => setValue('MINERU_API_URL', next)}
				/>
			{/snippet}
		</SettingRow>

		<SettingRow
			label={$t('admin.mineruTimeoutMs')}
			meaning={$t('admin.mineruTimeoutDescription')}
			configKey="MINERU_TIMEOUT_MS"
			controlId="MINERU_TIMEOUT_MS"
			dirty={isDirty('MINERU_TIMEOUT_MS')}
			highlighted={highlightKey === 'MINERU_TIMEOUT_MS'}
			onReset={() => resetValue('MINERU_TIMEOUT_MS')}
			canReset={isDirty('MINERU_TIMEOUT_MS')}
		>
			{#snippet control()}
				<ValueField
					id="MINERU_TIMEOUT_MS"
					type="number"
					size="sm"
					min={10000}
					unit={$t('admin.system.unit.ms')}
					value={adminConfig.MINERU_TIMEOUT_MS ?? ''}
					placeholder={envDefaults.MINERU_TIMEOUT_MS ?? ''}
					onchange={(next) => setValue('MINERU_TIMEOUT_MS', next)}
				/>
			{/snippet}
		</SettingRow>
	</div>

	<hr class="sys-hr" />
	<span class="sys-eyebrow">{$t('admin.system.integrations.webPush')}</span>
	<p class="sys-help">{$t('admin.atlasWebPushDescription')}</p>
	<div class="sys-rows">
		<SettingRow
			label={$t('admin.webPushVapidPublicKey')}
			configKey="WEB_PUSH_VAPID_PUBLIC_KEY"
			controlId="WEB_PUSH_VAPID_PUBLIC_KEY"
			dirty={isDirty('WEB_PUSH_VAPID_PUBLIC_KEY')}
			highlighted={highlightKey === 'WEB_PUSH_VAPID_PUBLIC_KEY'}
			onReset={() => resetValue('WEB_PUSH_VAPID_PUBLIC_KEY')}
			canReset={isDirty('WEB_PUSH_VAPID_PUBLIC_KEY')}
		>
			{#snippet control()}
				<ValueField
					id="WEB_PUSH_VAPID_PUBLIC_KEY"
					mono
					value={adminConfig.WEB_PUSH_VAPID_PUBLIC_KEY ?? ''}
					placeholder={envDefaults.WEB_PUSH_VAPID_PUBLIC_KEY ?? ''}
					onchange={(next) => setValue('WEB_PUSH_VAPID_PUBLIC_KEY', next)}
				/>
			{/snippet}
		</SettingRow>

		<SettingRow
			label={$t('admin.webPushVapidPrivateKey')}
			meaning={$t('admin.system.secret.writeOnly')}
			configKey="WEB_PUSH_VAPID_PRIVATE_KEY"
			dirty={isDirty('WEB_PUSH_VAPID_PRIVATE_KEY')}
			highlighted={highlightKey === 'WEB_PUSH_VAPID_PRIVATE_KEY'}
			onReset={() => resetValue('WEB_PUSH_VAPID_PRIVATE_KEY')}
			canReset={isDirty('WEB_PUSH_VAPID_PRIVATE_KEY')}
		>
			{#snippet control()}
				<SecretField
					inputId="WEB_PUSH_VAPID_PRIVATE_KEY"
					label={$t('admin.webPushVapidPrivateKey')}
					value={adminConfig.WEB_PUSH_VAPID_PRIVATE_KEY ?? ''}
					lastChanged={secretChangedAt.WEB_PUSH_VAPID_PRIVATE_KEY ?? ''}
					onchange={(next) => setValue('WEB_PUSH_VAPID_PRIVATE_KEY', next)}
					onCancelReplace={() => revertValue('WEB_PUSH_VAPID_PRIVATE_KEY')}
				/>
			{/snippet}
		</SettingRow>

		<SettingRow
			label={$t('admin.webPushVapidSubject')}
			configKey="WEB_PUSH_VAPID_SUBJECT"
			controlId="WEB_PUSH_VAPID_SUBJECT"
			dirty={isDirty('WEB_PUSH_VAPID_SUBJECT')}
			highlighted={highlightKey === 'WEB_PUSH_VAPID_SUBJECT'}
			onReset={() => resetValue('WEB_PUSH_VAPID_SUBJECT')}
			canReset={isDirty('WEB_PUSH_VAPID_SUBJECT')}
		>
			{#snippet control()}
				<ValueField
					id="WEB_PUSH_VAPID_SUBJECT"
					value={adminConfig.WEB_PUSH_VAPID_SUBJECT ?? ''}
					placeholder={envDefaults.WEB_PUSH_VAPID_SUBJECT ?? ''}
					onchange={(next) => setValue('WEB_PUSH_VAPID_SUBJECT', next)}
				/>
			{/snippet}
		</SettingRow>
	</div>
</SystemCard>
