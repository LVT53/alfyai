<script lang="ts">
// The admin System screen.
//
// Thirteen stacked cards became seven named pages behind a left navigator plus
// one read-only Diagnostics page. Nothing was removed: the same config keys are
// here, grouped by the concern they belong to instead of the order they were
// written in, and the navigator carries an unsaved-count badge per page so a
// pending edit on another page can never be lost silently.
import { beforeNavigate, goto } from "$app/navigation";
import { get } from "svelte/store";
import {
	batchCreateProviderModels,
	createAdminSystemSkill,
	createProviderEntry,
	deleteProviderEntry,
	discoverProviderModels,
	fetchAdminSystemSkills,
	fetchPersonalityProfiles,
	fetchProviderList,
	fetchProviderModels,
	updateAdminConfig,
	updateAdminSystemSkill,
	updateProviderEntry,
	updateProviderModel as updateModelProvider,
	type AdminSystemSkill,
	type AdminSystemSkillDraft,
	type Provider,
	type ProviderModel,
} from "$lib/client/api/admin";
import {
	fetchAdminConfigOverrideMeta,
	fetchAdminEffectiveConfig,
	fetchAdminToolHealth,
	validateProviderConnection,
	type EffectiveConfigReport,
	type ToolHealthSnapshot,
} from "$lib/client/api/admin-system-health";
import {
	saveModelIconAssetCrop,
	uploadCampaignAssetSource,
	uploadModelIconAsset,
	type CampaignAsset,
	type CampaignAssetCropGeometry,
} from "$lib/client/api/campaign-assets";
import CampaignCropModal from "$lib/components/campaign-admin/CampaignCropModal.svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import {
	ADVANCED_KEY_SPECS,
	validateAdminConfigValue,
} from "$lib/config/admin-config-registry";
import { t, type I18nKey } from "$lib/i18n";
import type { ModelId } from "$lib/model-types";
import ModelList from "./ModelList.svelte";
import ProviderForm from "./ProviderForm.svelte";
import ProviderList from "./ProviderList.svelte";
import AdvancedPage from "./system/AdvancedPage.svelte";
import AiTasksPage from "./system/AiTasksPage.svelte";
import DiagnosticsPage from "./system/DiagnosticsPage.svelte";
import GeneralPage from "./system/GeneralPage.svelte";
import IntegrationsPage from "./system/IntegrationsPage.svelte";
import LeaveGuardDialog from "./system/LeaveGuardDialog.svelte";
import LimitsPage from "./system/LimitsPage.svelte";
import ModelsPage from "./system/ModelsPage.svelte";
import SkillDialog from "./system/SkillDialog.svelte";
import SkillsPage from "./system/SkillsPage.svelte";
import SystemNav from "./system/SystemNav.svelte";
import SystemSaveBar from "./system/SystemSaveBar.svelte";
import SystemSearch from "./system/SystemSearch.svelte";
import { buildModelOptionGroups } from "./system/model-options";
import {
	keyCountForPage,
	pageForKey,
	type SystemPageId,
	type SystemSearchItem,
} from "./system/pages";
import "./system/system.css";

const tVal = get(t);

let {
	adminConfig = $bindable(),
	adminConfigSaved = $bindable({}),
	envDefaults = {},
	availableModels = [],
	adminSaving = false,
	adminMessage = "",
	adminError = "",
	onSaveAdminConfig,
}: {
	adminConfig: Record<string, string>;
	/**
	 * The values the server last confirmed. It is a prop, not local state,
	 * because opening the Users or Campaigns sub-tab unmounts this pane: a
	 * baseline that died with the component would be re-snapshotted from the
	 * already-edited `adminConfig` on the way back, and every pending edit
	 * would read as saved and never be sent.
	 */
	adminConfigSaved?: Record<string, string>;
	envDefaults?: Record<string, string>;
	availableModels?: Array<{
		id: ModelId;
		displayName: string;
		iconUrl?: string | null;
	}>;
	adminSaving?: boolean;
	adminMessage?: string;
	adminError?: string;
	// Widened additively: the pane sends only what changed, so an untouched key
	// never gets an admin_config row (and a masked secret is never re-sent).
	// An explicit `false` result means the write was rejected and the edits
	// stay pending. `unknown` rather than a union: a handler that returns
	// nothing (every test mock does) must stay assignable.
	onSaveAdminConfig: (patch?: Record<string, string>) => unknown;
} = $props();

