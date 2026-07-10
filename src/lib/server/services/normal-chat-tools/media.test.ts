import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	PlexError,
	plexLibrarySearch,
	plexLibrarySections,
	plexOnDeck,
	plexWatchHistory,
} from "$lib/server/services/connections/providers/plex";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import {
	mediaToolInputSchema,
	runMediaTool,
	sanitizeMediaToolInput,
} from "./media";

vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: vi.fn(),
		needsDisambiguation: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/providers/plex", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/plex")
	>("$lib/server/services/connections/providers/plex");
	return {
		...actual,
		plexWatchHistory: vi.fn(),
		plexLibrarySections: vi.fn(),
		plexOnDeck: vi.fn(),
		plexLibrarySearch: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const plexWatchHistoryMock = vi.mocked(plexWatchHistory);
const plexLibrarySectionsMock = vi.mocked(plexLibrarySections);
const plexOnDeckMock = vi.mocked(plexOnDeck);
const plexLibrarySearchMock = vi.mocked(plexLibrarySearch);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "plex",
		label: "Plex",
		accountIdentifier: "machine-abc",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["media"],
		config: {
			origin: "https://plex.example.com",
			machineIdentifier: "machine-abc",
		},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function resetAllMocks() {
	resolveConnectionsForCapabilityMock.mockReset();
	needsDisambiguationMock.mockReset();
	plexWatchHistoryMock.mockReset();
	plexLibrarySectionsMock.mockReset();
	plexOnDeckMock.mockReset();
	plexLibrarySearchMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
}

// ---------------------------------------------------------------------------
// Input schema — no write action exists
// ---------------------------------------------------------------------------

describe("mediaToolInputSchema", () => {
	it("only accepts read actions (watch_history, libraries, continue_watching, library_search) — no write action exists", () => {
		const actionSchema = mediaToolInputSchema.shape.action;
		const values = actionSchema.options as readonly string[];
		expect(values).toEqual(
			expect.arrayContaining([
				"watch_history",
				"libraries",
				"continue_watching",
				"library_search",
			]),
		);
		for (const value of values) {
			expect(value).not.toMatch(
				/write|create|update|delete|mark|scrobble|rate|play/i,
			);
		}
		expect(values).toHaveLength(4);
	});
});

describe("sanitizeMediaToolInput", () => {
	it("trims the query and drops undefined optional fields", () => {
		expect(
			sanitizeMediaToolInput({
				action: "watch_history",
				query: "  breaking bad  ",
			}),
		).toEqual({ action: "watch_history", query: "breaking bad" });
	});

	it("keeps since/limit when supplied", () => {
		expect(
			sanitizeMediaToolInput({
				action: "watch_history",
				since: "2026-01-01T00:00:00.000Z",
				limit: 10,
			}),
		).toEqual({
			action: "watch_history",
			since: "2026-01-01T00:00:00.000Z",
			limit: 10,
		});
	});
});

// ---------------------------------------------------------------------------
// runMediaTool
// ---------------------------------------------------------------------------

describe("runMediaTool", () => {
	beforeEach(resetAllMocks);

	it("returns a graceful note without throwing when there is no Media connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have a Media connection",
		);
		expect(outcome.modelPayload.results).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
		expect(plexWatchHistoryMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity but still executes against the first (sorted) connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Plex" });
		const connB = makeConn({ id: "conn-b", label: "Bob Plex" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		plexWatchHistoryMock.mockResolvedValue([]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history" },
			LOCAL_MODEL_ID,
		);

		expect(plexWatchHistoryMock).toHaveBeenCalledWith(
			"user-1",
			"conn-a",
			expect.any(Object),
		);
		expect(outcome.modelPayload.message).toContain("2 Media connections");
		expect(outcome.modelPayload.message).toContain("Alice Plex");
		expect(outcome.modelPayload.message).toContain("Bob Plex");
	});

	it("account selector routes to the matching Plex connection instead of the alphabetically-first one", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Plex" });
		const connB = makeConn({ id: "conn-b", label: "Bob Plex" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		plexWatchHistoryMock.mockResolvedValue([]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history", account: "Bob Plex" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(plexWatchHistoryMock).toHaveBeenCalledWith(
			"user-1",
			"conn-b",
			expect.any(Object),
		);
	});

	it("an account selector matching nothing returns a graceful listing message", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Plex" });
		const connB = makeConn({ id: "conn-b", label: "Bob Plex" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history", account: "jellyfin" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Alice Plex");
		expect(outcome.modelPayload.message).toContain("Bob Plex");
		expect(plexWatchHistoryMock).not.toHaveBeenCalled();
	});

	it("watch_history: returns results, citations, and Sources-tab candidates", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexWatchHistoryMock.mockResolvedValue([
			{
				title: "Pilot",
				show: "Breaking Bad",
				season: 1,
				episode: 1,
				type: "episode",
				viewedAt: "2026-06-01T09:55:00.000Z",
				library: "TV Shows",
			},
			{
				title: "Inception",
				type: "movie",
				viewedAt: "2026-05-01T00:00:00.000Z",
				library: "Movies",
			},
		]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history" },
			LOCAL_MODEL_ID,
		);

		expect(plexWatchHistoryMock).toHaveBeenCalledWith("user-1", "conn-1", {});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.results).toEqual([
			{
				title: "Pilot",
				show: "Breaking Bad",
				season: 1,
				episode: 1,
				type: "episode",
				viewedAt: "2026-06-01T09:55:00.000Z",
				library: "TV Shows",
			},
			{
				title: "Inception",
				type: "movie",
				viewedAt: "2026-05-01T00:00:00.000Z",
				library: "Movies",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Breaking Bad — Pilot", url: "" },
			{ label: "Inception", url: "" },
		]);
		expect(outcome.candidates).toHaveLength(2);
		expect(outcome.candidates[0]).toEqual(
			expect.objectContaining({
				title: "Breaking Bad — Pilot",
				sourceType: "tool",
			}),
		);
	});

	it("watch_history: forwards since/limit/query to plexWatchHistory", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexWatchHistoryMock.mockResolvedValue([]);

		await runMediaTool(
			"user-1",
			{
				action: "watch_history",
				since: "2026-01-01T00:00:00.000Z",
				limit: 5,
				query: "bad",
			},
			LOCAL_MODEL_ID,
		);

		expect(plexWatchHistoryMock).toHaveBeenCalledWith("user-1", "conn-1", {
			since: "2026-01-01T00:00:00.000Z",
			limit: 5,
			query: "bad",
		});
	});

	it("libraries: returns section list", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySectionsMock.mockResolvedValue([
			{ title: "Movies", type: "movie" },
			{ title: "TV Shows", type: "show" },
		]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "libraries" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.libraries).toEqual([
			{ title: "Movies", type: "movie" },
			{ title: "TV Shows", type: "show" },
		]);
	});

	// -------------------------------------------------------------------------
	// GAP B2 — continue_watching
	// -------------------------------------------------------------------------

	it("continue_watching: returns onDeck items, citations, and Sources-tab candidates", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexOnDeckMock.mockResolvedValue([
			{
				title: "Ozymandias",
				show: "Breaking Bad",
				season: 5,
				episode: 14,
				type: "episode",
				viewOffsetMs: 300000,
				durationMs: 1200000,
				progress: 0.25,
				library: "TV Shows",
			},
		]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "continue_watching" },
			LOCAL_MODEL_ID,
		);

		expect(plexOnDeckMock).toHaveBeenCalledWith("user-1", "conn-1", {});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.onDeck).toEqual([
			{
				title: "Ozymandias",
				show: "Breaking Bad",
				season: 5,
				episode: 14,
				type: "episode",
				viewOffsetMs: 300000,
				durationMs: 1200000,
				progress: 0.25,
				library: "TV Shows",
			},
		]);
		expect(outcome.modelPayload.message).toContain(
			"1 item to continue watching",
		);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Breaking Bad — Ozymandias", url: "" },
		]);
		expect(outcome.candidates).toHaveLength(1);
	});

	it("continue_watching: forwards limit to plexOnDeck", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexOnDeckMock.mockResolvedValue([]);

		await runMediaTool(
			"user-1",
			{ action: "continue_watching", limit: 5 },
			LOCAL_MODEL_ID,
		);

		expect(plexOnDeckMock).toHaveBeenCalledWith("user-1", "conn-1", {
			limit: 5,
		});
	});

	it("continue_watching: empty on-deck list produces a graceful message", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexOnDeckMock.mockResolvedValue([]);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "continue_watching" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.onDeck).toEqual([]);
		expect(outcome.modelPayload.message).toContain(
			"Nothing is currently in progress",
		);
	});

	it("continue_watching: maps adapter errors to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexOnDeckMock.mockRejectedValue(
			new PlexError("Plex rejected the stored token", "needs_reauth"),
		);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "continue_watching" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
	});

	// -------------------------------------------------------------------------
	// GAP B3 — library_search
	// -------------------------------------------------------------------------

	it("library_search: returns matched items and the true match count in the message", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySearchMock.mockResolvedValue({
			items: [
				{ title: "The Matrix", year: 1999, type: "movie", section: "Movies" },
			],
			totalCount: 1,
		});

		const outcome = await runMediaTool(
			"user-1",
			{ action: "library_search", query: "matrix" },
			LOCAL_MODEL_ID,
		);

		expect(plexLibrarySearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			query: "matrix",
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.librarySearch).toEqual([
			{ title: "The Matrix", year: 1999, type: "movie", section: "Movies" },
		]);
		expect(outcome.modelPayload.libraryMatchCount).toBe(1);
		expect(outcome.modelPayload.message).toContain("Found 1 matching title");
	});

	it("library_search: message surfaces the true count even when items are capped below it", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySearchMock.mockResolvedValue({
			items: [{ title: "A", type: "movie", section: "Movies" }],
			totalCount: 142,
		});

		const outcome = await runMediaTool(
			"user-1",
			{ action: "library_search" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.message).toContain("142");
		expect(outcome.modelPayload.message).toContain("showing 1");
	});

	it("library_search: no matches produces a graceful message", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySearchMock.mockResolvedValue({ items: [], totalCount: 0 });

		const outcome = await runMediaTool(
			"user-1",
			{ action: "library_search", query: "nonexistent" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toContain("No matching titles found");
	});

	it("library_search: never calls plexWatchHistory (distinct from history search)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySearchMock.mockResolvedValue({
			items: [{ title: "Unwatched Gem", type: "movie", section: "Movies" }],
			totalCount: 1,
		});

		await runMediaTool(
			"user-1",
			{ action: "library_search", query: "unwatched gem" },
			LOCAL_MODEL_ID,
		);

		expect(plexWatchHistoryMock).not.toHaveBeenCalled();
	});

	it("library_search: is never gated by Option A distillation (owned catalog, not watch behavior)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySearchMock.mockResolvedValue({
			items: [{ title: "The Matrix", type: "movie", section: "Movies" }],
			totalCount: 1,
		});
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "library_search", query: "matrix" },
			"cloud-model",
		);

		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.librarySearch[0]?.title).toBe("The Matrix");
	});

	it("library_search: maps adapter errors to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySearchMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runMediaTool(
			"user-1",
			{ action: "library_search", query: "matrix" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("couldn't reach your media");
	});

	it("maps needs_reauth adapter errors to a graceful note without leaking the token", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexWatchHistoryMock.mockRejectedValue(
			new PlexError("Plex rejected the stored token", "needs_reauth"),
		);

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
	});

	it("maps generic adapter failures to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexWatchHistoryMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runMediaTool(
			"user-1",
			{ action: "watch_history" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("couldn't reach your media");
	});
});

