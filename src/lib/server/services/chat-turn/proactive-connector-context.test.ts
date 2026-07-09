import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../connections/store";

const mocks = vi.hoisted(() => ({
	resolveConnectionsForCapability: vi.fn(),
	googleListEvents: vi.fn(),
	appleListEvents: vi.fn(),
	imapListRecent: vi.fn(),
	decideLocalDistill: vi.fn(),
	isConversationIncognito: vi.fn(),
}));

vi.mock("../connections/resolve", () => ({
	resolveConnectionsForCapability: mocks.resolveConnectionsForCapability,
}));
vi.mock("../connections/providers/google-calendar", () => ({
	googleListEvents: mocks.googleListEvents,
}));
vi.mock("../connections/providers/apple-caldav", () => ({
	appleListEvents: mocks.appleListEvents,
}));
vi.mock("../connections/providers/imap", () => ({
	imapListRecent: mocks.imapListRecent,
}));
vi.mock("$lib/server/services/normal-chat-tools/connector-distill", () => ({
	decideLocalDistill: mocks.decideLocalDistill,
}));
vi.mock("$lib/server/services/memory-controls", () => ({
	isConversationIncognito: mocks.isConversationIncognito,
}));

import { __resetProactiveConnectorContextCacheForTests } from "./proactive-connector-cache";
import {
	buildProactiveConnectorContext,
	CALENDAR_INTENT_RE,
	EMAIL_INTENT_RE,
} from "./proactive-connector-context";

function connection(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "google",
		label: "Home Google",
		accountIdentifier: "user@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: true,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["calendar"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const baseParams = {
	userId: "user-1",
	conversationId: "conv-1",
	modelId: "model1",
	targetConstructedContextTokens: 200_000,
	now: Date.UTC(2026, 6, 9, 12, 0, 0),
};

describe("relevance regexes", () => {
	it("CALENDAR_INTENT_RE matches bilingual calendar intent", () => {
		expect(CALENDAR_INTENT_RE.test("Do I have any meetings today?")).toBe(true);
		expect(CALENDAR_INTENT_RE.test("What's on my plate this week?")).toBe(true);
		expect(CALENDAR_INTENT_RE.test("Van holnap találkozóm?")).toBe(true);
		expect(CALENDAR_INTENT_RE.test("Write me a poem about the ocean")).toBe(
			false,
		);
	});

	it("EMAIL_INTENT_RE matches bilingual email intent", () => {
		expect(EMAIL_INTENT_RE.test("Any unread emails?")).toBe(true);
		expect(EMAIL_INTENT_RE.test("Van olvasatlan levelem?")).toBe(true);
		expect(EMAIL_INTENT_RE.test("Write me a poem about the ocean")).toBe(false);
	});
});

