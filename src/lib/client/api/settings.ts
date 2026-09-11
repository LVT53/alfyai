import type { UserModelPreference } from "$lib/model-types";
import type { UserSettings } from "$lib/server/services/auth-types";
import {
	ApiError,
	type FetchLike,
	readErrorPayload,
	requestJson,
	requestResponse,
} from "./http";

// Re-export admin functions for backward compatibility
export {
	createAdminUser,
	deleteAdminUser,
	fetchAdminUsers,
	revokeAdminUserSessions,
	updateAdminConfig,
	updateAdminUserRole,
} from "./admin";

// Analytics overhaul (frontend half) — a modelId that no longer resolves to
// an enabled providers/provider_models pair reads "removed" (deleted since
// the calls that reference it were recorded); "disabled" still exists but is
// turned off; built-in model1/model2 are always "active". Mirrors
// ModelAvailability in $lib/server/services/analytics.ts.
export type ModelAvailability = "active" | "disabled" | "removed";

interface AnalyticsByModelRow {
	model: string;
	displayName?: string;
	providerDisplayName?: string | null;
	msgCount: number;
	promptTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	totalCostUsd: number;
	// Analytics overhaul (frontend half) — resolved server-side against the
	// CURRENT providers/provider_models tables; avgReasoningTokens/
	// firstTokenP50Ms/firstTokenP90Ms/generationP50Ms are joined from
	// message_analytics by message_id (undefined = no rows joined at all, a
	// present `null` = rows joined but none carried that particular mark).
	availability?: ModelAvailability;
	avgReasoningTokens?: number;
	firstTokenP50Ms?: number | null;
	firstTokenP90Ms?: number | null;
	generationP50Ms?: number | null;
}

// Analytics overhaul (frontend half) — admin-only "Tools & latency" tab
// sections. Mirror the server types in $lib/server/services/analytics.ts.
export interface ToolActivitySummary {
	name: string;
	calls: number;
	failed: number;
	cached: number;
	p50DurationMs: number | null;
}

export type CommandOrSkillActivityKind =
	| "skill_use"
	| "composer_command"
	| "follow_up_click"
	| "answer_now";

export interface CommandOrSkillActivitySummary {
	kind: CommandOrSkillActivityKind;
	name: string;
	count: number;
}

export const PROMPT_TOKEN_BUCKETS = [
	"<10k",
	"10-30k",
	"30-60k",
	"60-120k",
	">120k",
] as const;
export type PromptTokenBucket = (typeof PROMPT_TOKEN_BUCKETS)[number];

export interface LatencyPromptBucketSummary {
	bucket: PromptTokenBucket;
	n: number;
	firstTokenP50Ms: number | null;
	firstTokenP90Ms: number | null;
	reasoningTokensMedian: number | null;
}

interface AnalyticsByProviderRow {
	providerId: string | null;
	displayName: string;
	totalCostUsd: number;
	totalTokens: number;
	msgCount: number;
}

interface PersonalAnalytics {
	byModel: AnalyticsByModelRow[];
	byProvider: AnalyticsByProviderRow[];
	// USER-AUTHORED messages (`messages` rows with role = 'user'), not billed
	// model calls. usage_events books a row per call — title generation, the
	// thought-step classifier, memory maintenance, every Atlas stage — so the
	// two numbers differ by a lot and only `modelCalls` may be shown as calls.
	totalMessages: number;
	modelCalls: number;
	avgGenerationMs: number;
	totalTokens: number;
	promptTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalCostUsd: number;
	favoriteModel: string | null;
	chatCount: number;
	monthly?: Array<{
		month: string;
		modelCalls: number;
		totalTokens: number;
		totalCostUsd: number;
	}>;
}

interface MonthlyAnalyticsRow {
	month: string;
	/** Billed model calls that month — a cost series, not a message count. */
	modelCalls: number;
	totalTokens: number;
	totalCostUsd: number;
}

interface SystemAnalytics {
	/** USER-AUTHORED messages across the users in scope. */
	totalMessages: number;
	/** Billed model calls across the users in scope. */
	modelCalls: number;
	avgGenerationMs: number;
	totalTokens: number;
	promptTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalCostUsd: number;
	totalUsers: number;
	totalConversations: number;
	byModel: AnalyticsByModelRow[];
	byProvider: AnalyticsByProviderRow[];
	monthly?: MonthlyAnalyticsRow[];
	parallel?: {
		monthly: {
			month: string;
			turboCalls: number;
			extractCalls: number;
			costUsd: number;
		}[];
		totalTurboCalls: number;
		totalExtractCalls: number;
		totalCostUsd: number;
	};
}

interface PerUserAnalytics {
	userId: string;
	displayName: string;
	email: string;
	/** Messages this person wrote. */
	messageCount: number;
	/** Billed model calls booked against this person. */
	modelCalls: number;
	avgGenerationMs: number;
	totalTokens: number;
	promptTokens: number;
	cachedInputTokens?: number;
	outputTokens: number;
	reasoningTokens: number;
	totalCostUsd: number;
	favoriteModel: string | null;
	conversationCount: number;
}

export interface AnalyticsUserSummary {
	userId: string;
	email: string | null;
	name: string | null;
}

