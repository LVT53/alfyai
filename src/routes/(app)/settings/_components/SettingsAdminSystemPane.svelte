<script lang="ts">
import {
	createAdminSystemSkill,
	fetchAdminSystemSkills,
	updateAdminConfig,
	updateAdminSystemSkill,
	fetchPersonalityProfiles,
	createProviderEntry,
	deleteProviderEntry,
	discoverProviderModels,
	batchCreateProviderModels,
	fetchProviderList,
	updateProviderEntry,
	updateProviderModel as updateModelProvider,
	type AdminSystemSkill,
	type AdminSystemSkillDraft,
	type PersonalityProfileSummary,
	type Provider,
} from "$lib/client/api/admin";
import {
	saveModelIconAssetCrop,
	uploadCampaignAssetSource,
	uploadModelIconAsset,
	type CampaignAsset,
	type CampaignAssetCropGeometry,
} from "$lib/client/api/campaign-assets";
import { get } from "svelte/store";
import { t, type I18nKey } from "$lib/i18n";
import {
	DEEP_RESEARCH_MODEL_ROLES,
	DEFAULT_DEEP_RESEARCH_MODEL_ID,
	type DeepResearchModelRoleDefinition,
} from "$lib/deep-research-models";
import type { ModelId } from "$lib/types";
import CampaignCropModal from "$lib/components/campaign-admin/CampaignCropModal.svelte";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import ProviderForm from "./ProviderForm.svelte";
import ProviderList from "./ProviderList.svelte";
import ModelList from "./ModelList.svelte";

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
	availableModels?: Array<{
		id: ModelId;
		displayName: string;
		iconUrl?: string | null;
	}>;
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

let providerConfigs = $state<Provider[]>([]);
let providerConfigsLoading = $state(false);
let providerConfigsError = $state("");
let providerConfigsMessage = $state("");
let showProviderForm = $state(false);
let providerFormProvider = $state<Provider | null>(null);
let providerFormIsCreate = $state(false);
let providerFormSaving = $state(false);
let providerFormError = $state("");
let providerFormTesting = $state(false);
let providerFormTestError = $state("");
let providerFormTestMessage = $state("");
let showModelList = $state(false);
let modelListProviderId = $state("");
let modelListKey = $state(0);
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
		.then((p) => {
			adminPersonalities = p;
		})
		.catch(() => {});
});
let providersMessage = $state("");
let iconUploading = $state<string | null>(null);
let providersMessageTimer: ReturnType<typeof setTimeout> | undefined;
let systemSkillsMessageTimer: ReturnType<typeof setTimeout> | undefined;

type ModelIconTarget =
	| { kind: "built-in"; modelName: "model1" | "model2" }
	| { kind: "provider"; providerId: string }
	| { kind: "model"; modelId: string; providerId: string };

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

function campaignAssetContentUrl(
	assetId: string | null | undefined,
): string | null {
	return assetId
		? `/api/campaign-assets/${encodeURIComponent(assetId)}/content`
		: null;
}

function builtInIconAssetId(modelName: "model1" | "model2"): string | null {
	const key =
		modelName === "model1" ? "MODEL_1_ICON_ASSET_ID" : "MODEL_2_ICON_ASSET_ID";
	return adminConfig[key] || null;
}

function builtInIconUrl(modelName: "model1" | "model2"): string | null {
	return campaignAssetContentUrl(builtInIconAssetId(modelName));
}

function isSvgFile(file: File): boolean {
	return (
		file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")
	);
}

async function applyModelIconAsset(target: ModelIconTarget, assetId: string) {
	if (target.kind === "built-in") {
		const configKey =
			target.modelName === "model1"
				? "MODEL_1_ICON_ASSET_ID"
				: "MODEL_2_ICON_ASSET_ID";
		adminConfig[configKey] = assetId;
		await updateAdminConfig({ [configKey]: assetId });
	} else if (target.kind === "provider") {
		await updateProviderEntry(target.providerId, { iconAssetId: assetId });
		await loadProviderConfigs();
	} else if (target.kind === "model") {
		await updateModelProvider(target.providerId, target.modelId, { iconAssetId: assetId });
	}
}

