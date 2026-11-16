// HTTP calls to the speech service, as `deploy/speech-service/README.md` states
// the contract (Plan 2, Task 4). The address comes from `getReadAloudUrl()`
// (config-store): this module never reads configuration, and nothing a model
// writes becomes an address (ADR-0068).
//
// Two things in the README shape it:
//   - a session has ONE reader of each stream for its whole life, and a second
//     GET is 409: the registry opens each stream once and never again;
//   - neither stream sends a keepalive, and both stay silent while playback is
//     paused, so a stream must have no idle or body timeout. Undici's `fetch`
//     gives up on a body that has been silent for 300 s, so the streams are read
//     with `node:http` by default (no timeout, and no dependency on whichever
//     undici this Node ships). The short calls use `fetch` with a time limit.
//
// No reply text is logged here: errors carry a status and a field path only.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { VoiceLanguage } from "./voices";

export type SpeechSentence = {
	id: string;
	language: VoiceLanguage;
	voice: { speaker_id: string; controls: Record<string, number> };
	tokens: string[];
	paragraph_start: boolean;
};

/** The service cannot be reached, or answered with a server error. */
export class SpeechUnavailable extends Error {
	override name = "SpeechUnavailable";
}

/** The service answered, and refused the call (a 422 would mean our schema let through something it refuses). */
export class SpeechRefused extends Error {
	override name = "SpeechRefused";

	constructor(
		readonly status: number,
		/** The path of the field a 422 names: never a value. */
		readonly field: string | null,
	) {
		super(`the speech service answered ${status}`);
	}
}

/** How long the short calls may take. The two streams have no limit. */
const SHORT_CALL_TIMEOUT_MS = 10_000;
const SESSION_ID = /^[0-9a-f]{32}$/u;
const JSON_HEADERS = { "content-type": "application/json" };

async function fieldOf(response: Response): Promise<string | null> {
	try {
		const body: unknown = await response.json();
		const field = (body as { field?: unknown } | null)?.field;
		return typeof field === "string" ? field : null;
	} catch {
		return null;
	}
}

/** A session of these sentences; the service starts speaking at once. */
export async function createSpeechSession(
	baseUrl: string,
	sentences: SpeechSentence[],
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ sentences }),
			signal: AbortSignal.timeout(SHORT_CALL_TIMEOUT_MS),
		});
	} catch {
		throw new SpeechUnavailable("the speech service did not answer");
	}
	if (response.status >= 500) {
		await response.body?.cancel().catch(() => undefined);
		throw new SpeechUnavailable(
			`the speech service answered ${response.status}`,
		);
	}
	if (response.status !== 201) {
		throw new SpeechRefused(response.status, await fieldOf(response));
	}
	let id: unknown;
	try {
		id = ((await response.json()) as { session_id?: unknown }).session_id;
	} catch {
		id = null;
	}
	if (typeof id !== "string" || !SESSION_ID.test(id)) {
		throw new SpeechUnavailable("the speech service sent no session id");
	}
	return id;
}

/** One GET with no timeout of any kind: the body may stay silent for as long as playback is paused. */
function getStream(
	url: string,
	signal: AbortSignal,
): Promise<{ status: number; body: ReadableStream<Uint8Array> }> {
	return new Promise((resolve, reject) => {
		const client = url.startsWith("https:") ? https : http;
		const request = client.get(url, { signal }, (response) => {
			resolve({
				status: response.statusCode ?? 0,
				body: Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
			});
		});
		request.on("error", reject);
	});
}

/**
 * One of a session's two streams, opened once. `signal` ends it. A stream that
 * breaks later errors the returned stream; it is never reopened.
 */
export async function openSpeechStream(
	baseUrl: string,
	sessionId: string,
	kind: "audio" | "events",
	signal: AbortSignal,
	fetchImpl?: typeof fetch,
): Promise<ReadableStream<Uint8Array>> {
	const url = `${baseUrl}/v1/sessions/${sessionId}/${kind}`;
	let status: number;
	let body: ReadableStream<Uint8Array> | null;
	try {
		if (fetchImpl) {
			const response = await fetchImpl(url, { signal });
			status = response.status;
			body = response.body;
		} else {
			({ status, body } = await getStream(url, signal));
		}
	} catch {
		throw new SpeechUnavailable("the speech service did not answer");
	}
	if (status !== 200 || !body) {
		await body?.cancel().catch(() => undefined);
		if (status >= 500 || status === 0)
			throw new SpeechUnavailable(`the speech service answered ${status}`);
		throw new SpeechRefused(status, null);
	}
	return body;
}

/** The sentence now playing, reported from playback time. Never throws: a lost report only holds the next sentences back a moment. */
export async function postSpeechPosition(
	baseUrl: string,
	sessionId: string,
	sentenceId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	try {
		const response = await fetchImpl(
			`${baseUrl}/v1/sessions/${sessionId}/position`,
			{
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({ sentence_id: sentenceId }),
				signal: AbortSignal.timeout(SHORT_CALL_TIMEOUT_MS),
			},
		);
		await response.body?.cancel();
	} catch {
		// The next report goes on.
	}
}

/** A cancel: it drops the audio nobody has read. A 404 means the session is over already. Never throws. */
export async function deleteSpeechSession(
	baseUrl: string,
	sessionId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	try {
		const response = await fetchImpl(`${baseUrl}/v1/sessions/${sessionId}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(SHORT_CALL_TIMEOUT_MS),
		});
		await response.body?.cancel();
	} catch {
		// The service ends a session nobody reads by itself, after its idle time.
	}
}