describe("buildProactiveConnectorContext", () => {
	beforeEach(() => {
		__resetProactiveConnectorContextCacheForTests();
		mocks.resolveConnectionsForCapability.mockReset();
		mocks.googleListEvents.mockReset();
		mocks.appleListEvents.mockReset();
		mocks.imapListRecent.mockReset();
		mocks.decideLocalDistill.mockReset();
		mocks.isConversationIncognito.mockReset();
		mocks.isConversationIncognito.mockResolvedValue(false);
		mocks.decideLocalDistill.mockResolvedValue({ shouldDistill: false });
		mocks.resolveConnectionsForCapability.mockResolvedValue([]);
	});

	it("returns null when no capability is active", async () => {
		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(),
		});

		expect(result).toBeNull();
		expect(mocks.resolveConnectionsForCapability).not.toHaveBeenCalled();
	});

	it("returns null (no fetch) when the capability is active but the message is not relevant", async () => {
		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Write me a poem about the ocean",
			activeCapabilities: new Set(["calendar", "email"]),
		});

		expect(result).toBeNull();
		expect(mocks.resolveConnectionsForCapability).not.toHaveBeenCalled();
		expect(mocks.googleListEvents).not.toHaveBeenCalled();
		expect(mocks.imapListRecent).not.toHaveBeenCalled();
	});

	it("injects a compact calendar block via googleListEvents when calendar is active and relevant", async () => {
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [connection()] : [],
		);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Team sync",
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				location: "HQ conf room",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});

		expect(mocks.googleListEvents).toHaveBeenCalledWith(
			"user-1",
			"conn-1",
			expect.objectContaining({ maxResults: 10 }),
		);
		expect(result?.block).toContain("## Your calendar & mail (live)");
		expect(result?.block).toContain("Team sync");
		expect(result?.block).toContain("HQ conf room");
	});

	it("dispatches to appleListEvents for an apple provider connection", async () => {
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar"
					? [connection({ provider: "apple", id: "conn-apple" })]
					: [],
		);
		mocks.appleListEvents.mockResolvedValue([
			{
				id: "evt-2",
				summary: "Dentist",
				start: "2026-07-10T09:00:00.000Z",
				end: "2026-07-10T09:30:00.000Z",
				htmlLink: "https://example.com/evt-2",
			},
		]);

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "What's my schedule tomorrow?",
			activeCapabilities: new Set(["calendar"]),
		});

		expect(mocks.appleListEvents).toHaveBeenCalledWith(
			"user-1",
			"conn-apple",
			expect.objectContaining({
				timeMin: expect.any(String),
				timeMax: expect.any(String),
			}),
		);
		expect(mocks.googleListEvents).not.toHaveBeenCalled();
		expect(result?.block).toContain("Dentist");
	});

	it("silently skips a broken/needs_reauth calendar connector without throwing", async () => {
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [connection()] : [],
		);
		mocks.googleListEvents.mockRejectedValue(new Error("needs_reauth"));

		await expect(
			buildProactiveConnectorContext({
				...baseParams,
				message: "Do I have any meetings today?",
				activeCapabilities: new Set(["calendar"]),
			}),
		).resolves.toBeNull();
	});

	it("injects a compact recent-unread email block via imapListRecent(unseenOnly)", async () => {
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "email"
					? [
							connection({
								id: "conn-imap",
								provider: "imap",
								capabilities: ["email"],
							}),
						]
					: [],
		);
		mocks.imapListRecent.mockResolvedValue([
			{
				uid: 1,
				from: "Alice Doe",
				subject: "Q3 numbers",
				date: "2026-07-09T08:00:00.000Z",
				seen: false,
			},
		]);

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Any unread emails?",
			activeCapabilities: new Set(["email"]),
		});

		expect(mocks.imapListRecent).toHaveBeenCalledWith(
			"user-1",
			"conn-imap",
			expect.objectContaining({ unseenOnly: true }),
		);
		expect(result?.block).toContain("Alice Doe");
		expect(result?.block).toContain("Q3 numbers");
	});

	it("combines calendar and email sections when both are active and relevant", async () => {
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) => {
				if (capability === "calendar") return [connection()];
				if (capability === "email") {
					return [
						connection({
							id: "conn-imap",
							provider: "imap",
							capabilities: ["email"],
						}),
					];
				}
				return [];
			},
		);
		mocks.googleListEvents.mockResolvedValue([]);
		mocks.imapListRecent.mockResolvedValue([]);

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "What's on my plate today, any unread emails too?",
			activeCapabilities: new Set(["calendar", "email"]),
		});

		expect(result?.block).toContain("Calendar");
		expect(result?.block).toContain("Recent unread email");
	});
});

describe("buildProactiveConnectorContext locality (Option A)", () => {
	beforeEach(() => {
		__resetProactiveConnectorContextCacheForTests();
		mocks.resolveConnectionsForCapability.mockReset();
		mocks.googleListEvents.mockReset();
		mocks.imapListRecent.mockReset();
		mocks.decideLocalDistill.mockReset();
		mocks.isConversationIncognito.mockReset();
		mocks.isConversationIncognito.mockResolvedValue(false);
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [connection()] : [],
		);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Confidential board meeting",
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				location: "Secret HQ",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
	});

	it("injects only the distilled summary — never the raw title/location — when Option A is active for a cloud model", async () => {
		mocks.decideLocalDistill.mockResolvedValue({
			shouldDistill: true,
			distilled: "One work meeting this afternoon.",
		});

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});

		expect(mocks.decideLocalDistill).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				modelId: "model1",
				capability: "calendar",
				userQuestion: "Do I have any meetings today?",
				rawText: expect.stringContaining("Confidential board meeting"),
			}),
		);
		expect(result?.block).toContain("One work meeting this afternoon.");
		expect(result?.block).not.toContain("Confidential board meeting");
		expect(result?.block).not.toContain("Secret HQ");
	});

	it("withholds the capability entirely (never falls back to raw text) when distillation is unavailable", async () => {
		mocks.decideLocalDistill.mockResolvedValue({
			shouldDistill: true,
			unavailable: true,
		});

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});

		expect(result).toBeNull();
	});

	it("injects the raw text when the local-distill gate opts out (shouldDistill: false)", async () => {
		mocks.decideLocalDistill.mockResolvedValue({ shouldDistill: false });

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});

		expect(result?.block).toContain("Confidential board meeting");
	});
});

