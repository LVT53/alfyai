// Analytics overhaul (backend half) — fire-and-forget client reporting of
// the three activity_events kinds the browser observes directly (a slash
// command chosen in the composer, a follow-up chip clicked, "Answer now"
// clicked). Never throws and never awaited by callers: telemetry can't fail
// or slow down the action it's reporting. Tool calls and skill use are
// recorded server-side instead (see $lib/server/services/activity-events.ts).
import type { FetchLike } from "./api/http";

export type ActivityClientKind =
	| "composer_command"
	| "follow_up_click"
	| "answer_now";

function postActivityEvent(params: {
	kind: ActivityClientKind;
	name: string;
	conversationId: string | null | undefined;
	messageId?: string | null;
	fetchImpl?: FetchLike;
}): void {
	if (typeof window === "undefined") return;
	if (!params.conversationId) return;

	const fetchImpl = params.fetchImpl ?? fetch;
	void fetchImpl("/api/analytics/activity", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			kind: params.kind,
			name: params.name,
			conversationId: params.conversationId,
			...(params.messageId ? { messageId: params.messageId } : {}),
		}),
	}).catch(() => {
		// Best-effort telemetry — never surfaced to the user.
	});
}

/**
 * Report that a composer command (a "/" slash command, e.g. "model",
 * "attach", "web") was chosen. Call this from the composer's command
 * selection handler.
 */
export function recordComposerCommandUsed(
	commandName: string,
	conversationId: string | null | undefined,
	fetchImpl?: FetchLike,
): void {
	postActivityEvent({
		kind: "composer_command",
		name: commandName,
		conversationId,
		fetchImpl,
	});
}

/**
 * Report that a follow-up suggestion chip was clicked.
 */
export function recordFollowUpClicked(
	followUpLabel: string,
	conversationId: string | null | undefined,
	messageId?: string | null,
	fetchImpl?: FetchLike,
): void {
	postActivityEvent({
		kind: "follow_up_click",
		name: followUpLabel,
		conversationId,
		messageId,
		fetchImpl,
	});
}

/**
 * Report that "Answer now" was clicked to interrupt an in-progress
 * reasoning turn.
 */
export function recordAnswerNowClicked(
	conversationId: string | null | undefined,
	messageId?: string | null,
	fetchImpl?: FetchLike,
): void {
	postActivityEvent({
		kind: "answer_now",
		name: "answer_now",
		conversationId,
		messageId,
		fetchImpl,
	});
}
