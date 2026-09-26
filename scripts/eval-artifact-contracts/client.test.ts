import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEvalArtifactsClient } from "./client";

// A FAKE key, shaped like a real one, used only to prove it never leaks
// through the client's own surface. Never a real credential.
const FAKE_KEY = "sk-test-fake-not-a-real-key-000111222333";

describe("resolveEvalArtifactsClient", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// Ruling 54: the old `~/.config/opencode/opencode.json` fallback is gone.
	// A live run now REQUIRES both EVAL_ARTIFACTS_BASE_URL and
	// EVAL_ARTIFACTS_MODEL; there is nowhere else left to get them from.
	it("throws naming both required env vars when either is missing, rather than returning null or reading a config file", () => {
		const missingBoth = { baseUrl: null, model: null, apiKey: null };
		const missingBaseUrl = { baseUrl: null, model: "m", apiKey: null };
		const missingModel = {
			baseUrl: "http://127.0.0.1:8000/v1",
			model: null,
			apiKey: null,
		};

		for (const params of [missingBoth, missingBaseUrl, missingModel]) {
			expect(() => resolveEvalArtifactsClient(params)).toThrow(
				/EVAL_ARTIFACTS_BASE_URL/,
			);
			expect(() => resolveEvalArtifactsClient(params)).toThrow(
				/EVAL_ARTIFACTS_MODEL/,
			);
		}
	});

	it("points at the README's tunnel recipe in the failure message", () => {
		expect(() =>
			resolveEvalArtifactsClient({ baseUrl: null, model: null, apiKey: null }),
		).toThrow(/README/);
	});

	it("makes no network call when the endpoint is not configured", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		expect(() =>
			resolveEvalArtifactsClient({ baseUrl: null, model: null, apiKey: null }),
		).toThrow();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("builds a client from the explicit endpoint used as given, and it never carries the key on its own surface", () => {
		const client = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "qwen3-6-27b",
			apiKey: FAKE_KEY,
		});

		expect(client.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(client.model).toBe("qwen3-6-27b");
		// The whole point of client.ts's design: JSON.stringify-ing the client
		// itself (as a results writer or a debug log accidentally might) must
		// never expose the key, because it is not an enumerable property.
		expect(JSON.stringify(client)).not.toContain(FAKE_KEY);
		expect(Object.keys(client)).toEqual(
			expect.arrayContaining(["baseUrl", "model", "send"]),
		);
	});

	it("strips a trailing slash from the base URL", () => {
		const client = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1/",
			model: "m",
			apiKey: null,
		});

		expect(client.baseUrl).toBe("http://127.0.0.1:8000/v1");
	});

	it("sends an Authorization header when a key is configured, and none when it is not", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const withKey = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "m",
			apiKey: FAKE_KEY,
		});
		await withKey.send({ prompt: "hi", thinking: "off" });
		const withKeyHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(withKeyHeaders.Authorization).toBe(`Bearer ${FAKE_KEY}`);

		fetchMock.mockClear();
		const withoutKey = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "m",
			apiKey: null,
		});
		await withoutKey.send({ prompt: "hi", thinking: "off" });
		const withoutKeyHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(withoutKeyHeaders.Authorization).toBeUndefined();
	});

	it("sends chat_template_kwargs.enable_thinking=false only when thinking is off", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "m",
			apiKey: null,
		});

		await client.send({ prompt: "hi", thinking: "off" });
		const offBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(offBody.chat_template_kwargs).toEqual({ enable_thinking: false });

		fetchMock.mockClear();
		await client.send({ prompt: "hi", thinking: "on" });
		const onBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(onBody.chat_template_kwargs).toBeUndefined();
	});

	it("throws with the HTTP status attached on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("rate limited", { status: 429 })),
		);
		const client = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "m",
			apiKey: null,
		});

		await expect(
			client.send({ prompt: "hi", thinking: "off" }),
		).rejects.toMatchObject({
			status: 429,
		});
	});
});