// --- page + pending-change state -----------------------------------------

let activePage = $state<SystemPageId>("general");
let diagnosticsTab = $state("toolHealth");
let highlightKey = $state("");
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

// The editable copy. The prop is written through on every edit (so the page
// that owns it, and anything else reading it, stays in step), but the screen
// reads THIS, which is reactive whatever the parent passed in.
let draft = $state<Record<string, string>>({});
let baselineReady = $state(false);
let lastSavedAt = $state("");
let leaveGuardOpen = $state(false);
let pendingNavigation: (() => void) | null = null;

// The baseline lives on the parent (`adminConfigSaved`) so it survives this
// pane being unmounted and remounted by a sub-tab switch.
const baseline = $derived(adminConfigSaved ?? {});

/** Written in place, so the parent's object is updated whether it was bound
 *  with `bind:` or handed over as a plain record. */
function commitSaved(next: Record<string, string>) {
	const target = adminConfigSaved;
	if (!target) return;
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, next);
}

$effect(() => {
	// The page load hands over the resolved values once; that snapshot is what
	// "unsaved" is measured against. On a REMOUNT `adminConfig` already carries
	// the pending edits, so only the draft is re-taken — the saved snapshot is
	// whatever the parent still holds.
	if (baselineReady) return;
	const snapshot = { ...adminConfig };
	if (Object.keys(snapshot).length === 0) return;
	draft = { ...snapshot };
	if (Object.keys(baseline).length === 0) commitSaved(snapshot);
	baselineReady = true;
});

