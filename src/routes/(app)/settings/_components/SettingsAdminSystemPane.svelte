<script lang="ts">
import {
	createAdminSystemSkill,
	createProvider,
	deleteProvider,
	fetchAdminSystemSkills,
	fetchProviders,
	updateAdminConfig,
	updateProvider,
	updateAdminSystemSkill,
	validateProvider,
	fetchPersonalityProfiles,
	type AdminSystemSkill,
	type AdminSystemSkillDraft,
	type InferenceProvider,
	type PersonalityProfileSummary,
} from "$lib/client/api/admin";
import {
	saveModelIconAssetCrop,
	uploadCampaignAssetSource,
	uploadModelIconAsset,
	type CampaignAsset,
	type CampaignAssetCropGeometry,
} from "$lib/client/api/campaign-assets";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import {
	DEEP_RESEARCH_MODEL_ROLES,
	DEFAULT_DEEP_RESEARCH_MODEL_ID,
	type DeepResearchModelRoleDefinition,
} from "$lib/deep-research-models";
import type { ModelId } from "$lib/types";
import CampaignCropModal from "$lib/components/campaign-admin/CampaignCropModal.svelte";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import ModelFormModal from "./ModelFormModal.svelte";

const tVal = get(t);

let {
	adminConfig = $bindable(),
	envDefaults = {},
	availableModels = [],
	adminSaving = false,
	adminMessage = "",
	adminError = "",
	honchoHealth = null,
	honchoLoading = false,
	onCheckHonchoHealth,
	onSaveAdminConfig,
}: {
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	availableModels?: Array<{ id: ModelId; displayName: string; iconUrl?: string | null }>;
	adminSaving?: boolean;
	adminMessage?: string;
	adminError?: string;
	honchoHealth?: {
		enabled: boolean;
		connected: boolean;
		workspace: string | null;
	} | null;
	honchoLoading?: boolean;
	onCheckHonchoHealth: () => void | Promise<void>;
	onSaveAdminConfig: () => void | Promise<void>;
} = $props();

let providers = $state<InferenceProvider[]>([]);
let providersLoading = $state(false);
let providersError = $state("");
let adminPersonalities = $state<PersonalityProfileSummary[]>([]);
let systemSkills = $state<AdminSystemSkill[]>([]);
let systemSkillsLoading = $state(false);
let systemSkillsError = $state("");
let systemSkillsMessage = $state("");
let editingSystemSkillId = $state<string | null>(null);
let systemSkillSaving = $state(false);
let systemSkillDraft = $state<
	AdminSystemSkillDraft & { activationExamplesText: string }
>({
	displayName: "",
	description: "",
	instructions: "",
	activationExamplesText: "",
	enabled: true,
	published: false,
	durationPolicy: "next_message",
	questionPolicy: "ask_when_needed",
	notesPolicy: "none",
	sourceScope: "selected_sources_only",
});

$effect(() => {
	void fetchPersonalityProfiles()
		.then((p) => (adminPersonalities = p))
		.catch(() => {});
});
let providersMessage = $state("");
let iconUploading = $state<string | null>(null);
let providersMessageTimer: ReturnType<typeof setTimeout> | undefined;
let systemSkillsMessageTimer: ReturnType<typeof setTimeout> | undefined;

type ModelIconTarget =
	| { kind: "built-in"; modelName: "model1" | "model2" }
	| { kind: "provider"; provider: InferenceProvider };

type ModelIconCropJob = {
	key: string;
	target: ModelIconTarget;
	imageSrc: string;
	sourceUpload: Promise<CampaignAsset>;
};

let modelIconCropJob = $state<ModelIconCropJob | null>(null);

function showProvidersMessage(text: string) {
	clearTimeout(providersMessageTimer);
	providersMessage = text;
	providersMessageTimer = setTimeout(() => {
		providersMessage = "";
	}, 4000);
}

function showSystemSkillsMessage(text: string) {
	clearTimeout(systemSkillsMessageTimer);
	systemSkillsMessage = text;
	systemSkillsMessageTimer = setTimeout(() => {
		systemSkillsMessage = "";
	}, 4000);
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function campaignAssetContentUrl(assetId: string | null | undefined): string | null {
	return assetId ? `/api/campaign-assets/${encodeURIComponent(assetId)}/content` : null;
}

function builtInIconAssetId(modelName: "model1" | "model2"): string | null {
	const key = modelName === "model1" ? "MODEL_1_ICON_ASSET_ID" : "MODEL_2_ICON_ASSET_ID";
	return adminConfig[key] || null;
}

function builtInIconUrl(modelName: "model1" | "model2"): string | null {
	return campaignAssetContentUrl(builtInIconAssetId(modelName));
}

function providerIconUrl(provider: InferenceProvider): string | null {
	return provider.iconUrl ?? campaignAssetContentUrl(provider.iconAssetId);
}

function uploadKeyForProvider(provider: InferenceProvider): string {
	return `provider:${provider.id}`;
}

function uploadKeyForTarget(target: ModelIconTarget): string {
	return target.kind === "built-in" ? target.modelName : uploadKeyForProvider(target.provider);
}

function isSvgFile(file: File): boolean {
	return file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
}

async function applyModelIconAsset(target: ModelIconTarget, assetId: string) {
	if (target.kind === "built-in") {
		const configKey =
			target.modelName === "model1"
				? "MODEL_1_ICON_ASSET_ID"
				: "MODEL_2_ICON_ASSET_ID";
		adminConfig[configKey] = assetId;
		await updateAdminConfig({ [configKey]: assetId });
		return;
	}

	await updateProvider(target.provider.id, { iconAssetId: assetId });
	await loadProviders();
}

async function handleModelIconFile(event: Event, target: ModelIconTarget) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0] ?? null;
	input.value = "";
	if (!file) return;

	const key = uploadKeyForTarget(target);
	iconUploading = key;
	providersError = "";
	providersMessage = "";
	try {
		if (isSvgFile(file)) {
			const asset = await uploadModelIconAsset({ image: file });
			await applyModelIconAsset(target, asset.id);
			showProvidersMessage($t("admin.modelIconUpdated"));
			return;
		}

		const imageSrc = URL.createObjectURL(file);
		const sourceUpload = uploadCampaignAssetSource({ image: file });
		sourceUpload.catch((error: unknown) => {
			providersError = errorMessage(error, $t("admin.modelIconUploadFailed"));
		});
		modelIconCropJob = {
			key,
			target,
			imageSrc,
			sourceUpload,
		};
	} catch (error: unknown) {
		providersError = errorMessage(error, $t("admin.modelIconUploadFailed"));
		if (modelIconCropJob?.key === key) {
			URL.revokeObjectURL(modelIconCropJob.imageSrc);
			modelIconCropJob = null;
		}
	} finally {
		iconUploading = null;
	}
}

async function saveModelIconCrop(payload: { file: File; width: number; height: number; crop: CampaignAssetCropGeometry }) {
	if (!modelIconCropJob) return;
	const activeCrop = modelIconCropJob;
	iconUploading = activeCrop.key;
	try {
		const source = await activeCrop.sourceUpload;
		const asset = await saveModelIconAssetCrop({
			sourceAssetId: source.id,
			image: payload.file,
			width: payload.width,
			height: payload.height,
			crop: payload.crop,
		});
		await applyModelIconAsset(activeCrop.target, asset.id);
		showProvidersMessage($t("admin.modelIconUpdated"));
		URL.revokeObjectURL(activeCrop.imageSrc);
		modelIconCropJob = null;
	} catch (error: unknown) {
		throw new Error(errorMessage(error, $t("admin.modelIconUploadFailed")));
	} finally {
		if (iconUploading === activeCrop.key) iconUploading = null;
	}
}

function cancelModelIconCrop() {
	if (modelIconCropJob) URL.revokeObjectURL(modelIconCropJob.imageSrc);
	modelIconCropJob = null;
}

