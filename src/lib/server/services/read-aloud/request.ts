// What the browser sends to start a reading, and what the server makes of it
// (Plan 2, Task 5). The shape is the "browser ↔ app contract" of the plan: the
// speech script's sentences, each word with its written form, its kind and the
// tokens it is spoken as. The schema bounds what the speech service would
// refuse anyway (400 characters a sentence, 2000 sentences), so a request that
// passes it is one the service takes.

import { z } from "zod";
import {
	MAX_SENTENCES_PER_SESSION,
	MAX_SHOWN_CHARS,
} from "$lib/shared/read-aloud/session-limits";
import type { SpeechSentence } from "./speech-client";
import type { ResolvedVoice, VoiceLanguage } from "./voices";

const MAX_TOKENS_PER_SENTENCE = 120;
const MAX_SENTENCE_CHARS = 400;

const wordSchema = z.object({
	shown: z.string().min(1).max(MAX_SHOWN_CHARS),
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

const sentencesSchema = z
	.array(sentenceSchema)
	.min(1)
	.max(MAX_SENTENCES_PER_SESSION)
	.refine(
		(sentences) =>
			new Set(sentences.map((sentence) => sentence.id)).size ===
			sentences.length,
		{ message: "a sentence id is used once" },
	);

const idSchema = z.string().min(1).max(100);

/**
 * A reading of a reply (its conversation and message); of a Document: its id,
 * the version the panel shows (the words are checked against that version's
 * text), and the chat the panel is in, which an incognito chat's own Document
 * needs to be reached at all (`ArtifactScopeOptions.conversationId`); or of a
 * standard report: the chat file the panel's preview shows, whose words are
 * checked against the report as the preview serves it to the same person.
 */
export const readingRequestSchema = z.union([
	z.object({
		conversationId: idSchema,
		messageId: idSchema,
		sentences: sentencesSchema,
	}),
	z.object({
		document: z.object({
			artifactId: idSchema,
			version: z.number().int().min(1).max(1_000_000_000),
		}),
		conversationId: idSchema.nullish(),
		sentences: sentencesSchema,
	}),
	z.object({
		report: z.object({ fileId: idSchema }),
		sentences: sentencesSchema,
	}),
]);

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
