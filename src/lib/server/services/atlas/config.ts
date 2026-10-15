import { createHash } from "node:crypto";
import { getConfig } from "$lib/server/config-store";
import type { AtlasAction, AtlasProfile } from "./types";

export const ATLAS_IDEMPOTENCY_VERSION = "atlas:v1";
export const DEFAULT_ATLAS_JOB_TITLE = "Research request";
export const DEFAULT_ATLAS_WORKER_ENABLED = true;
export const DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT = 2;
export const DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT = 1;

// The job engine's lease for an Atlas attempt (services/jobs, docs/plans/jobs-merge).
// Constants and not admin settings: a new admin key is a five-file change and
// nobody has asked to tune Atlas's lease. They are the file-production defaults.
//
// The runner beats on a timer of its own, so these measure whether the PROCESS is
// alive and not how long a pipeline stage takes (a stage is a model call that can
// run for minutes without reporting anything).
/** How often a running attempt proves it is alive. */
export const ATLAS_HEARTBEAT_MS = 15_000;
/** How long without a beat before the engine takes the attempt back. */
export const ATLAS_STALE_AFTER_MS = 120_000;
/**
 * How many attempts the engine may lose before the job settles `failed`. Before
 * the engine a lost job was requeued forever, so a job that kills the process
 * would have been retried at every restart.
 */
export const ATLAS_MAX_LOST_ATTEMPTS = 3;
/** The code the engine records on an attempt it took back, and on the job while it waits to run again. */
export const ATLAS_LOST_ATTEMPT_CODE = "atlas_worker_heartbeat_timeout";
export const ATLAS_LOST_ATTEMPT_MESSAGE =
	"Atlas worker heartbeat timed out before completion.";

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

export function getDefaultAtlasWorkerLimits(): {
	globalActiveLimit: number;
	perUserActiveLimit: number;
} {
	const config = getConfig();
	return {
		globalActiveLimit:
			config.atlasGlobalActiveLimit ?? DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT,
		perUserActiveLimit: DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT,
	};
}
