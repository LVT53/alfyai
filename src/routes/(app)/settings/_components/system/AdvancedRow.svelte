<script lang="ts">
// One Advanced row, saying the same four things every time: what it is in
// plain words, the value, the default, and when the change takes effect.
import { Bolt, Clock, Pencil, RotateCcw } from "@lucide/svelte";
import {
	type AdminConfigKeySpec,
	fromDisplayNumber,
	toDisplayNumber,
	validateAdminConfigValue,
} from "$lib/config/admin-config-registry";
import { t, type I18nKey } from "$lib/i18n";
import SecretField from "./SecretField.svelte";
import SystemToggle from "./SystemToggle.svelte";
import ValueField from "./ValueField.svelte";
import "./system.css";

let {
	spec,
	value,
	defaultValue = "",
	secretChangedAt = "",
	dirty = false,
	highlighted = false,
	error = "",
	onchange,
	onReset,
	onRevert,
}: {
	spec: AdminConfigKeySpec;
	value: string;
	defaultValue?: string;
	secretChangedAt?: string;
	dirty?: boolean;
	highlighted?: boolean;
	error?: string;
	onchange: (next: string) => void;
	onReset: () => void;
	onRevert: () => void;
} = $props();

const label = $derived($t(`admin.system.keys.${spec.key}.label` as I18nKey));
const meaning = $derived(
	$t(`admin.system.keys.${spec.key}.meaning` as I18nKey),
);

const unitLabel = $derived(
	spec.control.kind === "int" && spec.control.unit
		? $t(`admin.system.unit.${spec.control.unit}` as I18nKey)
		: "",
);

const shownValue = $derived(toDisplayNumber(spec, value ?? ""));
const shownDefault = $derived(
	defaultValue === ""
		? $t("admin.system.emptyValue")
		: `${toDisplayNumber(spec, defaultValue)}${unitLabel ? ` ${unitLabel}` : ""}`,
);

const effectLabel = $derived(
	spec.effect === "live"
		? $t("admin.system.effect.live")
		: spec.effect === "next-run"
			? $t("admin.system.effect.nextRun")
			: $t("admin.system.effect.restart"),
);

const effectHint = $derived(
	spec.effect === "live"
		? $t("admin.system.effect.liveHint")
		: spec.effect === "next-run"
			? $t("admin.system.effect.nextRunHint")
			: $t("admin.system.effect.restartHint"),
);

function write(shown: string) {
	onchange(fromDisplayNumber(spec, shown));
}

const localError = $derived.by(() => {
	if (error) return error;
	const result = validateAdminConfigValue(spec, value ?? "");
	if (result.ok) return "";
	if (result.reason === "not-a-number")
		return $t("admin.system.invalid.number");
	if (result.reason === "below-min") {
		return $t("admin.system.invalid.min", {
			limit: toDisplayNumber(spec, String(result.limit ?? 0)),
		});
	}
	if (result.reason === "above-max") {
		return $t("admin.system.invalid.max", {
			limit: toDisplayNumber(spec, String(result.limit ?? 0)),
		});
	}
	return $t("admin.system.invalid.option");
});
</script>

<tr
	class:sys-tr-dirty={dirty}
	class:sys-tr-highlight={highlighted}
	data-config-key={spec.key}
	data-testid={`advanced-row-${spec.key}`}
>
	<td class="sys-td-primary" style="width: 330px">
		<span class="sys-label">
			<label for={`adv-${spec.key}`}>{label}</label>
			{#if dirty}
				<span class="sys-chip sys-chip-dirty">
					<Pencil size={9} strokeWidth={2.5} aria-hidden="true" />
					{$t('admin.system.unsaved')}
				</span>
			{/if}
		</span>
		<span class="sys-key">{spec.key}</span>
		<p class="sys-help">{meaning}</p>
		{#if spec.warn}
			<p class="sys-help" style="color: var(--warning)">
				{$t('admin.system.advanced.owntracksWarning')}
			</p>
		{/if}
	</td>

	<td style="width: 320px">
		<div class="sys-row-control">
			{#if spec.control.kind === 'bool'}
				<SystemToggle
					id={`adv-${spec.key}`}
					label={label}
					checked={value === 'true'}
					onchange={(next) => onchange(next ? 'true' : 'false')}
				/>
				<span class="sys-xs sys-muted">
					{value === 'true' ? $t('admin.enabled') : $t('admin.disabled')}
				</span>
			{:else if spec.control.kind === 'secret'}
				<SecretField
					inputId={`adv-${spec.key}`}
					label={label}
					value={value ?? ''}
					lastChanged={secretChangedAt}
					onchange={onchange}
					onCancelReplace={onRevert}
				/>
			{:else if spec.control.kind === 'select'}
				<select
					id={`adv-${spec.key}`}
					class="sys-input sys-input-md"
					aria-label={label}
					value={value ?? ''}
					onchange={(event) => onchange(event.currentTarget.value)}
				>
					{#each spec.control.options as option (option)}
						<option value={option}>
							{option === '' ? $t('admin.system.emptyValue') : option}
						</option>
					{/each}
				</select>
			{:else if spec.control.kind === 'int'}
				<ValueField
					id={`adv-${spec.key}`}
					type="number"
					size="sm"
					label={label}
					unit={unitLabel}
					invalid={Boolean(localError)}
					value={shownValue}
					placeholder={toDisplayNumber(spec, defaultValue)}
					onchange={write}
				/>
			{:else}
				<ValueField
					id={`adv-${spec.key}`}
					label={label}
					mono={spec.control.kind === 'url'}
					value={value ?? ''}
					placeholder={defaultValue}
					onchange={onchange}
				/>
			{/if}

			{#if dirty || (value ?? '') !== defaultValue}
				<button
					type="button"
					class="sys-mini"
					aria-label={$t('admin.system.resetToDefaultA11y', { label })}
					onclick={onReset}
				>
					<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
					{$t('admin.system.resetToDefault')}
				</button>
			{/if}
		</div>
		{#if localError}
			<p class="sys-error" role="alert">{localError}</p>
		{/if}
	</td>

	<td class="sys-num" style="width: 130px">{shownDefault}</td>

	<td style="width: 110px">
		<span
			class="sys-chip"
			class:sys-chip-live={spec.effect === 'live'}
			class:sys-pill-muted={spec.effect !== 'live'}
			title={effectHint}
		>
			{#if spec.effect === 'live'}
				<Bolt size={9} strokeWidth={2.5} aria-hidden="true" />
			{:else}
				<Clock size={9} strokeWidth={2.5} aria-hidden="true" />
			{/if}
			{effectLabel}
		</span>
	</td>
</tr>