function asString(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

const dirtyKeys = $derived.by(() => {
	if (!baselineReady) return [] as string[];
	const keys = new Set([...Object.keys(baseline), ...Object.keys(draft)]);
	return [...keys].filter(
		(key) => asString(draft[key]) !== asString(baseline[key]),
	);
});

const dirtySet = $derived(new Set(dirtyKeys));

function isDirty(key: string): boolean {
	return dirtySet.has(key);
}

const dirtyByPage = $derived.by(() => {
	const counts: Partial<Record<SystemPageId, number>> = {};
	for (const key of dirtyKeys) {
		const page = pageForKey(key) ?? "advanced";
		counts[page] = (counts[page] ?? 0) + 1;
	}
	return counts;
});

const invalidKeys = $derived.by(() =>
	ADVANCED_KEY_SPECS.filter((spec) => {
		if (!dirtySet.has(spec.key)) return false;
		return !validateAdminConfigValue(spec, asString(draft[spec.key])).ok;
	}).map((spec) => spec.key),
);

function setValue(key: string, value: string) {
	draft[key] = value;
	adminConfig[key] = value;
}

/** Explicit reset: an empty value deletes the override on the next save. */
function resetValue(key: string) {
	setValue(key, "");
}

/** Cancel a pending edit without touching what is stored. */
function revertValue(key: string) {
	setValue(key, baseline[key] ?? "");
}

function discardAll() {
	for (const key of dirtyKeys) {
		setValue(key, baseline[key] ?? "");
	}
}

async function saveChanges() {
	if (dirtyKeys.length === 0 || invalidKeys.length > 0) return;
	const patch: Record<string, string> = {};
	for (const key of dirtyKeys) {
		const value = asString(draft[key]);
		// The server masks some secrets as "[set]"; sending that back would store
		// the sentinel as the key. An untouched secret is simply not in the patch.
		if (value === "[set]") continue;
		patch[key] = value;
	}
	const saved = await onSaveAdminConfig(patch);
	// A rejected write must not clear the pending marks: the admin would be
	// told everything is saved while the server still holds the old values.
	if (saved === false) return;
	commitSaved({ ...draft });
	lastSavedAt = new Date().toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
	void loadOverrideMeta();
}

// Guarded: several component tests mock `$app/navigation` with only the
// exports they use, and touching a missing export on that mock throws.
try {
	beforeNavigate((navigation) => {
		if (dirtyKeys.length === 0 || leaveGuardOpen) return;
		if (navigation.type === "leave") return;
		navigation.cancel();
		const target = navigation.to?.url;
		pendingNavigation = target ? () => void goto(target) : null;
		leaveGuardOpen = true;
	});
} catch {
	// No navigation guard available; the save bar still reports what is pending.
}

function leaveNow() {
	const go = pendingNavigation;
	pendingNavigation = null;
	leaveGuardOpen = false;
	go?.();
}

const leaveItems = $derived(
	dirtyKeys.slice(0, 12).map((key) => ({
		key,
		label: searchLabelFor(key),
		page: pageForKey(key) ?? ("advanced" as SystemPageId),
	})),
);

// --- providers ------------------------------------------------------------

let providerConfigs: Provider[] = $state([]);
let providerConfigsLoading = $state(false);
let providerConfigsError = $state("");
let allProviderModels: ProviderModel[] = $state([]);
let openProviderId = $state("");
let showProviderForm = $state(false);
let providerFormProvider: Provider | null = $state(null);
let providerFormIsCreate = $state(false);
let providerFormSaving = $state(false);
let providerFormError = $state("");
let providerFormTesting = $state(false);
let providerFormTestError = $state("");
let providerFormTestMessage = $state("");
let pendingProviderDelete: Provider | null = $state(null);
// The row whose delete is in flight — its controls go inert until the list
// comes back, the way the old list's `deletingId` did.
let deletingProviderId = $state("");
let providersMessage = $state("");
let iconUploading: string | null = $state(null);
let providersMessageTimer: ReturnType<typeof setTimeout> | undefined;
let systemSkillsMessageTimer: ReturnType<typeof setTimeout> | undefined;
let overrideMeta = $state<Record<string, { updatedAt: string }>>({});

const secretChangedAt = $derived.by(() => {
	const map: Record<string, string> = {};
	for (const [key, meta] of Object.entries(overrideMeta)) {
		const date = new Date(meta.updatedAt);
		map[key] = Number.isNaN(date.getTime())
			? ""
			: date.toLocaleDateString(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
				});
	}
	return map;
});

// Kept because the endpoint is part of the screen's contract; the old pane
// fetched it into state that nothing ever rendered.
$effect(() => {
	void fetchPersonalityProfiles().catch(() => {});
});

async function loadOverrideMeta() {
	try {
		overrideMeta = await fetchAdminConfigOverrideMeta();
	} catch {
		overrideMeta = {};
	}
}

$effect(() => {
	void loadOverrideMeta();
});

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

let modelIconCropJob: ModelIconCropJob | null = $state(null);
let modelIconAssetSaved: { modelId: string; assetId: string } | null =
	$state(null);

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
		// Icon uploads PATCH immediately, so the new value is the saved value.
		setValue(configKey, assetId);
		baseline[configKey] = assetId;
		await updateAdminConfig({ [configKey]: assetId });
	} else if (target.kind === "provider") {
		await updateProviderEntry(target.providerId, { iconAssetId: assetId });
		await loadProviderConfigs();
		if (providerFormProvider?.id === target.providerId) {
			const updated = providerConfigs.find((p) => p.id === target.providerId);
			if (updated) providerFormProvider = { ...updated };
		}
	} else if (target.kind === "model") {
		await updateModelProvider(target.providerId, target.modelId, {
			iconAssetId: assetId,
		});
		modelIconAssetSaved = { modelId: target.modelId, assetId };
	}
}

