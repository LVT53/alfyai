import { describe, expect, it } from "vitest";
import { BUILT_IN_VOICES, defaultVoiceFor } from "./voices";

describe("built-in voices", () => {
	it("gives the English voices their ids and the Hungarian ones studio by default", () => {
		expect(defaultVoiceFor("en").speakerId).toBe("default_b78b28baf5c31a1d");
		expect(defaultVoiceFor("en").key).toBe("imogen");
		expect(defaultVoiceFor("hu").key).toBe("berta");
		expect(defaultVoiceFor("hu").controls).toEqual({ "room.clean": 2 });
		for (const voice of BUILT_IN_VOICES)
			expect(voice.speakerId).toMatch(/^default_[0-9a-f]{16}$/);
	});

	it("lists the six voices in order, each language with its own", () => {
		expect(BUILT_IN_VOICES.map((voice) => voice.key)).toEqual([
			"imogen",
			"rupert",
			"savannah",
			"wyatt",
			"berta",
			"imre",
		]);
		expect(
			BUILT_IN_VOICES.filter((voice) => voice.language === "en"),
		).toHaveLength(4);
		expect(
			BUILT_IN_VOICES.filter((voice) => voice.language === "hu"),
		).toHaveLength(2);
		expect(new Set(BUILT_IN_VOICES.map((voice) => voice.speakerId)).size).toBe(
			6,
		);
	});

	it("uses the ids of Plan 1's README for the Hungarian voices", () => {
		const ids = Object.fromEntries(
			BUILT_IN_VOICES.map((voice) => [voice.key, voice.speakerId]),
		);
		expect(ids.berta).toBe("default_bf7632822e6b4dc0");
		expect(ids.imre).toBe("default_fde02d0881bd267d");
	});

	it("gives every voice a speaking rate for the estimate", () => {
		for (const voice of BUILT_IN_VOICES) expect(voice.charsPerSecond).toBe(15);
	});
});
