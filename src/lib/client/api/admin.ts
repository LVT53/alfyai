import type { UserRole } from "$lib/server/services/auth-types";
import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";
import { requestJson, requestVoid } from "./http";

interface AdminUsersResponse {
	users: AdminManagedUserSummary[];
}

interface AdminUserResponse {
	user: AdminManagedUserSummary;
}

export async function fetchAdminUsers(): Promise<AdminManagedUserSummary[]> {
	const response = await requestJson<AdminUsersResponse>(
		"/api/admin/users",
		undefined,
		"Failed to load users",
	);
	return response.users;
}

export async function createAdminUser(params: {
	email: string;
	password: string;
	name?: string | null;
	role?: UserRole;
}): Promise<AdminManagedUserSummary> {
	const response = await requestJson<AdminUserResponse>(
		"/api/admin/users",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
		"Failed to create user",
	);
	return response.user;
}

export async function updateAdminUserRole(
	userId: string,
	role: UserRole,
): Promise<AdminManagedUserSummary> {
	const response = await requestJson<AdminUserResponse>(
		`/api/admin/users/${userId}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role }),
		},
		"Failed to update user role",
	);
	return response.user;
}

export async function deleteAdminUser(userId: string): Promise<void> {
	await requestVoid(
		`/api/admin/users/${userId}`,
		{
			method: "DELETE",
		},
		"Failed to delete user",
	);
}

export async function revokeAdminUserSessions(userId: string): Promise<void> {
	await requestVoid(
		`/api/admin/users/${userId}/sessions`,
		{
			method: "DELETE",
		},
		"Failed to revoke sessions",
	);
}

export async function updateAdminConfig(
	config: Record<string, string>,
): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/admin/config",
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(config),
		},
		"Failed to save configuration",
	);
}

export interface Provider {
	id: string;
	name: string;
	displayName: string;
	baseUrl: string;
	iconAssetId: string | null;
	processingRegionCode: string | null;
	privacyPolicyUrl: string | null;
	rateLimitFallbackEnabled: boolean;
	rateLimitFallbackBaseUrl: string | null;
	rateLimitFallbackModelName: string | null;
	rateLimitFallbackTimeoutMs: number;
	sortOrder: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ProviderCreateInput {
	name: string;
	displayName: string;
	baseUrl: string;
	apiKey: string;
	iconAssetId?: string | null;
	processingRegionCode?: string | null;
	privacyPolicyUrl?: string | null;
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number;
}

export interface ProviderUpdateInput {
	displayName?: string;
	baseUrl?: string;
	apiKey?: string;
	iconAssetId?: string | null;
	processingRegionCode?: string | null;
	privacyPolicyUrl?: string | null;
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number;
	enabled?: boolean;
	sortOrder?: number;
}

interface ProviderListResponse {
	providers: Provider[];
}

interface ProviderDetailResponse {
	provider: Provider;
}

export interface DiscoveredModel {
	id: string;
	contextLength?: number;
	supportsChat?: boolean;
	supportsTools?: boolean;
}

interface ProviderDiscoverResponse {
	models: DiscoveredModel[];
}

export async function fetchProviderList(): Promise<Provider[]> {
	const response = await requestJson<ProviderListResponse>(
		"/api/admin/providers",
		undefined,
		"Failed to load providers",
	);
	return response.providers;
}

export async function createProviderEntry(
	input: ProviderCreateInput,
): Promise<Provider> {
	const response = await requestJson<ProviderDetailResponse>(
		"/api/admin/providers",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to create provider",
	);
	return response.provider;
}

export async function updateProviderEntry(
	id: string,
	input: ProviderUpdateInput,
): Promise<Provider> {
	const response = await requestJson<ProviderDetailResponse>(
		`/api/admin/providers/${id}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to update provider",
	);
	return response.provider;
}

export async function deleteProviderEntry(id: string): Promise<void> {
	await requestVoid(
		`/api/admin/providers/${id}`,
		{ method: "DELETE" },
		"Failed to delete provider",
	);
}

