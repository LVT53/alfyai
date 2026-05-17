import { requestJson, requestVoid, type FetchLike } from './http';

export type CampaignLocale = 'en' | 'hu';
export type CampaignAssetVariant = 'desktop' | 'mobile';
export type CampaignStatus = 'draft' | 'published' | 'archived' | (string & {});
export type CampaignType = 'first_run_onboarding' | 'release_update' | (string & {});
export type CampaignSlideKind = 'setup' | 'standard' | (string & {});
export type CampaignSetupControl = 'ui_language' | 'theme' | 'model_default' | 'ai_style' | (string & {});
export type CampaignEventType =
	| 'auto_shown'
	| 'slide_viewed'
	| 'completed'
	| 'skipped'
	| 'replay_opened'
	| 'setup_preference_changed'
	| (string & {});
export type CampaignCompletionReason = 'completed' | 'skipped';

export type CampaignValidationIssue = {
	path?: string;
	field?: string;
	message: string;
	code?: string;
};

export type CampaignAssetRef = {
	id: string;
	url?: string;
	assetId?: string;
	sourceAssetId?: string | null;
	variant?: CampaignAssetVariant | null;
	alt?: string | null;
	width?: number | null;
	height?: number | null;
};

export type CampaignSlide = {
	id?: string;
	campaignId?: string;
	kind?: CampaignSlideKind;
	type?: CampaignSlideKind;
	layoutType?: CampaignSlideKind;
	semanticRole?: string | null;
	sortOrder?: number;
	title?: Partial<Record<CampaignLocale, string | null>> | null;
	titleEn?: string | null;
	titleHu?: string | null;
	body?: Partial<Record<CampaignLocale, string | null>> | null;
	bodyEn?: string | null;
	bodyHu?: string | null;
	altText?: Partial<Record<CampaignLocale, string | null>> | null;
	altEn?: string | null;
	altHu?: string | null;
	actionLabel?: Partial<Record<CampaignLocale, string | null>> | null;
	actionLabelEn?: string | null;
	actionLabelHu?: string | null;
	actionDestination?: string | null;
	actionUrl?: string | null;
	desktopCropAssetId?: string | null;
	desktopAssetId?: string | null;
	mobileCropAssetId?: string | null;
	mobileAssetId?: string | null;
	desktopSourceAssetId?: string | null;
	mobileSourceAssetId?: string | null;
	desktopAsset?: CampaignAssetRef | null;
	mobileAsset?: CampaignAssetRef | null;
	assets?: CampaignAssetRef[];
	setupControls?: CampaignSetupControl[];
	createdAt?: string | number | Date | null;
	updatedAt?: string | number | Date | null;
};

export type CampaignAnalyticsSummary = {
	autoShown?: number;
	completed?: number;
	skipped?: number;
	replayOpened?: number;
	completionRate?: number;
	slideViews?: Array<{ slideId: string; sortOrder: number; views: number }>;
	[key: string]: unknown;
};

export type Campaign = {
	id: string;
	type: CampaignType;
	releaseVersion?: string | null;
	name?: string | null;
	version?: number | string | null;
	status: CampaignStatus;
	slideCount?: number | null;
	slides?: CampaignSlide[];
	validationErrors?: CampaignValidationIssue[];
	validationIssues?: CampaignValidationIssue[];
	analyticsSummary?: CampaignAnalyticsSummary | null;
	createdAt?: string | number | Date | null;
	updatedAt?: string | number | Date | null;
	publishedAt?: string | number | Date | null;
	archivedAt?: string | number | Date | null;
};

export type CampaignSlideDraft = Omit<CampaignSlide, 'campaignId' | 'createdAt' | 'updatedAt'>;

export type CampaignDraftPayload = {
	type?: CampaignType;
	releaseVersion?: string | null;
	name?: string | null;
	status?: CampaignStatus;
	slides?: CampaignSlideDraft[];
};

export type CreateCampaignPayload = {
	type: CampaignType;
	releaseVersion?: string | null;
	name?: string | null;
};

type CampaignListResponse = {
	campaigns: Campaign[];
};

type CampaignResponse = {
	campaign: Campaign;
};

type CampaignEventResponse = {
	event: unknown;
};

type CampaignCompletionResponse = {
	state: unknown;
};

export type SeedFirstRunCampaignResponse = {
	campaign: Campaign;
	created: boolean;
};

const jsonHeaders = { 'Content-Type': 'application/json' };

export async function fetchAdminCampaigns(fetchImpl: FetchLike = fetch): Promise<Campaign[]> {
	const response = await requestJson<CampaignListResponse>(
		'/api/admin/campaigns',
		undefined,
		'Failed to load campaigns',
		fetchImpl,
	);
	return response.campaigns;
}

