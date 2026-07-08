import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	PlexError,
	plexLibrarySections,
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

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/plex", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/plex")
	>("$lib/server/services/connections/providers/plex");
	return {
		...actual,
		plexWatchHistory: vi.fn(),
		plexLibrarySections: vi.fn(),
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
	it("only accepts read actions (watch_history, libraries) — no write action exists", () => {
		const actionSchema = mediaToolInputSchema.shape.action;
		const values = actionSchema.options as readonly string[];
		expect(values).toEqual(
			expect.arrayContaining(["watch_history", "libraries"]),
		);
		for (const value of values) {
			expect(value).not.toMatch(
				/write|create|update|delete|mark|scrobble|rate|play/i,
			);
		}
		expect(values).toHaveLength(2);
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
// Locality Option A distillation gate — watch history is sensitive personal
// data (what someone watches).
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
});