export async function discoverProviderModels(
	id: string,
): Promise<ProviderDiscoverResponse["models"]> {
	const response = await requestJson<ProviderDiscoverResponse>(
		`/api/admin/providers/${id}/discover`,
		{ method: "POST" },
		"Failed to discover provider models",
	);
	return response.models;
}

export type AdminSkillDurationPolicy = "next_message" | "session";
export type AdminSkillQuestionPolicy = "none" | "ask_when_needed";
export type AdminSkillNotesPolicy = "none" | "create_private_notes";
export type AdminSkillSourceScope =
	| "current_conversation"
	| "selected_sources_only";
export type AdminSkillCreationSource =
	| "user_created"
	| "ai_draft"
	| "system_seed";

export interface AdminSystemSkill {
	id: string;
	ownership: "system";
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	enabled: boolean;
	published: boolean;
	durationPolicy: AdminSkillDurationPolicy;
	questionPolicy: AdminSkillQuestionPolicy;
	notesPolicy: AdminSkillNotesPolicy;
	sourceScope: AdminSkillSourceScope;
	creationSource: AdminSkillCreationSource;
	version: number;
	createdAt: number;
	updatedAt: number;
	localizedDefaults?: {
		en: { displayName: string; description: string; instructions: string };
		hu: { displayName: string; description: string; instructions: string };
	};
}

export interface AdminSystemSkillDraft {
	displayName: string;
	description?: string;
	instructions: string;
	activationExamples?: string[];
	enabled?: boolean;
	published?: boolean;
	durationPolicy?: AdminSkillDurationPolicy;
	questionPolicy?: AdminSkillQuestionPolicy;
	notesPolicy?: AdminSkillNotesPolicy;
	sourceScope?: AdminSkillSourceScope;
}

interface AdminSystemSkillsResponse {
	skills: AdminSystemSkill[];
}

interface AdminSystemSkillResponse {
	skill: AdminSystemSkill;
}

export async function fetchAdminSystemSkills(): Promise<AdminSystemSkill[]> {
	const response = await requestJson<AdminSystemSkillsResponse>(
		"/api/admin/skills",
		undefined,
		"Failed to load skills",
	);
	return Array.isArray(response.skills) ? response.skills : [];
}

export async function createAdminSystemSkill(
	data: AdminSystemSkillDraft,
): Promise<AdminSystemSkill> {
	const response = await requestJson<AdminSystemSkillResponse>(
		"/api/admin/skills",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		},
		"Failed to save skill",
	);
	return response.skill;
}

export async function updateAdminSystemSkill(
	id: string,
	data: Partial<AdminSystemSkillDraft>,
): Promise<AdminSystemSkill> {
	const response = await requestJson<AdminSystemSkillResponse>(
		`/api/admin/skills/${encodeURIComponent(id)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		},
		"Failed to save skill",
	);
	return response.skill;
}

export interface PersonalityProfileSummary {
	id: string;
	name: string;
	description: string;
	promptText: string;
	isBuiltIn: boolean;
	createdAt: string;
}

interface AdminPersonalityListResponse {
	profiles: PersonalityProfileSummary[];
}
interface AdminPersonalityResponse {
	profile: PersonalityProfileSummary;
}

export async function fetchPersonalityProfiles(): Promise<
	PersonalityProfileSummary[]
> {
	const res = await requestJson<AdminPersonalityListResponse>(
		"/api/admin/personalities",
		undefined,
		"Failed to load personality profiles",
	);
	return res.profiles;
}

export async function createPersonalityProfileApi(params: {
	name: string;
	description: string;
	promptText: string;
}): Promise<PersonalityProfileSummary> {
	const res = await requestJson<AdminPersonalityResponse>(
		"/api/admin/personalities",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
		"Failed to create personality profile",
	);
	return res.profile;
}

export async function updatePersonalityProfileApi(
	id: string,
	params: {
		name?: string;
		description?: string;
		promptText?: string;
	},
): Promise<PersonalityProfileSummary> {
	const res = await requestJson<AdminPersonalityResponse>(
		`/api/admin/personalities/${id}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
		"Failed to update personality profile",
	);
	return res.profile;
}

