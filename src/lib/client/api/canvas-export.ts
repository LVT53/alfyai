/**
 * The browser side of a board's pictures (Feature 2 · Artifacts, Slice 3, T7):
 * sends a PNG the browser drew — the board's export, or one block's still image —
 * to `POST /api/artifacts/[id]/exports/png`, and says what came of it. Only the
 * browser has the board drawn, which is why the picture is sent rather than made.
 *
 * Its own module, and not part of `artifacts.ts`, so the editor and the chat page
 * that share that one do not carry an upload they use only when a picture is made.
 * Never throws: a picture that could not be kept is a `reason`, and the caller
 * says it in words (`artifacts.canvas.export.*`).
 */
import { type FetchLike, requestResponse } from "$lib/client/api/http";

/** How long a picture is given to reach the server. */
const UPLOAD_TIMEOUT_MS = 45_000;

export type CanvasImageSource = "canvas-export" | "canvas-poster";

export type UploadCanvasImageResult =
	| {
			ok: true;
			fileId: string;
			width: number;
			height: number;
			filename: string;
	  }
	| {
			ok: false;
			reason:
				| "not_found"
				| "no_conversation"
				| "not_png"
				| "too_large"
				| "invalid_request"
				/** The request never got an answer (the network went, the session ended). */
				| "failed";
	  };

export async function uploadCanvasImage(
	input: {
		artifactId: string;
		/** The chat the panel shows (ruling 51): what lets an incognito chat's own board be pictured. */
		conversationId?: string | null;
		source: CanvasImageSource;
		/** A poster only: the block it is the picture of. */
		nodeId?: string;
		dataUrl: string;
		width: number;
		height: number;
	},
	fetchImpl: FetchLike = fetch,
): Promise<UploadCanvasImageResult> {
	const query = input.conversationId
		? `?conversationId=${encodeURIComponent(input.conversationId)}`
		: "";
	try {
		const response = await requestResponse(
			`/api/artifacts/${encodeURIComponent(input.artifactId)}/exports/png${query}`,
			{
				method: "POST",
				// A request that never answers must not hold a picture (or the board drawn over for it).
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					source: input.source,
					dataUrl: input.dataUrl,
					width: input.width,
					height: input.height,
					...(input.nodeId ? { nodeId: input.nodeId } : {}),
				}),
			},
			fetchImpl,
		);
		const answer = (await response
			.json()
			.catch(() => null)) as UploadCanvasImageResult | null;
		if (answer && typeof answer === "object" && "ok" in answer) return answer;
		return { ok: false, reason: "failed" };
	} catch {
		return { ok: false, reason: "failed" };
	}
}