describe("buildProactiveConnectorContext budget", () => {
	beforeEach(() => {
		__resetProactiveConnectorContextCacheForTests();
		mocks.resolveConnectionsForCapability.mockReset();
		mocks.googleListEvents.mockReset();
		mocks.decideLocalDistill.mockReset();
		mocks.isConversationIncognito.mockReset();
		mocks.isConversationIncognito.mockResolvedValue(false);
		mocks.decideLocalDistill.mockResolvedValue({ shouldDistill: false });
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [connection()] : [],
		);
	});

	it("truncates the injected block to its bounded token budget", async () => {
		mocks.googleListEvents.mockResolvedValue(
			Array.from({ length: 10 }, (_, index) => ({
				id: `evt-${index}`,
				summary: `Very long event title number ${index} `.repeat(40),
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				location: "Somewhere",
				htmlLink: `https://calendar.google.com/evt-${index}`,
			})),
		);

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
			// A tiny target keeps deriveProactiveConnectorContextBudget's floor
			// (300 tokens) as the effective bound, well under the full event list.
			targetConstructedContextTokens: 1_000,
		});

		expect(result?.block).toContain("[truncated]");
		expect(result?.block.length ?? 0).toBeLessThan(3_000);
	});
});

describe("buildProactiveConnectorContext cache", () => {
	beforeEach(() => {
		__resetProactiveConnectorContextCacheForTests();
		mocks.resolveConnectionsForCapability.mockReset();
		mocks.googleListEvents.mockReset();
		mocks.decideLocalDistill.mockReset();
		mocks.isConversationIncognito.mockReset();
		mocks.isConversationIncognito.mockResolvedValue(false);
		mocks.decideLocalDistill.mockResolvedValue({ shouldDistill: false });
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [connection()] : [],
		);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Team sync",
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
	});

	it("does not re-call the provider on a second relevant turn within the TTL", async () => {
		await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});
		await buildProactiveConnectorContext({
			...baseParams,
			message: "What's on my plate?",
			activeCapabilities: new Set(["calendar"]),
			now: baseParams.now + 30_000,
		});

		expect(mocks.googleListEvents).toHaveBeenCalledTimes(1);
	});

	it("re-fetches once the cache entry has expired", async () => {
		await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});
		await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
			now: baseParams.now + 10 * 60 * 1000,
		});

		expect(mocks.googleListEvents).toHaveBeenCalledTimes(2);
	});

	it("still populates the cache from an incognito turn's fetch by default, but skips the write when incognito", async () => {
		mocks.isConversationIncognito.mockResolvedValue(true);

		await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});
		await buildProactiveConnectorContext({
			...baseParams,
			message: "What's on my plate?",
			activeCapabilities: new Set(["calendar"]),
			now: baseParams.now + 30_000,
		});

		// Cache write is suppressed in incognito, so the second (still-incognito)
		// turn fetches again rather than reusing a stale cache entry.
		expect(mocks.googleListEvents).toHaveBeenCalledTimes(2);
	});
});

describe("buildProactiveConnectorContext incognito", () => {
	beforeEach(() => {
		__resetProactiveConnectorContextCacheForTests();
		mocks.resolveConnectionsForCapability.mockReset();
		mocks.googleListEvents.mockReset();
		mocks.decideLocalDistill.mockReset();
		mocks.isConversationIncognito.mockReset();
		mocks.decideLocalDistill.mockResolvedValue({ shouldDistill: false });
		mocks.resolveConnectionsForCapability.mockImplementation(
			async (_userId: string, capability: string) =>
				capability === "calendar" ? [connection()] : [],
		);
		mocks.googleListEvents.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Team sync",
				start: "2026-07-09T15:00:00.000Z",
				end: "2026-07-09T15:30:00.000Z",
				htmlLink: "https://calendar.google.com/evt-1",
			},
		]);
	});

	it("still injects context in an incognito conversation (functionality preserved)", async () => {
		mocks.isConversationIncognito.mockResolvedValue(true);

		const result = await buildProactiveConnectorContext({
			...baseParams,
			message: "Do I have any meetings today?",
			activeCapabilities: new Set(["calendar"]),
		});

		expect(result?.block).toContain("Team sync");
	});
});