// Modal state
let showModal = $state(false);
let modalModel = $state<
	| (InferenceProvider & {
			isBuiltIn?: boolean;
			flowId?: string;
			componentId?: string;
	  })
	| null
>(null);
let modalIsCreate = $state(false);
let modalSaving = $state(false);
let modalError = $state("");

async function loadProviders() {
	providersLoading = true;
	providersError = "";
	try {
		providers = await fetchProviders();
	} catch (error: unknown) {
		providersError = errorMessage(error, $t("admin.failedLoadProviders"));
	} finally {
		providersLoading = false;
	}
}

async function loadSystemSkills() {
	systemSkillsLoading = true;
	systemSkillsError = "";
	try {
		systemSkills = await fetchAdminSystemSkills();
	} catch (error: unknown) {
		systemSkillsError = errorMessage(error, $t("admin.systemSkills.errors.load"));
	} finally {
		systemSkillsLoading = false;
	}
}

function resetSystemSkillDraft() {
	editingSystemSkillId = null;
	systemSkillDraft = {
		displayName: "",
		description: "",
		instructions: "",
		activationExamplesText: "",
		enabled: true,
		published: false,
		durationPolicy: "next_message",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "selected_sources_only",
	};
}

function editSystemSkill(skill: AdminSystemSkill) {
	editingSystemSkillId = skill.id;
	systemSkillsError = "";
	systemSkillDraft = {
		displayName: skill.displayName,
		description: skill.description,
		instructions: skill.instructions,
		activationExamplesText: skill.activationExamples.join("\n"),
		enabled: skill.enabled,
		published: skill.published,
		durationPolicy: skill.durationPolicy,
		questionPolicy: skill.questionPolicy,
		notesPolicy: skill.notesPolicy,
		sourceScope: skill.sourceScope,
	};
}

function systemSkillPayload(): AdminSystemSkillDraft {
	return {
		displayName: systemSkillDraft.displayName,
		description: systemSkillDraft.description,
		instructions: systemSkillDraft.instructions,
		activationExamples: systemSkillDraft.activationExamplesText
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		enabled: systemSkillDraft.enabled,
		published: systemSkillDraft.published,
		durationPolicy: systemSkillDraft.durationPolicy,
		questionPolicy: systemSkillDraft.questionPolicy,
		notesPolicy: systemSkillDraft.notesPolicy,
		sourceScope: systemSkillDraft.sourceScope,
	};
}

async function saveSystemSkill() {
	systemSkillSaving = true;
	systemSkillsError = "";
	try {
		if (editingSystemSkillId) {
			await updateAdminSystemSkill(editingSystemSkillId, systemSkillPayload());
			showSystemSkillsMessage($t("admin.systemSkills.updated"));
		} else {
			await createAdminSystemSkill(systemSkillPayload());
			showSystemSkillsMessage($t("admin.systemSkills.created"));
		}
		resetSystemSkillDraft();
		await loadSystemSkills();
	} catch (error: unknown) {
		systemSkillsError = errorMessage(error, $t("admin.systemSkills.errors.save"));
	} finally {
		systemSkillSaving = false;
	}
}

async function updateSystemSkillFlags(skill: AdminSystemSkill, changes: Partial<AdminSystemSkillDraft>) {
	systemSkillsError = "";
	try {
		await updateAdminSystemSkill(skill.id, changes);
		showSystemSkillsMessage($t("admin.systemSkills.updated"));
		await loadSystemSkills();
	} catch (error: unknown) {
		systemSkillsError = errorMessage(error, $t("admin.systemSkills.errors.save"));
	}
}

function openAddProvider() {
	modalModel = null;
	modalIsCreate = true;
	modalError = "";
	modalSaving = false;
	showModal = true;
}

function openEditBuiltIn(modelName: string) {
	const prefix = modelName === "model1" ? "MODEL_1" : "MODEL_2";
	modalModel = {
		id: modelName,
		name: modelName,
		displayName: adminConfig[`${prefix}_DISPLAY_NAME`] ?? "",
		baseUrl: adminConfig[`${prefix}_BASEURL`] ?? "",
		apiKey: adminConfig[`${prefix}_API_KEY`] ?? "",
		modelName: adminConfig[`${prefix}_NAME`] ?? "",
		reasoningEffort:
			(adminConfig[`${prefix}_REASONING_EFFORT`] as
				| "low"
				| "medium"
				| "high"
				| "max"
				| "xhigh"
				| "") || null,
		thinkingType:
			(adminConfig[`${prefix}_THINKING_TYPE`] as "enabled" | "disabled" | "") ||
			null,
		enabled:
			modelName === "model2" ? adminConfig.MODEL_2_ENABLED !== "false" : true,
		sortOrder: 0,
		maxModelContext: adminConfig[`${prefix}_MAX_MODEL_CONTEXT`]
			? Number(adminConfig[`${prefix}_MAX_MODEL_CONTEXT`])
			: null,
		compactionUiThreshold: adminConfig[`${prefix}_COMPACTION_UI_THRESHOLD`]
			? Number(adminConfig[`${prefix}_COMPACTION_UI_THRESHOLD`])
			: null,
		targetConstructedContext: adminConfig[
			`${prefix}_TARGET_CONSTRUCTED_CONTEXT`
		]
			? Number(adminConfig[`${prefix}_TARGET_CONSTRUCTED_CONTEXT`])
			: null,
		maxMessageLength: adminConfig[`${prefix}_MAX_MESSAGE_LENGTH`]
			? Number(adminConfig[`${prefix}_MAX_MESSAGE_LENGTH`])
			: null,
		maxTokens: adminConfig[`${prefix}_MAX_TOKENS`]
			? Number(adminConfig[`${prefix}_MAX_TOKENS`])
			: null,
		iconAssetId: adminConfig[`${prefix}_ICON_ASSET_ID`] || null,
		createdAt: "",
		updatedAt: "",
		isBuiltIn: true,
		flowId: adminConfig[`${prefix}_FLOW_ID`] ?? "",
		componentId: adminConfig[`${prefix}_COMPONENT_ID`] ?? "",
	};
	modalIsCreate = false;
	modalError = "";
	modalSaving = false;
	showModal = true;
}

function openEditProvider(provider: InferenceProvider) {
	modalModel = { ...provider };
	modalIsCreate = false;
	modalError = "";
	modalSaving = false;
	showModal = true;
}

function closeModal() {
	showModal = false;
	modalModel = null;
	modalError = "";
}

