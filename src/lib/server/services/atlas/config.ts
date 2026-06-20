import { createHash } from "node:crypto";
import type { AtlasAction, AtlasProfile } from "./types";

export const ATLAS_IDEMPOTENCY_VERSION = "atlas:v1";
export const DEFAULT_ATLAS_JOB_TITLE = "Research request";
export const DEFAULT_ATLAS_WORKER_ENABLED = true;
export const DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT = 2;
export const DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT = 1;
export const DEFAULT_ATLAS_STALE_WORKER_MS = 10 * 60 * 1000;
export const DEFAULT_ATLAS_SEARCH_CONCURRENCY = 3;
export const DEFAULT_ATLAS_SEARCH_INTER_BATCH_DELAY_MS = 500;
export const DEFAULT_ATLAS_SEARCH_INITIAL_RETRY_BACKOFF_MS = 500;
export const DEFAULT_ATLAS_SEARCH_MAX_RETRY_BACKOFF_MS = 10_000;
export const DEFAULT_ATLAS_SEARCH_MAX_ATTEMPTS = 3;

export interface AtlasProfileRuntimeConfig {
	maxSearchQueries: number;
	maxAcceptedWebSources: number;
	maxOutputTokens: number;
	promptPosture: {
		en: string;
		hu: string;
	};
}

const ATLAS_PROFILE_RUNTIME_CONFIG: Record<
	AtlasProfile,
	AtlasProfileRuntimeConfig
> = {
	overview: {
		maxSearchQueries: 6,
		maxAcceptedWebSources: 16,
		maxOutputTokens: 2400,
		promptPosture: {
			en: "Profile posture: Overview. Be concise, prioritize the strongest evidence, avoid unnecessary branches, and produce a focused report with clear limitations.",
			hu: "Profilhangolás: Áttekintő. Légy tömör, a legerősebb bizonyítékokat részesítsd előnyben, kerüld a szükségtelen mellékszálakat, és fókuszált jelentést írj világos korlátokkal.",
		},
	},
	"in-depth": {
		maxSearchQueries: 14,
		maxAcceptedWebSources: 36,
		maxOutputTokens: 5200,
		promptPosture: {
			en: "Profile posture: In-Depth. Balance breadth and depth, compare the main evidence clusters, preserve important tradeoffs, and write a moderately detailed report.",
			hu: "Profilhangolás: Részletes. Egyensúlyozd a szélességet és mélységet, hasonlítsd össze a fő bizonyítékcsoportokat, őrizd meg a fontos kompromisszumokat, és közepesen részletes jelentést írj.",
		},
	},
	exhaustive: {
		maxSearchQueries: 28,
		maxAcceptedWebSources: 72,
		maxOutputTokens: 9000,
		promptPosture: {
			en: "Profile posture: Exhaustive. Search broadly, preserve minority evidence and contradictions, cover edge cases, and write a comprehensive report without dropping uncertainty.",
			hu: "Profilhangolás: Kimerítő. Keress szélesen, őrizd meg a kisebbségi bizonyítékokat és ellentmondásokat, térj ki a szélső esetekre, és írj átfogó jelentést a bizonytalanságok elhagyása nélkül.",
		},
	},
};

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

export function generateAtlasJobTitle(query: string): string {
	const normalized = query.normalize("NFKC").replace(/\s+/g, " ").trim();
	const firstSentence =
		normalized.match(/^(.+?)[.!?。！？](?:\s|$)/u)?.[1]?.trim() ?? normalized;
	const withoutTerminalPunctuation = firstSentence
		.replace(/[.!?。！？]+$/u, "")
		.trim();
	if (!withoutTerminalPunctuation) {
		return DEFAULT_ATLAS_JOB_TITLE;
	}
	const maxLength = 80;
	if (withoutTerminalPunctuation.length <= maxLength) {
		return withoutTerminalPunctuation;
	}
	const clipped = withoutTerminalPunctuation.slice(0, maxLength + 1);
	return (
		clipped.slice(0, Math.max(clipped.lastIndexOf(" "), 40)).trim() ||
		withoutTerminalPunctuation.slice(0, maxLength).trim()
	);
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

export function getAtlasProfileRuntimeConfig(
	profile: AtlasProfile,
): AtlasProfileRuntimeConfig {
	return ATLAS_PROFILE_RUNTIME_CONFIG[profile];
}
