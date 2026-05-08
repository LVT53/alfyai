<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import type { InferenceProvider } from "$lib/client/api/admin";

const tVal = get(t);

function handleKeydown(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		onClose?.();
	}
}

let {
	model = null,
	isCreate = false,
	onSave,
	onClose,
	adminConfig = {},
	saving = false,
	error = "",
}: {
	model?:
		| (InferenceProvider & {
				isBuiltIn?: boolean;
				flowId?: string;
				componentId?: string;
		  })
		| null;
	isCreate?: boolean;
	onSave?: (data: Record<string, unknown>) => void | Promise<void>;
	onClose?: () => void;
	adminConfig?: Record<string, string>;
	saving?: boolean;
	error?: string;
} = $props();

let formDisplayName = $state(untrack(() => model?.displayName ?? ""));
let formBaseUrl = $state(
	untrack(() => model?.baseUrl ?? "https://api.fireworks.ai/inference/v1"),
);
let formApiKey = $state("");
let formModelName = $state(untrack(() => model?.modelName ?? ""));
let formReasoningEffort = $state<
	"" | "low" | "medium" | "high" | "max" | "xhigh"
>(untrack(() => model?.reasoningEffort ?? ""));
let formThinkingType = $state<"" | "enabled" | "disabled">(
	untrack(() => model?.thinkingType ?? ""),
);
let formEnabled = $state(untrack(() => model?.enabled ?? true));
let formFlowId = $state(untrack(() => model?.flowId ?? ""));
let formComponentId = $state(untrack(() => model?.componentId ?? ""));
let formMaxTokens = $state(
	untrack(() => (model?.maxTokens ? String(model.maxTokens) : "")),
);
let formMaxModelContext = $state(
	untrack(() => (model?.maxModelContext ? String(model.maxModelContext) : "")),
);
let formCompactionUiThreshold = $state(
	untrack(() =>
		model?.compactionUiThreshold ? String(model.compactionUiThreshold) : "",
	),
);
let formTargetConstructedContext = $state(
	untrack(() =>
		model?.targetConstructedContext
			? String(model.targetConstructedContext)
			: "",
	),
);
let formMaxMessageLength = $state(
	untrack(() =>
		model?.maxMessageLength ? String(model.maxMessageLength) : "",
	),
);
let formName = $state(untrack(() => model?.name ?? ""));
let showApiKey = $state(false);
let localError = $state("");

let isBuiltIn = $derived(model?.isBuiltIn ?? false);
let requiresProviderContext = $derived(!isBuiltIn && formEnabled);
let visibleError = $derived(error || localError);

function handleSave() {
	localError = "";
	const data: Record<string, unknown> = {};
	if (isCreate) {
		if (
			!formName ||
			!formDisplayName ||
			!formBaseUrl ||
			!formApiKey ||
			!formModelName
		) {
			localError = $t("admin.fillRequiredFields");
			return;
		}
		data.name = formName;
		data.apiKey = formApiKey;
	} else if (isBuiltIn) {
		if (!formDisplayName || !formBaseUrl || !formModelName) {
			localError = $t("admin.fillRequiredBuiltIn");
			return;
		}
		data.displayName = formDisplayName;
		data.baseUrl = formBaseUrl;
		data.modelName = formModelName;
		data.flowId = formFlowId;
		data.componentId = formComponentId;
		data.model1 =
			model?.name === "model1" || model?.name === "model2"
				? model.name
				: undefined;
		if (formApiKey) data.apiKey = formApiKey;
	} else {
		if (!formDisplayName || !formBaseUrl || !formModelName) {
			localError = $t("admin.fillRequiredBuiltIn");
			return;
		}
	}
	if (requiresProviderContext && !formMaxModelContext) {
		localError = $t("admin.fillRequiredProviderContext");
		return;
	}
	data.displayName = data.displayName ?? formDisplayName;
	data.baseUrl = data.baseUrl ?? formBaseUrl;
	data.modelName = data.modelName ?? formModelName;
	data.reasoningEffort = formReasoningEffort || null;
	data.thinkingType = formThinkingType || null;
	data.enabled = formEnabled;
	data.maxTokens = formMaxTokens ? Number(formMaxTokens) : null;
	data.maxModelContext = formMaxModelContext
		? Number(formMaxModelContext)
		: null;
	data.compactionUiThreshold = formCompactionUiThreshold
		? Number(formCompactionUiThreshold)
		: null;
	data.targetConstructedContext = formTargetConstructedContext
		? Number(formTargetConstructedContext)
		: null;
	data.maxMessageLength = formMaxMessageLength
		? Number(formMaxMessageLength)
		: null;
	onSave?.(data);
}
</script>