async function handleModalSave(data: Record<string, unknown>) {
	modalSaving = true;
	modalError = "";
	providersMessage = "";
	try {
		if (modalIsCreate) {
			await createProvider(data as Parameters<typeof createProvider>[0]);
			showProvidersMessage($t("admin.providerAdded"));
		} else if (modalModel?.isBuiltIn) {
			// Save built-in model config via admin config keys
			const prefix = modalModel.name === "model1" ? "MODEL_1" : "MODEL_2";
			if (data.displayName !== undefined)
				adminConfig[`${prefix}_DISPLAY_NAME`] = data.displayName as string;
			if (data.baseUrl !== undefined)
				adminConfig[`${prefix}_BASEURL`] = data.baseUrl as string;
			if (data.apiKey !== undefined)
				adminConfig[`${prefix}_API_KEY`] = data.apiKey as string;
			if (data.modelName !== undefined)
				adminConfig[`${prefix}_NAME`] = data.modelName as string;
			if (data.flowId !== undefined)
				adminConfig[`${prefix}_FLOW_ID`] = data.flowId as string;
			if (data.componentId !== undefined)
				adminConfig[`${prefix}_COMPONENT_ID`] = data.componentId as string;
			if (data.maxTokens !== undefined)
				adminConfig[`${prefix}_MAX_TOKENS`] =
					data.maxTokens != null ? String(data.maxTokens) : "";
			if (data.reasoningEffort !== undefined)
				adminConfig[`${prefix}_REASONING_EFFORT`] =
					data.reasoningEffort != null ? String(data.reasoningEffort) : "";
			if (data.thinkingType !== undefined)
				adminConfig[`${prefix}_THINKING_TYPE`] =
					data.thinkingType != null ? String(data.thinkingType) : "";
			if (data.enabled !== undefined)
				adminConfig[`${prefix}_ENABLED`] = (data.enabled as boolean)
					? "true"
					: "false";
			if (data.maxModelContext !== undefined)
				adminConfig[`${prefix}_MAX_MODEL_CONTEXT`] =
					data.maxModelContext != null ? String(data.maxModelContext) : "";
			if (data.compactionUiThreshold !== undefined)
				adminConfig[`${prefix}_COMPACTION_UI_THRESHOLD`] =
					data.compactionUiThreshold != null
						? String(data.compactionUiThreshold)
						: "";
			if (data.targetConstructedContext !== undefined)
				adminConfig[`${prefix}_TARGET_CONSTRUCTED_CONTEXT`] =
					data.targetConstructedContext != null
						? String(data.targetConstructedContext)
						: "";
			if (data.maxMessageLength !== undefined)
				adminConfig[`${prefix}_MAX_MESSAGE_LENGTH`] =
					data.maxMessageLength != null ? String(data.maxMessageLength) : "";
			await onSaveAdminConfig?.();
			showProvidersMessage(
				`${modalModel.displayName || modelNameDisplay(modalModel.name)} ${$t("common.updated").toLowerCase()}`,
			);
		} else if (modalModel) {
			await updateProvider(
				modalModel.id,
				data as Parameters<typeof updateProvider>[1],
			);
			showProvidersMessage($t("admin.providerUpdated"));
		}
		closeModal();
		await loadProviders();
	} catch (error: unknown) {
		modalError = errorMessage(error, $t("admin.failedSave"));
	} finally {
		modalSaving = false;
	}
}

async function handleDelete(provider: InferenceProvider) {
	if (
		!confirm($t("admin.deleteProviderConfirm", { name: provider.displayName }))
	)
		return;
	providersMessage = "";
	try {
		await deleteProvider(provider.id);
		showProvidersMessage($t("admin.providerDeleted"));
		await loadProviders();
	} catch (error: unknown) {
		providersError = errorMessage(error, $t("admin.failedDeleteProvider"));
	}
}

async function handleValidate(provider: InferenceProvider) {
	providersMessage = "";
	providersError = "";
	try {
		const result = await validateProvider(provider.id);
		if (result.valid) {
			showProvidersMessage(
				$t("admin.providerValid", {
					name: provider.displayName,
				}),
			);
		} else {
			providersError = $t("admin.validationFailed", {
				error: result.error ?? "Unknown error",
			});
		}
	} catch (error: unknown) {
		providersError = errorMessage(error, $t("admin.failedValidateProvider"));
	}
}

function modelNameDisplay(name: string): string {
	return name === "model1"
		? adminConfig.MODEL_1_DISPLAY_NAME || "Model 1"
		: name === "model2"
			? adminConfig.MODEL_2_DISPLAY_NAME || "Model 2"
			: name;
}

function deepResearchModelOptions(): Array<{
	id: ModelId;
	displayName: string;
}> {
	const options = new Map<ModelId, string>();
	for (const model of availableModels) {
		options.set(model.id, model.displayName);
	}
	if (!options.has("model1")) {
		options.set("model1", adminConfig.MODEL_1_DISPLAY_NAME || "Model 1");
	}
	if (adminConfig.MODEL_2_ENABLED !== "false" && !options.has("model2")) {
		options.set("model2", adminConfig.MODEL_2_DISPLAY_NAME || "Model 2");
	}
	for (const provider of providers) {
		if (!provider.enabled) continue;
		options.set(`provider:${provider.id}` as ModelId, provider.displayName);
	}
	return Array.from(options, ([id, displayName]) => ({ id, displayName }));
}

function defaultNewUserModelOptions(): Array<{
	id: ModelId;
	displayName: string;
}> {
	const options = new Map<ModelId, string>();
	for (const provider of providers) {
		if (!provider.enabled) continue;
		options.set(`provider:${provider.id}` as ModelId, provider.displayName);
	}
	for (const model of deepResearchModelOptions()) {
		if (!options.has(model.id)) {
			options.set(model.id, model.displayName);
		}
	}
	return Array.from(options, ([id, displayName]) => ({ id, displayName }));
}

function defaultNewUserModelValue(): ModelId {
	const configured = (adminConfig.DEFAULT_NEW_USER_MODEL ||
		envDefaults.DEFAULT_NEW_USER_MODEL ||
		"model1") as ModelId;
	const options = defaultNewUserModelOptions();
	return options.some((model) => model.id === configured)
		? configured
		: (options[0]?.id ?? "model1");
}

function deepResearchRoleValue(
	role: DeepResearchModelRoleDefinition,
): ModelId {
	return (adminConfig[role.configKey] ||
		envDefaults[role.configKey] ||
		DEFAULT_DEEP_RESEARCH_MODEL_ID) as ModelId;
}

$effect(() => {
	void loadProviders();
});

$effect(() => {
	void loadSystemSkills();
});

