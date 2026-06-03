import type { ModelId, UserModelPreference, UserSettings } from '$lib/types';
import { requestJson, type FetchLike } from './http';

// Re-export admin functions for backward compatibility
export {
	fetchAdminUsers,
	createAdminUser,
	updateAdminUserRole,
	deleteAdminUser,
	revokeAdminUserSessions,
	updateAdminConfig,
} from './admin';


export interface HonchoHealth {
	enabled: boolean;
	connected: boolean;
	workspace: string | null;
}

interface AnalyticsByModelRow {
	model: string;
	displayName?: string;
	msgCount: number;
	totalCostUsd?: number;
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
	monthly?: Array<{ month: string; messages: number; totalTokens: number; totalCostUsd: number }>;
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

export interface AnalyticsResponse {
	personal: PersonalAnalytics;
	system?: SystemAnalytics;
	perUser?: PerUserAnalytics[];
	availableMonths?: string[];
	timeline?: Array<{ label: string; tokens: number }>;
}

export async function fetchUserSettings(fetchImpl?: FetchLike): Promise<UserSettings> {
	return requestJson<UserSettings>(
		'/api/settings',
		undefined,
		'Failed to load settings',
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
	theme?: 'system' | 'light' | 'dark';
	titleLanguage?: 'auto' | 'en' | 'hu';
	uiLanguage?: 'en' | 'hu';
	avatarId?: number | null;
	preferredPersonalityId?: string | null;
}): Promise<void> {
	await requestJson<{ success?: boolean }>(
		'/api/settings/preferences',
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(params),
		},
		'Failed to update preferences'
	);
}

export async function fetchHonchoHealth(): Promise<HonchoHealth> {
	return requestJson<HonchoHealth>(
		'/api/admin/honcho',
		undefined,
		'Failed to load Honcho health'
	);
}

export async function fetchAnalytics(useMockData = false, month?: string, timeline?: string): Promise<AnalyticsResponse> {
	const params = new URLSearchParams();
	if (useMockData) params.set('mock', '1');
	if (month) params.set('month', month);
	if (timeline) params.set('timeline', timeline);
	const qs = params.toString();
	const endpoint = qs ? `/api/analytics?${qs}` : '/api/analytics';
	return requestJson<AnalyticsResponse>(endpoint, undefined, 'Failed to load analytics');
}

export async function deleteAvatar(): Promise<void> {
	await requestJson<{ success?: boolean }>(
		'/api/settings/avatar',
		{
			method: 'DELETE',
		},
		'Failed to remove photo'
	);
}

export async function uploadAvatar(image: Blob): Promise<void> {
	const formData = new FormData();
	formData.append('image', image, 'avatar.webp');

	await requestJson<{ success?: boolean }>(
		'/api/settings/avatar',
		{
			method: 'POST',
			body: formData,
		},
		'Upload failed'
	);
}

export async function updateProfile(params: ProfileUpdateParams): Promise<void> {
	await requestJson<{ name: string | null; email: string }>(
		'/api/settings/profile',
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(params),
		},
		'Failed to update profile'
	);
}

export async function updatePassword(params: PasswordUpdateParams): Promise<void> {
	await requestJson<{ success?: boolean }>(
		'/api/settings/password',
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(params),
		},
		'Failed to change password'
	);
}

export async function deleteAccount(password: string): Promise<void> {
	await requestJson<{ success?: boolean }>(
		'/api/settings/account',
		{
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password }),
		},
		'Failed to delete account'
	);
}

export async function resetAccount(password: string): Promise<void> {
	await requestJson<{ success?: boolean }>(
		'/api/settings/account',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password }),
		},
		'Failed to reset account'
	);
}