export async function createAdminCampaign(
	payload: CreateCampaignPayload,
	fetchImpl: FetchLike = fetch,
): Promise<Campaign> {
	const response = await requestJson<CampaignResponse>(
		'/api/admin/campaigns',
		{
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify(payload),
		},
		'Failed to create campaign',
		fetchImpl,
	);
	return response.campaign;
}

export async function fetchAdminCampaign(id: string, fetchImpl: FetchLike = fetch): Promise<Campaign> {
	const response = await requestJson<CampaignResponse>(
		`/api/admin/campaigns/${encodeURIComponent(id)}`,
		undefined,
		'Failed to load campaign',
		fetchImpl,
	);
	return response.campaign;
}

export async function updateAdminCampaign(
	id: string,
	payload: CampaignDraftPayload,
	fetchImpl: FetchLike = fetch,
): Promise<Campaign> {
	const response = await requestJson<CampaignResponse>(
		`/api/admin/campaigns/${encodeURIComponent(id)}`,
		{
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify(payload),
		},
		'Failed to save campaign',
		fetchImpl,
	);
	return response.campaign;
}

export async function publishAdminCampaign(id: string, fetchImpl: FetchLike = fetch): Promise<Campaign> {
	const response = await requestJson<CampaignResponse>(
		`/api/admin/campaigns/${encodeURIComponent(id)}/publish`,
		{ method: 'POST' },
		'Failed to publish campaign',
		fetchImpl,
	);
	return response.campaign;
}

export async function archiveAdminCampaign(id: string, fetchImpl: FetchLike = fetch): Promise<Campaign> {
	const response = await requestJson<CampaignResponse>(
		`/api/admin/campaigns/${encodeURIComponent(id)}/archive`,
		{ method: 'POST' },
		'Failed to archive campaign',
		fetchImpl,
	);
	return response.campaign;
}

export async function deleteAdminCampaignDraft(id: string, fetchImpl: FetchLike = fetch): Promise<void> {
	await requestVoid(
		`/api/admin/campaigns/${encodeURIComponent(id)}`,
		{ method: 'DELETE' },
		'Failed to delete campaign draft',
		fetchImpl,
	);
}

export async function duplicateAdminCampaign(id: string, fetchImpl: FetchLike = fetch): Promise<Campaign> {
	const response = await requestJson<CampaignResponse>(
		`/api/admin/campaigns/${encodeURIComponent(id)}/duplicate`,
		{ method: 'POST' },
		'Failed to duplicate campaign',
		fetchImpl,
	);
	return response.campaign;
}

export async function seedFirstRunCampaign(
	fetchImpl: FetchLike = fetch,
): Promise<SeedFirstRunCampaignResponse> {
	return requestJson<SeedFirstRunCampaignResponse>(
		'/api/admin/campaigns/seed-first-run',
		{ method: 'POST' },
		'Failed to seed first-run campaign',
		fetchImpl,
	);
}

export async function fetchEligibleCampaign(fetchImpl: FetchLike = fetch): Promise<Campaign | null> {
	const response = await requestJson<CampaignResponse>(
		'/api/campaigns/eligible',
		undefined,
		'Failed to load campaign',
		fetchImpl,
	);
	return response.campaign ?? null;
}

export async function fetchLatestCampaign(fetchImpl: FetchLike = fetch): Promise<Campaign | null> {
	const response = await requestJson<CampaignResponse>(
		'/api/campaigns/latest',
		undefined,
		'Failed to load campaign',
		fetchImpl,
	);
	return response.campaign ?? null;
}

export async function recordCampaignEvent(
	campaignId: string,
	payload: { eventType: CampaignEventType; slideId?: string | null; metadata?: Record<string, unknown> },
	fetchImpl: FetchLike = fetch,
): Promise<unknown> {
	const response = await requestJson<CampaignEventResponse>(
		`/api/campaigns/${encodeURIComponent(campaignId)}/events`,
		{
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify(payload),
		},
		'Failed to record campaign event',
		fetchImpl,
	);
	return response.event;
}

export async function completeCampaign(
	campaignId: string,
	reason: CampaignCompletionReason,
	fetchImpl: FetchLike = fetch,
): Promise<unknown> {
	const response = await requestJson<CampaignCompletionResponse>(
		`/api/campaigns/${encodeURIComponent(campaignId)}/complete`,
		{
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ reason }),
		},
		'Failed to complete campaign',
		fetchImpl,
	);
	return response.state;
}