function configLabelKey(key: string): string {
	const map: Record<string, string> = {
		MODEL_1_BASEURL: "admin.model1BaseUrl",
		MODEL_1_API_KEY: "admin.model1ApiKey",
		MODEL_1_NAME: "admin.model1Name",
		MODEL_1_DISPLAY_NAME: "admin.model1DisplayName",
		MODEL_1_ICON_ASSET_ID: "admin.model1IconAssetId",
		MODEL_1_SYSTEM_PROMPT: "admin.model1SystemPrompt",
		MODEL_1_FLOW_ID: "admin.model1FlowId",
		MODEL_1_COMPONENT_ID: "admin.model1ComponentId",
		MODEL_2_BASEURL: "admin.model2BaseUrl",
		MODEL_2_API_KEY: "admin.model2ApiKey",
		MODEL_2_NAME: "admin.model2Name",
		MODEL_2_DISPLAY_NAME: "admin.model2DisplayName",
		MODEL_2_ICON_ASSET_ID: "admin.model2IconAssetId",
		MODEL_2_SYSTEM_PROMPT: "admin.model2SystemPrompt",
		MODEL_2_FLOW_ID: "admin.model2FlowId",
		MODEL_2_COMPONENT_ID: "admin.model2ComponentId",
		MODEL_2_ENABLED: "admin.model2Enabled",
		COMPOSER_COMMAND_REGISTRY_ENABLED:
			"admin.composerCommandRegistryEnabled",
		APP_VERSION_OVERRIDE: "admin.appVersionOverride",
		DEEP_RESEARCH_ENABLED: "admin.deepResearchEnabled",
		DEEP_RESEARCH_WORKER_ENABLED: "admin.deepResearchWorkerEnabled",
		DEEP_RESEARCH_WORKER_INTERVAL_MS: "admin.deepResearchWorkerIntervalMs",
		DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS: "admin.deepResearchWorkerStaleTimeoutMs",
		DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS: "admin.deepResearchJobRuntimeLimitMs",
		DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY: "admin.deepResearchWorkerGlobalConcurrency",
		DEEP_RESEARCH_WORKER_USER_CONCURRENCY: "admin.deepResearchWorkerUserConcurrency",
		DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT: "admin.deepResearchActiveConversationLimit",
		DEEP_RESEARCH_ACTIVE_USER_LIMIT: "admin.deepResearchActiveUserLimit",
		DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT: "admin.deepResearchActiveGlobalLimit",
		DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY: "admin.deepResearchGlobalReasoningConcurrency",
		DEEP_RESEARCH_USER_REASONING_CONCURRENCY: "admin.deepResearchUserReasoningConcurrency",
		DEEP_RESEARCH_DEPTH_BUDGETS_JSON: "admin.deepResearchDepthBudgetsJson",
		MODEL_1_MAX_MODEL_CONTEXT: "admin.model1MaxModelContext",
		MODEL_1_COMPACTION_UI_THRESHOLD: "admin.model1CompactionThreshold",
		MODEL_1_TARGET_CONSTRUCTED_CONTEXT: "admin.model1TargetContext",
		MODEL_1_MAX_MESSAGE_LENGTH: "admin.model1MaxMessageLength",
		MODEL_2_MAX_MODEL_CONTEXT: "admin.model2MaxModelContext",
		MODEL_2_COMPACTION_UI_THRESHOLD: "admin.model2CompactionThreshold",
		MODEL_2_TARGET_CONSTRUCTED_CONTEXT: "admin.model2TargetContext",
		MODEL_2_MAX_MESSAGE_LENGTH: "admin.model2MaxMessageLength",
		TITLE_GEN_URL: "admin.titleGenUrl",
		TITLE_GEN_MODEL: "admin.titleGenModel",
		CONTEXT_SUMMARIZER_URL: "admin.contextSummarizerUrl",
		CONTEXT_SUMMARIZER_MODEL: "admin.contextSummarizerModel",
		EXA_API_KEY: "admin.exaApiKey",
		BRAVE_SEARCH_API_KEY: "admin.braveSearchApiKey",
		WEB_RESEARCH_EXA_SEARCH_TYPE: "admin.webResearchExaSearchType",
		WEB_RESEARCH_EXA_NUM_RESULTS: "admin.webResearchExaNumResults",
		WEB_RESEARCH_BRAVE_NUM_RESULTS: "admin.webResearchBraveNumResults",
		WEB_RESEARCH_MAX_SOURCES: "admin.webResearchMaxSources",
		WEB_RESEARCH_HIGHLIGHT_CHARS: "admin.webResearchHighlightChars",
		WEB_RESEARCH_CONTENT_CHARS: "admin.webResearchContentChars",
		WEB_RESEARCH_FRESHNESS_HOURS: "admin.webResearchFreshnessHours",
		TITLE_GEN_SYSTEM_PROMPT_EN: "admin.titleGenPromptEn",
		TITLE_GEN_SYSTEM_PROMPT_HU: "admin.titleGenPromptHu",
		TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN: "admin.titleGenCodeAppendixEn",
		TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU: "admin.titleGenCodeAppendixHu",
		HONCHO_CONTEXT_WAIT_MS: "admin.honchoContextWaitMs",
		HONCHO_PERSONA_CONTEXT_WAIT_MS: "admin.honchoPersonaContextWaitMs",
		HONCHO_OVERVIEW_WAIT_MS: "admin.honchoOverviewWaitMs",
		MINERU_API_URL: "admin.mineruApiUrl",
		MINERU_TIMEOUT_MS: "admin.mineruTimeoutMs",
		MAX_MODEL_CONTEXT: "admin.maxModelContext",
		COMPACTION_UI_THRESHOLD: "admin.compactionUiThreshold",
		TARGET_CONSTRUCTED_CONTEXT: "admin.targetConstructedContext",
		MAX_MESSAGE_LENGTH: "admin.maxMessageLength",
		MAX_FILE_UPLOAD_SIZE: "admin.maxFileUploadSize",
		REQUEST_TIMEOUT_MS: "admin.requestTimeoutMs",
		MODEL_TIMEOUT_FAILOVER_ENABLED: "admin.modelTimeoutFailoverEnabled",
		MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS: "admin.modelTimeoutFailoverTimeoutMs",
		MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: "admin.modelTimeoutFailoverTargetModel",
		SYSTEM_PROMPT: "admin.systemPromptLabel",
	};
	return map[key] ?? key;
}

const NUMBER_KEYS = new Set([
	"HONCHO_CONTEXT_WAIT_MS",
	"HONCHO_OVERVIEW_WAIT_MS",
	"MAX_MODEL_CONTEXT",
	"COMPACTION_UI_THRESHOLD",
	"TARGET_CONSTRUCTED_CONTEXT",
	"MAX_MESSAGE_LENGTH",
	"MINERU_TIMEOUT_MS",
	"HONCHO_PERSONA_CONTEXT_WAIT_MS",
	"WEB_RESEARCH_EXA_NUM_RESULTS",
	"WEB_RESEARCH_BRAVE_NUM_RESULTS",
	"WEB_RESEARCH_MAX_SOURCES",
	"WEB_RESEARCH_HIGHLIGHT_CHARS",
	"WEB_RESEARCH_CONTENT_CHARS",
	"WEB_RESEARCH_FRESHNESS_HOURS",
	"MAX_FILE_UPLOAD_SIZE",
	"REQUEST_TIMEOUT_MS",
	"MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS",
	"DEEP_RESEARCH_WORKER_INTERVAL_MS",
	"DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS",
	"DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS",
	"DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY",
	"DEEP_RESEARCH_WORKER_USER_CONCURRENCY",
	"DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT",
	"DEEP_RESEARCH_ACTIVE_USER_LIMIT",
	"DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT",
	"DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY",
	"DEEP_RESEARCH_USER_REASONING_CONCURRENCY",
]);

function placeholderFor(key: string): string {
	return envDefaults[key] ?? "";
}
</script>

