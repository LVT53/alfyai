import { createHash } from "node:crypto";
import type { AtlasAction, AtlasProfile } from "./types";

export const ATLAS_IDEMPOTENCY_VERSION = "atlas:v1";
export const DEFAULT_ATLAS_JOB_TITLE = "Atlas research";
export const DEFAULT_ATLAS_WORKER_ENABLED = true;
export const DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT = 2;
export const DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT = 1;
export const DEFAULT_ATLAS_STALE_WORKER_MS = 10 * 60 * 1000;
export const DEFAULT_ATLAS_SEARCH_CONCURRENCY = 3;
export const DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS = 500;
export const DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS = 500;
export const DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS = 10_000;
export const DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS = 3;

export interface AtlasIdempotencyScope {
	userId: string;
	conversationId: string;
	action: AtlasAction;
	parentAtlasJobId?: string | null;
	profile: AtlasProfile;
	normalizedQueryHash: string;
	clientAtlasTurnId: string;
}

function sha256Base64Url(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

export function normalizeAtlasQueryForHash(query: string): string {
	return query
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.!?。！？]+$/u, "");
}

export function hashAtlasQuery(query: string): string {
	return sha256Base64Url(normalizeAtlasQueryForHash(query));
}

export function buildAtlasIdempotencyKey(scope: AtlasIdempotencyScope): string {
	const stableScope = {
		userId: scope.userId,
		conversationId: scope.conversationId,
		action: scope.action,
		parentAtlasJobId: scope.parentAtlasJobId ?? "root",
		profile: scope.profile,
		normalizedQueryHash: scope.normalizedQueryHash,
		clientAtlasTurnId: scope.clientAtlasTurnId,
	};
	return `${ATLAS_IDEMPOTENCY_VERSION}:${sha256Base64Url(
		JSON.stringify(stableScope),
	)}`;
}
