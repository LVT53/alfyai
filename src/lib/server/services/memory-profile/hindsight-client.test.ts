import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HINDSIGHT_ENGINE_COMMIT } from "./contracts";
import { HindsightClient, NativeMemoryError } from "./hindsight-client";
import { splitNativeNotes } from "./presentation";

describe("native memory boundary", () => {
	it("checks native build and actual tenant identity before provisioning", async () => {
		const tenantId = "a3f54a51-679f-4211-9920-519ec8cb821d";
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					engine_commit: HINDSIGHT_ENGINE_COMMIT,
					extension: "alfyai-identity-v1",
					tenant_extension: "StaticKeysTenantExtension",
					tenant_binding: createHash("sha256")
						.update(`alfyai_t_${tenantId.replaceAll("-", "_")}`)
						.digest("hex"),
				}),
			),
		);
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			tenantId,
			fetcher,
		});
		await expect(client.verifyCapabilities()).resolves.toBeUndefined();
		expect(fetcher.mock.calls[0][0]).toBe(
			"http://native/ext/alfyai/capabilities",
		);
		fetcher.mockResolvedValue(
			new Response(
				JSON.stringify({
					engine_commit: "different",
					extension: "alfyai-identity-v1",
				}),
			),
		);
		await expect(client.verifyCapabilities()).rejects.toMatchObject({
			code: "native_capability_mismatch",
		});
	});
	it("decodes the actual native recall type field", async () => {
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [{ id: "o", text: "Green", type: "observation" }],
					}),
				),
			),
		});
		expect(await client.recall("kayak", 100)).toEqual([
			{ id: "o", text: "Green", fact_type: "observation" },
		]);
	});
	it("requests ranked support IDs without accepting native raw expansions", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							id: "o",
							type: "observation",
							text: "Native wording",
							source_fact_ids: ["f"],
						},
					],
					source_facts: { f: { id: "f", text: "Native raw must stay out" } },
				}),
			),
		);
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher,
		});
		expect(await client.recall("kayak", 100)).toEqual([
			{
				id: "o",
				text: "Native wording",
				fact_type: "observation",
				source_memory_ids: ["f"],
			},
		]);
		expect(JSON.parse(fetcher.mock.calls[0][1].body).include).toEqual({
			entities: null,
			chunks: null,
			source_facts: { max_tokens: 0, max_tokens_per_observation: 0 },
		});
	});
	it("uses durable application operation identity and rejects a changed acknowledgement", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ operation_id: "other" })),
			);
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher,
		});
		await expect(
			client.retain(
				{
					content: "x",
					context: "",
					timestamp: "2026-11-18T00:00:00Z",
					document_id: "d",
					tags: [],
					metadata: {},
				},
				"stable",
			),
		).rejects.toMatchObject({ code: "native_format_unsupported" });
		expect(JSON.parse(fetcher.mock.calls[0][1].body).operation_id).toBe(
			"stable",
		);
	});
	it("rejects duplicate and incomplete native pages", async () => {
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						total: 2,
						offset: 0,
						items: [
							{ id: "f", text: "x", fact_type: "world" },
							{ id: "f", text: "x", fact_type: "world" },
						],
					}),
				),
			),
		});
		await expect(client.list()).rejects.toMatchObject({
			code: "native_capture_unstable",
		});
	});
	it("binds requests to one server supplied bank and credential", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ items: [], total: 0, offset: 0 })),
			);
		const client = new HindsightClient({
			baseUrl: "http://localhost:8888",
			apiKey: "private",
			bankId: "bank/a",
			fetcher,
		});
		await client.list();
		expect(fetcher.mock.calls[0][0]).toContain("/banks/bank%2Fa/memories/list");
		expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
			"Bearer private",
		);
	});
	it("does not reveal remote error bodies or keys", async () => {
		const client = new HindsightClient({
			baseUrl: "http://localhost",
			apiKey: "private",
			bankId: "b",
			fetcher: vi
				.fn()
				.mockResolvedValue(new Response("secret-content", { status: 503 })),
		});
		await expect(client.list()).rejects.toMatchObject({
			code: "native_unavailable",
			retryable: true,
		});
		await expect(client.list()).rejects.not.toThrow("secret-content");
	});
	it("rejects malformed observations instead of publishing them", async () => {
		const client = new HindsightClient({
			baseUrl: "http://localhost",
			apiKey: "key",
			bankId: "b",
			fetcher: vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ items: [{ id: 5, text: "x" }] })),
				),
		});
		await expect(client.list()).rejects.toBeInstanceOf(NativeMemoryError);
	});
	it("only separates exact source verified suffixes", () => {
		const source = {
			id: "f",
			text: "The kayak is green | more",
			fact_type: "world",
			mentioned_at: "2026-11-18T12:30:00Z",
		};
		expect(
			splitNativeNotes(
				{
					id: "o",
					text: "Green (2026-11-18 12:30: The kayak is green)",
					source_memory_ids: ["f"],
					fact_type: "observation",
				},
				[source],
			),
		).toBe("Green");
		expect(
			splitNativeNotes(
				{
					id: "o",
					text: "Green (formerly purple)",
					source_memory_ids: ["f"],
					fact_type: "observation",
				},
				[source],
			),
		).toBe("Green (formerly purple)");
	});
});

it("verifies bank absence via supported authenticated config GET, never root GET", async () => {
	const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "GET" && String(url).endsWith("/config"))
			return new Response("missing", { status: 404 });
		return new Response("method not allowed", { status: 405 });
	});
	const client = new HindsightClient({
		baseUrl: "http://native",
		apiKey: "key",
		bankId: "b",
		fetcher,
	});
	expect(await client.bankExists()).toBe(false);
	expect(String(fetcher.mock.calls[0][0])).toBe(
		"http://native/v1/default/banks/b/config",
	);
});
