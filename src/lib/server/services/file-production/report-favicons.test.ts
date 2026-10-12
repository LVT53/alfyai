import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { conversations, messages, users } from "$lib/server/db/schema";
import { GLOBE_FALLBACK_SVG } from "$lib/server/favicon/globe";
import { FaviconCache } from "$lib/server/favicon/lru";
import {
	hasSourceHost,
	noteSourceUrls,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import {
	collectReportFaviconHosts,
	reportFaviconHost,
	resolveReportFavicons,
} from "./report-favicons";
import {
	type GeneratedDocumentSource,
	validateGeneratedDocumentSource,
} from "./source-schema";

function source(blocks: unknown[]): GeneratedDocumentSource {
	const validation = validateGeneratedDocumentSource({
		version: 1,
		template: "alfyai_standard_report",
		title: "Favicon report",
		blocks,
	});
	if (!validation.ok) throw new Error("fixture did not validate");
	return validation.source;
}

function imageResponse(bytes: Uint8Array, contentType: string): Response {
	return new Response(new Uint8Array(bytes).buffer, {
		status: 200,
		headers: { "content-type": contentType },
	});
}

/** A `fetch` stub that records the URL it was asked for. */
function stubFetch(handler: () => Response) {
	return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
		Promise.resolve(handler()),
	);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function freshCache(): FaviconCache {
	return new FaviconCache({ maxSize: 16, ttlMs: 60_000 });
}

describe("reportFaviconHost", () => {
	it("returns the normalized host of a web source", () => {
		expect(reportFaviconHost("https://www.Example.com/docs")).toBe(
			"example.com",
		);
	});

	it("returns null for a library source, a bad URL, or a non-public host", () => {
		expect(reportFaviconHost(null)).toBeNull();
		expect(reportFaviconHost(undefined)).toBeNull();
		expect(reportFaviconHost("not a url")).toBeNull();
		// SSRF guard shared with the /api/favicon route.
		expect(
			reportFaviconHost("http://169.254.169.254/latest/meta-data"),
		).toBeNull();
		expect(reportFaviconHost("http://localhost:5173/x")).toBeNull();
	});
});

describe("collectReportFaviconHosts", () => {
	it("collects and dedupes hosts from source chips, paragraph sources and basis markers", () => {
		const hosts = collectReportFaviconHosts(
			source([
				{
					type: "paragraph",
					text: "Revenue increased by 12%.",
					sources: [{ title: "Filing", url: "https://sec.gov/filing" }],
					basisMarkers: [
						{
							type: "basisMarker",
							id: "basis-1",
							support: "supported",
							anchorText: "Revenue increased by 12%",
							rationale: "Two filings agree.",
							sourceRefs: [
								{ title: "Filing", url: "https://sec.gov/filing" },
								{ title: "Press", url: "https://reuters.com/a" },
							],
						},
					],
				},
				{ type: "heading", level: 2, text: "Sources" },
				{
					type: "sourceChips",
					title: "Sources",
					sources: [
						{ title: "Docs", url: "https://www.example.com/docs" },
						// Library sources have no URL and get no icon lookup.
						{ title: "Local note", provided: true },
					],
				},
			]),
		);

		expect(hosts.sort()).toEqual(["example.com", "reuters.com", "sec.gov"]);
	});

	it("returns nothing for a report with only library sources", () => {
		expect(
			collectReportFaviconHosts(
				source([
					{
						type: "sourceChips",
						title: "Sources",
						sources: [{ title: "Local note", provided: true }],
					},
				]),
			),
		).toEqual([]);
	});
});

describe("resolveReportFavicons", () => {
	// Whose report this is: only hosts a tool returned to this user are fetched
	// (docs/plans/exfil-channels), so the fixture's host is one a search returned.
	const scope = { userId: "user-1", conversationId: "conversation-1" };
	beforeEach(() => {
		resetUrlProvenanceForTests();
		noteSourceUrls("user-1", ["https://example.com/docs"]);
	});

	const fixture = source([
		{
			type: "sourceChips",
			title: "Sources",
			sources: [
				{ title: "Docs", url: "https://example.com/docs" },
				{ title: "Local note", provided: true },
			],
		},
	]);

	it("inlines the fetched icon bytes as a data URI keyed by host", async () => {
		const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));

		const favicons = await resolveReportFavicons(fixture, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache: freshCache(),
			timeoutMs: 0,
			...scope,
		});

		expect(favicons.get("example.com")).toBe(
			`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
		);
		// The source site is tried first, over https, exactly as the proxy does.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
			"https://example.com/favicon.ico",
		);
	});

	it("leaves a host out when its icon cannot be fetched, so the renderer draws its globe", async () => {
		const fetchImpl = stubFetch(() => new Response("nope", { status: 404 }));

		const favicons = await resolveReportFavicons(fixture, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache: freshCache(),
			timeoutMs: 0,
			...scope,
		});

		expect(favicons.has("example.com")).toBe(false);
		expect(favicons.size).toBe(0);
	});

	it("does not inline the proxy's globe placeholder as if it were a real icon", async () => {
		// `fetchFavicon` negative-caches failures AS the globe SVG. Inlining that
		// would duplicate the renderer's own fallback into every source.
		const cache = freshCache();
		const globeBytes = new TextEncoder().encode(GLOBE_FALLBACK_SVG);
		cache.set("example.com", cache.wrap(globeBytes, "image/svg+xml"));
		const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));

		const favicons = await resolveReportFavicons(fixture, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache,
			timeoutMs: 0,
			...scope,
		});

		expect(favicons.size).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("never fetches anything for a report with no web sources", async () => {
		const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));

		const favicons = await resolveReportFavicons(
			source([
				{
					type: "sourceChips",
					title: "Sources",
					sources: [{ title: "Local note", provided: true }],
				},
			]),
			{
				fetch: fetchImpl as unknown as typeof globalThis.fetch,
				cache: freshCache(),
				timeoutMs: 0,
				...scope,
			},
		);

		expect(favicons.size).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("fetches an icon only for a host a tool returned to this user: a host the model wrote on its own gets the renderer's globe, and no request", async () => {
		const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));
		const report = source([
			{
				type: "sourceChips",
				title: "Sources",
				sources: [
					{ title: "Docs", url: "https://example.com/docs" },
					{
						title: "Injected",
						url: "https://private-data-in-name.exfil.example/x",
					},
				],
			},
		]);

		const favicons = await resolveReportFavicons(report, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache: freshCache(),
			timeoutMs: 0,
			...scope,
		});

		expect([...favicons.keys()]).toEqual(["example.com"]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
			"https://example.com/favicon.ico",
		);
	});

	it("fetches nothing for a report whose hosts no tool returned", async () => {
		resetUrlProvenanceForTests();
		const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));

		const favicons = await resolveReportFavicons(fixture, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache: freshCache(),
			timeoutMs: 0,
			...scope,
		});

		expect(favicons.size).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("does not take another user's ledger for this user's report", async () => {
		resetUrlProvenanceForTests();
		noteSourceUrls("user-2", ["https://example.com/docs"]);
		const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));

		const favicons = await resolveReportFavicons(fixture, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache: freshCache(),
			timeoutMs: 0,
			...scope,
		});

		expect(favicons.size).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	describe("when the worker runs after a restart, or before the turn is stored", () => {
		async function storedConversation(): Promise<typeof scope> {
			const userId = `user-${randomUUID()}`;
			const conversationId = `conversation-${randomUUID()}`;
			await db.insert(users).values({
				id: userId,
				email: `${userId}@example.com`,
				passwordHash: "hash",
			});
			await db
				.insert(conversations)
				.values({ id: conversationId, userId, title: "Report" });
			await db.insert(messages).values({
				id: randomUUID(),
				conversationId,
				role: "assistant",
				content: "I found sources.",
				messageSequence: 1,
				toolCalls: JSON.stringify([
					{
						type: "tool_call",
						name: "research_web",
						input: { query: "q" },
						status: "done",
						candidates: [
							{
								id: "c1",
								title: "Docs",
								url: "https://www.example.com/docs",
								sourceType: "web",
							},
						],
					},
				]),
			});
			return { userId, conversationId };
		}

		it("takes a host from the conversation's stored tool results, and remembers it", async () => {
			resetUrlProvenanceForTests();
			const stored = await storedConversation();
			const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));
			const report = source([
				{
					type: "sourceChips",
					title: "Sources",
					sources: [
						{ title: "Docs", url: "https://example.com/docs" },
						{ title: "Injected", url: "https://exfil.example/x" },
					],
				},
			]);

			const favicons = await resolveReportFavicons(report, {
				fetch: fetchImpl as unknown as typeof globalThis.fetch,
				cache: freshCache(),
				timeoutMs: 0,
				...stored,
			});

			expect([...favicons.keys()]).toEqual(["example.com"]);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(hasSourceHost(stored.userId, "example.com")).toBe(true);
			expect(hasSourceHost(stored.userId, "exfil.example")).toBe(false);
		});

		it("reads nothing of a conversation that is not the user's", async () => {
			resetUrlProvenanceForTests();
			const stored = await storedConversation();
			const fetchImpl = stubFetch(() => imageResponse(PNG, "image/png"));

			const favicons = await resolveReportFavicons(fixture, {
				fetch: fetchImpl as unknown as typeof globalThis.fetch,
				cache: freshCache(),
				timeoutMs: 0,
				userId: "someone-else",
				conversationId: stored.conversationId,
			});

			expect(favicons.size).toBe(0);
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	});

	it("drops an oversized payload rather than bloating the report", async () => {
		const huge = new Uint8Array(64 * 1024).fill(1);
		const fetchImpl = stubFetch(() => imageResponse(huge, "image/png"));

		const favicons = await resolveReportFavicons(fixture, {
			fetch: fetchImpl as unknown as typeof globalThis.fetch,
			cache: freshCache(),
			timeoutMs: 0,
			...scope,
		});

		expect(favicons.size).toBe(0);
	});
});