<!-- Unified Models Section -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.models')}</h2>
	<div class="flex flex-col gap-3">
		{#if providersLoading}
			<p class="text-sm text-text-secondary">{$t('admin.loadingModels')}</p>
		{:else if providersError}
			<p class="text-sm text-danger">{providersError}</p>
		{:else}
			<div class="flex flex-col gap-2">
				<!-- Model 1 (built-in, always present) -->
				<div class="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-page px-3 py-2">
					<div class="flex min-w-0 items-center gap-3">
						<ModelIcon iconUrl={builtInIconUrl('model1')} displayName={adminConfig.MODEL_1_DISPLAY_NAME || $t('admin.model1')} size={32} />
						<div class="flex min-w-0 flex-col">
							<span class="truncate text-sm font-medium text-text-primary">{adminConfig.MODEL_1_DISPLAY_NAME || $t('admin.model1')}</span>
							<span class="truncate text-xs text-text-muted">{$t('admin.langflow')} &bull; {adminConfig.MODEL_1_NAME || 'model-1'}</span>
						</div>
					</div>
					<div class="flex flex-wrap items-center justify-end gap-2">
						<span class="inline-block h-2 w-2 rounded-full bg-success"></span>
						<span class="text-xs text-text-muted">{$t('admin.builtIn')}</span>
						<label class="btn-small cursor-pointer">
							{iconUploading === 'model1' ? $t('admin.modelIconUploading') : $t('admin.uploadModelIcon')}
							<input class="sr-only" type="file" accept="image/*,.svg" disabled={iconUploading !== null} onchange={(event) => handleModelIconFile(event, { kind: 'built-in', modelName: 'model1' })} />
						</label>
						<button class="btn-small" onclick={() => openEditBuiltIn('model1')}>{$t('common.edit')}</button>
					</div>
				</div>

				<!-- Model 2 (built-in) -->
				<div class="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-page px-3 py-2">
					<div class="flex min-w-0 items-center gap-3">
						<ModelIcon iconUrl={builtInIconUrl('model2')} displayName={adminConfig.MODEL_2_DISPLAY_NAME || $t('admin.model2')} size={32} />
						<div class="flex min-w-0 flex-col">
							<span class="truncate text-sm font-medium text-text-primary">{adminConfig.MODEL_2_DISPLAY_NAME || $t('admin.model2')}</span>
							<span class="truncate text-xs text-text-muted">{$t('admin.langflow')} &bull; {adminConfig.MODEL_2_NAME || 'model-2'}</span>
						</div>
					</div>
					<div class="flex flex-wrap items-center justify-end gap-2">
						<span class={`inline-block h-2 w-2 rounded-full ${adminConfig.MODEL_2_ENABLED !== 'false' ? 'bg-success' : 'bg-text-muted'}`}></span>
						<span class="text-xs text-text-muted">{$t('admin.builtIn')}</span>
						<label class="btn-small cursor-pointer">
							{iconUploading === 'model2' ? $t('admin.modelIconUploading') : $t('admin.uploadModelIcon')}
							<input class="sr-only" type="file" accept="image/*,.svg" disabled={iconUploading !== null} onchange={(event) => handleModelIconFile(event, { kind: 'built-in', modelName: 'model2' })} />
						</label>
						<button class="btn-small" onclick={() => openEditBuiltIn('model2')}>{$t('common.edit')}</button>
					</div>
				</div>

				<!-- Third-party providers -->
				{#each providers as provider}
					<div class="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-page px-3 py-2">
						<div class="flex min-w-0 items-center gap-3">
							<ModelIcon iconUrl={providerIconUrl(provider)} displayName={provider.displayName} size={32} />
							<div class="flex min-w-0 flex-col">
								<span class="truncate text-sm font-medium text-text-primary">{provider.displayName}</span>
								<span class="truncate text-xs text-text-muted">{provider.baseUrl} &bull; {provider.modelName}</span>
								{#if provider.reasoningEffort || provider.thinkingType}
									<span class="truncate text-xs text-text-tertiary">
										{#if provider.reasoningEffort}
											reasoning_effort: {provider.reasoningEffort}
										{/if}
										{#if provider.reasoningEffort && provider.thinkingType}
											&bull;
										{/if}
										{#if provider.thinkingType}
											extra_body.thinking.type: {provider.thinkingType}
										{/if}
									</span>
								{/if}
							</div>
						</div>
						<div class="flex flex-wrap items-center justify-end gap-2">
							<span class={`inline-block h-2 w-2 rounded-full ${provider.enabled ? 'bg-success' : 'bg-text-muted'}`}></span>
							<label class="btn-small cursor-pointer">
								{iconUploading === uploadKeyForProvider(provider) ? $t('admin.modelIconUploading') : $t('admin.uploadModelIcon')}
								<input class="sr-only" type="file" accept="image/*,.svg" disabled={iconUploading !== null} onchange={(event) => handleModelIconFile(event, { kind: 'provider', provider })} />
							</label>
							<button class="btn-small" onclick={() => handleValidate(provider)}>{$t('common.test')}</button>
							<button class="btn-small" onclick={() => openEditProvider(provider)}>{$t('common.edit')}</button>
							<button class="btn-small text-danger" onclick={() => handleDelete(provider)}>{$t('common.delete')}</button>
						</div>
					</div>
				{/each}
				<p class="text-xs text-text-muted">
					{$t('admin.thirdPartyDescription')}
				</p>
				<div class="border-t border-border pt-3">
					<label class="settings-label" for="DEFAULT_NEW_USER_MODEL">{$t('admin.defaultNewUserModel')}</label>
					<select
						id="DEFAULT_NEW_USER_MODEL"
						class="settings-input"
						value={defaultNewUserModelValue()}
						onchange={(event) => {
							adminConfig.DEFAULT_NEW_USER_MODEL = event.currentTarget.value;
						}}
					>
						{#each defaultNewUserModelOptions() as model}
							<option value={model.id}>{model.displayName}</option>
						{/each}
					</select>
					<p class="mt-1 text-xs text-text-muted">{$t('admin.defaultNewUserModelDescription')}</p>
				</div>
			</div>
		{/if}

		{#if providersMessage}
			<p class="text-sm text-success">{providersMessage}</p>
		{/if}

		<button class="btn-secondary w-full" onclick={openAddProvider}>
			{$t('admin.addProvider')}
		</button>
	</div>
</section>

<!-- Model 2 enable/disable toggle (separate from edit modal since it affects visibility) -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.model2Visibility')}</h2>
	<div class="flex items-center justify-between">
		<div>
			<label class="settings-label mb-0" for="MODEL_2_ENABLED">{$t('admin.model2Enabled')}</label>
			<p class="text-xs text-text-tertiary">{$t('admin.model2VisibilityDescription')}</p>
		</div>
		<label class="relative inline-flex cursor-pointer items-center">
			<input
				id="MODEL_2_ENABLED"
				type="checkbox"
				class="peer sr-only"
				checked={adminConfig.MODEL_2_ENABLED !== 'false'}
				onchange={(event) => {
					adminConfig.MODEL_2_ENABLED = event.currentTarget.checked ? 'true' : 'false';
				}}
			/>
			<div class="peer h-6 w-11 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"></div>
		</label>
	</div>
</section>

<!-- Composer Command Registry feature flag -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.composerCommandRegistry')}</h2>
	<div class="flex items-center justify-between">
		<div>
			<label class="settings-label mb-0" for="COMPOSER_COMMAND_REGISTRY_ENABLED">
				{$t('admin.composerCommandRegistryEnabled')}
			</label>
			<p class="text-xs text-text-tertiary">{$t('admin.composerCommandRegistryDescription')}</p>
		</div>
		<label class="relative inline-flex cursor-pointer items-center">
			<input
				id="COMPOSER_COMMAND_REGISTRY_ENABLED"
				type="checkbox"
				class="peer sr-only"
				checked={adminConfig.COMPOSER_COMMAND_REGISTRY_ENABLED === 'true'}
				onchange={(event) => {
					adminConfig.COMPOSER_COMMAND_REGISTRY_ENABLED = event.currentTarget.checked ? 'true' : 'false';
				}}
			/>
			<div class="peer h-6 w-11 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"></div>
		</label>
	</div>
</section>

<!-- Application Version -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.appVersion')}</h2>
	<div>
		<label class="settings-label" for="APP_VERSION_OVERRIDE">{$t('admin.appVersionOverride')}</label>
		<input
			id="APP_VERSION_OVERRIDE"
			type="text"
			class="settings-input"
			bind:value={adminConfig.APP_VERSION_OVERRIDE}
			placeholder={placeholderFor('APP_VERSION_OVERRIDE')}
			autocomplete="off"
		/>
		<p class="mt-1 text-xs text-text-muted">{$t('admin.appVersionOverrideDescription')}</p>
	</div>
</section>

<!-- System Skills -->
<section class="settings-card mb-4">
	<div class="mb-3 flex items-center justify-between gap-3">
		<div>
			<h2 class="settings-section-title mb-0">{$t('admin.systemSkills.title')}</h2>
			<p class="text-xs text-text-tertiary">{$t('admin.systemSkills.description')}</p>
		</div>
		<button class="btn-small" onclick={resetSystemSkillDraft}>
			{$t('admin.systemSkills.new')}
		</button>
	</div>

	{#if systemSkillsLoading}
		<p class="text-sm text-text-secondary">{$t('admin.systemSkills.loading')}</p>
	{:else if systemSkillsError}
		<p class="text-sm text-danger">{systemSkillsError}</p>
	{:else if systemSkills.length === 0}
		<p class="text-sm text-text-muted">{$t('admin.systemSkills.empty')}</p>
	{:else}
		<div class="mb-4 flex flex-col gap-2">
			{#each systemSkills as skill}
				<div class="rounded-md border border-border bg-surface-page px-3 py-2">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium text-text-primary">{skill.displayName}</span>
								<span class={`text-xs ${skill.published ? 'text-success' : 'text-text-muted'}`}>
									{skill.published ? $t('admin.systemSkills.status.published') : $t('admin.systemSkills.status.draft')}
								</span>
								<span class={`text-xs ${skill.enabled ? 'text-success' : 'text-text-muted'}`}>
									{skill.enabled ? $t('skills.status.enabled') : $t('skills.status.disabled')}
								</span>
							</div>
							<p class="mt-1 text-xs text-text-muted">{skill.description}</p>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<button
								class="btn-small"
								aria-label={$t('skills.editA11y', { name: skill.displayName })}
								onclick={() => editSystemSkill(skill)}
							>
								{$t('common.edit')}
							</button>
							<button
								class="btn-small"
								aria-label={skill.enabled ? $t('skills.disableA11y', { name: skill.displayName }) : $t('skills.enableA11y', { name: skill.displayName })}
								onclick={() => updateSystemSkillFlags(skill, { enabled: !skill.enabled })}
							>
								{skill.enabled ? $t('skills.disable') : $t('skills.enable')}
							</button>
							{#if !skill.published}
								<button
									class="btn-small"
									aria-label={$t('admin.systemSkills.publishA11y', { name: skill.displayName })}
									onclick={() => updateSystemSkillFlags(skill, { published: true, enabled: true })}
								>
									{$t('admin.systemSkills.publish')}
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="border-t border-border pt-4">
		<h3 class="text-sm font-medium text-text-primary">
			{editingSystemSkillId ? $t('admin.systemSkills.editTitle') : $t('admin.systemSkills.createTitle')}
		</h3>
		<div class="mt-3 grid gap-3 md:grid-cols-2">
			<div>
				<label class="settings-label" for="SYSTEM_SKILL_DISPLAY_NAME">{$t('skills.displayName')}</label>
				<input
					id="SYSTEM_SKILL_DISPLAY_NAME"
					class="settings-input"
					bind:value={systemSkillDraft.displayName}
					placeholder={$t('admin.systemSkills.displayNamePlaceholder')}
				/>
			</div>
			<div>
				<label class="settings-label" for="SYSTEM_SKILL_EXAMPLES">{$t('skills.activationExamples')}</label>
				<input
					id="SYSTEM_SKILL_EXAMPLES"
					class="settings-input"
					bind:value={systemSkillDraft.activationExamplesText}
					placeholder={$t('skills.activationExamplesPlaceholder')}
				/>
			</div>
		</div>
		<div class="mt-3">
			<label class="settings-label" for="SYSTEM_SKILL_DESCRIPTION">{$t('skills.description')}</label>
			<input
				id="SYSTEM_SKILL_DESCRIPTION"
				class="settings-input"
				bind:value={systemSkillDraft.description}
				placeholder={$t('admin.systemSkills.descriptionPlaceholder')}
			/>
		</div>
		<div class="mt-3">
			<label class="settings-label" for="SYSTEM_SKILL_INSTRUCTIONS">{$t('skills.instructions')}</label>
			<textarea
				id="SYSTEM_SKILL_INSTRUCTIONS"
				class="settings-input min-h-[140px]"
				bind:value={systemSkillDraft.instructions}
				placeholder={$t('admin.systemSkills.instructionsPlaceholder')}
				rows="6"
			></textarea>
		</div>
		<div class="mt-3 grid gap-3 md:grid-cols-2">
			<label class="flex items-center gap-2 text-sm text-text-secondary">
				<input type="checkbox" bind:checked={systemSkillDraft.enabled} />
				{$t('skills.enabled')}
			</label>
			<label class="flex items-center gap-2 text-sm text-text-secondary">
				<input type="checkbox" bind:checked={systemSkillDraft.published} />
				{$t('admin.systemSkills.published')}
			</label>
		</div>
		<div class="mt-4 flex flex-wrap gap-2">
			<button class="btn-primary" onclick={saveSystemSkill} disabled={systemSkillSaving}>
				{systemSkillSaving ? $t('common.saving') : $t('admin.systemSkills.save')}
			</button>
			{#if editingSystemSkillId}
				<button class="btn-secondary" onclick={resetSystemSkillDraft}>
					{$t('common.cancel')}
				</button>
			{/if}
		</div>
		{#if systemSkillsMessage}
			<p class="mt-3 text-sm text-success">{systemSkillsMessage}</p>
		{/if}
	</div>
</section>

<!-- Deep Research feature flag -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.deepResearch')}</h2>
	<div class="flex flex-col gap-3">
		<div class="flex items-center justify-between">
			<div>
				<label class="settings-label mb-0" for="DEEP_RESEARCH_ENABLED">{$t('admin.deepResearchEnabled')}</label>
				<p class="text-xs text-text-tertiary">{$t('admin.deepResearchDescription')}</p>
			</div>
			<label class="relative inline-flex cursor-pointer items-center">
				<input
					id="DEEP_RESEARCH_ENABLED"
					type="checkbox"
					class="peer sr-only"
					checked={adminConfig.DEEP_RESEARCH_ENABLED === 'true'}
					onchange={(event) => {
						adminConfig.DEEP_RESEARCH_ENABLED = event.currentTarget.checked ? 'true' : 'false';
					}}
				/>
				<div class="peer h-6 w-11 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"></div>
			</label>
		</div>
		<div class="flex items-center justify-between">
			<label class="settings-label mb-0" for="DEEP_RESEARCH_WORKER_ENABLED">{$t('admin.deepResearchWorkerEnabled')}</label>
			<label class="relative inline-flex cursor-pointer items-center">
				<input
					id="DEEP_RESEARCH_WORKER_ENABLED"
					type="checkbox"
					class="peer sr-only"
					checked={adminConfig.DEEP_RESEARCH_WORKER_ENABLED === 'true'}
					onchange={(event) => {
						adminConfig.DEEP_RESEARCH_WORKER_ENABLED = event.currentTarget.checked ? 'true' : 'false';
					}}
				/>
				<div class="peer h-6 w-11 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"></div>
			</label>
		</div>
		<div class="grid gap-3 md:grid-cols-2">
			{#each [
				'DEEP_RESEARCH_WORKER_INTERVAL_MS',
				'DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS',
				'DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS',
				'DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY',
				'DEEP_RESEARCH_WORKER_USER_CONCURRENCY',
				'DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT',
				'DEEP_RESEARCH_ACTIVE_USER_LIMIT',
				'DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT',
				'DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY',
				'DEEP_RESEARCH_USER_REASONING_CONCURRENCY',
			] as key}
				<div>
					<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
					<input
						id={key}
						type="number"
						class="settings-input"
						bind:value={adminConfig[key]}
						min={key === 'DEEP_RESEARCH_WORKER_INTERVAL_MS'
							? '1000'
							: key === 'DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS' ||
								  key === 'DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS'
								? '60000'
								: key === 'DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT' ||
									  key === 'DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY'
									? '1'
								: '0'}
						placeholder={placeholderFor(key)}
					/>
				</div>
			{/each}
		</div>
		<div class="border-t border-border pt-3">
			<h3 class="text-sm font-medium text-text-primary">{$t('admin.deepResearchDepthBudgets')}</h3>
			<p class="mt-1 text-xs text-text-muted">{$t('admin.deepResearchDepthBudgetsDescription')}</p>
			<div class="mt-3">
				<label class="settings-label" for="DEEP_RESEARCH_DEPTH_BUDGETS_JSON">
					{$t(configLabelKey('DEEP_RESEARCH_DEPTH_BUDGETS_JSON'))}
				</label>
				<textarea
					id="DEEP_RESEARCH_DEPTH_BUDGETS_JSON"
					class="settings-input min-h-[180px] font-mono text-xs"
					bind:value={adminConfig.DEEP_RESEARCH_DEPTH_BUDGETS_JSON}
					rows="8"
					spellcheck="false"
					placeholder={placeholderFor('DEEP_RESEARCH_DEPTH_BUDGETS_JSON')}
				></textarea>
			</div>
		</div>
		<div class="border-t border-border pt-3">
			<h3 class="text-sm font-medium text-text-primary">{$t('admin.deepResearchModels')}</h3>
			<p class="mt-1 text-xs text-text-muted">{$t('admin.deepResearchModelsDescription')}</p>
			<div class="mt-3 grid gap-3 md:grid-cols-2">
				{#each DEEP_RESEARCH_MODEL_ROLES as role}
					<div>
						<label class="settings-label" for={role.configKey}>{$t(role.labelKey)}</label>
						<select
							id={role.configKey}
							class="settings-input"
							value={deepResearchRoleValue(role)}
							onchange={(event) => {
								adminConfig[role.configKey] = event.currentTarget.value;
							}}
						>
							{#each deepResearchModelOptions() as model}
								<option value={model.id}>{model.displayName}</option>
							{/each}
						</select>
					</div>
				{/each}
			</div>
		</div>
	</div>
</section>

<!-- Title Generator -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.titleGenerator')}</h2>
	<div class="flex flex-col gap-3">
		{#each ['TITLE_GEN_URL', 'TITLE_GEN_MODEL'] as key}
			<div>
				<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
				<input
					id={key}
					type="text"
					class="settings-input"
					bind:value={adminConfig[key]}
					placeholder={placeholderFor(key)}
				/>
			</div>
		{/each}
		{#each [
			'TITLE_GEN_SYSTEM_PROMPT_EN',
			'TITLE_GEN_SYSTEM_PROMPT_HU',
			'TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN',
			'TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU',
		] as key}
			<div>
				<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
				<textarea
					id={key}
					class="settings-input min-h-[120px]"
					bind:value={adminConfig[key]}
					rows="5"
				></textarea>
				{#if key === 'TITLE_GEN_SYSTEM_PROMPT_EN' || key === 'TITLE_GEN_SYSTEM_PROMPT_HU'}
					<p class="mt-1 text-xs text-text-muted">{$t('admin.basePromptDescription')}</p>
				{:else}
					<p class="mt-1 text-xs text-text-muted">{$t('admin.codeAppendixDescription')}</p>
				{/if}
			</div>
		{/each}
	</div>
</section>

<!-- Context Summarizer -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.contextSummarizer')}</h2>
	<div class="flex flex-col gap-3">
		{#each ['CONTEXT_SUMMARIZER_URL', 'CONTEXT_SUMMARIZER_MODEL'] as key}
			<div>
				<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
				<input id={key} type="text" class="settings-input" bind:value={adminConfig[key]} placeholder={placeholderFor(key)} />
				<p class="mt-1 text-xs text-text-muted">{key === 'CONTEXT_SUMMARIZER_URL' ? $t('admin.summarizerUrlDescription') : $t('admin.summarizerModelDescription')}</p>
			</div>
		{/each}
	</div>
</section>

<!-- Web Research -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.webResearch')}</h2>
	<p class="mb-3 text-xs text-text-muted">{$t('admin.webResearchDescription')}</p>
	<div class="flex flex-col gap-4">
		<div class="grid gap-3 md:grid-cols-2">
			{#each ['EXA_API_KEY', 'BRAVE_SEARCH_API_KEY'] as key}
				<div>
					<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
					<input
						id={key}
						type="password"
						class="settings-input"
						bind:value={adminConfig[key]}
						placeholder={placeholderFor(key)}
						autocomplete="off"
					/>
				</div>
			{/each}
		</div>
		<p class="text-xs text-text-muted">{$t('admin.webResearchProviderDescription')}</p>

		<div class="grid gap-3 md:grid-cols-3">
			<div>
				<label class="settings-label" for="WEB_RESEARCH_EXA_SEARCH_TYPE">{$t(configLabelKey('WEB_RESEARCH_EXA_SEARCH_TYPE'))}</label>
				<input
					id="WEB_RESEARCH_EXA_SEARCH_TYPE"
					type="text"
					class="settings-input"
					bind:value={adminConfig.WEB_RESEARCH_EXA_SEARCH_TYPE}
					placeholder={placeholderFor('WEB_RESEARCH_EXA_SEARCH_TYPE')}
				/>
			</div>
			{#each ['WEB_RESEARCH_EXA_NUM_RESULTS', 'WEB_RESEARCH_BRAVE_NUM_RESULTS', 'WEB_RESEARCH_MAX_SOURCES'] as key}
				<div>
					<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
					<input
						id={key}
						type="number"
						min="1"
						class="settings-input"
						bind:value={adminConfig[key]}
						placeholder={placeholderFor(key)}
					/>
				</div>
			{/each}
		</div>
		<p class="text-xs text-text-muted">{$t('admin.webResearchBreadthDescription')}</p>

		<div class="grid gap-3 md:grid-cols-3">
			{#each ['WEB_RESEARCH_HIGHLIGHT_CHARS', 'WEB_RESEARCH_CONTENT_CHARS', 'WEB_RESEARCH_FRESHNESS_HOURS'] as key}
				<div>
					<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
					<input
						id={key}
						type="number"
						class="settings-input"
						bind:value={adminConfig[key]}
						placeholder={placeholderFor(key)}
					/>
				</div>
			{/each}
		</div>
		<p class="text-xs text-text-muted">{$t('admin.webResearchEvidenceDescription')}</p>
	</div>
</section>

<!-- Honcho Memory -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.honchoMemory')}</h2>
	<div class="mb-3 flex items-center justify-between">
		<div>
			<label class="settings-label mb-0" for="HONCHO_ENABLED">{$t('admin.enableHoncho')}</label>
			<p class="text-xs text-text-tertiary">{$t('admin.honchoDescription')}</p>
		</div>
		<label class="relative inline-flex cursor-pointer items-center">
			<input
				id="HONCHO_ENABLED"
				type="checkbox"
				class="peer sr-only"
				checked={adminConfig.HONCHO_ENABLED === 'true'}
				onchange={(event) => {
					adminConfig.HONCHO_ENABLED = event.currentTarget.checked ? 'true' : 'false';
				}}
			/>
			<div class="peer h-6 w-11 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"></div>
		</label>
	</div>
	<div class="flex items-center gap-2 text-xs text-text-secondary">
		<button class="text-accent hover:underline" onclick={onCheckHonchoHealth} disabled={honchoLoading}>
			{honchoLoading ? $t('admin.checking') : $t('admin.checkConnection')}
		</button>
		{#if honchoHealth}
			<span class="inline-flex items-center gap-1">
				<span class={`inline-block h-2 w-2 rounded-full ${honchoHealth.connected ? 'bg-success' : 'bg-danger'}`}></span>
				{honchoHealth.connected ? $t('admin.connected') : $t('admin.disconnected')}
				{#if honchoHealth.workspace}
					<span class="text-text-tertiary">({honchoHealth.workspace})</span>
				{/if}
			</span>
		{/if}
	</div>
	<div class="mt-4 flex flex-col gap-3">
		{#each ['HONCHO_CONTEXT_WAIT_MS', 'HONCHO_PERSONA_CONTEXT_WAIT_MS', 'HONCHO_OVERVIEW_WAIT_MS'] as key}
			<div>
				<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
				<input
					id={key}
					type="number"
					class="settings-input"
					bind:value={adminConfig[key]}
					placeholder={placeholderFor(key)}
				/>
				{#if key === 'HONCHO_CONTEXT_WAIT_MS'}
					<p class="mt-1 text-xs text-text-muted">
						{$t('admin.honchoContextWaitDescription')}
					</p>
				{:else if key === 'HONCHO_PERSONA_CONTEXT_WAIT_MS'}
					<p class="mt-1 text-xs text-text-muted">
						{$t('admin.honchoPersonaWaitDescription')}
					</p>
				{:else}
					<p class="mt-1 text-xs text-text-muted">
						{$t('admin.honchoOverviewWaitDescription')}
					</p>
				{/if}
			</div>
		{/each}
	</div>
</section>

<!-- MinerU Document Extraction -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.mineruDocumentExtraction')}</h2>
	<div class="flex flex-col gap-3">
		<div>
			<label class="settings-label" for="MINERU_API_URL">{$t('admin.mineruApiUrl')}</label>
			<input
				id="MINERU_API_URL"
				type="text"
				class="settings-input"
				bind:value={adminConfig.MINERU_API_URL}
				placeholder={placeholderFor('MINERU_API_URL')}
			/>
			<p class="mt-1 text-xs text-text-muted">
				{$t('admin.mineruApiDescription')}
			</p>
		</div>
		<div>
			<label class="settings-label" for="MINERU_TIMEOUT_MS">{$t('admin.mineruTimeoutMs')}</label>
			<input
				id="MINERU_TIMEOUT_MS"
				type="number"
				class="settings-input"
				bind:value={adminConfig.MINERU_TIMEOUT_MS}
				placeholder={placeholderFor('MINERU_TIMEOUT_MS')}
			/>
			<p class="mt-1 text-xs text-text-muted">
				{$t('admin.mineruTimeoutDescription')}
			</p>
		</div>
	</div>
</section>

<!-- System Prompt -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.systemPrompt')}</h2>
	<div>
		<label class="settings-label" for="SYSTEM_PROMPT">{$t('admin.systemPromptLabel')}</label>
		<textarea
			id="SYSTEM_PROMPT"
			class="settings-input min-h-[200px]"
			bind:value={adminConfig.SYSTEM_PROMPT}
			rows="10"
			placeholder={placeholderFor('SYSTEM_PROMPT')}
		></textarea>
		<p class="mt-1 text-xs text-text-muted">{$t('admin.systemPromptDescription')}</p>
	</div>
</section>

<!-- Rate & Size Limits -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.rateSizeLimits')}</h2>
	<div class="flex flex-col gap-3">
		<div>
			<label class="settings-label" for="MAX_MESSAGE_LENGTH">{$t('admin.maxMessageLength')}</label>
			<input
				id="MAX_MESSAGE_LENGTH"
				type="number"
				min="1"
				class="settings-input"
				bind:value={adminConfig.MAX_MESSAGE_LENGTH}
				placeholder={placeholderFor('MAX_MESSAGE_LENGTH')}
			/>
			<p class="mt-1 text-xs text-text-muted">{$t('admin.maxMessageLengthDescription')}</p>
		</div>
		<div>
			<label class="settings-label" for="MAX_FILE_UPLOAD_SIZE">{$t('admin.maxFileUploadSize')}</label>
			<input
				id="MAX_FILE_UPLOAD_SIZE"
				type="number"
				class="settings-input"
				bind:value={adminConfig.MAX_FILE_UPLOAD_SIZE}
				placeholder={placeholderFor('MAX_FILE_UPLOAD_SIZE')}
			/>
			<p class="mt-1 text-xs text-text-muted">{$t('admin.maxFileUploadDescription')}</p>
		</div>
		<div>
			<label class="settings-label" for="REQUEST_TIMEOUT_MS">{$t('admin.requestTimeoutMs')}</label>
			<input
				id="REQUEST_TIMEOUT_MS"
				type="number"
				class="settings-input"
				bind:value={adminConfig.REQUEST_TIMEOUT_MS}
				placeholder={placeholderFor('REQUEST_TIMEOUT_MS')}
			/>
			<p class="mt-1 text-xs text-text-muted">{$t('admin.requestTimeoutDescription')}</p>
		</div>
		<div class="border-t border-border pt-3">
			<div class="flex items-center justify-between">
				<div>
					<label class="settings-label mb-0" for="MODEL_TIMEOUT_FAILOVER_ENABLED">{$t('admin.modelTimeoutFailoverEnabled')}</label>
					<p class="text-xs text-text-tertiary">{$t('admin.modelTimeoutFailoverDescription')}</p>
				</div>
				<label class="relative inline-flex cursor-pointer items-center">
					<input
						id="MODEL_TIMEOUT_FAILOVER_ENABLED"
						type="checkbox"
						class="peer sr-only"
						checked={adminConfig.MODEL_TIMEOUT_FAILOVER_ENABLED === 'true'}
						onchange={(event) => {
							adminConfig.MODEL_TIMEOUT_FAILOVER_ENABLED = event.currentTarget.checked ? 'true' : 'false';
						}}
					/>
					<div class="peer h-6 w-11 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"></div>
				</label>
			</div>
			<div class="mt-3 grid gap-3 md:grid-cols-2">
				<div>
					<label class="settings-label" for="MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS">{$t('admin.modelTimeoutFailoverTimeoutMs')}</label>
					<input
						id="MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS"
						type="number"
						min="1000"
						class="settings-input"
						bind:value={adminConfig.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS}
						placeholder={placeholderFor('MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS')}
					/>
				</div>
				<div>
					<label class="settings-label" for="MODEL_TIMEOUT_FAILOVER_TARGET_MODEL">{$t('admin.modelTimeoutFailoverTargetModel')}</label>
					<select
						id="MODEL_TIMEOUT_FAILOVER_TARGET_MODEL"
						class="settings-input"
						value={adminConfig.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL || placeholderFor('MODEL_TIMEOUT_FAILOVER_TARGET_MODEL')}
						onchange={(event) => {
							adminConfig.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL = event.currentTarget.value;
						}}
					>
						{#each deepResearchModelOptions() as model}
							<option value={model.id}>{model.displayName}</option>
						{/each}
					</select>
				</div>
			</div>
		</div>
	</div>
</section>


<!-- Modal -->
{#if showModal}
	<ModelFormModal
		error={modalError}
		model={modalModel}
		isCreate={modalIsCreate}
		saving={modalSaving}
		{adminConfig}
		onSave={handleModalSave}
		onClose={closeModal}
	/>
{/if}

<section class="settings-card mb-4">
	<h2 class="settings-section-title">Personality Profiles</h2>
	<div class="text-sm text-text-muted mb-3">Pre-made tone and style profiles that users can select in chat.</div>
	<div class="flex flex-col gap-2">
		{#each adminPersonalities ?? [] as profile}
			<div class="flex items-center justify-between py-2 border-b border-border last:border-0">
				<div>
					<div class="text-sm font-medium text-text-primary">{profile.name}</div>
					<div class="text-xs text-text-muted">{profile.description}</div>
				</div>
				<span class="text-xs text-text-muted">
					{profile.isBuiltIn ? 'Built-in' : 'Custom'}
				</span>
			</div>
		{/each}
	</div>
</section>

<!-- Save button -->
{#if adminMessage}
	<p class="mb-3 text-sm text-success">{adminMessage}</p>
{/if}
{#if adminError}
	<p class="mb-3 text-sm text-danger">{adminError}</p>
{/if}
<button class="btn-primary mb-8 w-full" onclick={onSaveAdminConfig} disabled={adminSaving}>
	{adminSaving ? $t('common.saving') : $t('admin.saveConfiguration')}
</button>

{#if modelIconCropJob}
	<CampaignCropModal
		imageSrc={modelIconCropJob.imageSrc}
		ratio={1}
		title={$t('admin.modelIconCropTitle')}
		metadata={$t('campaignCrop.modelIconMetadata')}
		outputFilename="model-icon.webp"
		outputWidth={512}
		outputHeight={512}
		onSave={saveModelIconCrop}
		onCancel={cancelModelIconCrop}
	/>
{/if}

<style>
	:global(.btn-small) {
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-secondary);
		cursor: pointer;
		transition: all var(--duration-standard);
	}

	:global(.btn-small:hover) {
		border-color: var(--accent);
		color: var(--text-primary);
	}

	:global(.btn-secondary) {
		padding: 0.5rem 1rem;
		font-size: 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-primary);
		cursor: pointer;
		transition: all var(--duration-standard);
	}

	:global(.btn-secondary:hover) {
		border-color: var(--accent);
		background: var(--surface-elevated);
	}

	:global(.btn-secondary:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
