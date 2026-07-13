import type { UserModelPreference, UserSettings } from "$lib/types";
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
	totalMessages: number;
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
		messages: number;
		totalTokens: number;
		totalCostUsd: number;
	}>;
}

interface MonthlyAnalyticsRow {
	month: string;
	messages: number;
	totalTokens: number;
	totalCostUsd: number;
}

interface SystemAnalytics {
	totalMessages: number;
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
	messageCount: number;
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

export async function fetchAnalytics(
	useMockData = false,
	month?: string,
	timeline?: string,
	systemMonth?: string,
): Promise<AnalyticsResponse> {
	const params = new URLSearchParams();
	if (useMockData) params.set("mock", "1");
	if (month) params.set("month", month);
	if (timeline) params.set("timeline", timeline);
	if (systemMonth) params.set("systemMonth", systemMonth);
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
