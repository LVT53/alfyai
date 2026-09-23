// Why a Normal Chat turn exists — shared by the browser transport
// (streaming.ts, the client turn runtime) and the chat-turn pipeline, so both
// sides agree on the vocabulary.
//
// A client body can only ever claim "send" or "edit_resend" (request.ts). The
// regenerate family is established by chat-turn/retry.ts, which is the only
// route that replaces an existing answer; the browser tells it which of its
// three callers it is:
//   - "regenerate"  — the Regenerate button: the user rejected the answer.
//   - "answer_now"  — "Answer now" interrupting an in-flight turn. Already
//                     recorded as its own client-observed answer_now row.
//   - "error_retry" — the Retry button after a failed turn: a verdict on the
//                     failure, not on the answer.
const RETRY_ORIGINS = ["regenerate", "answer_now", "error_retry"] as const;
export type RetryOrigin = (typeof RETRY_ORIGINS)[number];

export type ChatTurnOrigin = "send" | "edit_resend" | RetryOrigin;

/** A retry route body's `retryOrigin`, defaulting to a plain "regenerate". */
export function parseRetryOrigin(value: unknown): RetryOrigin {
	return typeof value === "string" &&
		(RETRY_ORIGINS as readonly string[]).includes(value)
		? (value as RetryOrigin)
		: "regenerate";
}