export interface AnalyticsResponse {
	personal: PersonalAnalytics;
	system?: SystemAnalytics;
	perUser?: PerUserAnalytics[];
	availableMonths?: string[];
	systemAvailableMonths?: string[];
	timeline?: Array<{ label: string; tokens: number }>;
	analyticsUsers?: AnalyticsUserSummary[];
	// Analytics overhaul (frontend half) — admin-only, alongside `system`.
	// Honour the same month/userId/modelId/providerId/excludedUserIds filters.
	tools?: ToolActivitySummary[];
	commandsAndSkills?: CommandOrSkillActivitySummary[];
	latencyByPromptBucket?: LatencyPromptBucketSummary[];
}

export async function fetchUserSettings(
	fetchImpl?: FetchLike,
): Promise<UserSettings> {
	return requestJson<UserSettings>(
		"/api/settings",
		undefined,
		"Failed to load settings",
		fetchImpl,
	);
}

interface ProfileUpdateParams {
	name: string | null;
	email: string;
}

interface PasswordUpdateParams {
	currentPassword: string;
	newPassword: string;
}

export async function updateUserPreferences(params: {
	preferredModel?: UserModelPreference;
	theme?: "system" | "light" | "dark";
	titleLanguage?: "auto" | "en" | "hu";
	uiLanguage?: "en" | "hu";
	preferredPersonalityId?: string | null;
	sidebarProjectsExpanded?: boolean;
	sidebarChatsExpanded?: boolean;
	memoryEnabled?: boolean;
}): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/settings/preferences",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
		"Failed to update preferences",
	);
}

export interface AnalyticsSystemFilters {
	userId?: string | null;
	modelId?: string | null;
	providerId?: string | null;
}

export async function fetchAnalytics(
	useMockData = false,
	month?: string,
	timeline?: string,
	systemMonth?: string,
	// Analytics overhaul (frontend half) — admin-only narrowing filters over
	// the system/tools/commandsAndSkills/latencyByPromptBucket sections.
	filters?: AnalyticsSystemFilters,
): Promise<AnalyticsResponse> {
	const params = new URLSearchParams();
	if (useMockData) params.set("mock", "1");
	if (month) params.set("month", month);
	if (timeline) params.set("timeline", timeline);
	if (systemMonth) params.set("systemMonth", systemMonth);
	if (filters?.userId) params.set("userId", filters.userId);
	if (filters?.modelId) params.set("modelId", filters.modelId);
	if (filters?.providerId) params.set("providerId", filters.providerId);
	const qs = params.toString();
	const endpoint = qs ? `/api/analytics?${qs}` : "/api/analytics";
	return requestJson<AnalyticsResponse>(
		endpoint,
		undefined,
		"Failed to load analytics",
	);
}

export async function deleteAvatar(): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/settings/avatar",
		{
			method: "DELETE",
		},
		"Failed to remove photo",
	);
}

export async function uploadAvatar(image: Blob): Promise<void> {
	const formData = new FormData();
	formData.append("image", image, "avatar.webp");

	await requestJson<{ success?: boolean }>(
		"/api/settings/avatar",
		{
			method: "POST",
			body: formData,
		},
		"Upload failed",
	);
}

export async function updateProfile(
	params: ProfileUpdateParams,
): Promise<void> {
	await requestJson<{ name: string | null; email: string }>(
		"/api/settings/profile",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
		"Failed to update profile",
	);
}

export async function updatePassword(
	params: PasswordUpdateParams,
): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/settings/password",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		},
		"Failed to change password",
	);
}

export async function deleteAccount(
	password: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/settings/account",
		{
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		},
		"Failed to delete account",
		fetchImpl,
	);
}

export interface AccountDataArchiveDownload {
	blob: Blob;
	filename: string;
}

const DEFAULT_ARCHIVE_FILENAME = "AlfyAI Data Archive.zip";

function filenameFromContentDisposition(header: string | null): string {
	if (!header) return DEFAULT_ARCHIVE_FILENAME;

	const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
	if (utf8Match?.[1]) {
		try {
			return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ""));
		} catch {
			return utf8Match[1].trim().replace(/^"|"$/g, "");
		}
	}

	const filenameMatch = /filename="?([^";]+)"?/i.exec(header);
	return filenameMatch?.[1]?.trim() || DEFAULT_ARCHIVE_FILENAME;
}

export function saveBlobAsDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export async function downloadAccountDataArchive(
	password: string,
	fetchImpl: FetchLike = fetch,
): Promise<AccountDataArchiveDownload> {
	const response = await requestResponse(
		"/api/settings/account/archive",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		},
		fetchImpl,
	);
	if (!response.ok) {
		const error = await readErrorPayload(
			response,
			"Failed to download account data archive",
		);
		throw new ApiError(error.message, {
			code: error.code,
			errorKey: error.errorKey,
			fieldErrors: error.fieldErrors,
			status: response.status,
		});
	}

	return {
		blob: await response.blob(),
		filename: filenameFromContentDisposition(
			response.headers.get("Content-Disposition"),
		),
	};
}

export async function clearMemoryAndKnowledge(
	password: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/settings/account/clear-memory",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		},
		"Failed to clear memory and knowledge",
		fetchImpl,
	);
}

export async function clearWorkspaceData(
	password: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestJson<{ success?: boolean }>(
		"/api/settings/account",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		},
		"Failed to clear workspace data",
		fetchImpl,
	);
}

export async function resetAccount(password: string): Promise<void> {
	await clearWorkspaceData(password);
}