export async function deletePersonalityProfileApi(id: string): Promise<void> {
	await requestVoid(
		`/api/admin/personalities/${id}`,
		{ method: "DELETE" },
		"Failed to delete personality profile",
	);
}

export async function fetchPublicPersonalityProfiles(): Promise<
	PersonalityProfileSummary[]
> {
	const res = await requestJson<AdminPersonalityListResponse>(
		"/api/personalities",
		undefined,
		"Failed to load personality profiles",
	);
	return res.profiles.filter(
		(profile) => !(profile.isBuiltIn && profile.name === "Default"),
	);
}

export interface ProviderModel {
	id: string;
	providerId: string;
	name: string;
	displayName: string;
	aliases: string[];
	iconAssetId: string | null;
	guideNoteEn: string | null;
	guideNoteHu: string | null;
	guideBadge: "intelligent" | "simple" | null;
	guideNoCost: boolean;
	estimatedTokensPerSecond: number | null;
	fallbackProviderModelId: string | null;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxMessageLength: number | null;
	maxTokens: number | null;
	reasoningEffort: string | null;
	thinkingType: string | null;
	capabilitiesJson: string;
	inputUsdMicrosPer1m: number;
	cachedInputUsdMicrosPer1m: number;
	cacheHitUsdMicrosPer1m: number;
	cacheMissUsdMicrosPer1m: number;
	outputUsdMicrosPer1m: number;
	enabled: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export type ProviderModelInput = {
	name: string;
	displayName?: string;
	aliases?: string[];
	iconAssetId?: string | null;
	guideNoteEn?: string | null;
	guideNoteHu?: string | null;
	guideBadge?: "intelligent" | "simple" | null;
	guideNoCost?: boolean;
	estimatedTokensPerSecond?: number | null;
	fallbackProviderModelId?: string | null;
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
	reasoningEffort?: string | null;
	thinkingType?: string | null;
	capabilitiesJson?: string | null;
	inputUsdMicrosPer1m?: number;
	cachedInputUsdMicrosPer1m?: number;
	cacheHitUsdMicrosPer1m?: number;
	cacheMissUsdMicrosPer1m?: number;
	outputUsdMicrosPer1m?: number;
	enabled?: boolean;
	sortOrder?: number;
};

export type ProviderModelUpdate = Partial<ProviderModelInput>;

interface ProviderModelListResponse {
	models: ProviderModel[];
}

interface ProviderModelDetailResponse {
	model: ProviderModel;
}

export async function fetchProviderModels(
	providerId: string,
): Promise<ProviderModel[]> {
	const response = await requestJson<ProviderModelListResponse>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models`,
		undefined,
		"Failed to load provider models",
	);
	return response.models;
}

export async function createProviderModel(
	providerId: string,
	input: ProviderModelInput,
): Promise<ProviderModel> {
	const response = await requestJson<ProviderModelDetailResponse>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to create provider model",
	);
	return response.model;
}

export async function updateProviderModel(
	providerId: string,
	modelId: string,
	input: ProviderModelUpdate,
): Promise<ProviderModel> {
	const response = await requestJson<ProviderModelDetailResponse>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to update provider model",
	);
	return response.model;
}

export async function deleteProviderModel(
	providerId: string,
	modelId: string,
): Promise<void> {
	await requestVoid(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
		{ method: "DELETE" },
		"Failed to delete provider model",
	);
}

interface BatchModelsResponse {
	models: ProviderModel[];
}

export async function batchCreateProviderModels(
	providerId: string,
	entries: DiscoveredModel[],
): Promise<ProviderModel[]> {
	const response = await requestJson<BatchModelsResponse>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models/batch`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				models: entries.map((e) => ({
					name: e.id,
					contextLength: e.contextLength,
					supportsChat: e.supportsChat,
					supportsTools: e.supportsTools,
				})),
			}),
		},
		"Failed to create provider models",
	);
	return response.models;
}