<svelte:window onkeydown={handleKeydown} />
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label={isCreate ? $t('admin.addModel') : $t('admin.editModel')}>
	<div class="modal-card">
		<div class="modal-header">
			<h2 class="modal-title">{isCreate ? $t('admin.addModel') : $t('admin.editModel')}</h2>
			<button class="modal-close" onclick={onClose} aria-label={$t('common.close')}>&times;</button>
		</div>
		<div class="modal-body">
			<div class="flex flex-col gap-3">
				{#if isCreate}
					<div>
						<label class="settings-label" for="form-name">{$t('admin.nameId')}</label>
						<input id="form-name" type="text" class="settings-input" bind:value={formName} placeholder={$t('admin.nameIdPlaceholder')} disabled={!isCreate} />
						<p class="mt-1 text-xs text-text-muted">{$t('admin.nameIdDescription')}</p>
					</div>
				{/if}
				<div>
					<label class="settings-label" for="form-display-name">{$t('admin.displayName')}</label>
					<input id="form-display-name" type="text" class="settings-input" bind:value={formDisplayName} placeholder={$t('admin.displayNamePlaceholder')} />
				</div>
				<div>
					<label class="settings-label" for="form-base-url">{$t('admin.baseUrl')}</label>
					<input id="form-base-url" type="url" class="settings-input" bind:value={formBaseUrl} placeholder={$t('admin.baseUrlPlaceholder')} />
				</div>
				<div>
					<label class="settings-label" for="form-api-key">{$t('admin.apiKey')}</label>
					<div class="flex items-center gap-2">
						<input id="form-api-key" type={showApiKey ? 'text' : 'password'} class="settings-input flex-1" bind:value={formApiKey} placeholder={model && !isCreate ? $t('admin.unchanged') : $t('admin.apiKeyPlaceholder')} />
						<button type="button" class="btn-secondary" onclick={() => (showApiKey = !showApiKey)}>
							{showApiKey ? $t('admin.hide') : $t('admin.show')}
						</button>
					</div>
				</div>
				<div>
					<label class="settings-label" for="form-model-name">{$t('admin.modelName')}</label>
					<input id="form-model-name" type="text" class="settings-input" bind:value={formModelName} placeholder={isBuiltIn ? $t('admin.modelNamePlaceholderBuiltIn') : $t('admin.modelNamePlaceholderProvider')} />
				</div>
				<div>
					<label class="settings-label" for="form-max-tokens">{$t('admin.maxTokens')}</label>
					<input id="form-max-tokens" type="number" class="settings-input" bind:value={formMaxTokens} placeholder={$t('admin.maxTokensPlaceholder')} min="1" />
					<p class="mt-1 text-xs text-text-muted">{$t('admin.maxTokensDescription')}</p>
				</div>
				{#if isBuiltIn}
					<div>
						<label class="settings-label" for="form-flow-id">{$t('admin.flowId')}</label>
						<input id="form-flow-id" type="text" class="settings-input" bind:value={formFlowId} placeholder={$t('admin.flowIdPlaceholder')} />
					</div>
					<div>
						<label class="settings-label" for="form-component-id">{$t('admin.componentId')}</label>
						<input id="form-component-id" type="text" class="settings-input" bind:value={formComponentId} placeholder={$t('admin.componentIdPlaceholder')} />
						<p class="mt-1 text-xs text-text-muted">{$t('admin.componentIdDescription')}</p>
					</div>
				{/if}
				<div>
					<label class="settings-label" for="form-reasoning-effort">{$t('admin.reasoningEffort')}</label>
					<select id="form-reasoning-effort" class="settings-input" bind:value={formReasoningEffort}>
						<option value="">{$t('admin.providerDefault')}</option>
						<option value="low">{$t('admin.low')}</option>
						<option value="medium">{$t('admin.medium')}</option>
						<option value="high">{$t('admin.high')}</option>
						<option value="max">{$t('admin.max')}</option>
						<option value="xhigh">{$t('admin.xHigh')}</option>
					</select>
				</div>
				<div>
					<label class="settings-label" for="form-thinking-type">{$t('admin.thinkingType')}</label>
					<select id="form-thinking-type" class="settings-input" bind:value={formThinkingType}>
						<option value="">{$t('admin.doNotSend')}</option>
						<option value="enabled">{$t('admin.enabled')}</option>
						<option value="disabled">{$t('admin.disabled')}</option>
					</select>
				</div>
				<div class="flex items-center gap-2">
					<input id="form-enabled" type="checkbox" bind:checked={formEnabled} />
					<label class="settings-label mb-0" for="form-enabled">{$t('admin.enabled')}</label>
				</div>
				<div class="mt-2 border-t border-border pt-3">
					<h3 class="text-sm font-medium text-text-primary mb-2">{$t('admin.contextLimits')}</h3>
					<p class="text-xs text-text-muted mb-2">{requiresProviderContext ? $t('admin.contextLimitsDescriptionProvider') : $t('admin.contextLimitsDescriptionBuiltIn')}</p>
					<div class="flex flex-col gap-2">
						<div>
							<label class="settings-label" for="form-max-context">{$t('admin.maxModelContextLabel')}</label>
							<input id="form-max-context" type="number" class="settings-input" bind:value={formMaxModelContext} placeholder="262144" min="1000" required={requiresProviderContext} />
							{#if requiresProviderContext}
								<p class="mt-1 text-xs text-text-muted">{$t('admin.maxModelContextRequired')}</p>
							{/if}
						</div>
						<div>
							<label class="settings-label" for="form-compaction-threshold">{$t('admin.compactionUiThresholdLabel')}</label>
							<input id="form-compaction-threshold" type="number" class="settings-input" bind:value={formCompactionUiThreshold} placeholder="209715" min="1000" />
						</div>
						<div>
							<label class="settings-label" for="form-target-context">{$t('admin.targetConstructedContextLabel')}</label>
							<input id="form-target-context" type="number" class="settings-input" bind:value={formTargetConstructedContext} placeholder="235929" min="1000" />
						</div>
						<div>
							<label class="settings-label" for="form-max-msg-length">{$t('admin.maxMessageLengthLabel')}</label>
							<input id="form-max-msg-length" type="number" class="settings-input" bind:value={formMaxMessageLength} placeholder="10000" min="1" />
						</div>
					</div>
				</div>
			</div>

			{#if visibleError}
				<p class="mt-4 text-sm text-danger">{visibleError}</p>
			{/if}

			<div class="mt-4 flex gap-2">
				<button class="btn-primary flex-1" onclick={handleSave} disabled={saving}>
					{saving ? $t('common.saving') : $t('admin.saveChanges')}
				</button>
				<button class="btn-secondary" onclick={onClose}>{$t('common.cancel')}</button>
			</div>
		</div>
	</div>
</div>

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(4px);
	}
	.modal-card {
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		width: min(32rem, calc(100vw - 2rem));
		max-height: calc(100vh - 4rem);
		overflow-y: auto;
	}
	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-default);
	}
	.modal-title {
		font-size: 1.1rem;
		font-weight: 600;
	}
	.modal-close {
		font-size: 1.5rem;
		line-height: 1;
		padding: 0.25rem;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
	}
	.modal-body {
		padding: 1.25rem;
	}
</style>
