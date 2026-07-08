import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	GoogleCalendarError,
	googleFreeBusy,
	googleListEvents,
} from "$lib/server/services/connections/providers/google-calendar";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import { runCalendarTool, sanitizeCalendarToolInput } from "./calendar";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock(
	"$lib/server/services/connections/providers/google-calendar",
	async () => {
		const actual = await vi.importActual<
			typeof import("$lib/server/services/connections/providers/google-calendar")
		>("$lib/server/services/connections/providers/google-calendar");
		return {
			...actual,
			googleListEvents: vi.fn(),
			googleFreeBusy: vi.fn(),
		};
	},
);
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const googleListEventsMock = vi.mocked(googleListEvents);
const googleFreeBusyMock = vi.mocked(googleFreeBusy);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "google",
		label: "Google",
		accountIdentifier: "alice@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["calendar"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("sanitizeCalendarToolInput", () => {
	it("trims optional fields and drops empty strings", () => {
		expect(
			sanitizeCalendarToolInput({
				action: "list_events",
				start: "  2026-07-08T00:00:00Z  ",
				query: "",
			}),
		).toEqual({
			action: "list_events",
			start: "2026-07-08T00:00:00Z",
		});
	});
});

describe("runCalendarTool", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
	});

	it("returns a graceful note without throwing when there is no Calendar connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have a Calendar connection",
		);
		expect(outcome.modelPayload.events).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
		expect(googleListEventsMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity but still executes against the first (sorted) connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Google" });
		const connB = makeConn({ id: "conn-b", label: "Bob Google" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		googleListEventsMock.mockResolvedValue([]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(googleListEventsMock).toHaveBeenCalledWith(
			"user-1",
			"conn-a",
			expect.objectContaining({ timeMin: expect.any(String) }),
		);
		expect(outcome.modelPayload.message).toContain("2 Calendar connections");
		expect(outcome.modelPayload.message).toContain("Alice Google");
		expect(outcome.modelPayload.message).toContain("Bob Google");
	});

	it("list_events returns events and citations, defaulting to now..now+7d when unspecified", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
			},
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.events).toEqual([
			{
				id: "evt-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Standup", url: "https://calendar.google.com/event?eid=evt-1" },
		]);
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				id: "calendar:https://calendar.google.com/event?eid=evt-1",
				title: "Standup",
				sourceType: "tool",
			}),
		]);

		const call = googleListEventsMock.mock.calls[0]?.[2];
		expect(call).toMatchObject({ maxResults: 20 });
		const timeMin = new Date(call?.timeMin as string);
		const timeMax = new Date(call?.timeMax as string);
		expect(timeMax.getTime() - timeMin.getTime()).toBeCloseTo(
			7 * 24 * 60 * 60 * 1000,
			-3,
		);
	});

	it("check_availability summarizes free/busy", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleFreeBusyMock.mockResolvedValue([
			{
				calendarId: "primary",
				busy: [{ start: "2026-07-09T09:00:00Z", end: "2026-07-09T09:30:00Z" }],
			},
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "check_availability" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("check_availability");
		expect(outcome.modelPayload.busy).toEqual([
			{
				calendarId: "primary",
				busy: [{ start: "2026-07-09T09:00:00Z", end: "2026-07-09T09:30:00Z" }],
			},
		]);
		expect(outcome.modelPayload.message).toContain("1 busy interval");
	});

	it("maps needs_reauth adapter errors to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockRejectedValue(
			new GoogleCalendarError(
				"Google rejected the access token for this Calendar request",
				"needs_reauth",
			),
		);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
	});

	it("maps generic adapter failures to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleFreeBusyMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "check_availability" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"couldn't reach your calendar",
		);
	});
});

describe("runCalendarTool — locality Option A distillation gate", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);

		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Therapy session — anxiety follow-up",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				location: "123 Clinic Rd",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
			},
		]);
	});

	async function listOnce() {
		return runCalendarTool(
			"user-1",
			{ action: "list_events" },
			"whichever-model",
		);
	}

	it("Option A off: raw event details are returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await listOnce();

		expect(outcome.modelPayload.events[0]?.summary).toBe(
			"Therapy session — anxiety follow-up",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw event details are returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await listOnce();

		expect(outcome.modelPayload.events[0]?.summary).toBe(
			"Therapy session — anxiety follow-up",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the model-bound payload carries only the distilled summary — raw event details are absent, citations preserved", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One appointment in the morning.",
		});

		const outcome = await listOnce();

		const serializedEvents = JSON.stringify(outcome.modelPayload.events);
		expect(serializedEvents).not.toContain("Therapy session");
		expect(serializedEvents).not.toContain("Clinic Rd");
		expect(outcome.modelPayload.events[0]?.summary).toBeUndefined();
		expect(outcome.modelPayload.events[0]?.location).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"One appointment in the morning.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "calendar",
				rawText: expect.stringContaining("Therapy session"),
			}),
		);
		// Citations (event title + link — metadata, not sensitive content) are
		// kept, mirroring the files tool's posture on filenames.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({
				label: "Therapy session — anxiety follow-up",
				url: "https://calendar.google.com/event?eid=evt-1",
			}),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw event details are withheld, not leaked", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await listOnce();

		const serializedEvents = JSON.stringify(outcome.modelPayload.events);
		expect(serializedEvents).not.toContain("Therapy session");
		expect(serializedEvents).not.toContain("Clinic Rd");
		expect(outcome.modelPayload.message).toContain("withheld");
	});
});
