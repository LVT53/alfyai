import { type FetchLike, requestJson, requestVoid } from "./http";

/** The URL of a picture file. An incognito chat's pictures need the chat named. */
export function imageFileUrl(
	fileId: string,
	options: {
		variant?: "full" | "thumb";
		download?: boolean;
		conversationId?: string | null;
	} = {},
): string {
	const query = new URLSearchParams();
	if (options.variant === "thumb") query.set("variant", "thumb");
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
