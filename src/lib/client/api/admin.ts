import type { AdminManagedUserSummary, UserRole } from "$lib/types";
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

export interface InferenceProvider {
	id: string;
	name: string;
	displayName: string;
	baseUrl: string;
	modelName: string;
	reasoningEffort: "low" | "medium" | "high" | "max" | "xhigh" | null;
	thinkingType: "enabled" | "disabled" | null;
	enabled: boolean;
	sortOrder: number;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxMessageLength: number | null;
	maxTokens: number | null;
	createdAt: string;
	updatedAt: string;
}

interface ProvidersResponse {
	providers: InferenceProvider[];
}

interface ProviderResponse {
	provider: InferenceProvider;
}

interface ValidateResponse {
	valid: boolean;
	error?: string;
}

export async function fetchProviders(): Promise<InferenceProvider[]> {
	const response = await requestJson<ProvidersResponse>(
		"/api/admin/providers",
		undefined,
		"Failed to load providers",
	);
	return response.providers;
}

export async function createProvider(data: {
	name: string;
	displayName: string;
	baseUrl: string;
	apiKey: string;
	modelName: string;
	reasoningEffort?: "low" | "medium" | "high" | "max" | "xhigh" | null;
	thinkingType?: "enabled" | "disabled" | null;
	enabled?: boolean;
	sortOrder?: number;
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
}): Promise<InferenceProvider> {
	const response = await requestJson<ProviderResponse>(
		"/api/admin/providers",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		},
		"Failed to create provider",
	);
	return response.provider;
}

export async function updateProvider(
	id: string,
	data: {
		displayName?: string;
		baseUrl?: string;
		apiKey?: string;
		modelName?: string;
		reasoningEffort?: "low" | "medium" | "high" | "max" | "xhigh" | null;
		thinkingType?: "enabled" | "disabled" | null;
		enabled?: boolean;
		sortOrder?: number;
		maxModelContext?: number | null;
		compactionUiThreshold?: number | null;
		targetConstructedContext?: number | null;
		maxMessageLength?: number | null;
		maxTokens?: number | null;
	},
): Promise<InferenceProvider> {
	const response = await requestJson<ProviderResponse>(
		`/api/admin/providers/${id}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		},
		"Failed to update provider",
	);
	return response.provider;
}

export async function deleteProvider(id: string): Promise<void> {
	await requestVoid(
		`/api/admin/providers/${id}`,
		{ method: "DELETE" },
		"Failed to delete provider",
	);
}

export async function validateProvider(id: string): Promise<ValidateResponse> {
	return requestJson<ValidateResponse>(
		`/api/admin/providers/${id}/validate`,
		{ method: "POST" },
		"Failed to validate provider",
	);
}

export type AdminSkillDurationPolicy = "next_message" | "session";
export type AdminSkillQuestionPolicy = "none" | "ask_when_needed";
export type AdminSkillNotesPolicy = "none" | "create_private_notes";
export type AdminSkillSourceScope = "current_conversation" | "selected_sources_only";
export type AdminSkillCreationSource = "user_created" | "ai_draft" | "system_seed";

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
		"Failed to load system skills",
	);
	return Array.isArray(response.skills) ? response.skills : [];
}

export async function createAdminSystemSkill(data: AdminSystemSkillDraft): Promise<AdminSystemSkill> {
	const response = await requestJson<AdminSystemSkillResponse>(
		"/api/admin/skills",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		},
		"Failed to save system skill",
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
		"Failed to save system skill",
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

interface AdminPersonalityListResponse { profiles: PersonalityProfileSummary[] }
interface AdminPersonalityResponse { profile: PersonalityProfileSummary }

export async function fetchPersonalityProfiles(): Promise<PersonalityProfileSummary[]> {
	const res = await requestJson<AdminPersonalityListResponse>(
		'/api/admin/personalities',
		undefined,
		'Failed to load personality profiles',
	);
	return res.profiles;
}

export async function createPersonalityProfileApi(params: {
	name: string;
	description: string;
	promptText: string;
}): Promise<PersonalityProfileSummary> {
	const res = await requestJson<AdminPersonalityResponse>(
		'/api/admin/personalities',
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
		'Failed to create personality profile',
	);
	return res.profile;
}

export async function updatePersonalityProfileApi(id: string, params: {
	name?: string;
	description?: string;
	promptText?: string;
}): Promise<PersonalityProfileSummary> {
	const res = await requestJson<AdminPersonalityResponse>(
		`/api/admin/personalities/${id}`,
		{ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
		'Failed to update personality profile',
	);
	return res.profile;
}

export async function deletePersonalityProfileApi(id: string): Promise<void> {
	await requestVoid(
		`/api/admin/personalities/${id}`,
		{ method: 'DELETE' },
		'Failed to delete personality profile',
	);
}

export async function fetchPublicPersonalityProfiles(): Promise<PersonalityProfileSummary[]> {
	const res = await requestJson<AdminPersonalityListResponse>(
		'/api/personalities',
		undefined,
		'Failed to load personality profiles',
	);
	return res.profiles.filter((profile) => !(profile.isBuiltIn && profile.name === 'Default'));
}
