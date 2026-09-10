<script lang="ts">
import { t } from "$lib/i18n";
import SettingRow from "./SettingRow.svelte";
import SystemCard from "./SystemCard.svelte";
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

const ROWS = [
	{
		key: "MAX_MESSAGE_LENGTH",
		label: "admin.maxMessageLength",
		meaning: "admin.maxMessageLengthDescription",
		unit: "admin.system.unit.chars",
		min: 1,
	},
	{
		key: "MAX_FILE_UPLOAD_SIZE",
		label: "admin.maxFileUploadSize",
		meaning: "admin.maxFileUploadDescription",
		unit: "",
		min: 1,
	},
	{
		key: "REQUEST_TIMEOUT_MS",
		label: "admin.requestTimeoutMs",
		meaning: "admin.requestTimeoutDescription",
		unit: "admin.system.unit.ms",
		min: 1,
	},
] as const;
</script>

<SystemCard
	title={$t('admin.system.limits.title')}
	description={$t('admin.system.limits.description')}
	testId="system-page-limits"
>
	<div class="sys-rows">
		{#each ROWS as row (row.key)}
			<SettingRow
				label={$t(row.label)}
				meaning={$t(row.meaning)}
				configKey={row.key}
				controlId={row.key}
				dirty={isDirty(row.key)}
				highlighted={highlightKey === row.key}
				onReset={() => resetValue(row.key)}
				canReset={isDirty(row.key)}
			>
				{#snippet control()}
					<ValueField
						id={row.key}
						type="number"
						size="sm"
						min={row.min}
						unit={row.unit ? $t(row.unit) : ''}
						value={adminConfig[row.key] ?? ''}
						placeholder={envDefaults[row.key] ?? ''}
						onchange={(next) => setValue(row.key, next)}
					/>
				{/snippet}
			</SettingRow>
		{/each}
	</div>
</SystemCard>