async function handleModelIconFile(event: Event, target: ModelIconTarget) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0] ?? null;
	input.value = "";
	if (!file) return;

	const key =
		target.kind === "built-in"
			? target.modelName
			: target.kind === "provider"
				? `provider:${target.providerId}`
				: `model:${target.modelId}`;
	iconUploading = key;
	providerConfigsError = "";
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
			providerConfigsError = errorMessage(
				error,
				$t("admin.modelIconUploadFailed"),
			);
		});
		modelIconCropJob = {
			key,
			target,
			imageSrc,
			sourceUpload,
		};
	} catch (error: unknown) {
		providerConfigsError = errorMessage(
			error,
			$t("admin.modelIconUploadFailed"),
		);
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
		const modelGroups = await Promise.all(
			providerConfigs.map(async (provider) => {
				try {
					return await fetchProviderModels(provider.id);
				} catch {
					return [];
				}
			}),
		);
		allProviderModels = modelGroups.flat();
	} catch (error: unknown) {
		providerConfigsError = errorMessage(error, $t("admin.failedLoadProviders"));
		allProviderModels = [];
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
	handleModelIconFile(event, {
		kind: "provider",
		providerId: providerFormProvider.id,
	});
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
	try {
		if (providerFormIsCreate) {
			await createProviderEntry(
				data as unknown as Parameters<typeof createProviderEntry>[0],
			);
			showProvidersMessage($t("admin.providerAdded"));
		} else if (providerFormProvider) {
			await updateProviderEntry(
				providerFormProvider.id,
				data as unknown as Parameters<typeof updateProviderEntry>[1],
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

async function handleTestProvider(provider: Provider | null) {
	const target = provider ?? providerFormProvider;
	if (!target) return;
	providerFormTesting = true;
	providerFormTestError = "";
	providerFormTestMessage = "";
	try {
		const result = await validateProviderConnection(target.id);
		if (result.valid) {
			providerFormTestMessage = $t("admin.providerTestOk");
		} else {
			providerFormTestError = result.error || $t("admin.providerTestFailed");
		}
	} catch (error: unknown) {
		providerFormTestError = errorMessage(error, $t("admin.providerTestFailed"));
	} finally {
		providerFormTesting = false;
	}
}

async function confirmDeleteProvider() {
	const provider = pendingProviderDelete;
	pendingProviderDelete = null;
	if (!provider) return;
	deletingProviderId = provider.id;
	try {
		await deleteProviderEntry(provider.id);
		showProvidersMessage($t("admin.providerDeleted"));
		await loadProviderConfigs();
	} catch (error: unknown) {
		providerConfigsError = errorMessage(
			error,
			$t("admin.failedDeleteProvider"),
		);
	} finally {
		deletingProviderId = "";
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
			showProvidersMessage($t("admin.discoverNone"));
			return;
		}
		showProvidersMessage(
			$t("admin.discoverFound", { count: String(models.length) }),
		);
		const created = await batchCreateProviderModels(provider.id, models);
		showProvidersMessage(
			$t("admin.discoverCreated", { count: String(created.length) }),
		);
		await loadProviderConfigs();
	} catch (error: unknown) {
		providerConfigsError = errorMessage(error, $t("admin.discoverFailed"));
	}
}

function handleManageModels(providerId: string) {
	openProviderId = providerId;
}

async function handleReorderProvider(
	providerId: string,
	direction: "up" | "down",
) {
	const idx = providerConfigs.findIndex((p) => p.id === providerId);
	if (idx < 0) return;
	const targetIdx = direction === "up" ? idx - 1 : idx + 1;
	if (targetIdx < 0 || targetIdx >= providerConfigs.length) return;

	const a = providerConfigs[idx];
	const b = providerConfigs[targetIdx];

	providerConfigs = providerConfigs.map((p, i) => {
		if (i === idx) return { ...b, sortOrder: idx };
		if (i === targetIdx) return { ...a, sortOrder: targetIdx };
		return p;
	});

	await Promise.all([
		updateProviderEntry(a.id, { sortOrder: targetIdx }),
		updateProviderEntry(b.id, { sortOrder: idx }),
	]).catch((err) => {
		providerConfigsError = errorMessage(err, $t("admin.reorderFailed"));
	});
}

function handleModelModelIconFile(event: Event, modelId: string) {
	handleModelIconFile(event, {
		kind: "model",
		modelId,
		providerId: openProviderId,
	});
}

// --- skills ---------------------------------------------------------------

let systemSkills: AdminSystemSkill[] = $state([]);
let systemSkillsLoading = $state(false);
let systemSkillsError = $state("");
let systemSkillsMessage = $state("");
let editingSystemSkillId: string | null = $state(null);
let systemSkillSaving = $state(false);
let showSkillDialog = $state(false);
let systemSkillDraft: AdminSystemSkillDraft & {
	activationExamplesText: string;
} = $state(emptySkillDraft());

function emptySkillDraft() {
	return {
		displayName: "",
		description: "",
		instructions: "",
		activationExamplesText: "",
		enabled: true,
		published: false,
		durationPolicy: "next_message" as const,
		questionPolicy: "ask_when_needed" as const,
		notesPolicy: "none" as const,
		sourceScope: "selected_sources_only" as const,
	};
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

function openNewSkill() {
	editingSystemSkillId = null;
	systemSkillDraft = emptySkillDraft();
	systemSkillsError = "";
	showSkillDialog = true;
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
	showSkillDialog = true;
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
		showSkillDialog = false;
		editingSystemSkillId = null;
		systemSkillDraft = emptySkillDraft();
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

$effect(() => {
	void loadProviderConfigs();
});

$effect(() => {
	void loadSystemSkills();
});

// --- diagnostics ----------------------------------------------------------

let toolHealth: ToolHealthSnapshot | null = $state(null);
let toolHealthLoading = $state(false);
let toolHealthRefreshing = $state(false);
let toolHealthError = $state("");
let effectiveConfig: EffectiveConfigReport | null = $state(null);
let effectiveConfigLoading = $state(false);
let effectiveConfigError = $state("");

async function loadToolHealth(refresh = false) {
	if (refresh) toolHealthRefreshing = true;
	else toolHealthLoading = true;
	toolHealthError = "";
	try {
		toolHealth = await fetchAdminToolHealth({ refresh });
	} catch (error: unknown) {
		toolHealthError = errorMessage(error, $t("admin.toolHealth.errors.load"));
	} finally {
		toolHealthLoading = false;
		toolHealthRefreshing = false;
	}
}

async function loadEffectiveConfig() {
	effectiveConfigLoading = true;
	effectiveConfigError = "";
	try {
		effectiveConfig = await fetchAdminEffectiveConfig();
	} catch (error: unknown) {
		effectiveConfigError = errorMessage(
			error,
			$t("admin.effectiveConfig.errors.load"),
		);
	} finally {
		effectiveConfigLoading = false;
	}
}

$effect(() => {
	void loadToolHealth();
});

$effect(() => {
	void loadEffectiveConfig();
});

// The Knowledge/tool deep link (/settings?section=tool-health) opens the
// read-only page rather than scrolling a card into the middle of a form.
$effect(() => {
	if (typeof window === "undefined") return;
	const section = new URLSearchParams(window.location.search).get("section");
	if (section === "tool-health") {
		activePage = "diagnostics";
		diagnosticsTab = "toolHealth";
	}
});

// --- model option groups --------------------------------------------------

const modelGroups = $derived(
	buildModelOptionGroups({
		availableModels,
		providers: providerConfigs,
		providerModels: allProviderModels,
		adminConfig: draft,
		freeLabel: tVal("admin.system.modelFree"),
	}),
);

// The failover target and the memory models must name a concrete model, not a
// provider — the same rule the old `timeoutFailoverTargetModelOptions` had.
const failoverModelGroups = $derived(
	buildModelOptionGroups({
		availableModels,
		providers: providerConfigs,
		providerModels: allProviderModels,
		adminConfig: draft,
		freeLabel: tVal("admin.system.modelFree"),
		includeProviderLevel: false,
		// All three selects that share this list, not just the first non-empty
		// one: a stale id with no matching option renders as the wrong model.
		configuredValues: [
			draft.MEMORY_JUDGE_MODEL,
			draft.MEMORY_CONSOLIDATION_MODEL,
			draft.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL,
		],
	}),
);

const defaultUserModelGroups = $derived(modelGroups);

// --- search ---------------------------------------------------------------

const NAMED_KEY_LABEL: Record<string, I18nKey> = {
	COMPOSER_COMMAND_REGISTRY_ENABLED: "admin.composerCommandRegistryEnabled",
	APP_VERSION_OVERRIDE: "admin.appVersionOverride",
	MODEL_TIMEOUT_FAILOVER_ENABLED: "admin.modelTimeoutFailoverEnabled",
	MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS: "admin.modelTimeoutFailoverTimeoutMs",
	MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: "admin.modelTimeoutFailoverTargetModel",
	DEFAULT_NEW_USER_MODEL: "admin.defaultNewUserModel",
	ATLAS_WORKER_ENABLED: "admin.atlasWorkerEnabled",
	ATLAS_GLOBAL_ACTIVE_LIMIT: "admin.atlasGlobalActiveLimit",
	ATLAS_SEARCH_CONCURRENCY: "admin.atlasSearchConcurrency",
	ATLAS_SEARCH_BATCH_DELAY_MS: "admin.atlasSearchBatchDelayMs",
	ATLAS_SYNTHESIS_MODEL: "admin.atlasSynthesisModel",
	ATLAS_AUDIT_MODEL: "admin.atlasAuditModel",
	ATLAS_PIPELINE: "admin.system.atlas.pipeline.label",
	MEMORY_JUDGE_MODEL: "admin.memoryJudgeModel",
	MEMORY_CONSOLIDATION_MODEL: "admin.memoryConsolidationModel",
	TITLE_GEN_MODEL: "admin.titleGenModel",
	TITLE_GEN_SYSTEM_PROMPT_EN: "admin.titleGenPromptEn",
	TITLE_GEN_SYSTEM_PROMPT_HU: "admin.titleGenPromptHu",
	TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN: "admin.titleGenCodeAppendixEn",
	TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU: "admin.titleGenCodeAppendixHu",
	CONTEXT_SUMMARIZER_MODEL: "admin.contextSummarizerModel",
	SYSTEM_PROMPT: "admin.systemPromptLabel",
	PARALLEL_API_KEY: "admin.parallelApiKey",
	BRAVE_SEARCH_API_KEY: "admin.braveSearchApiKey",
	MINERU_API_URL: "admin.mineruApiUrl",
	MINERU_TIMEOUT_MS: "admin.mineruTimeoutMs",
	WEB_PUSH_VAPID_PUBLIC_KEY: "admin.webPushVapidPublicKey",
	WEB_PUSH_VAPID_PRIVATE_KEY: "admin.webPushVapidPrivateKey",
	WEB_PUSH_VAPID_SUBJECT: "admin.webPushVapidSubject",
	MAX_MESSAGE_LENGTH: "admin.maxMessageLength",
	MAX_FILE_UPLOAD_SIZE: "admin.maxFileUploadSize",
	REQUEST_TIMEOUT_MS: "admin.requestTimeoutMs",
};

function searchLabelFor(key: string): string {
	const named = NAMED_KEY_LABEL[key];
	if (named) return tVal(named);
	const spec = ADVANCED_KEY_SPECS.find((entry) => entry.key === key);
	if (spec) return tVal(`admin.system.keys.${key}.label` as I18nKey);
	return key;
}

const searchItems = $derived.by(() => {
	const items: SystemSearchItem[] = [];
	for (const key of Object.keys(NAMED_KEY_LABEL)) {
		items.push({
			id: `key:${key}`,
			label: $t(NAMED_KEY_LABEL[key]),
			sub: key,
			page: pageForKey(key) ?? "advanced",
		});
	}
	for (const spec of ADVANCED_KEY_SPECS) {
		if (NAMED_KEY_LABEL[spec.key]) continue;
		items.push({
			id: `key:${spec.key}`,
			label: $t(`admin.system.keys.${spec.key}.label` as I18nKey),
			sub: spec.key,
			page: pageForKey(spec.key) ?? "advanced",
		});
	}
	for (const provider of providerConfigs) {
		items.push({
			id: `provider:${provider.id}`,
			label: provider.displayName,
			sub: provider.name,
			page: "models",
		});
	}
	return items;
});

function goToSearchResult(item: SystemSearchItem) {
	activePage = item.page;
	if (item.id.startsWith("provider:")) {
		openProviderId = item.id.slice("provider:".length);
		return;
	}
	const key = item.sub ?? "";
	highlight(key);
}

function highlight(key: string) {
	highlightKey = key;
	clearTimeout(highlightTimer);
	requestAnimationFrame(() => {
		const node = document.querySelector(`[data-config-key="${key}"]`);
		node?.scrollIntoView({ behavior: "smooth", block: "center" });
	});
	highlightTimer = setTimeout(() => {
		highlightKey = "";
	}, 2400);
}
</script>

<div class="sys-shell" data-testid="admin-system-screen">
	<SystemNav
		active={activePage}
		{dirtyByPage}
		counts={{ skills: systemSkills.length, advanced: keyCountForPage('advanced') }}
		onselect={(page) => {
			activePage = page;
		}}
	/>

	<div class="sys-main">
		<SystemSearch items={searchItems} onselect={goToSearchResult} />

		{#if activePage === 'general'}
			<GeneralPage
				adminConfig={draft}
				{envDefaults}
				{highlightKey}
				{isDirty}
				{setValue}
				{resetValue}
			/>
		{:else if activePage === 'models'}
			<ModelsPage
				adminConfig={draft}
				{envDefaults}
				{failoverModelGroups}
				{defaultUserModelGroups}
				{highlightKey}
				{isDirty}
				{setValue}
				{resetValue}
			>
				{#snippet providerList()}
					<ProviderList
						providers={providerConfigs}
						providerModels={allProviderModels}
						loading={providerConfigsLoading}
						busyProviderId={deletingProviderId}
						error={providerConfigsError}
						message={providersMessage}
						bind:openProviderId
						onAdd={openAddProviderConfig}
						onEdit={openEditProviderConfig}
						onDelete={(provider) => (pendingProviderDelete = provider)}
						onToggleEnabled={handleToggleProviderConfig}
						onDiscover={handleDiscoverProviderConfig}
						onManageModels={handleManageModels}
						onReorder={handleReorderProvider}
						onTest={(provider) => handleTestProvider(provider)}
					>
						{#snippet drawer(providerId)}
							<ModelList
								{providerId}
								models={allProviderModels}
								allModels={allProviderModels}
								allProviders={providerConfigs}
								onIconFile={handleModelModelIconFile}
								onRefresh={loadProviderConfigs}
								{modelIconAssetSaved}
							/>
						{/snippet}
					</ProviderList>
				{/snippet}
			</ModelsPage>
		{:else if activePage === 'aiTasks'}
			<AiTasksPage
				adminConfig={draft}
				{envDefaults}
				{modelGroups}
				{failoverModelGroups}
				{highlightKey}
				{isDirty}
				{setValue}
				{resetValue}
			/>
		{:else if activePage === 'integrations'}
			<IntegrationsPage
				adminConfig={draft}
				{envDefaults}
				{secretChangedAt}
				{highlightKey}
				{isDirty}
				{setValue}
				{resetValue}
				{revertValue}
			/>
		{:else if activePage === 'limits'}
			<LimitsPage
				adminConfig={draft}
				{envDefaults}
				{highlightKey}
				{isDirty}
				{setValue}
				{resetValue}
			/>
		{:else if activePage === 'skills'}
			<SkillsPage
				skills={systemSkills}
				loading={systemSkillsLoading}
				error={systemSkillsError}
				message={systemSkillsMessage}
				onNew={openNewSkill}
				onEdit={editSystemSkill}
				onToggleEnabled={(skill, enabled) =>
					updateSystemSkillFlags(skill, { enabled })}
				onTogglePublished={(skill, published) =>
					updateSystemSkillFlags(
						skill,
						published ? { published: true, enabled: true } : { published: false },
					)}
			/>
		{:else if activePage === 'advanced'}
			<AdvancedPage
				adminConfig={draft}
				{envDefaults}
				{secretChangedAt}
				{highlightKey}
				{isDirty}
				{setValue}
				{resetValue}
				{revertValue}
			/>
		{:else}
			<DiagnosticsPage
				bind:activeTab={diagnosticsTab}
				{toolHealth}
				{toolHealthLoading}
				{toolHealthRefreshing}
				{toolHealthError}
				{effectiveConfig}
				{effectiveConfigLoading}
				{effectiveConfigError}
				onRefreshToolHealth={() => loadToolHealth(true)}
				onRefreshEffectiveConfig={() => loadEffectiveConfig()}
			/>
		{/if}

		<SystemSaveBar
			pending={dirtyKeys.length}
			pendingByPage={dirtyByPage}
			saving={adminSaving}
			invalid={invalidKeys.length}
			{lastSavedAt}
			message={adminMessage}
			error={adminError}
			onSave={() => void saveChanges()}
			onDiscard={discardAll}
		/>
	</div>
</div>

{#if showProviderForm}
	<ProviderForm
		provider={providerFormProvider}
		isCreate={providerFormIsCreate}
		saving={providerFormSaving}
		testing={providerFormTesting}
		error={providerFormError}
		testError={providerFormTestError}
		testMessage={providerFormTestMessage}
		onSave={handleProviderFormSave}
		onClose={closeProviderForm}
		onTest={() => handleTestProvider(providerFormProvider)}
		onIconFile={handleProviderIconFile}
		allProviders={providerConfigs}
	/>
{/if}

{#if pendingProviderDelete}
	<ConfirmDialog
		title={$t('admin.system.deleteProvider.title', {
			name: pendingProviderDelete.displayName,
		})}
		message={$t('admin.system.deleteProvider.message')}
		confirmText={$t('common.delete')}
		confirmVariant="danger"
		onConfirm={confirmDeleteProvider}
		onCancel={() => (pendingProviderDelete = null)}
	/>
{/if}

{#if showSkillDialog}
	<SkillDialog
		bind:draft={systemSkillDraft}
		isEdit={Boolean(editingSystemSkillId)}
		saving={systemSkillSaving}
		error={systemSkillsError}
		onSave={saveSystemSkill}
		onClose={() => {
			showSkillDialog = false;
			editingSystemSkillId = null;
		}}
	/>
{/if}

{#if leaveGuardOpen}
	<LeaveGuardDialog
		pending={dirtyKeys.length}
		items={leaveItems}
		saving={adminSaving}
		onKeepEditing={() => {
			leaveGuardOpen = false;
			pendingNavigation = null;
		}}
		onDiscard={() => {
			discardAll();
			leaveNow();
		}}
		onSave={async () => {
			await saveChanges();
			leaveNow();
		}}
	/>
{/if}

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
