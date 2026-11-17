// What the browser sends to start a reading, and what the server makes of it
// (Plan 2, Task 5). The shape is the "browser ↔ app contract" of the plan: the
// speech script's sentences, each word with its written form, its kind and the
// tokens it is spoken as. The schema bounds what the speech service would
// refuse anyway (400 characters a sentence, 2000 sentences), so a request that
// passes it is one the service takes.

import { z } from "zod";
import { MAX_SENTENCES_PER_SESSION } from "$lib/shared/read-aloud/session-limits";
import type { SpeechSentence } from "./speech-client";
import type { ResolvedVoice, VoiceLanguage } from "./voices";

const MAX_TOKENS_PER_SENTENCE = 120;
const MAX_SENTENCE_CHARS = 400;

const wordSchema = z.object({
	shown: z.string().min(1).max(2048),
	kind: z.enum(["prose", "code", "shell", "listNumber", "math"]),
	tokens: z.array(z.string().min(1).max(80).regex(/^\S+$/u)).min(1).max(40),
});

const sentenceSchema = z
	.object({
		id: z.string().regex(/^s\d{1,5}$/u),
		language: z.enum(["en", "hu"]),
		paragraphStart: z.boolean(),
		words: z.array(wordSchema).min(1).max(200),
	})
	.refine(
		(sentence) => {
			const tokens = sentence.words.flatMap((word) => word.tokens);
			return (
				tokens.length <= MAX_TOKENS_PER_SENTENCE &&
				tokens.join(" ").length <= MAX_SENTENCE_CHARS
			);
		},
		{
			message: "a sentence is at most 120 tokens and 400 characters",
			path: ["words"],
		},
	);

export const readingRequestSchema = z
	.object({
		conversationId: z.string().min(1).max(100),
		messageId: z.string().min(1).max(100),
		sentences: z.array(sentenceSchema).min(1).max(MAX_SENTENCES_PER_SESSION),
	})
	.refine(
		(request) =>
			new Set(request.sentences.map((sentence) => sentence.id)).size ===
			request.sentences.length,
		{ message: "a sentence id is used once", path: ["sentences"] },
	);

export type ReadingRequest = z.infer<typeof readingRequestSchema>;

/** The sentence the person's playback is in. */
export const positionRequestSchema = z.object({
	sentenceId: z.string().regex(/^s\d{1,5}$/u),
});

/**
 * The request as the speech service takes it: each sentence in the voice the
 * person reads its language with (`resolveReadingVoices`), its words' tokens in
 * one list. Every sentence gets a controls object of its own.
 */
export function speechSentencesFor(
	request: ReadingRequest,
	voices: Record<VoiceLanguage, ResolvedVoice>,
): SpeechSentence[] {
	return request.sentences.map((sentence) => {
		const voice = voices[sentence.language];
		return {
			id: sentence.id,
			language: sentence.language,
			voice: { speaker_id: voice.speakerId, controls: { ...voice.controls } },
			tokens: sentence.words.flatMap((word) => word.tokens),
			paragraph_start: sentence.paragraphStart,
		};
	});
}

/** The speaking rate of the voice each language reads with, for the browser's estimate of a reading's length. */
export function charsPerSecondByLanguage(
	voices: Record<VoiceLanguage, ResolvedVoice>,
): { en: number; hu: number } {
	return { en: voices.en.charsPerSecond, hu: voices.hu.charsPerSecond };
}
