import type { SkillDraftProposal } from "$lib/types";
import { requestJson, requestVoid, type FetchLike } from "./http";

export type SkillDurationPolicy = "next_message" | "session";
export type SkillQuestionPolicy = "none" | "ask_when_needed";
export type SkillNotesPolicy = "none" | "create_private_notes";
export type SkillSourceScope = "current_conversation" | "selected_sources_only";
export type SkillCreationSource = "user_created" | "ai_draft" | "system_seed";

export interface UserSkill {
	id: string;
	ownership: "user";
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	enabled: boolean;
	durationPolicy: SkillDurationPolicy;
	questionPolicy: SkillQuestionPolicy;
	notesPolicy: SkillNotesPolicy;
	sourceScope: SkillSourceScope;
	creationSource: SkillCreationSource;
	version: number;
	createdAt: number;
	updatedAt: number;
}

export type UserSkillSummary = Omit<UserSkill, "instructions">;

export interface SystemSkillSummary {
	id: string;
	ownership: "system";
	displayName: string;
	description: string;
	localizedDefaults?: {
		en: {
			displayName: string;
			description: string;
		};
		hu: {
			displayName: string;
			description: string;
		};
	};
	activationExamples: string[];
	enabled: boolean;
	published: boolean;
	durationPolicy: SkillDurationPolicy;
	questionPolicy: SkillQuestionPolicy;
	notesPolicy: SkillNotesPolicy;
	sourceScope: SkillSourceScope;
	creationSource: SkillCreationSource;
	version: number;
	createdAt: number;
	updatedAt: number;
}

export interface UserSkillDraft {
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	enabled?: boolean;
	durationPolicy?: SkillDurationPolicy;
	questionPolicy?: SkillQuestionPolicy;
	notesPolicy?: SkillNotesPolicy;
	sourceScope?: SkillSourceScope;
	creationSource?: SkillCreationSource;
}

export type UserSkillUpdate = Partial<UserSkillDraft>;

export type SkillDiscoverySummary = UserSkillSummary | SystemSkillSummary;

export interface SkillDraftActionResponse {
	skill?: UserSkill;
	systemSkill?: SystemSkillSummary;
	draft?: SkillDraftProposal;
}

interface SkillListResponse {
	skills: UserSkill[];
	systemSkills?: SystemSkillSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function instructionFreeLocalizedDefaults(value: unknown): SystemSkillSummary["localizedDefaults"] {
	if (!isRecord(value)) return undefined;
	const en = isRecord(value.en) ? value.en : {};
	const hu = isRecord(value.hu) ? value.hu : {};
	return {
		en: {
			displayName: typeof en.displayName === "string" ? en.displayName : "",
			description: typeof en.description === "string" ? en.description : "",
		},
		hu: {
			displayName: typeof hu.displayName === "string" ? hu.displayName : "",
			description: typeof hu.description === "string" ? hu.description : "",
		},
	};
}

function publicSystemSkillSummary(skill: SystemSkillSummary): SystemSkillSummary {
	const { instructions: _instructions, localizedDefaults, ...summary } = skill as SystemSkillSummary & {
		instructions?: unknown;
	};
	const safeLocalizedDefaults = instructionFreeLocalizedDefaults(localizedDefaults);
	return safeLocalizedDefaults
		? { ...summary, localizedDefaults: safeLocalizedDefaults }
		: summary;
}

function publicUserSkillSummary(skill: UserSkillSummary): UserSkillSummary {
	const { instructions: _instructions, ...summary } = skill as UserSkillSummary & {
		instructions?: unknown;
	};
	return summary;
}

function publicDiscoverySummary(skill: SkillDiscoverySummary): SkillDiscoverySummary {
	if (skill.ownership === "system") return publicSystemSkillSummary(skill);
	return publicUserSkillSummary(skill);
}

export async function fetchUserSkills(fetchImpl?: FetchLike): Promise<UserSkill[]> {
	const data = await requestJson<SkillListResponse>(
		"/api/skills",
		undefined,
		"Failed to load skills",
		fetchImpl,
	);
	return Array.isArray(data.skills) ? data.skills : [];
}

export async function fetchSystemSkillSummaries(
	fetchImpl?: FetchLike,
): Promise<SystemSkillSummary[]> {
	const data = await requestJson<SkillListResponse>(
		"/api/skills",
		undefined,
		"Failed to load skills",
		fetchImpl,
	);
	return Array.isArray(data.systemSkills) ? data.systemSkills.map(publicSystemSkillSummary) : [];
}

export async function discoverSkills(
	query = "",
	fetchImpl?: FetchLike,
): Promise<SkillDiscoverySummary[]> {
	const params = new URLSearchParams();
	const trimmedQuery = query.trim();
	if (trimmedQuery) params.set("q", trimmedQuery);
	const suffix = params.toString() ? `?${params.toString()}` : "";
	const data = await requestJson<{ skills?: SkillDiscoverySummary[] }>(
		`/api/skills/discovery${suffix}`,
		undefined,
		"Failed to discover skills",
		fetchImpl,
	);
	return Array.isArray(data.skills) ? data.skills.map(publicDiscoverySummary) : [];
}

export async function createUserSkill(
	input: UserSkillDraft,
	fetchImpl?: FetchLike,
): Promise<UserSkill> {
	const data = await requestJson<{ skill: UserSkill }>(
		"/api/skills",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to save skill",
		fetchImpl,
	);
	return data.skill;
}

export async function updateUserSkill(
	id: string,
	input: UserSkillUpdate,
	fetchImpl?: FetchLike,
): Promise<UserSkill> {
	const data = await requestJson<{ skill: UserSkill }>(
		`/api/skills/${encodeURIComponent(id)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to save skill",
		fetchImpl,
	);
	return data.skill;
}

export async function deleteUserSkill(id: string, fetchImpl?: FetchLike): Promise<void> {
	await requestVoid(
		`/api/skills/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		"Failed to delete skill",
		fetchImpl,
	);
}

function skillDraftUrl(
	conversationId: string,
	messageId: string,
	draftId: string,
	action?: "save" | "publish",
): string {
	const base = `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(
		messageId,
	)}/skill-drafts/${encodeURIComponent(draftId)}`;
	return action ? `${base}/${action}` : base;
}

export async function saveSkillDraft(
	conversationId: string,
	messageId: string,
	draftId: string,
	fetchImpl?: FetchLike,
): Promise<SkillDraftActionResponse> {
	return requestJson<SkillDraftActionResponse>(
		skillDraftUrl(conversationId, messageId, draftId, "save"),
		{ method: "POST" },
		"Failed to save skill draft",
		fetchImpl,
	);
}

export async function dismissSkillDraft(
	conversationId: string,
	messageId: string,
	draftId: string,
	fetchImpl?: FetchLike,
): Promise<SkillDraftActionResponse> {
	return requestJson<SkillDraftActionResponse>(
		skillDraftUrl(conversationId, messageId, draftId),
		{ method: "DELETE" },
		"Failed to dismiss skill draft",
		fetchImpl,
	);
}

export async function publishSkillDraft(
	conversationId: string,
	messageId: string,
	draftId: string,
	systemSkillId?: string,
	fetchImpl?: FetchLike,
): Promise<SkillDraftActionResponse> {
	const body = systemSkillId ? { systemSkillId } : {};
	return requestJson<SkillDraftActionResponse>(
		skillDraftUrl(conversationId, messageId, draftId, "publish"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		"Failed to publish skill draft",
		fetchImpl,
	);
}
