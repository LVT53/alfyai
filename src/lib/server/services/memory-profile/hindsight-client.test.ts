import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as configStore from "$lib/server/config-store";
import { HINDSIGHT_ENGINE_COMMIT, NATIVE_BANK_CONFIG } from "./contracts";
import { HindsightClient, NativeMemoryError } from "./hindsight-client";
import { splitNativeNotes } from "./presentation";

describe("native extraction preview", () => {
	const baseUrl = "http://127.0.0.1:8888";
	const bankPath = `${baseUrl}/v1/default/banks/staged-bank`;
	const tenantId = "a3f54a51-679f-4211-9920-519ec8cb821d";
	const source = {
		content: "I prefer a wool blanket.",
		timestamp: "2026-11-19T15:00:00.000Z",
	};
	const result = {
		facts: [
			{
				text: "The user prefers a wool blanket.",
				fact_type: "world",
				chunk_index: 0,
				attachments: [],
			},
		],
		chunks: [{ text: source.content, fact_count: 1 }],
		usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
	};
	function preview(output: unknown = result, enabled = true) {
		const config = vi.spyOn(configStore, "getConfig").mockReturnValue({
			...configStore.getConfig(),
			hindsightQuarantineEnabled: enabled,
		});
		const fetcher = vi.fn<typeof fetch>(async (url) => {
			if (String(url).endsWith("/capabilities")) {
				return Response.json({
					engine_commit: HINDSIGHT_ENGINE_COMMIT,
					extension: "alfyai-identity-v1",
					tenant_extension: "AlfyTenant",
					tenant_binding: createHash("sha256")
						.update(`alfyai_t_${tenantId.replaceAll("-", "_")}`)
						.digest("hex"),
				});
			}
			if (String(url).endsWith("/config"))
				return Response.json({ config: NATIVE_BANK_CONFIG });
			return Response.json(output);
		});
		return {
			config,
			fetcher,
			client: new HindsightClient({
				baseUrl,
				allowedUrls: [baseUrl],
				apiKey: "synthetic-key",
				bankId: "staged-bank",
				tenantId,
				fetcher,
			}),
		};
	}

	it("checks the bank and fences dispatch of the source-only POST", async () => {
		const { client, fetcher, config } = preview();
		try {
			const fence = vi.fn(() => expect(fetcher).toHaveBeenCalledTimes(2));
			await expect(client.extractDrafts(source, fence)).resolves.toEqual([
				{ text: "The user prefers a wool blanket." },
			]);
			expect(fence).toHaveBeenCalledOnce();
			expect(
				fetcher.mock.calls.map(([url, init]) => [url, init?.method]),
			).toEqual([
				[`${baseUrl}/ext/alfyai/capabilities`, undefined],
				[`${bankPath}/config`, "GET"],
				[`${bankPath}/memories/dry-run-extract`, "POST"],
			]);
			const request = fetcher.mock.calls[2][1];
			expect(request?.redirect).toBe("error");
			expect(new Headers(request?.headers).get("Authorization")).toBe(
				"Bearer synthetic-key",
			);
			expect(JSON.parse(String(request?.body))).toEqual(source);
		} finally {
			config.mockRestore();
		}
	});

	it("strips the pinned owner annotation without deleting natural wording or other entities", async () => {
		const texts = [
			"The user prefers a wool blanket. | Involving: user",
			"The user’s sister Adél reads novels. | Involving: Adél, user",
			"The label reads left | right.",
		];
		const { client, config } = preview({
			facts: texts.map((text) => ({ ...result.facts[0], text })),
			chunks: [{ text: source.content, fact_count: texts.length }],
		});
		try {
			await expect(client.extractDrafts(source, () => {})).resolves.toEqual([
				{ text: "The user prefers a wool blanket." },
				{ text: texts[1] },
				{ text: texts[2] },
			]);
		} finally {
			config.mockRestore();
		}
	});

	it("preserves the literal owner notation when it was present in the authored source", async () => {
		const authored = {
			...source,
			content: "My sign includes the text left | Involving: user",
		};
		const { client, config } = preview({
			facts: [{ ...result.facts[0], text: authored.content }],
			chunks: [{ text: authored.content, fact_count: 1 }],
		});
		try {
			await expect(client.extractDrafts(authored, () => {})).resolves.toEqual([
				{ text: authored.content },
			]);
		} finally {
			config.mockRestore();
		}
	});

	it("refuses all traffic when quarantine is disabled", async () => {
		const { client, fetcher, config } = preview(result, false);
		try {
			await expect(client.extractDrafts(source, vi.fn())).rejects.toMatchObject(
				{
					code: "native_preview_disabled",
				},
			);
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			config.mockRestore();
		}
	});

	it("never sends text after the source fence rejects", async () => {
		const { client, fetcher, config } = preview();
		try {
			await expect(
				client.extractDrafts(source, () => {
					throw new NativeMemoryError("memory_source_withdrawn", false);
				}),
			).rejects.toMatchObject({ code: "memory_source_withdrawn" });
			expect(fetcher).toHaveBeenCalledTimes(2);
		} finally {
			config.mockRestore();
		}
	});

	it.each([
		{ ...result, facts: [{ ...result.facts[0], chunk_index: null }] },
		{ ...result, chunks: [{ ...result.chunks[0], text: "other source" }] },
		{ ...result, facts: [{ ...result.facts[0], text: "x".repeat(2_049) }] },
		{ ...result, usage: { excessive: "x".repeat(262_145) } },
	])("refuses malformed, unattributed and oversized outputs", async (wire) => {
		const { client, config } = preview(wire);
		try {
			await expect(client.extractDrafts(source, vi.fn())).rejects.toMatchObject(
				{
					code: "native_format_unsupported",
				},
			);
		} finally {
			config.mockRestore();
		}
	});
});

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
