import type {
	ImageMarksRequest,
	PictureRef,
} from "$lib/shared/artifacts/image-body";
import { ApiError, type FetchLike, requestJson } from "./http";

/**
 * The body of a turn's request, as far as the gate reads it: the same fields the
 * stream takes (`services/streaming.ts`), parsed by the same
 * `parseChatTurnRequest`. A turn's linked sources and pending skill are not here;
 * the check does not look at them.
 */
export type ChatTurnCheckRequest = {
	conversationId: string;
	message: string;
	model?: string;
	attachmentIds: string[];
	pictureRefs?: PictureRef[];
	imageMarks?: ImageMarksRequest | null;
	activeDocumentArtifactId?: string;
	/** The resend of an edit: a picture gone since is dropped, as in the turn itself. */
	isEditResend?: boolean;
};

export type ChatTurnCheck =
	| { ok: true }
	/** The gate said no. The error carries what a refused send's error carries, so `toFriendlySendError` says the same sentence. */
	| { ok: false; error: ApiError };

/**
 * The statuses the turn's gate refuses with (`chat-turn/request.ts`, `preflight.ts`).
 * Anything else, a session that ended, a server that failed, is a check that could
 * not be made, which says nothing about the turn.
 */
const GATE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
	400, 403, 404, 409, 422,
]);

/**
 * Asks the server whether the turn's gate would take this request, without
 * starting a turn. An edit asks it before it deletes its message, because the
 * resend meets the gate only after the delete. Resolves with the gate's answer;
 * rejects when no answer came (a network error, a server error, an expired session).
 */
export async function checkChatTurn(
	request: ChatTurnCheckRequest,
	fetchImpl: FetchLike = fetch,
): Promise<ChatTurnCheck> {
	try {
		await requestJson<{ ok: true }>(
			"/api/chat/turn-check",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
			},
			"Failed to check the message",
			fetchImpl,
		);
		return { ok: true };
	} catch (error) {
		if (error instanceof ApiError && GATE_REFUSAL_STATUSES.has(error.status)) {
			return { ok: false, error };
		}
		throw error;
	}
}
