// @vitest-environment node
// The preview service (Plan 3, Task 5) against the fake speech service: one
// call per sentence, joined with the 0.30 s gap, one preview per person.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MP3_FRAME_SECONDS } from "$lib/shared/read-aloud/silent-mp3";
import { STYLES } from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import { readMp3 } from "./mp3-join";
import { PreviewSuperseded, renderPreview } from "./preview";
import {
	previewSpeech,
	SpeechRefused,
	SpeechUnavailable,
} from "./speech-client";
import {
	createFakeSpeechService,
	type FakeSpeechService,
} from "./testing/fake-speech-service";
import { builtInVoice, defaultVoiceFor, resolvedVoice } from "./voices";

let fake: FakeSpeechService;

beforeEach(async () => {
	fake = await createFakeSpeechService();
});

afterEach(async () => {
	await fake.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2000) {
	for (let waited = 0; !condition(); waited += 10) {
		if (waited >= timeoutMs) throw new Error("timed out");
		await sleep(10);
	}
}

const imogen = () => resolvedVoice(defaultVoiceFor("en"));
const framesOf = (text: string, secondsPerChar = 0.02) =>
	Math.max(
		1,
		Math.ceil((Array.from(text).length * secondsPerChar) / MP3_FRAME_SECONDS),
	);
const round = (value: number) => Math.round(value * 1000) / 1000;

function input(userId: string, overrides: Record<string, unknown> = {}) {
	return {
		userId,
		baseUrl: fake.baseUrl,
		voice: imogen(),
		language: "en" as const,
		sentences: VOICE_SAMPLES.en,
		...overrides,
	};
}

describe("renderPreview", () => {
	it("renders the two sample sentences in one call each and joins them", async () => {
		const result = await renderPreview(input("user-a"));
		// One call for each sentence (they arrive together, in either order).
		expect(fake.previews.map((made) => made.text).sort()).toEqual(
			[...VOICE_SAMPLES.en].sort(),
		);
		const [first, second] = VOICE_SAMPLES.en.map((text) => framesOf(text));
		if (first === undefined || second === undefined)
			throw new Error("no samples");
		const gap = 12; // 0.30 s in whole frames
		expect(result.sentences).toEqual([
			[0, round(first * MP3_FRAME_SECONDS)],
			[
				round((first + gap) * MP3_FRAME_SECONDS),
				round((first + gap + second) * MP3_FRAME_SECONDS),
			],
		]);
		// The audio is one MP3 of exactly those frames.
		expect(readMp3(result.audio).seconds).toBeCloseTo(
			(first + gap + second) * MP3_FRAME_SECONDS,
			9,
		);
	});

	it("sends the base's speaker and the knobs' controls with every sentence", async () => {
		const berta = builtInVoice("berta");
		const bedtime = STYLES.find((style) => style.key === "bedtime");
		if (!berta || !bedtime) throw new Error("no berta or bedtime");
		await renderPreview(
			input("user-a", {
				voice: resolvedVoice(berta, bedtime.knobs),
				language: "hu",
				sentences: VOICE_SAMPLES.hu,
			}),
		);
		expect(fake.previews).toHaveLength(2);
		for (const made of fake.previews) {
			expect(made.language).toBe("hu");
			expect(made.voice).toEqual({
				speaker_id: "default_bf7632822e6b4dc0",
				controls: {
					"room.clean": 2,
					"delivery.tempo": -1,
					"texture.deep": 1,
					"mood.arousal": -2.5,
					"delivery.whisper": 0.6,
				},
			});
		}
	});

	it("renders one sentence of the person's own words", async () => {
		const result = await renderPreview(
			input("user-a", { sentences: ["Hello there."] }),
		);
		expect(fake.previews.map((made) => made.text)).toEqual(["Hello there."]);
		expect(result.sentences).toEqual([
			[0, round(framesOf("Hello there.") * MP3_FRAME_SECONDS)],
		]);
	});

	it("a later preview of the same person supersedes the earlier one", async () => {
		fake.setOptions({ previewDelayMs: 250 });
		const first = renderPreview(input("user-a"));
		const outcome = first.then(
			() => "played",
			(error: unknown) => error,
		);
		await until(() => fake.previews.length === 2);
		const second = renderPreview(
			input("user-a", { sentences: ["Hello again."] }),
		);
		expect(await outcome).toBeInstanceOf(PreviewSuperseded);
		// The first call's two requests were aborted upstream, and nothing of it plays.
		await until(() => fake.abortedPreviews.length === 2);
		expect(fake.abortedPreviews.map((made) => made.text).sort()).toEqual(
			[...VOICE_SAMPLES.en].sort(),
		);
		const result = await second;
		expect(result.sentences).toHaveLength(1);
		// The newer one is not harmed by the older one ending.
		expect(fake.abortedPreviews).toHaveLength(2);
	});

	it("a third preview supersedes the second, and only the last one plays", async () => {
		fake.setOptions({ previewDelayMs: 200 });
		const results = [1, 2, 3].map((n) =>
			renderPreview(input("user-a", { sentences: [`Take number ${n}.`] })).then(
				(value) => ({ n, value }),
				(error: unknown) => ({ n, error }),
			),
		);
		const settled = await Promise.all(results);
		const played = settled
			.filter((entry) => "value" in entry)
			.map((entry) => entry.n);
		const superseded = settled
			.filter(
				(entry) => "error" in entry && entry.error instanceof PreviewSuperseded,
			)
			.map((entry) => entry.n);
		expect(played).toEqual([3]);
		expect(superseded).toEqual([1, 2]);
	});

	it("two people's previews do not touch each other", async () => {
		fake.setOptions({ previewDelayMs: 100 });
		const [a, b] = await Promise.all([
			renderPreview(input("user-a")),
			renderPreview(input("user-b")),
		]);
		expect(a.sentences).toHaveLength(2);
		expect(b.sentences).toHaveLength(2);
		expect(fake.abortedPreviews).toEqual([]);
	});

	it("a finished preview is not superseded by the next one", async () => {
		await renderPreview(input("user-a"));
		const again = await renderPreview(input("user-a"));
		expect(again.sentences).toHaveLength(2);
		expect(fake.abortedPreviews).toEqual([]);
	});

	it("stops the other sentences when one fails", async () => {
		fake.setOptions({ previewDelayMs: 400 });
		// "★ …" has nothing speakable, so the service refuses it at once; the other waits.
		const failed = renderPreview(
			input("user-a", { sentences: ["Hello there.", "★ …"] }),
		);
		await expect(failed).rejects.toMatchObject({
			name: "SpeechRefused",
			status: 422,
			field: "text",
		});
		await until(() => fake.abortedPreviews.length === 1);
		expect(fake.abortedPreviews.map((made) => made.text)).toEqual([
			"Hello there.",
		]);
	});

	it("503 and 502 from the service are SpeechUnavailable, 422 is SpeechRefused with its field", async () => {
		fake.setOptions({ failPreview: "unavailable" });
		await expect(renderPreview(input("user-a"))).rejects.toBeInstanceOf(
			SpeechUnavailable,
		);
		fake.setOptions({ failPreview: "failed" });
		await expect(renderPreview(input("user-a"))).rejects.toBeInstanceOf(
			SpeechUnavailable,
		);
		fake.setOptions({});
		const refused = await renderPreview(
			input("user-a", { sentences: ["★"] }),
		).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SpeechRefused);
		expect(refused).toMatchObject({ status: 422, field: "text" });
		// A service nobody listens at.
		const url = fake.baseUrl;
		await fake.close();
		await expect(
			renderPreview(input("user-a", { baseUrl: url })),
		).rejects.toBeInstanceOf(SpeechUnavailable);
		fake = await createFakeSpeechService();
	});
});

