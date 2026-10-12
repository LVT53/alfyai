import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, sqlite } from "$lib/server/db";
import { conversations, messages, users } from "$lib/server/db/schema";
import type {
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";
import {
	createTurnUrlProvenance,
	hasSourceHost,
	hasSourceThumbnail,
	hostsWithKnownSource,
	noteAtlasJobSources,
	noteAtlasProgressSources,
	noteMessageSources,
	noteSourceUrls,
	noteToolEntrySources,
	noteWebPrefetch,
	resetUrlProvenanceForTests,
} from "./index";
import { LEDGER_MAX_HOSTS_PER_USER } from "./ledger";

// What feeds the ledger: every place a tool's answer reaches the user's screen
// notes the hosts and thumbnails it carries first. These cases pin each writer,
// that only RESULTS count (never a call's input), and that none of it writes to
// the database: an incognito conversation promises that nothing it touched is
// written down.

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";

function entry(
	name: string,
	candidates: Array<{ url?: string | null; metadata?: Record<string, string> }>,
	overrides: Partial<ToolCallEntry> = {},
): ToolCallEntry {
	return {
		callId: `call-${name}`,
		name,
		input: {},
		status: "done",
		candidates: candidates.map((candidate, index) => ({
			id: `c${index}`,
			title: `Result ${index}`,
			sourceType: "web" as const,
			...candidate,
		})),
		...overrides,
	};
}

function segment(toolEntry: ToolCallEntry): ThinkingSegment {
	return { type: "tool_call", ...toolEntry } as ThinkingSegment;
}

describe("noteToolEntrySources (the recorder's writer)", () => {
	beforeEach(() => resetUrlProvenanceForTests());

	it("notes the host of every address a call returned", () => {
		noteToolEntrySources(
			"user-1",
			entry("research_web", [
				{ url: "https://www.Example.com/a" },
				{ url: "https://news.example.org/b?x=1" },
			]),
		);

		expect(hasSourceHost("user-1", "example.com")).toBe(true);
		expect(hasSourceHost("user-1", "news.example.org")).toBe(true);
		expect(hasSourceHost("user-2", "example.com")).toBe(false);
	});

	it("never notes a host the model only asked for: a call's input is its own words", () => {
		noteToolEntrySources(
			"user-1",
			entry("fetch_url", [], {
				input: { urls: ["https://asked-for-only.example/?d=secret"] },
			}),
		);

		expect(hasSourceHost("user-1", "asked-for-only.example")).toBe(false);
	});

	it("notes the exact thumbnail an image search returned, and only that one", () => {
		noteToolEntrySources(
			"user-1",
			entry("image_search", [
				{
					url: "https://example.com/cat.jpg",
					metadata: { thumbnail: THUMB },
				},
			]),
		);

		expect(hasSourceThumbnail("user-1", THUMB)).toBe(true);
		expect(hasSourceHost("user-1", "example.com")).toBe(true);
		expect(hasSourceThumbnail("user-1", `${THUMB}x`)).toBe(false);
	});

	it("does not note a thumbnail from anything but a finished image search", () => {
		noteToolEntrySources(
			"user-1",
			entry(
				"image_search",
				[
					{
						url: "https://example.com/cat.jpg",
						metadata: { thumbnail: THUMB },
					},
				],
				{ status: "failed" },
			),
		);
		noteToolEntrySources(
			"user-1",
			entry("research_web", [
				{ url: "https://example.com/cat.jpg", metadata: { thumbnail: THUMB } },
			]),
		);

		expect(hasSourceThumbnail("user-1", THUMB)).toBe(false);
	});
});

describe("noteMessageSources (the read model's backfill)", () => {
	beforeEach(() => resetUrlProvenanceForTests());

	it("fills the ledger again from the tool calls stored on a conversation's messages", () => {
		noteMessageSources("user-1", [
			{ thinkingSegments: undefined },
			{
				thinkingSegments: [
					{ type: "text", content: "Let me look." },
					segment(entry("research_web", [{ url: "https://stored.example/a" }])),
					segment(
						entry("image_search", [
							{
								url: "https://pics.example/cat.jpg",
								metadata: { thumbnail: THUMB },
							},
						]),
					),
				],
			},
		]);

		expect(hasSourceHost("user-1", "stored.example")).toBe(true);
		expect(hasSourceHost("user-1", "pics.example")).toBe(true);
		expect(hasSourceThumbnail("user-1", THUMB)).toBe(true);
		expect(hasSourceHost("user-2", "stored.example")).toBe(false);
	});

	it("keeps a busy conversation within the ledger's bound", () => {
		const candidates = Array.from(
			{ length: LEDGER_MAX_HOSTS_PER_USER + 50 },
			(_, index) => ({ url: `https://host-${index}.example/` }),
		);
		noteMessageSources("user-1", [
			{ thinkingSegments: [segment(entry("research_web", candidates))] },
		]);

		expect(hasSourceHost("user-1", "host-0.example")).toBe(false);
		expect(
			hasSourceHost("user-1", `host-${LEDGER_MAX_HOSTS_PER_USER + 49}.example`),
		).toBe(true);
	});
});

describe("noteSourceUrls (a live-web block's search)", () => {
	beforeEach(() => resetUrlProvenanceForTests());

	it("notes the hosts of the addresses a search returned and skips what is not an address", () => {
		noteSourceUrls("user-1", [
			"https://www.found.example/page",
			"/relative/path",
			"javascript:alert(1)",
			null,
			undefined,
		]);

		expect(hasSourceHost("user-1", "found.example")).toBe(true);
		expect(hasSourceHost("user-1", "relative")).toBe(false);
	});
});

describe("noteAtlasProgressSources (Atlas source registration)", () => {
	beforeEach(() => resetUrlProvenanceForTests());

	const details = {
		pipelineVersion: 3,
		evidence: {
			sources: [
				{ n: 1, title: "A", host: "www.atlas-source.example", kind: "web" },
				{ n: 2, title: "B", host: "", kind: "local" },
				{ n: 3, title: "C", host: "legacy-v2.example" },
				{ n: 4, title: "D", host: "should-not-count.example", kind: "local" },
			],
		},
	};

	it("notes the host of every web source an Atlas run has read, and no library document", () => {
		noteAtlasProgressSources("user-1", details);

		expect(hasSourceHost("user-1", "atlas-source.example")).toBe(true);
		expect(hasSourceHost("user-1", "legacy-v2.example")).toBe(true);
		expect(hasSourceHost("user-1", "should-not-count.example")).toBe(false);
	});

	it("notes the hosts of the Atlas cards a conversation read returns", () => {
		noteAtlasJobSources("user-1", [
			{ progress: { details } },
			{ progress: { details: { queries: ["only a v1 card"] } } },
			{ progress: null },
			{},
		]);

		expect(hasSourceHost("user-1", "atlas-source.example")).toBe(true);
	});

	it("ignores details that are not an evidence list", () => {
		noteAtlasProgressSources("user-1", null);
		noteAtlasProgressSources("user-1", "text");
		noteAtlasProgressSources("user-1", { evidence: { sources: "not a list" } });
		noteAtlasProgressSources("user-1", {
			evidence: { sources: [null, 7, {}] },
		});

		expect(hasSourceHost("user-1", "atlas-source.example")).toBe(false);
	});
});

describe("noteWebPrefetch (the page read for a link in the message)", () => {
	beforeEach(() => resetUrlProvenanceForTests());

	it("notes the sources of the prefetched exchange and lets the turn follow a link on its page", async () => {
		noteWebPrefetch({
			userId: "user-1",
			conversationId: "conversation-prefetch",
			toolCalls: [
				entry("fetch_url", [{ url: "https://pasted.example/article" }]),
			],
			toolMessages: [
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							output: {
								type: "json",
								value: {
									answerBriefMarkdown:
										"See [the report](https://linked.example/report?id=7).",
								},
							},
						},
					],
				},
			],
		});

		expect(hasSourceHost("user-1", "pasted.example")).toBe(true);
		const provenance = createTurnUrlProvenance({
			userId: "user-1",
			conversationId: "conversation-prefetch",
		});
		const verdict = await provenance.partition([
			"https://linked.example/report?id=7",
			"https://linked.example/report?id=8",
		]);
		expect(verdict.allowed).toEqual(["https://linked.example/report?id=7"]);
		expect(verdict.refusedCount).toBe(1);
	});

	it("does not carry a prefetch from one conversation, or one user, into another", async () => {
		noteWebPrefetch({
			userId: "user-1",
			conversationId: "conversation-a",
			toolCalls: [],
			toolMessages: [{ note: "https://linked.example/report" }],
		});

		for (const [userId, conversationId] of [
			["user-1", "conversation-b"],
			["user-2", "conversation-a"],
		]) {
			const provenance = createTurnUrlProvenance({ userId, conversationId });
			const verdict = await provenance.partition([
				"https://linked.example/report",
			]);
			expect(verdict.allowed, `${userId}/${conversationId}`).toEqual([]);
		}
	});
});

