// Analytics overhaul (backend half) — recording side for activity_events.
// Two server-observed kinds are written straight from the chat-turn
// pipeline (tool_call, skill_use); three client-observed kinds
// (composer_command, follow_up_click, answer_now) come in through
// POST /api/analytics/activity, which calls recordClientActivityEvent after
// its own validation + rate limiting. Every writer here is best-effort: a
// failure to record an activity event never fails or alters a turn or a
// request, mirroring every other analytics writer in analytics.ts.
import * as crypto from "node:crypto";
import { db } from "../db";
import { activityEvents } from "../db/schema";
import type { ToolCallEntry } from "./messages-types";

export type ActivityEventKind =
	| "tool_call"
	| "skill_use"
	| "composer_command"
	| "follow_up_click"
	| "answer_now";

export type ActivityEventStatus = "done" | "failed" | "cached";

// The three kinds a client is allowed to report through the public endpoint.
// tool_call and skill_use are only ever recorded server-side from turn state
// the client cannot fabricate.
export const CLIENT_ACTIVITY_EVENT_KINDS = [
	"composer_command",
	"follow_up_click",
	"answer_now",
] as const;
export type ClientActivityEventKind =
	(typeof CLIENT_ACTIVITY_EVENT_KINDS)[number];

export const ACTIVITY_EVENT_NAME_MAX_LENGTH = 64;

export interface RecordActivityEventParams {
	userId: string;
	conversationId: string;
	messageId?: string | null;
	kind: ActivityEventKind;
	name: string;
	status?: ActivityEventStatus;
	durationMs?: number | null;
	modelId?: string | null;
}

export async function recordActivityEvent(
	params: RecordActivityEventParams,
): Promise<void> {
	try {
		await db.insert(activityEvents).values({
			id: crypto.randomUUID(),
			userId: params.userId,
			conversationId: params.conversationId,
			messageId: params.messageId ?? null,
			kind: params.kind,
			name: params.name.slice(0, ACTIVITY_EVENT_NAME_MAX_LENGTH),
			status: params.status ?? "done",
			durationMs:
				typeof params.durationMs === "number" &&
				Number.isFinite(params.durationMs) &&
				params.durationMs >= 0
					? Math.round(params.durationMs)
					: null,
			modelId: params.modelId ?? null,
		});
	} catch (error) {
		console.error("[ANALYTICS] Failed to record activity event", {
			kind: params.kind,
			name: params.name,
			error,
		});
	}
}

// A tool call is "cached" when the tool itself flagged it in metadata.cached
// (no current tool sets this yet, but the shape is reserved for it — see
// ToolCallEntry in messages-types.ts); otherwise a "failed" ToolCallEntry
// status maps straight across, and everything else (including "running",
// which finalize's toolCalls list never contains at turn completion) is
// "done".
function toolCallStatus(entry: ToolCallEntry): ActivityEventStatus {
	if (entry.metadata?.cached === true) return "cached";
	if (entry.status === "failed") return "failed";
	return "done";
}

// Duration isn't tracked on ToolCallEntry today; this reads
// metadata.durationMs defensively so a tool that starts reporting it is
// picked up with no further changes here.
function toolCallDurationMs(entry: ToolCallEntry): number | null {
	const raw = entry.metadata?.durationMs;
	return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
		? Math.round(raw)
		: null;
}

// The use_skill tool call is recorded as a skill_use event (named after the
// skill, not the tool) whenever it actually loaded a skill — see the
// `skillDisplayName`/`skillId`/`found` fields set on its ToolCallEntry
// metadata in normal-chat-tools/index.ts. A call that found nothing (bad
// name, disabled skill) falls through to the ordinary tool_call recording
// below so it still shows up as a failure in the Tools table.
function useSkillEventName(entry: ToolCallEntry): string | null {
	if (entry.name !== "use_skill" || entry.metadata?.found !== true) {
		return null;
	}
	const displayName = entry.metadata?.skillDisplayName;
	const skillId = entry.metadata?.skillId;
	if (typeof displayName === "string" && displayName.length > 0) {
		return displayName;
	}
	if (typeof skillId === "string" && skillId.length > 0) return skillId;
	return null;
}

export async function recordToolCallActivityEvents(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	modelId?: string | null;
	toolCalls: ToolCallEntry[] | undefined;
}): Promise<void> {
	const entries = (params.toolCalls ?? []).filter(
		(entry) => entry.status !== "running",
	);
	if (entries.length === 0) return;

	await Promise.all(
		entries.map((entry) => {
			const skillUseName = useSkillEventName(entry);
			return recordActivityEvent({
				userId: params.userId,
				conversationId: params.conversationId,
				messageId: params.messageId,
				kind: skillUseName ? "skill_use" : "tool_call",
				name: skillUseName ?? entry.name,
				status: toolCallStatus(entry),
				durationMs: toolCallDurationMs(entry),
				modelId: params.modelId ?? null,
			});
		}),
	);
}

export async function recordSkillUseActivityEvent(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	modelId?: string | null;
	// The applied skill's display name — the read model groups skill_use
	// events by this exact string, so an id would show up as a separate,
	// less readable row.
	displayName: string;
}): Promise<void> {
	if (!params.displayName) return;
	await recordActivityEvent({
		userId: params.userId,
		conversationId: params.conversationId,
		messageId: params.messageId,
		kind: "skill_use",
		name: params.displayName,
		status: "done",
		modelId: params.modelId ?? null,
	});
}

export async function recordClientActivityEvent(params: {
	userId: string;
	conversationId: string;
	messageId?: string | null;
	kind: ClientActivityEventKind;
	name: string;
}): Promise<void> {
	await recordActivityEvent({
		userId: params.userId,
		conversationId: params.conversationId,
		messageId: params.messageId ?? null,
		kind: params.kind,
		name: params.name,
		status: "done",
		modelId: null,
	});
}

export function isClientActivityEventKind(
	value: unknown,
): value is ClientActivityEventKind {
	return (
		typeof value === "string" &&
		(CLIENT_ACTIVITY_EVENT_KINDS as readonly string[]).includes(value)
	);
}

// A small in-memory sliding-window limiter, scoped to this process — good
// enough for a fire-and-forget telemetry endpoint that never needs
// cross-instance coordination (worst case under-counts activity by a little
// after a restart, never blocks a real chat turn). Not persisted, not
// shared with any other rate limiter in the codebase.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const rateLimitBuckets = new Map<string, number[]>();

export function checkClientActivityRateLimit(
	userId: string,
	now: number = Date.now(),
): boolean {
	const windowStart = now - RATE_LIMIT_WINDOW_MS;
	const recent = (rateLimitBuckets.get(userId) ?? []).filter(
		(timestamp) => timestamp > windowStart,
	);
	if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
		rateLimitBuckets.set(userId, recent);
		return false;
	}
	recent.push(now);
	rateLimitBuckets.set(userId, recent);
	return true;
}

// Test-only: clears every bucket so rate-limit tests don't leak state across
// cases (the map is otherwise process-lifetime, matching production).
export function _resetClientActivityRateLimitForTests(): void {
	rateLimitBuckets.clear();
}
