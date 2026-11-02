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
	/**
	 * The turn would be refused. For the gate's own refusal the error carries what a
	 * refused send's error carries, so `toFriendlySendError` says the same sentence.
	 * `busy` is the server turning any turn away for now (a reply running in another
	 * chat, a server that is draining): that has no sentence of its own there.
	 */
	| { ok: false; error: ApiError; busy?: boolean };

/**
 * The statuses the turn's gate refuses with (`chat-turn/request.ts`, `preflight.ts`).
 * Anything else, a session that ended, a server that failed, is a check that could
 * not be made, which says nothing about the turn.
 */
const GATE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
	400, 403, 404, 409, 422,
]);

/** The code of the 503 the stream route, and so the check, answers when it cannot take a turn (`refuseTurnWhenOverCapacity`). */
const CAPACITY_REFUSAL_CODE = "CAPACITY_EXCEEDED";

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
		if (error instanceof ApiError) {
			if (error.status === 503 && error.code === CAPACITY_REFUSAL_CODE) {
				return { ok: false, error, busy: true };
			}
			if (GATE_REFUSAL_STATUSES.has(error.status)) {
				return { ok: false, error };
			}
		}
		throw error;
	}
}