describe("the source ledger and the database", () => {
	beforeEach(() => resetUrlProvenanceForTests());

	function totalChanges(): number {
		const row = sqlite.prepare("SELECT total_changes() AS n").get() as {
			n: number;
		};
		return row.n;
	}

	it("writes nothing to the database, whichever way it is fed or asked", async () => {
		// An incognito conversation promises that nothing it touched is written
		// down, and the ledger is fed by every tool call of every conversation.
		const userId = `user-${randomUUID()}`;
		const conversationId = `conversation-${randomUUID()}`;
		await db.insert(users).values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "x",
		});
		await db
			.insert(conversations)
			.values({ id: conversationId, userId, title: "Incognito" });
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			role: "assistant",
			content: "Found it.",
			toolCalls: JSON.stringify([
				segment(entry("research_web", [{ url: "https://stored.example/a" }])),
			]),
		});
		const before = totalChanges();

		noteToolEntrySources(
			userId,
			entry("research_web", [{ url: "https://live.example/a" }]),
		);
		noteMessageSources(userId, [
			{
				thinkingSegments: [
					segment(entry("research_web", [{ url: "https://x.example/" }])),
				],
			},
		]);
		noteSourceUrls(userId, ["https://search.example/"]);
		noteAtlasProgressSources(userId, {
			evidence: { sources: [{ host: "atlas.example", kind: "web" }] },
		});
		noteWebPrefetch({
			userId,
			conversationId,
			toolCalls: [entry("fetch_url", [{ url: "https://pasted.example/" }])],
			toolMessages: [],
		});
		// The reads that go to the database: the turn's stored sources, and a report's hosts.
		await createTurnUrlProvenance({
			userId,
			conversationId,
			requestText: "see example.com/page",
		}).partition(["https://stored.example/a", "https://made-up.example/"]);
		const known = await hostsWithKnownSource({
			userId,
			conversationId,
			hosts: ["stored.example", "made-up.example"],
		});

		expect([...known]).toEqual(["stored.example"]);
		expect(hasSourceHost(userId, "live.example")).toBe(true);
		expect(totalChanges()).toBe(before);
	});
});
