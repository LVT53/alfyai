import { type FetchLike, requestJson, requestVoid } from "./http";

/** The URL of a picture file. An incognito chat's pictures need the chat named. */
export function imageFileUrl(
	fileId: string,
	options: {
		variant?: "full" | "thumb" | "display";
		download?: boolean;
		conversationId?: string | null;
	} = {},
): string {
	const query = new URLSearchParams();
	if (options.variant === "thumb" || options.variant === "display") {
		query.set("variant", options.variant);
	}
	if (options.download) query.set("download", "1");
	if (options.conversationId) {
		query.set("conversationId", options.conversationId);
	}
	const suffix = query.toString();
	return `/api/images/files/${encodeURIComponent(fileId)}${suffix ? `?${suffix}` : ""}`;
}

function actionUrl(path: string, conversationId?: string | null): string {
	return conversationId
		? `${path}?conversationId=${encodeURIComponent(conversationId)}`
		: path;
}

const take = (takeId: string) =>
	`/api/images/takes/${encodeURIComponent(takeId)}`;

/** Makes the take the version in use. */
export function useImageTake(
	takeId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<{ versionNumber: number }> {
	return requestJson(
		actionUrl(`${take(takeId)}/use`, conversationId),
		{ method: "POST" },
		"Could not use this picture",
		fetchImpl,
	);
}

/** Asks for another take of the card. */
export function anotherImageTake(
	cardId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<{ takeId: string }> {
	return requestJson(
		actionUrl(
			`/api/images/cards/${encodeURIComponent(cardId)}/another`,
			conversationId,
		),
		{ method: "POST" },
		"Could not make another picture",
		fetchImpl,
	);
}

/** The card's Stop. */
export function stopImageTake(
	takeId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	return requestVoid(
		actionUrl(`${take(takeId)}/stop`, conversationId),
		{ method: "POST" },
		"Could not stop this picture",
		fetchImpl,
	);
}

/** Try again, for a take that failed or was stopped. */
export function retryImageTake(
	takeId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	return requestVoid(
		actionUrl(`${take(takeId)}/retry`, conversationId),
		{ method: "POST" },
		"Could not try this picture again",
		fetchImpl,
	);
}

/**
 * Waits for a take's end on its own SSE channel, so a picture that settles
 * outside a chat turn (Another, Try again) reaches the card without a poll
 * tick. Resolves `{ settled: true }` when the take ended (and calls
 * `onSettled`, once) and `{ settled: false }` when the channel could not open,
 * the browser closed it, or the caller aborted: it never throws, so the page's
 * poll stays the quiet fallback. The stream is always closed before it
 * resolves, and the session cookie rides along as it does on every same-origin
 * `fetch` (`EventSource` sends same-origin cookies by default).
 */
export function awaitImageTakeSettled(
	conversationId: string | null | undefined,
	takeId: string,
	options: {
		signal?: AbortSignal;
		onSettled?: () => void;
	} = {},
): Promise<{ settled: boolean }> {
	const signal = options.signal;
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ settled: false });
			return;
		}
		const Source = globalThis.EventSource;
		if (typeof Source !== "function") {
			resolve({ settled: false });
			return;
		}

		let source: EventSource | null = null;
		let done = false;
		const listeners: Array<[string, EventListener]> = [];

		const cleanup = (): void => {
			for (const [type, listener] of listeners) {
				source?.removeEventListener(type, listener);
			}
			listeners.length = 0;
			signal?.removeEventListener("abort", onAbort);
			source?.close();
			source = null;
		};

		const finish = (settled: boolean): void => {
			if (done) return;
			done = true;
			cleanup();
			if (settled) {
				try {
					options.onSettled?.();
				} catch {
					// The page's own hydration is its problem, never the wait's.
				}
			}
			resolve(settled ? { settled: true } : { settled: false });
		};

		const listen = (type: string, listener: EventListener): void => {
			listeners.push([type, listener]);
			source?.addEventListener(type, listener);
		};

		const onAbort = (): void => finish(false);

		try {
			source = new Source(actionUrl(`${take(takeId)}/events`, conversationId));
		} catch {
			resolve({ settled: false });
			return;
		}

		// The event's name is the signal; the payload only carries what the card
		// could show. A `close` or an error means the stream ended without a
		// verdict (the deadline, a restart, a lost connection).
		listen("settled", () => finish(true));
		listen("close", () => finish(false));
		listen("error", () => finish(false));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