describe("previewSpeech", () => {
	const body = (text: string) => ({
		text,
		language: "en" as const,
		voice: { speaker_id: "default_b78b28baf5c31a1d", controls: {} },
	});

	it("answers the clip's bytes", async () => {
		const bytes = await previewSpeech(fake.baseUrl, body("Hello there."));
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(readMp3(bytes).seconds).toBeGreaterThan(0);
	});

	it("is SpeechUnavailable when the service does not answer in time", async () => {
		fake.setOptions({ previewDelayMs: 600 });
		await expect(
			previewSpeech(fake.baseUrl, body("Hello there."), undefined, {
				timeoutMs: 80,
			}),
		).rejects.toBeInstanceOf(SpeechUnavailable);
	});

	it("rejects with the signal's reason when the caller aborts", async () => {
		fake.setOptions({ previewDelayMs: 600 });
		const controller = new AbortController();
		const reason = new Error("the person asked for another preview");
		const pending = previewSpeech(
			fake.baseUrl,
			body("Hello there."),
			controller.signal,
		);
		await until(() => fake.previews.length === 1);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		// And a signal that is aborted already never reaches the service.
		await expect(
			previewSpeech(fake.baseUrl, body("Never sent."), controller.signal),
		).rejects.toBe(reason);
		expect(fake.previews.map((made) => made.text)).toEqual(["Hello there."]);
	});

	it("refuses with the status and the field of any other answer, never a value", async () => {
		const refused = await previewSpeech(fake.baseUrl, {
			...body(""),
			text: "",
		}).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SpeechRefused);
		expect(refused).toMatchObject({ status: 422, field: "text" });
	});
});