// Optional per-model time-slot pricing. Rates are nullable (null = inherit the
// model's flat rate); minutes are minutes-from-UTC-midnight.
export interface PriceWindow {
	id: string;
	providerModelId: string;
	label: string;
	daysOfWeek: string;
	startMinute: number;
	endMinute: number;
	inputUsdMicrosPer1m: number | null;
	cachedInputUsdMicrosPer1m: number | null;
	cacheHitUsdMicrosPer1m: number | null;
	cacheMissUsdMicrosPer1m: number | null;
	outputUsdMicrosPer1m: number | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export type PriceWindowInput = {
	label: string;
	daysOfWeek: string;
	startMinute: number;
	endMinute: number;
	inputUsdMicrosPer1m: number | null;
	cachedInputUsdMicrosPer1m: number | null;
	cacheHitUsdMicrosPer1m: number | null;
	cacheMissUsdMicrosPer1m: number | null;
	outputUsdMicrosPer1m: number | null;
	enabled: boolean;
};

interface PriceWindowsResponse {
	windows: PriceWindow[];
}

export async function fetchPriceWindows(
	providerId: string,
	modelId: string,
): Promise<PriceWindow[]> {
	const response = await requestJson<PriceWindowsResponse>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/price-windows`,
		undefined,
		"Failed to load price windows",
	);
	return response.windows;
}

export async function savePriceWindows(
	providerId: string,
	modelId: string,
	windows: PriceWindowInput[],
): Promise<PriceWindow[]> {
	const response = await requestJson<PriceWindowsResponse>(
		`/api/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/price-windows`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ windows }),
		},
		"Failed to save price windows",
	);
	return response.windows;
}

// ── Routing regions (on-demand map coverage) ──────────────────

export type RoutingRegionSummary = {
	id: string;
	name: string;
	slug: string;
	pbfUrl: string;
	status: string;
	managed: boolean;
	baseUrl: string | null;
	hostPort: number | null;
	containerName: string | null;
	pbfSizeBytes: number | null;
	geocoderStatus: string;
	extractSource: string | null;
	attempts: number;
	nextAttemptAt: string | null;
	resident: boolean;
	// Public transport (GTFS) timetables for this region.
	gtfsUrl: string | null;
	gtfsSizeBytes: number | null;
	gtfsDownloadedAt: string | null;
	transitStatus: string;
	timezone: string | null;
	error: string | null;
	requestedBy: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	readyAt: string | null;
};

type RoutingRegionsResponse = {
	configured: boolean;
	regions: RoutingRegionSummary[];
};

export async function fetchRoutingRegions(): Promise<RoutingRegionsResponse> {
	const response = await requestJson<RoutingRegionsResponse>(
		"/api/admin/routing-regions",
		undefined,
		"Failed to load routing regions",
	);
	return {
		configured: Boolean(response.configured),
		regions: Array.isArray(response.regions) ? response.regions : [],
	};
}

export async function requestRoutingRegion(
	input: { id: string } | { lat: number; lng: number },
): Promise<{ kind: string }> {
	const response = await requestJson<{ outcome: { kind: string } }>(
		"/api/admin/routing-regions",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to request routing region",
	);
	return response.outcome;
}

export async function retryRoutingRegion(id: string): Promise<void> {
	await requestJson<{ region: unknown }>(
		`/api/admin/routing-regions/${encodeURIComponent(id)}`,
		{ method: "POST" },
		"Failed to retry routing region",
	);
}

// Re-download the region's GTFS feed and rebuild only its public-transport
// graph. Ignores the nightly refresh window — this is an explicit ask.
export async function refreshRoutingRegionTransit(id: string): Promise<void> {
	await requestJson<{ region: unknown }>(
		`/api/admin/routing-regions/${encodeURIComponent(id)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "refresh_transit" }),
		},
		"Failed to refresh the region timetable",
	);
}

export async function setRoutingRegionResident(
	id: string,
	resident: boolean,
): Promise<void> {
	await requestJson<{ region: unknown }>(
		`/api/admin/routing-regions/${encodeURIComponent(id)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ resident }),
		},
		"Failed to update routing region",
	);
}

export async function removeRoutingRegion(id: string): Promise<void> {
	await requestJson<{ ok: boolean }>(
		`/api/admin/routing-regions/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		"Failed to remove routing region",
	);
}
