import type { WordKind } from "$lib/shared/read-aloud/spoken-forms";
import { type FetchLike, requestJson, requestVoid } from "./http";

/**
 * Read aloud's session routes (`src/routes/api/read-aloud/sessions/`). Only the
 * reading controller (`src/lib/client/read-aloud/controller.ts`) calls them.
 */

export type ReadingStart = {
	sessionId: string;
	defaultSpeed: number;
	charsPerSecond: Record<"en" | "hu", number>;
};

type RequestSentence = {
	id: string;
	language: "en" | "hu";
	paragraphStart: boolean;
	words: Array<{ shown: string; kind: WordKind; tokens: string[] }>;
};

/**
 * A reading of a reply; of a Document (its id, the version the panel shows and the panel's
 * chat); or of a standard report (its chat file).
 */
export type ReadingRequestBody =
	| {
			conversationId: string;
			messageId: string;
			sentences: RequestSentence[];
	  }
	| {
			document: { artifactId: string; version: number };
			conversationId: string | null;
			sentences: RequestSentence[];
	  }
	| {
			/** A standard report: the chat file the panel's preview shows. */
			report: { fileId: string };
			sentences: RequestSentence[];
	  };

const SESSIONS = "/api/read-aloud/sessions";
const session = (id: string) => `${SESSIONS}/${encodeURIComponent(id)}`;

/** Opens a reading of the sentences: 201 with the session, or the route's refusal as an `ApiError`. */
export function createReadingSession(
	body: ReadingRequestBody,
	fetchImpl?: FetchLike,
): Promise<ReadingStart> {
	return requestJson<ReadingStart>(
		SESSIONS,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		"Couldn't start reading.",
		fetchImpl,
	);
}

/** Ends a reading. `keepalive`, so it goes out even as the page closes; whatever it answers is ignored. */
export function cancelReadingSession(id: string, fetchImpl?: FetchLike): void {
	void requestVoid(
		session(id),
		{ method: "DELETE", keepalive: true },
		"Couldn't stop reading.",
		fetchImpl,
	).catch(() => {});
}

/** Tells the service which sentence is playing, so it makes the next ones; a failure is ignored. */
export function reportReadingPosition(
	id: string,
	sentenceId: string,
	fetchImpl?: FetchLike,
): void {
	void requestVoid(
		`${session(id)}/position`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sentenceId }),
		},
		"Couldn't report the reading's position.",
		fetchImpl,
	).catch(() => {});
}

export function readingAudioUrl(id: string): string {
	return `${session(id)}/audio`;
}

export function readingEventsUrl(id: string): string {
	return `${session(id)}/events`;
}
