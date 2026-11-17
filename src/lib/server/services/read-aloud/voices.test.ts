import { describe, expect, it } from "vitest";
import { STYLES, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import {
	BUILT_IN_VOICES,
	builtInVoice,
	defaultVoiceFor,
	listBuiltInVoices,
	RETIRED_BUILT_IN_VOICES,
	resolvedVoice,
} from "./voices";

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

describe("finding and resolving a voice", () => {
	it("finds a built-in voice by key", () => {
		expect(builtInVoice("rupert")).toMatchObject({
			key: "rupert",
			language: "en",
			speakerId: "default_3765f0d1140c05c0",
		});
		expect(builtInVoice("berta")?.language).toBe("hu");
		expect(builtInVoice("nobody")).toBeNull();
		// A key is looked up, not read off an object: nothing is inherited.
		expect(builtInVoice("constructor")).toBeNull();
		expect(builtInVoice("__proto__")).toBeNull();
		expect(builtInVoice("")).toBeNull();
	});

	it("lists the built-in voices as a picker shows them, without their speaker ids", () => {
		expect(listBuiltInVoices()).toEqual([
			{ key: "imogen", name: "Imogen", language: "en" },
			{ key: "rupert", name: "Rupert", language: "en" },
			{ key: "savannah", name: "Savannah", language: "en" },
			{ key: "wyatt", name: "Wyatt", language: "en" },
			{ key: "berta", name: "Berta", language: "hu" },
			{ key: "imre", name: "Imre", language: "hu" },
		]);
	});

	it("has no retired voice today", () => {
		expect(RETIRED_BUILT_IN_VOICES).toEqual({});
	});

	it("resolves a built-in voice with its knobs on top of its own controls", () => {
		const berta = builtInVoice("berta");
		if (!berta) throw new Error("no berta");
		const bedtime = STYLES.find((style) => style.key === "bedtime");
		if (!bedtime) throw new Error("no bedtime");
		expect(resolvedVoice(berta, bedtime.knobs)).toEqual({
			speakerId: "default_bf7632822e6b4dc0",
			controls: {
				"room.clean": 2,
				"delivery.tempo": -1,
				"texture.deep": 1,
				"mood.arousal": -2.5,
				"delivery.whisper": 0.6,
			},
			charsPerSecond: 15,
		});
		// Without knobs it is the voice as it is.
		expect(resolvedVoice(berta).controls).toEqual({ "room.clean": 2 });
		const imogen = builtInVoice("imogen");
		if (!imogen) throw new Error("no imogen");
		expect(resolvedVoice(imogen, ZERO_KNOBS).controls).toEqual({});
	});

	it("does not hand out the built-in voice's own controls object", () => {
		const berta = builtInVoice("berta");
		if (!berta) throw new Error("no berta");
		const resolved = resolvedVoice(berta);
		resolved.controls["delivery.tempo"] = 9;
		expect(berta.controls).toEqual({ "room.clean": 2 });
		expect(resolvedVoice(berta).controls).toEqual({ "room.clean": 2 });
	});

	it("clamps a voice's knobs to the safe range of its own language", () => {
		const imre = builtInVoice("imre");
		if (!imre) throw new Error("no imre");
		const resolved = resolvedVoice(imre, { ...ZERO_KNOBS, pace: 99 });
		expect(resolved.controls["delivery.tempo"]).toBeLessThanOrEqual(2);
	});
});
