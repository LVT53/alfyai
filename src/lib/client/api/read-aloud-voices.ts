import type { Knobs } from "$lib/shared/read-aloud/voice-knobs";
import {
	ApiError,
	type FetchLike,
	readErrorPayload,
	requestJson,
	requestResponse,
} from "./http";

/**
 * Read aloud's voice routes (`src/routes/api/read-aloud/voices/`, `preferences/`
 * and `preview/`), from the browser's side of Plan 3's contract. The Settings
 * card and the voice editor call the voice and preference routes; only the
 * voice preview (`src/lib/client/read-aloud/voice-preview.ts`) calls the preview.
 */

export type BuiltInVoiceInfo = {
	key: string;
	name: string;
	language: "en" | "hu";
};

export type PersonalVoiceInfo = {
	id: string;
	name: string;
	base: string;
	baseName: string;
	language: "en" | "hu";
	knobs: Knobs;
	baseMissing: boolean;
};

/** For each language, a built-in key or one of the person's voice ids. */
export type VoiceChoice = Record<"en" | "hu", string>;

export type ReadAloudVoiceSettings = {
	builtIn: BuiltInVoiceInfo[];
	voices: PersonalVoiceInfo[];
	choice: VoiceChoice;
	defaultSpeed: number;
};

export type VoiceDraftBody = { name: string; base: string; knobs: Knobs };

export type PreviewRequestBody = { base: string; knobs: Knobs; text?: string };

/** A rendered preview: the clip, and each sentence's start and end in seconds on its clock. */
export type PreviewRender = {
	blob: Blob;
	sentences: Array<[number, number]>;
};

const VOICES = "/api/read-aloud/voices";
const PREFERENCES = "/api/read-aloud/preferences";
const PREVIEW = "/api/read-aloud/preview";
const SENTENCES_HEADER = "X-Read-Aloud-Sentences";

const jsonBody = (body: unknown): RequestInit => ({
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

/**
 * The code of a route's refusal (`{"error": "too_many"}` arrives as the
 * `ApiError`'s message), or null for anything that is not a refusal.
 */
export function refusalCode(error: unknown): string | null {
	if (!(error instanceof ApiError)) return null;
	return error.code ?? error.message;
}

export function fetchReadAloudVoices(
	fetchImpl?: FetchLike,
): Promise<ReadAloudVoiceSettings> {
	return requestJson<ReadAloudVoiceSettings>(
		VOICES,
		{ method: "GET" },
		"Couldn't load your voices.",
		fetchImpl,
	);
}

export async function createReadAloudVoice(
	draft: VoiceDraftBody,
	fetchImpl?: FetchLike,
): Promise<PersonalVoiceInfo> {
	const { voice } = await requestJson<{ voice: PersonalVoiceInfo }>(
		VOICES,
		{ method: "POST", ...jsonBody(draft) },
		"Couldn't save this voice.",
		fetchImpl,
	);
	return voice;
}

export async function updateReadAloudVoice(
	id: string,
	patch: Partial<VoiceDraftBody>,
	fetchImpl?: FetchLike,
): Promise<PersonalVoiceInfo> {
	const { voice } = await requestJson<{ voice: PersonalVoiceInfo }>(
		`${VOICES}/${encodeURIComponent(id)}`,
		{ method: "PATCH", ...jsonBody(patch) },
		"Couldn't save this voice.",
		fetchImpl,
	);
	return voice;
}

/** Deletes one of the person's voices; the answer is the choice as it now stands. */
export async function deleteReadAloudVoice(
	id: string,
	fetchImpl?: FetchLike,
): Promise<VoiceChoice> {
	const { choice } = await requestJson<{ choice: VoiceChoice }>(
		`${VOICES}/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		"Couldn't delete this voice.",
		fetchImpl,
	);
	return choice;
}

export function saveReadAloudChoice(
	next: { en?: string; hu?: string; defaultSpeed?: number },
	fetchImpl?: FetchLike,
): Promise<{ choice: VoiceChoice; defaultSpeed: number }> {
	return requestJson<{ choice: VoiceChoice; defaultSpeed: number }>(
		PREFERENCES,
		{ method: "PUT", ...jsonBody(next) },
		"Couldn't save this setting.",
		fetchImpl,
	);
}

/** `[[start, end], …]` in seconds, or null when the header says anything else. */
function readSentenceTimes(
	header: string | null,
): Array<[number, number]> | null {
	if (header === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(header);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const times: Array<[number, number]> = [];
	for (const pair of parsed) {
		if (
			!Array.isArray(pair) ||
			pair.length !== 2 ||
			!pair.every(
				(value) => typeof value === "number" && Number.isFinite(value),
			)
		)
			return null;
		times.push([pair[0] as number, pair[1] as number]);
	}
	return times;
}

/**
 * Renders a preview: the clip as a blob, with each sentence's start and end from
 * `X-Read-Aloud-Sentences`. A refusal, or an answer without readable times, is an
 * `ApiError`, as the other calls throw.
 */
export async function renderVoicePreview(
	body: PreviewRequestBody,
	signal?: AbortSignal,
	fetchImpl?: FetchLike,
): Promise<PreviewRender> {
	const response = await requestResponse(
		PREVIEW,
		{ method: "POST", ...jsonBody(body), signal },
		fetchImpl,
	);
	if (!response.ok) {
		const refusal = await readErrorPayload(
			response,
			"Couldn't play the sample.",
		);
		throw new ApiError(refusal.message, {
			code: refusal.code,
			reason: refusal.reason,
			serverUnavailable: refusal.serverUnavailable,
			errorKey: refusal.errorKey,
			status: response.status,
		});
	}
	const sentences = readSentenceTimes(response.headers.get(SENTENCES_HEADER));
	if (!sentences)
		throw new ApiError("Couldn't play the sample.", {
			code: "invalid_preview",
			status: response.status,
		});
	return { blob: await response.blob(), sentences };
}