async function handleModelIconFile(event: Event, target: ModelIconTarget) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0] ?? null;
	input.value = "";
	if (!file) return;

	const key = target.kind === "built-in" ? target.modelName : target.kind === "provider" ? `provider:${target.providerId}` : `model:${target.modelId}`;
	iconUploading = key;
	providerConfigsError = "";
	providerConfigsMessage = "";
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
			providerConfigsError = errorMessage(error, $t("admin.modelIconUploadFailed"));
		});
		modelIconCropJob = {
			key,
			target,
			imageSrc,
			sourceUpload,
		};
	} catch (error: unknown) {
		providerConfigsError = errorMessage(error, $t("admin.modelIconUploadFailed"));
		if (modelIconCropJob?.key === key) {
			URL.revokeObjectURL(modelIconCropJob.imageSrc);
			modelIconCropJob = null;
		}
	} finally {
		iconUploading = null;
	}
}

async function saveModelIconCrop(payload: {
	file: File;
	width: number;
	height: number;
	crop: CampaignAssetCropGeometry;
}) {
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

async function loadProviderConfigs() {
	providerConfigsLoading = true;
	providerConfigsError = "";
	try {
		providerConfigs = await fetchProviderList();
	} catch (error: unknown) {
		providerConfigsError = errorMessage(error, $t("admin.failedLoadProviders"));
	} finally {
		providerConfigsLoading = false;
	}
}

function openAddProviderConfig() {
	providerFormProvider = null;
	providerFormIsCreate = true;
	providerFormError = "";
	providerFormTestError = "";
	providerFormTestMessage = "";
	providerFormSaving = false;
	providerFormTesting = false;
	showProviderForm = true;
}

function openEditProviderConfig(provider: Provider) {
	providerFormProvider = { ...provider };
	providerFormIsCreate = false;
	providerFormError = "";
	providerFormTestError = "";
	providerFormTestMessage = "";
	providerFormSaving = false;
	providerFormTesting = false;
	showProviderForm = true;
}

function handleProviderIconFile(event: Event) {
	if (!providerFormProvider) return;
	handleModelIconFile(event, { kind: "provider", providerId: providerFormProvider.id });
}
function closeProviderForm() {
	showProviderForm = false;
	providerFormProvider = null;
	providerFormError = "";
	providerFormTestError = "";
	providerFormTestMessage = "";
}

async function handleProviderFormSave(data: Record<string, unknown>) {
	providerFormSaving = true;
	providerFormError = "";
	providerConfigsMessage = "";
	try {
		if (providerFormIsCreate) {
			await createProviderEntry(
				data as Parameters<typeof createProviderEntry>[0],
			);
			showProvidersMessage($t("admin.providerAdded"));
		} else if (providerFormProvider) {
			await updateProviderEntry(
				providerFormProvider.id,
				data as Parameters<typeof updateProviderEntry>[1],
			);
			showProvidersMessage($t("admin.providerUpdated"));
		}
		closeProviderForm();
		await loadProviderConfigs();
	} catch (error: unknown) {
		providerFormError = errorMessage(error, $t("admin.failedSave"));
	} finally {
		providerFormSaving = false;
	}
}

async function handleDeleteProviderConfig(provider: Provider) {
	providerConfigsMessage = "";
	try {
		await deleteProviderEntry(provider.id);
		showProvidersMessage($t("admin.providerDeleted"));
		await loadProviderConfigs();
	} catch (error: unknown) {
		providerConfigsError = errorMessage(
			error,
			$t("admin.failedDeleteProvider"),
		);
	}
}

async function handleToggleProviderConfig(
	provider: Provider,
	enabled: boolean,
) {
	providerConfigsError = "";
	try {
		await updateProviderEntry(provider.id, { enabled });
		showProvidersMessage($t("admin.providerUpdated"));
		await loadProviderConfigs();
	} catch (error: unknown) {
		providerConfigsError = errorMessage(error, $t("admin.failedSave"));
	}
}

async function handleDiscoverProviderConfig(provider: Provider) {
	providerConfigsError = "";
	try {
		const models = await discoverProviderModels(provider.id);
		if (models.length === 0) {
			showProvidersMessage("No models discovered.");
			return;
		}
		showProvidersMessage(`Discovered ${models.length} model(s). Creating...`);
		const created = await batchCreateProviderModels(provider.id, models);
		showProvidersMessage(`Created ${created.length} model(s). Refresh the model list to see them.`);
	} catch (error: unknown) {
		providerConfigsError = errorMessage(error, "Failed to discover models.");
	}
}

function handleManageModels(providerId: string) {
	modelListProviderId = providerId;
	showModelList = true;
	modelListKey += 1;
}

function closeModelList() {
	showModelList = false;
	modelListProviderId = "";
}

function handleModelModelIconFile(event: Event, modelId: string) {
	handleModelIconFile(event, { kind: "model", modelId, providerId: modelListProviderId });
}

async function loadSystemSkills() {
	systemSkillsLoading = true;
	systemSkillsError = "";
	try {
		systemSkills = await fetchAdminSystemSkills();
	} catch (error: unknown) {
		systemSkillsError = errorMessage(
			error,
			$t("admin.systemSkills.errors.load"),
		);
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
		systemSkillsError = errorMessage(
			error,
			$t("admin.systemSkills.errors.save"),
		);
	} finally {
		systemSkillSaving = false;
	}
}

async function updateSystemSkillFlags(
	skill: AdminSystemSkill,
	changes: Partial<AdminSystemSkillDraft>,
) {
	systemSkillsError = "";
	try {
		await updateAdminSystemSkill(skill.id, changes);
		showSystemSkillsMessage($t("admin.systemSkills.updated"));
		await loadSystemSkills();
	} catch (error: unknown) {
		systemSkillsError = errorMessage(
			error,
			$t("admin.systemSkills.errors.save"),
		);
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
	for (const provider of providerConfigs) {
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
	for (const provider of providerConfigs) {
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

function deepResearchRoleValue(role: DeepResearchModelRoleDefinition): ModelId {
	return (adminConfig[role.configKey] ||
		envDefaults[role.configKey] ||
		DEFAULT_DEEP_RESEARCH_MODEL_ID) as ModelId;
}

$effect(() => {
	void loadProviderConfigs();
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
		MODEL_2_BASEURL: "admin.model2BaseUrl",
		MODEL_2_API_KEY: "admin.model2ApiKey",
		MODEL_2_NAME: "admin.model2Name",
		MODEL_2_DISPLAY_NAME: "admin.model2DisplayName",
		MODEL_2_ICON_ASSET_ID: "admin.model2IconAssetId",
		MODEL_2_SYSTEM_PROMPT: "admin.model2SystemPrompt",
		MODEL_1_ENABLED: "admin.model1Enabled",
		MODEL_2_ENABLED: "admin.model2Enabled",
		COMPOSER_COMMAND_REGISTRY_ENABLED: "admin.composerCommandRegistryEnabled",
		APP_VERSION_OVERRIDE: "admin.appVersionOverride",
		DEEP_RESEARCH_ENABLED: "admin.deepResearchEnabled",
		DEEP_RESEARCH_WORKER_ENABLED: "admin.deepResearchWorkerEnabled",
		DEEP_RESEARCH_WORKER_INTERVAL_MS: "admin.deepResearchWorkerIntervalMs",
		DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS:
			"admin.deepResearchWorkerStaleTimeoutMs",
		DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS: "admin.deepResearchJobRuntimeLimitMs",
		DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY:
			"admin.deepResearchWorkerGlobalConcurrency",
		DEEP_RESEARCH_WORKER_USER_CONCURRENCY:
			"admin.deepResearchWorkerUserConcurrency",
		DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT:
			"admin.deepResearchActiveConversationLimit",
		DEEP_RESEARCH_ACTIVE_USER_LIMIT: "admin.deepResearchActiveUserLimit",
		DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT: "admin.deepResearchActiveGlobalLimit",
		DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY:
			"admin.deepResearchGlobalReasoningConcurrency",
		DEEP_RESEARCH_USER_REASONING_CONCURRENCY:
			"admin.deepResearchUserReasoningConcurrency",
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
		SEARXNG_BASE_URL: "admin.searxngBaseUrl",
		BRAVE_SEARCH_API_KEY: "admin.braveSearchApiKey",
		WEB_RESEARCH_SEARXNG_NUM_RESULTS: "admin.webResearchSearxngNumResults",
		WEB_RESEARCH_SEARXNG_LANGUAGE: "admin.webResearchSearxngLanguage",
		WEB_RESEARCH_SEARXNG_SAFESEARCH: "admin.webResearchSearxngSafesearch",
		WEB_RESEARCH_SEARXNG_CATEGORIES: "admin.webResearchSearxngCategories",
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
		MODEL_TIMEOUT_FAILOVER_TARGET_MODEL:
			"admin.modelTimeoutFailoverTargetModel",
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
	"WEB_RESEARCH_SEARXNG_NUM_RESULTS",
	"WEB_RESEARCH_SEARXNG_SAFESEARCH",
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

<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.providers')}</h2>
	<ProviderList
		providers={providerConfigs}
		loading={providerConfigsLoading}
		error={providerConfigsError}
		message={providersMessage}
		onAdd={openAddProviderConfig}
		onEdit={openEditProviderConfig}
		onDelete={handleDeleteProviderConfig}
		onToggleEnabled={handleToggleProviderConfig}
		onDiscover={handleDiscoverProviderConfig}
		onManageModels={handleManageModels}
	/>
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
		<div>
			<label class="settings-label" for="TITLE_GEN_MODEL">{$t(configLabelKey('TITLE_GEN_MODEL'))}</label>
			<select
				id="TITLE_GEN_MODEL"
				class="settings-input"
				value={adminConfig['TITLE_GEN_MODEL'] || ''}
				onchange={(event) => {
					adminConfig['TITLE_GEN_MODEL'] = event.currentTarget.value;
				}}
			>
				{#each deepResearchModelOptions() as model}
					<option value={model.id}>{model.displayName}</option>
				{/each}
			</select>
		</div>
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
		<div>
			<label class="settings-label" for="CONTEXT_SUMMARIZER_MODEL">{$t(configLabelKey('CONTEXT_SUMMARIZER_MODEL'))}</label>
			<select
				id="CONTEXT_SUMMARIZER_MODEL"
				class="settings-input"
				value={adminConfig['CONTEXT_SUMMARIZER_MODEL'] || ''}
				onchange={(event) => {
					adminConfig['CONTEXT_SUMMARIZER_MODEL'] = event.currentTarget.value;
				}}
			>
				{#each deepResearchModelOptions() as model}
					<option value={model.id}>{model.displayName}</option>
				{/each}
			</select>
			<p class="mt-1 text-xs text-text-muted">{$t('admin.summarizerModelDescription')}</p>
		</div>
	</div>
</section>

<!-- Web Research -->
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('admin.webResearch')}</h2>
	<p class="mb-3 text-xs text-text-muted">{$t('admin.webResearchDescription')}</p>
	<div class="flex flex-col gap-4">
		<div class="grid gap-3 md:grid-cols-2">
			{#each ['SEARXNG_BASE_URL', 'BRAVE_SEARCH_API_KEY'] as key}
				<div>
					<label class="settings-label" for={key}>{$t(configLabelKey(key))}</label>
					<input
						id={key}
						type={key === 'BRAVE_SEARCH_API_KEY' ? 'password' : 'url'}
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
			{#each ['WEB_RESEARCH_SEARXNG_NUM_RESULTS', 'WEB_RESEARCH_MAX_SOURCES', 'WEB_RESEARCH_SEARXNG_SAFESEARCH'] as key}
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

		<div class="grid gap-3 md:grid-cols-2">
			{#each ['WEB_RESEARCH_SEARXNG_LANGUAGE', 'WEB_RESEARCH_SEARXNG_CATEGORIES'] as key}
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
		</div>

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


{#if showProviderForm}
	<ProviderForm
		provider={providerFormProvider}
		isCreate={providerFormIsCreate}
		saving={providerFormSaving}
		error={providerFormError}
		testError={providerFormTestError}
		testMessage={providerFormTestMessage}
		onSave={handleProviderFormSave}
		onClose={closeProviderForm}
		onIconFile={handleProviderIconFile}
	/>
{/if}

{#if showModelList}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onclick={closeModelList} onkeydown={(e) => e.key === 'Escape' && closeModelList()}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-surface-page p-6 shadow-xl" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
			{#key modelListKey}
				<ModelList
					providerId={modelListProviderId}
					onClose={closeModelList}
					onIconFile={handleModelModelIconFile}
				/>
			{/key}
		</div>
	</div>
{/if}

<!-- Sticky Save button -->
<div class="sticky bottom-0 z-10 border-t border-border bg-surface-page py-4">
	{#if adminMessage}
		<p class="mb-3 text-sm text-success">{adminMessage}</p>
	{/if}
	{#if adminError}
		<p class="mb-3 text-sm text-danger">{adminError}</p>
	{/if}
	<button class="btn-primary w-full" onclick={onSaveAdminConfig} disabled={adminSaving}>
		{adminSaving ? $t('common.saving') : $t('admin.saveConfiguration')}
	</button>
</div>

{#if modelIconCropJob}
	<div class="fixed inset-0 z-[110]">
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
	</div>
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
