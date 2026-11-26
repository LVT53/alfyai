// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import {
	createReadAloudVoice,
	deleteReadAloudVoice,
	fetchReadAloudVoices,
	refusalCode,
	renderVoicePreview,
	saveReadAloudChoice,
	updateReadAloudVoice,
} from "./read-aloud-voices";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const knobs = { pace: -1, pitch: 0, depth: 1, energy: -2.5, projection: -0.6 };
const voice = {
	id: "v1",
	name: "Test Voice",
	base: "imogen",
	baseName: "Imogen",
	language: "en" as const,
	knobs,
	baseMissing: false,
};
const settings = {
	builtIn: [{ key: "imogen", name: "Imogen", language: "en" as const }],
	voices: [voice],
	choice: { en: "imogen", hu: "berta" },
	defaultSpeed: 1,
};

describe("the voices API client", () => {
	it("each call sends its method, address and body", async () => {
		const calls: Array<{ url: string; method: string; body: unknown }> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({
					url: String(input),
					method,
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				if (method === "GET") return json(settings);
				if (method === "POST") return json({ voice }, 201);
				if (method === "PATCH")
					return json({ voice: { ...voice, name: "Renamed" } });
				if (method === "DELETE")
					return json({ choice: { en: "imogen", hu: "berta" } });
				return json({
					choice: { en: "rupert", hu: "berta" },
					defaultSpeed: 1.5,
				});
			},
		);
		await expect(fetchReadAloudVoices(fetchImpl)).resolves.toEqual(settings);
		await expect(
			createReadAloudVoice(
				{ name: "Test Voice", base: "imogen", knobs },
				fetchImpl,
			),
		).resolves.toEqual(voice);
		await expect(
			updateReadAloudVoice("v 1", { name: "Renamed" }, fetchImpl),
		).resolves.toMatchObject({ name: "Renamed" });
		await expect(deleteReadAloudVoice("v1", fetchImpl)).resolves.toEqual({
			en: "imogen",
			hu: "berta",
		});
		await expect(
			saveReadAloudChoice({ en: "rupert", defaultSpeed: 1.5 }, fetchImpl),
		).resolves.toEqual({
			choice: { en: "rupert", hu: "berta" },
			defaultSpeed: 1.5,
		});
		expect(calls).toEqual([
			{ url: "/api/read-aloud/voices", method: "GET", body: undefined },
			{
				url: "/api/read-aloud/voices",
				method: "POST",
				body: { name: "Test Voice", base: "imogen", knobs },
			},
			{
				url: "/api/read-aloud/voices/v%201",
				method: "PATCH",
				body: { name: "Renamed" },
			},
			{ url: "/api/read-aloud/voices/v1", method: "DELETE", body: undefined },
			{
				url: "/api/read-aloud/preferences",
				method: "PUT",
				body: { en: "rupert", defaultSpeed: 1.5 },
			},
		]);
	});

	it("renderVoicePreview reads the sentences' times from the header and gives the audio as a blob", async () => {
		const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(audio, {
					status: 200,
					headers: {
						"Content-Type": "audio/mpeg",
						"X-Read-Aloud-Sentences": "[[0,1.234],[1.534,2.5]]",
					},
				}),
		);
		const controller = new AbortController();
		const render = await renderVoicePreview(
			{ base: "imogen", knobs, text: "Hello there." },
			controller.signal,
			fetchImpl,
		);
		expect(render.sentences).toEqual([
			[0, 1.234],
			[1.534, 2.5],
		]);
		expect(render.blob.type).toBe("audio/mpeg");
		expect(new Uint8Array(await render.blob.arrayBuffer())).toEqual(audio);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("/api/read-aloud/preview");
		expect(init?.method).toBe("POST");
		expect(init?.signal).toBe(controller.signal);
		expect(JSON.parse(String(init?.body))).toEqual({
			base: "imogen",
			knobs,
			text: "Hello there.",
		});
	});

	it("a refusal is an ApiError with its code", async () => {
		for (const [status, code] of [
			[409, "too_many"],
			[503, "voice_unavailable"],
		] as const) {
			const fetchImpl = vi.fn(async () => json({ error: code }, status));
			const saving = await createReadAloudVoice(
				{ name: "Test Voice", base: "imogen", knobs },
				fetchImpl,
			).catch((error: unknown) => error);
			expect(saving).toBeInstanceOf(ApiError);
			expect((saving as ApiError).status).toBe(status);
			expect(refusalCode(saving)).toBe(code);
			const rendering = await renderVoicePreview(
				{ base: "imogen", knobs },
				undefined,
				fetchImpl,
			).catch((error: unknown) => error);
			expect(rendering).toBeInstanceOf(ApiError);
			expect((rendering as ApiError).status).toBe(status);
			expect(refusalCode(rendering)).toBe(code);
		}
		expect(refusalCode(new Error("network"))).toBeNull();
	});

	it("a preview answer without a readable header is refused", async () => {
		for (const header of [
			null,
			"nonsense",
			"{}",
			"[[0,1],[2]]",
			'[["a","b"]]',
			"[[0,null]]",
		]) {
			const fetchImpl = vi.fn(
				async () =>
					new Response(new Uint8Array([1]), {
						status: 200,
						headers:
							header === null
								? { "Content-Type": "audio/mpeg" }
								: {
										"Content-Type": "audio/mpeg",
										"X-Read-Aloud-Sentences": header,
									},
					}),
			);
			await expect(
				renderVoicePreview({ base: "imogen", knobs }, undefined, fetchImpl),
				String(header),
			).rejects.toBeInstanceOf(ApiError);
		}
	});
});
