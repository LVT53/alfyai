<script lang="ts">
// Every secret in the product, in one place and one idiom. Two of these — the
// VAPID keys — used to live inside the Atlas card, which they never belonged to.
import {
	ADVANCED_KEY_SPEC_BY_KEY,
	type AdminConfigKeySpec,
	fromDisplayNumber,
	toDisplayNumber,
} from "$lib/config/admin-config-registry";
import { t, type I18nKey } from "$lib/i18n";
import MineruStatusCard from "./MineruStatusCard.svelte";
import SecretField from "./SecretField.svelte";
import SettingRow from "./SettingRow.svelte";
import SystemCard from "./SystemCard.svelte";
import SystemToggle from "./SystemToggle.svelte";
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

// The reset affordance is offered whenever the row is not already sitting on
// its environment default — a saved override with no pending edit is exactly
// the case an admin needs it for. (`isDirty` alone hid it there.)
function canResetKey(key: string): boolean {
	return isDirty(key) || (adminConfig[key] ?? "") !== (envDefaults[key] ?? "");
}

// The MinerU rows, in the order an admin reads them: where the service is,
// what it is allowed to do, then the timings. Each key's control shape comes
// from its AdminConfigKeySpec, so the page and the Advanced page can never
// disagree about a bound or an option list; only the wording is local, because
// these rows have room for a full sentence where the Advanced table does not.
const MINERU_ROWS: ReadonlyArray<{
	key: string;
	label: I18nKey;
	meaning: I18nKey;
}> = [
	{
		key: "MINERU_API_URL",
		label: "admin.mineruApiUrl",
		meaning: "admin.mineruApiDescription",
	},
	{
		key: "MINERU_API_KEY",
		label: "admin.mineruApiKey",
		meaning: "admin.mineruApiKeyDescription",
	},
	{
		key: "MINERU_DEFAULT_TIER",
		label: "admin.mineruDefaultTier",
		meaning: "admin.mineruDefaultTierDescription",
	},
	{
		key: "MINERU_OCR_MODE",
		label: "admin.mineruOcrMode",
		meaning: "admin.mineruOcrModeDescription",
	},
	{
		key: "MINERU_JOB_TIMEOUT_MS",
		label: "admin.mineruJobTimeoutMs",
		meaning: "admin.mineruJobTimeoutMsDescription",
	},
	{
		key: "MINERU_REQUEST_TIMEOUT_MS",
		label: "admin.mineruRequestTimeoutMs",
		meaning: "admin.mineruRequestTimeoutMsDescription",
	},
	{
		key: "MINERU_TRANSFER_TIMEOUT_MS",
		label: "admin.mineruTransferTimeoutMs",
		meaning: "admin.mineruTransferTimeoutMsDescription",
	},
	{
		key: "MINERU_POLL_MIN_MS",
		label: "admin.mineruPollMinMs",
		meaning: "admin.mineruPollMinMsDescription",
	},
	{
		key: "MINERU_POLL_MAX_MS",
		label: "admin.mineruPollMaxMs",
		meaning: "admin.mineruPollMaxMsDescription",
	},
	{
		key: "MINERU_CAPABILITIES_TTL_MS",
		label: "admin.mineruCapabilitiesTtlMs",
		meaning: "admin.mineruCapabilitiesTtlMsDescription",
	},
	{
		key: "MINERU_BUNDLE_MAX_BYTES",
		label: "admin.mineruBundleMaxBytes",
		meaning: "admin.mineruBundleMaxBytesDescription",
	},
	{
		key: "MINERU_BUNDLE_USER_QUOTA_BYTES",
		label: "admin.mineruBundleUserQuotaBytes",
		meaning: "admin.mineruBundleUserQuotaBytesDescription",
	},
	{
		key: "MINERU_STRUCTURE_CHUNKING_ENABLED",
		label: "admin.mineruStructureChunking",
		meaning: "admin.mineruStructureChunkingDescription",
	},
];

// Every MinerU key has a spec (that is the point of dual-registering them), so
// the fallback here is a type narrowing, never a real case.
function specFor(key: string): AdminConfigKeySpec {
	const spec = ADVANCED_KEY_SPEC_BY_KEY.get(key);
	if (!spec) throw new Error(`no admin config spec for ${key}`);
	return spec;
}

function unitKeyFor(spec: AdminConfigKeySpec): I18nKey | null {
	return spec.control.kind === "int" && spec.control.unit
		? (`admin.system.unit.${spec.control.unit}` as I18nKey)
		: null;
}
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
			canReset={canResetKey('PARALLEL_API_KEY')}
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
			canReset={canResetKey('BRAVE_SEARCH_API_KEY')}
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
	<MineruStatusCard />
	<div class="sys-rows">
		{#each MINERU_ROWS as row (row.key)}
			{@const spec = specFor(row.key)}
			{@const unitKey = unitKeyFor(spec)}
			<SettingRow
				label={$t(row.label)}
				meaning={$t(row.meaning)}
				configKey={row.key}
				controlId={spec.control.kind === 'bool' || spec.control.kind === 'secret'
					? undefined
					: row.key}
				dirty={isDirty(row.key)}
				highlighted={highlightKey === row.key}
				onReset={() => resetValue(row.key)}
				canReset={canResetKey(row.key)}
			>
				{#snippet control()}
					{#if spec.control.kind === 'secret'}
						<SecretField
							inputId={row.key}
							label={$t(row.label)}
							value={adminConfig[row.key] ?? ''}
							lastChanged={secretChangedAt[row.key] ?? ''}
							onchange={(next) => setValue(row.key, next)}
							onCancelReplace={() => revertValue(row.key)}
						/>
					{:else if spec.control.kind === 'bool'}
						<SystemToggle
							id={row.key}
							label={$t(row.label)}
							checked={(adminConfig[row.key] ?? envDefaults[row.key]) !== 'false'}
							onchange={(next) => setValue(row.key, next ? 'true' : 'false')}
						/>
					{:else if spec.control.kind === 'select'}
						<select
							id={row.key}
							class="sys-input sys-input-md"
							aria-label={$t(row.label)}
							value={adminConfig[row.key] ?? envDefaults[row.key] ?? ''}
							onchange={(event) => setValue(row.key, event.currentTarget.value)}
						>
							{#each spec.control.options as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					{:else if spec.control.kind === 'int'}
						<ValueField
							id={row.key}
							type="number"
							size="sm"
							unit={unitKey ? $t(unitKey) : ''}
							value={toDisplayNumber(spec, adminConfig[row.key] ?? '')}
							placeholder={toDisplayNumber(spec, envDefaults[row.key] ?? '')}
							onchange={(next) => setValue(row.key, fromDisplayNumber(spec, next))}
						/>
					{:else}
						<ValueField
							id={row.key}
							mono={spec.control.kind === 'url'}
							value={adminConfig[row.key] ?? ''}
							placeholder={envDefaults[row.key] ?? ''}
							onchange={(next) => setValue(row.key, next)}
						/>
					{/if}
				{/snippet}
			</SettingRow>
		{/each}
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
			canReset={canResetKey('WEB_PUSH_VAPID_PUBLIC_KEY')}
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
			canReset={canResetKey('WEB_PUSH_VAPID_PRIVATE_KEY')}
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
			canReset={canResetKey('WEB_PUSH_VAPID_SUBJECT')}
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
