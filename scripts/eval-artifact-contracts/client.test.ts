import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOpencodeConfig, resolveEvalArtifactsClient } from "./client";

// This machine's OWN ~/.config/opencode/opencode.json may well exist (it is
// a real dev tool config, not a fixture), so every test here that means to
// exercise "nothing configured" points opencodeConfigPath at a path that
// provably does not exist, rather than depending on whether the machine
// running the suite happens to have opencode installed.
const MISSING_OPENCODE_CONFIG_PATH =
	"/nonexistent/opencode-config-for-tests.json";

// A FAKE key, shaped like a real one, used only to prove it never leaks
// through the client's own surface. Never a real credential.
const FAKE_KEY = "sk-test-fake-not-a-real-key-000111222333";

describe("parseOpencodeConfig", () => {
	it("reads the first provider's baseURL, first model, and apiKey", () => {
		const resolved = parseOpencodeConfig(
			JSON.stringify({
				provider: {
					alfyai: {
						options: {
							baseURL: "https://inference.example.com/v1",
							apiKey: FAKE_KEY,
						},
						models: { "qwen3-6-27b": { name: "Qwen" } },
					},
				},
			}),
		);

		expect(resolved).toEqual({
			baseUrl: "https://inference.example.com/v1",
			model: "qwen3-6-27b",
			apiKey: FAKE_KEY,
		});
	});

	it("returns null for invalid JSON rather than throwing", () => {
		expect(parseOpencodeConfig("{not json")).toBeNull();
	});

	it("returns null when no provider has both a baseURL and a model", () => {
		expect(parseOpencodeConfig(JSON.stringify({ provider: {} }))).toBeNull();
		expect(
			parseOpencodeConfig(
				JSON.stringify({
					provider: { x: { options: { baseURL: "http://x" } } },
				}),
			),
		).toBeNull();
	});

	it("resolves a null apiKey when the provider has none (a local server needing no auth)", () => {
		const resolved = parseOpencodeConfig(
			JSON.stringify({
				provider: {
					local: {
						options: { baseURL: "http://127.0.0.1:8000/v1" },
						models: { "local-model": {} },
					},
				},
			}),
		);

		expect(resolved?.apiKey).toBeNull();
	});
});

describe("resolveEvalArtifactsClient", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns null when nothing is configured and the opencode fallback file is missing", () => {
		const client = resolveEvalArtifactsClient({
			baseUrl: null,
			model: null,
			apiKey: null,
			opencodeConfigPath: MISSING_OPENCODE_CONFIG_PATH,
		});
		expect(client).toBeNull();
	});

	it("falls back to a real opencode.json-shaped file when no explicit config is given", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "eval-artifacts-client-test-"));
		const fixturePath = join(dir, "opencode.json");
		writeFileSync(
			fixturePath,
			JSON.stringify({
				provider: {
					alfyai: {
						options: { baseURL: "http://127.0.0.1:9000/v1", apiKey: FAKE_KEY },
						models: { "local-model": {} },
					},
				},
			}),
		);

		try {
			const client = resolveEvalArtifactsClient({
				baseUrl: null,
				model: null,
				apiKey: null,
				opencodeConfigPath: fixturePath,
			});

			expect(client?.baseUrl).toBe("http://127.0.0.1:9000/v1");
			expect(client?.model).toBe("local-model");
			expect(JSON.stringify(client)).not.toContain(FAKE_KEY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds a client from explicit config, and it never carries the key on its own surface", () => {
		const client = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "qwen3-6-27b",
			apiKey: FAKE_KEY,
		});

		expect(client).not.toBeNull();
		expect(client?.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(client?.model).toBe("qwen3-6-27b");
		// The whole point of client.ts's design: JSON.stringify-ing the client
		// itself (as a results writer or a debug log accidentally might) must
		// never expose the key, because it is not an enumerable property.
		expect(JSON.stringify(client)).not.toContain(FAKE_KEY);
		expect(Object.keys(client ?? {})).toEqual(
			expect.arrayContaining(["baseUrl", "model", "send"]),
		);
	});

	it("strips a trailing slash from the base URL", () => {
		const client = resolveEvalArtifactsClient({
			baseUrl: "http://127.0.0.1:8000/v1/",
			model: "m",
			apiKey: null,
		});

		expect(client?.baseUrl).toBe("http://127.0.0.1:8000/v1");
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
		await withKey?.send({ prompt: "hi", thinking: "off" });
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
		await withoutKey?.send({ prompt: "hi", thinking: "off" });
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

		await client?.send({ prompt: "hi", thinking: "off" });
		const offBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(offBody.chat_template_kwargs).toEqual({ enable_thinking: false });

		fetchMock.mockClear();
		await client?.send({ prompt: "hi", thinking: "on" });
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
			client?.send({ prompt: "hi", thinking: "off" }),
		).rejects.toMatchObject({
			status: 429,
		});
	});
});
