// The voice preview (Plan 3, Task 5; spec §4.6): a sample, or the person's own
// words, spoken in a voice with some knobs, and heard in the editor. The
// speech service's preview answers one sentence as one whole clip with no
// times, so a preview of several sentences is one call each, all at once, and
// the clips are joined with Plan 1's gap between sentences. The editor's
// scrubber gets exact notches that way.
//
// A person has one preview at a time: a newer preview of the same person ends
// the older one, whose calls are aborted upstream (it would only waste a Zonos
// slot, which previews share with readings) and which rejects with
// `PreviewSuperseded`. Nothing is cached or kept, and nothing about the words
// is logged.

import { joinMp3, readMp3 } from "./mp3-join";
import { previewSpeech } from "./speech-client";
import type { ResolvedVoice, VoiceLanguage } from "./voices";

/**
 * The silence between a preview's sentences: the speech service's gap between sentences
 * (`SPEECH_GAP_SECONDS`, 0.45 s), kept equal to it by hand, so the editor's Listen sounds as a
 * reading does.
 */
const PREVIEW_GAP_SECONDS = 0.45;

/** A newer preview of the same person began before this one ended. */
export class PreviewSuperseded extends Error {
	override name = "PreviewSuperseded";

	constructor() {
		super("a later preview has begun");
	}
}

type Running = { controller: AbortController; superseded: boolean };

/** The preview each person has in the making: at most one. */
const running = new Map<string, Running>();

/**
 * The joined clip of `sentences` spoken in `voice`, and where each sentence
 * starts and ends in it (seconds, to the millisecond). Rejects with
 * `PreviewSuperseded` when the same person's newer preview took over,
 * `SpeechUnavailable` or `SpeechRefused` as `previewSpeech` does, and
 * `Mp3Unreadable` for a clip that is not what the service writes.
 */
export async function renderPreview(input: {
	userId: string;
	baseUrl: string;
	voice: ResolvedVoice;
	language: VoiceLanguage;
	sentences: readonly string[];
}): Promise<{
	audio: Uint8Array<ArrayBuffer>;
	sentences: Array<[number, number]>;
}> {
	const mine: Running = {
		controller: new AbortController(),
		superseded: false,
	};
	const older = running.get(input.userId);
	if (older) {
		older.superseded = true;
		older.controller.abort();
	}
	running.set(input.userId, mine);
	try {
		const clips = await Promise.all(
			input.sentences.map((text) =>
				previewSpeech(
					input.baseUrl,
					{
						text,
						language: input.language,
						voice: {
							speaker_id: input.voice.speakerId,
							controls: { ...input.voice.controls },
						},
					},
					mine.controller.signal,
				),
			),
		);
		if (mine.superseded) throw new PreviewSuperseded();
		for (const clip of clips) readMp3(clip);
		return joinMp3(clips, PREVIEW_GAP_SECONDS);
	} catch (error) {
		// Calls that a newer preview aborted fail with an abort: that is no
		// failure of the service, whatever they report.
		if (mine.superseded) throw new PreviewSuperseded();
		throw error;
	} finally {
		// Whatever is still running (the other sentences of a call that failed)
		// stops with this preview.
		mine.controller.abort();
		if (running.get(input.userId) === mine) running.delete(input.userId);
	}
}