// ---------------------------------------------------------------------------
// Locality Option A distillation gate — watch history and continue_watching
// are sensitive personal data (what someone watches).
// ---------------------------------------------------------------------------

describe("runMediaTool — locality Option A distillation gate", () => {
	beforeEach(resetAllMocks);

	function seedHistory() {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexWatchHistoryMock.mockResolvedValue([
			{
				title: "Intervention",
				show: "Celebrity Rehab",
				season: 2,
				episode: 4,
				type: "episode",
				viewedAt: "2026-06-01T09:55:00.000Z",
				library: "TV Shows",
			},
		]);
	}

	async function watchHistoryOnce() {
		return runMediaTool(
			"user-1",
			{ action: "watch_history", query: "rehab" },
			"whichever-model",
		);
	}

	it("Option A off: raw watch-history data is returned unchanged and distill is not called", async () => {
		seedHistory();
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await watchHistoryOnce();

		expect(outcome.modelPayload.results[0]?.title).toBe("Intervention");
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw watch-history data is returned unchanged and distill is not called", async () => {
		seedHistory();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await watchHistoryOnce();

		expect(outcome.modelPayload.results[0]?.show).toBe("Celebrity Rehab");
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the ENTIRE model-bound payload carries only the distilled summary — raw titles/show names absent, candidates keep the real data", async () => {
		seedHistory();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One episode of a reality TV show was watched recently.",
		});

		const outcome = await watchHistoryOnce();

		// The single most important assertion: raw title/show name must not
		// appear ANYWHERE in the whole model-facing payload — not just
		// `results`, but also `citations`.
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Intervention");
		expect(serializedPayload).not.toContain("Celebrity Rehab");
		expect(outcome.modelPayload.results[0]?.title).toBeUndefined();
		expect(outcome.modelPayload.results[0]?.show).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"One episode of a reality TV show was watched recently.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "media",
				rawText: expect.stringContaining("Celebrity Rehab"),
			}),
		);
		// The MODEL-facing citation label is redacted too — the raw title must
		// never reach the cloud model through this side channel.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({ url: "" }),
		]);
		expect(outcome.modelPayload.citations[0]?.label).not.toContain(
			"Intervention",
		);
		expect(outcome.modelPayload.citations[0]?.label).not.toContain(
			"Celebrity Rehab",
		);
		// The user's own Sources-tab candidates keep the real title/show.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Celebrity Rehab — Intervention" }),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw details are withheld, not leaked", async () => {
		seedHistory();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await watchHistoryOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Intervention");
		expect(serializedPayload).not.toContain("Celebrity Rehab");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Celebrity Rehab — Intervention" }),
		]);
	});

	it("libraries action never triggers distillation (no raw personal watch data involved)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexLibrarySectionsMock.mockResolvedValue([
			{ title: "Movies", type: "movie" },
		]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);

		await runMediaTool("user-1", { action: "libraries" }, "cloud-model");

		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// GAP B2 — continue_watching is gated the same way watch_history is: it
	// reveals the same kind of sensitive "what someone watches" data (in this
	// case, what they're mid-way through right now).
	// -------------------------------------------------------------------------

	function seedOnDeck() {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		plexOnDeckMock.mockResolvedValue([
			{
				title: "Intervention",
				show: "Celebrity Rehab",
				season: 2,
				episode: 4,
				type: "episode",
				viewOffsetMs: 100000,
				durationMs: 1000000,
				progress: 0.1,
				library: "TV Shows",
			},
		]);
	}

	async function onDeckOnce() {
		return runMediaTool(
			"user-1",
			{ action: "continue_watching" },
			"whichever-model",
		);
	}

	it("Option A off: raw on-deck data is returned unchanged and distill is not called", async () => {
		seedOnDeck();
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await onDeckOnce();

		expect(outcome.modelPayload.onDeck[0]?.title).toBe("Intervention");
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the ENTIRE model-bound payload carries only the distilled summary for continue_watching too", async () => {
		seedOnDeck();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One in-progress episode of a reality TV show.",
		});

		const outcome = await onDeckOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Intervention");
		expect(serializedPayload).not.toContain("Celebrity Rehab");
		expect(outcome.modelPayload.onDeck[0]?.title).toBeUndefined();
		expect(outcome.modelPayload.onDeck[0]?.show).toBeUndefined();
		// Structural fields (progress/season/episode/type) survive the strip.
		expect(outcome.modelPayload.onDeck[0]?.progress).toBe(0.1);
		expect(outcome.modelPayload.message).toContain(
			"One in-progress episode of a reality TV show.",
		);
		expect(outcome.modelPayload.citations[0]?.label).not.toContain(
			"Intervention",
		);
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Celebrity Rehab — Intervention" }),
		]);
	});

	it("Option A on + cloud model + distill unavailable: on-deck details are withheld, not leaked", async () => {
		seedOnDeck();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await onDeckOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Intervention");
		expect(serializedPayload).not.toContain("Celebrity Rehab");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Celebrity Rehab — Intervention" }),
		]);
	});
});
