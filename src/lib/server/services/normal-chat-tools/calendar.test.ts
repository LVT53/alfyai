import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	AppleCalDavError,
	appleGetEventByUid,
	appleListEvents,
} from "$lib/server/services/connections/providers/apple-caldav";
import {
	CalDavError,
	caldavGetEventByUid,
	caldavListEvents,
} from "$lib/server/services/connections/providers/caldav-tasks";
import {
	GoogleCalendarError,
	googleFreeBusy,
	googleGetEvent,
	googleListCalendars,
	googleListEvents,
} from "$lib/server/services/connections/providers/google-calendar";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import { runCalendarTool, sanitizeCalendarToolInput } from "./calendar";

// selectConnection/pickDefaultConnection are kept as their REAL (pure)
// implementations — only resolveConnectionsForCapability/needsDisambiguation
// (which touch the DB) are mocked, same posture as every other tool test
// file after the multi-connection disambiguation change.
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
			googleGetEvent: vi.fn(),
			googleListCalendars: vi.fn(),
		};
	},
);
vi.mock("$lib/server/services/connections/providers/apple-caldav", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/apple-caldav")
	>("$lib/server/services/connections/providers/apple-caldav");
	return {
		...actual,
		appleListEvents: vi.fn(),
		appleGetEventByUid: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/providers/caldav-tasks", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/caldav-tasks")
	>("$lib/server/services/connections/providers/caldav-tasks");
	return {
		...actual,
		caldavListEvents: vi.fn(),
		caldavGetEventByUid: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	createPendingWrite: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const googleListEventsMock = vi.mocked(googleListEvents);
const googleFreeBusyMock = vi.mocked(googleFreeBusy);
const googleGetEventMock = vi.mocked(googleGetEvent);
const googleListCalendarsMock = vi.mocked(googleListCalendars);
const appleListEventsMock = vi.mocked(appleListEvents);
const appleGetEventByUidMock = vi.mocked(appleGetEventByUid);
const caldavListEventsMock = vi.mocked(caldavListEvents);
const caldavGetEventByUidMock = vi.mocked(caldavGetEventByUid);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);
const createPendingWriteMock = vi.mocked(createPendingWrite);

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
		hasWriteSecret: false,
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
		appleListEventsMock.mockReset();
		appleGetEventByUidMock.mockReset();
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

	it("account:'google' routes to the Google connection even though Apple sorts first alphabetically", async () => {
		const apple = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "me@icloud.com",
		});
		const google = makeConn({
			id: "conn-google",
			provider: "google",
			label: "Google",
			accountIdentifier: "me@gmail.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([apple, google]);
		needsDisambiguationMock.mockReturnValue(true);
		googleListEventsMock.mockResolvedValue([]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events", account: "google" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(googleListEventsMock).toHaveBeenCalledWith(
			"user-1",
			"conn-google",
			expect.objectContaining({ timeMin: expect.any(String) }),
		);
		expect(appleListEventsMock).not.toHaveBeenCalled();
	});

	it("an account selector matching nothing returns a graceful listing message and never calls a provider", async () => {
		const apple = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
		});
		const google = makeConn({
			id: "conn-google",
			provider: "google",
			label: "Google",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([apple, google]);
		needsDisambiguationMock.mockReturnValue(true);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events", account: "microsoft" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Apple iCloud");
		expect(outcome.modelPayload.message).toContain("Google");
		expect(outcome.modelPayload.message).toContain('"microsoft"');
		expect(googleListEventsMock).not.toHaveBeenCalled();
		expect(appleListEventsMock).not.toHaveBeenCalled();
	});

	it("the ambiguity note mentions the account param so the model can target a different connection", async () => {
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

		expect(outcome.modelPayload.message).toContain("account:");
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

	// Task 11b — the agenda peek (ThinkingBlock's display-only calendar
	// widget) needs start/end/location on the candidate, not just the label/
	// url a Sources-tab link needs. These are the user's own event fields,
	// display-only (candidates never reach modelPayload), so no locality gate
	// applies to this metadata the way it applies to events[]/citations[].
	it("carries start/end/location on the candidate metadata for the agenda peek, leaving modelPayload untouched", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([
			{
				id: "evt-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				location: "Room 204",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
			},
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				id: "calendar:https://calendar.google.com/event?eid=evt-1",
				title: "Standup",
				metadata: expect.objectContaining({
					start: "2026-07-09T09:00:00-04:00",
					end: "2026-07-09T09:30:00-04:00",
					location: "Room 204",
				}),
			}),
		]);

		// modelPayload is completely unaffected by this candidate-only
		// addition — events[]/citations[] are exactly what they were before.
		expect(outcome.modelPayload.events).toEqual([
			{
				id: "evt-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				location: "Room 204",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Standup", url: "https://calendar.google.com/event?eid=evt-1" },
		]);
	});

	it("normalizes a date-only start/end into RFC3339 date-times (Google 400s on bare dates)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([]);

		await runCalendarTool(
			"user-1",
			{ action: "list_events", start: "2026-07-09", end: "2026-07-23" },
			LOCAL_MODEL_ID,
		);

		expect(googleListEventsMock).toHaveBeenCalledWith(
			"user-1",
			"conn-1",
			expect.objectContaining({
				timeMin: "2026-07-09T00:00:00.000Z",
				timeMax: "2026-07-23T23:59:59.999Z",
			}),
		);
	});

	it("passes a full RFC3339 start/end through as a valid timestamp", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([]);

		await runCalendarTool(
			"user-1",
			{
				action: "list_events",
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T17:00:00Z",
			},
			LOCAL_MODEL_ID,
		);

		const call = googleListEventsMock.mock.calls[0]?.[2];
		expect(new Date(call?.timeMin as string).toISOString()).toBe(
			"2026-07-09T09:00:00.000Z",
		);
		expect(new Date(call?.timeMax as string).toISOString()).toBe(
			"2026-07-09T17:00:00.000Z",
		);
	});

	it("falls back to the default range when a bound is unparseable rather than forwarding garbage", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([]);

		await runCalendarTool(
			"user-1",
			{ action: "list_events", start: "next monday", end: "sometime" },
			LOCAL_MODEL_ID,
		);

		const call = googleListEventsMock.mock.calls[0]?.[2];
		// Both bounds are valid ISO timestamps (the default now..now+7d range),
		// never the raw unparseable strings.
		expect(() => new Date(call?.timeMin as string).toISOString()).not.toThrow();
		expect(Number.isNaN(new Date(call?.timeMin as string).getTime())).toBe(
			false,
		);
		expect(Number.isNaN(new Date(call?.timeMax as string).getTime())).toBe(
			false,
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
		appleListEventsMock.mockReset();
		appleGetEventByUidMock.mockReset();
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

		// The single most important assertion: the raw event text must not
		// appear anywhere in the WHOLE model-facing payload — not just
		// `events`, but also `citations` (which used to leak the raw summary
		// verbatim via its `label`, see C1 of the 5.2 review).
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Therapy session");
		expect(serializedPayload).not.toContain("Clinic Rd");
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
		// The MODEL-facing citation label is redacted to a non-sensitive
		// placeholder — the raw event title must not reach the cloud model
		// through this side channel.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({
				label: "Calendar event at 2026-07-09T09:00:00-04:00",
				url: "https://calendar.google.com/event?eid=evt-1",
			}),
		]);
		// But the user's own Sources-tab candidates (a different, user-facing
		// channel — recorded separately from modelPayload) may keep the real
		// event title, since that's the user's own data on their own screen.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "Therapy session — anxiety follow-up",
				url: "https://calendar.google.com/event?eid=evt-1",
			}),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw event details are withheld, not leaked", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await listOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Therapy session");
		expect(serializedPayload).not.toContain("Clinic Rd");
		expect(outcome.modelPayload.message).toContain("withheld");
		// Candidates (Sources tab) still carry the real title in this branch too.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "Therapy session — anxiety follow-up",
			}),
		]);
	});
});

describe("runCalendarTool — provider dispatch (5.3)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		appleListEventsMock.mockReset();
		appleGetEventByUidMock.mockReset();
		caldavListEventsMock.mockReset();
		caldavGetEventByUidMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
	});

	it("list_events dispatches to caldavListEvents for a caldav connection, never touching appleListEvents/googleListEvents (Task 9b)", async () => {
		const conn = makeConn({
			id: "conn-caldav",
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: "alice",
			capabilities: ["calendar"],
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		caldavListEventsMock.mockResolvedValue([
			{
				id: "evt-caldav-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T09:15:00Z",
				htmlLink: "https://dav.example.com/cal/evt-caldav-1.ics",
				etag: '"etag-1"',
			},
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(caldavListEventsMock).toHaveBeenCalledWith(
			"user-1",
			"conn-caldav",
			expect.objectContaining({ timeMin: expect.any(String) }),
		);
		expect(appleListEventsMock).not.toHaveBeenCalled();
		expect(googleListEventsMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.events).toEqual([
			{
				id: "evt-caldav-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T09:15:00Z",
				htmlLink: "https://dav.example.com/cal/evt-caldav-1.ics",
			},
		]);
		expect(JSON.stringify(outcome.modelPayload)).not.toContain("etag-1");
	});

	it("maps a CalDAV needs_reauth adapter error to a graceful, generic (non-Apple) note", async () => {
		const conn = makeConn({
			id: "conn-caldav",
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: "alice",
			capabilities: ["calendar"],
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		caldavListEventsMock.mockRejectedValue(
			new CalDavError(
				"The server rejected the stored app password",
				"needs_reauth",
			),
		);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("CalDAV Calendar");
		expect(outcome.modelPayload.message).not.toContain("Apple");
		expect(outcome.modelPayload.message).toContain("reconnected");
	});

	it("check_availability with only a caldav connection returns a graceful note instead of calling any adapter", async () => {
		const conn = makeConn({
			id: "conn-caldav",
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: "alice",
			capabilities: ["calendar"],
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "check_availability" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"Google Calendar connection",
		);
		expect(googleFreeBusyMock).not.toHaveBeenCalled();
		expect(caldavListEventsMock).not.toHaveBeenCalled();
	});

	it("list_events dispatches to appleListEvents for an apple connection, never touching googleListEvents", async () => {
		const conn = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		appleListEventsMock.mockResolvedValue([
			{
				id: "evt-apple-1",
				summary: "Dentist",
				start: "2026-07-09T15:00:00Z",
				end: "2026-07-09T15:30:00Z",
				htmlLink: "https://p1-caldav.icloud.com/cal/evt-apple-1.ics",
				etag: '"etag-1"',
			},
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(appleListEventsMock).toHaveBeenCalledWith(
			"user-1",
			"conn-apple",
			expect.objectContaining({ timeMin: expect.any(String) }),
		);
		expect(googleListEventsMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.events).toEqual([
			{
				id: "evt-apple-1",
				summary: "Dentist",
				start: "2026-07-09T15:00:00Z",
				end: "2026-07-09T15:30:00Z",
				htmlLink: "https://p1-caldav.icloud.com/cal/evt-apple-1.ics",
			},
		]);
		// The internal-only `etag` field must never reach the model-facing
		// payload — it's carried on the provider's CalendarEvent purely for
		// Phase 6.2 writes.
		expect(JSON.stringify(outcome.modelPayload)).not.toContain("etag-1");
	});

	it("with BOTH a google and an apple connection, ambiguity is surfaced and the first (sorted) connection's provider is used", async () => {
		const googleConn = makeConn({
			id: "conn-google",
			provider: "google",
			label: "Alice Google",
		});
		const appleConn = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Bob Apple",
			accountIdentifier: "bob@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			googleConn,
			appleConn,
		]);
		needsDisambiguationMock.mockReturnValue(true);
		googleListEventsMock.mockResolvedValue([]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(googleListEventsMock).toHaveBeenCalledWith(
			"user-1",
			"conn-google",
			expect.objectContaining({ timeMin: expect.any(String) }),
		);
		expect(appleListEventsMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.message).toContain("2 Calendar connections");
		expect(outcome.modelPayload.message).toContain("Alice Google");
		expect(outcome.modelPayload.message).toContain("Bob Apple");
	});

	it("check_availability with only an apple connection returns a graceful note instead of calling any adapter", async () => {
		const appleConn = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([appleConn]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "check_availability" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"Google Calendar connection",
		);
		expect(googleFreeBusyMock).not.toHaveBeenCalled();
		expect(appleListEventsMock).not.toHaveBeenCalled();
	});

	it("check_availability with BOTH google and apple connections still uses google, ignoring apple", async () => {
		const googleConn = makeConn({ id: "conn-google", provider: "google" });
		const appleConn = makeConn({
			id: "conn-apple",
			provider: "apple",
			accountIdentifier: "alice@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([
			appleConn,
			googleConn,
		]);
		googleFreeBusyMock.mockResolvedValue([{ calendarId: "primary", busy: [] }]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "check_availability" },
			LOCAL_MODEL_ID,
		);

		expect(googleFreeBusyMock).toHaveBeenCalledWith(
			"user-1",
			"conn-google",
			expect.objectContaining({ timeMin: expect.any(String) }),
		);
		expect(outcome.modelPayload.success).toBe(true);
	});

	it("maps an Apple needs_reauth adapter error to a graceful note", async () => {
		const conn = makeConn({
			id: "conn-apple",
			provider: "apple",
			accountIdentifier: "alice@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		const { AppleCalDavError } = await import(
			"$lib/server/services/connections/providers/apple-caldav"
		);
		appleListEventsMock.mockRejectedValue(
			new AppleCalDavError(
				"Apple rejected the stored app-specific password",
				"needs_reauth",
			),
		);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("Apple iCloud Calendar");
		expect(outcome.modelPayload.message).toContain("reconnected");
	});
});

describe("runCalendarTool — locality Option A distillation with an apple event", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		appleListEventsMock.mockReset();
		appleGetEventByUidMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);

		const conn = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		appleListEventsMock.mockResolvedValue([
			{
				id: "evt-apple-1",
				summary: "Therapy session — anxiety follow-up",
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T09:30:00Z",
				location: "123 Clinic Rd",
				htmlLink: "https://p1-caldav.icloud.com/cal/evt-apple-1.ics",
				etag: '"etag-1"',
			},
		]);
	});

	it("Option A on + cloud model: the raw apple event summary/location are absent from the WHOLE model-facing payload, citations preserved on the user's Sources tab", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One appointment in the morning.",
		});

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			"whichever-model",
		);

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Therapy session");
		expect(serializedPayload).not.toContain("Clinic Rd");
		expect(serializedPayload).not.toContain("etag-1");
		expect(outcome.modelPayload.events[0]?.summary).toBeUndefined();
		expect(outcome.modelPayload.events[0]?.location).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"One appointment in the morning.",
		);
		// The user's own Sources-tab candidates may keep the real event title.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "Therapy session — anxiety follow-up",
			}),
		]);
	});
});

// Task 9b — confirms the generic caldav connector's list_events results flow
// through the SAME Option-A distill gate as apple's, above (the gate reads
// generically off outcome.modelPayload.events, so no provider-specific gate
// code is needed — this test documents/locks in that it actually applies).
describe("runCalendarTool — locality Option A distillation with a caldav event (Task 9b)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		caldavListEventsMock.mockReset();
		caldavGetEventByUidMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);

		const conn = makeConn({
			id: "conn-caldav",
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: "alice",
			capabilities: ["calendar"],
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		caldavListEventsMock.mockResolvedValue([
			{
				id: "evt-caldav-1",
				summary: "Therapy session — anxiety follow-up",
				start: "2026-07-09T09:00:00Z",
				end: "2026-07-09T09:30:00Z",
				location: "123 Clinic Rd",
				htmlLink: "https://dav.example.com/cal/evt-caldav-1.ics",
				etag: '"etag-1"',
			},
		]);
	});

	it("Option A on + cloud model: the raw caldav event summary/location are absent from the WHOLE model-facing payload, citations preserved on the user's Sources tab", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One appointment in the morning.",
		});

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events" },
			"whichever-model",
		);

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Therapy session");
		expect(serializedPayload).not.toContain("Clinic Rd");
		expect(serializedPayload).not.toContain("etag-1");
		expect(outcome.modelPayload.events[0]?.summary).toBeUndefined();
		expect(outcome.modelPayload.events[0]?.location).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"One appointment in the morning.",
		);
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "Therapy session — anxiety follow-up",
			}),
		]);
	});
});

describe("runCalendarTool — write actions (Issue 6.1)", () => {
	const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

	function makeWritableGoogleConn(
		overrides: Partial<ConnectionPublic> = {},
	): ConnectionPublic {
		return makeConn({
			allowWrites: true,
			oauthScopes: [WRITE_SCOPE],
			...overrides,
		});
	}

	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		googleGetEventMock.mockReset();
		appleListEventsMock.mockReset();
		appleGetEventByUidMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		createPendingWriteMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
		createPendingWriteMock.mockImplementation(async (_userId, params) => ({
			id: "pending-1",
			preview: params.preview,
		}));
	});

	// Task 9b: caldav writes are explicitly out of scope for this task (only
	// reads were generalized) — a caldav connection must keep degrading
	// gracefully through the existing "Google and Apple only for v1" gate
	// rather than creating a pending write.
	it("create_event on a caldav connection returns a graceful not-supported note and creates no pending write", async () => {
		const conn = makeConn({
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: "alice",
			allowWrites: true,
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runCalendarTool(
			"user-1",
			{
				action: "create_event",
				title: "Standup",
				start: "2026-07-10T09:00:00-04:00",
				end: "2026-07-10T09:30:00-04:00",
			},
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"only supported for Google and Apple",
		);
		expect(createPendingWriteMock).not.toHaveBeenCalled();
	});

	// The exact bug this task fixes: a user with both an Apple (writes off)
	// and a Google (writes on) calendar connection used to have every write
	// silently routed to Apple, because connections[0] is alphabetically
	// first ("Apple iCloud" < "Google"). With no explicit `account`, a write
	// action must now prefer the writes-enabled connection instead.
	it("create_event with no account and [Apple writes-off, Google writes-on] picks Google, not the alphabetically-first Apple", async () => {
		const apple = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "me@icloud.com",
			allowWrites: false,
		});
		const google = makeWritableGoogleConn({
			id: "conn-google",
			label: "Google",
			accountIdentifier: "me@gmail.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([apple, google]);
		needsDisambiguationMock.mockReturnValue(true);

		const outcome = await runCalendarTool(
			"user-1",
			{
				action: "create_event",
				title: "Standup",
				start: "2026-07-10T09:00:00-04:00",
				end: "2026-07-10T09:30:00-04:00",
			},
			LOCAL_MODEL_ID,
			"conv-1",
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		const call = createPendingWriteMock.mock.calls[0]?.[1];
		expect(call).toMatchObject({
			connectionId: "conn-google",
			provider: "google",
		});
	});

	describe("create_event", () => {
		it("allowWrites=true + write scope granted: returns a PENDING result (preview + id) and creates a pending row — never a real mutation", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "create_event",
					title: "Standup",
					start: "2026-07-10T09:00:00-04:00",
					end: "2026-07-10T09:30:00-04:00",
					location: "Zoom",
				},
				LOCAL_MODEL_ID,
				"conv-1",
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(outcome.modelPayload.action).toBe("create_event");
			expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
			expect(outcome.modelPayload.preview).toBeDefined();
			expect(outcome.modelPayload.message).toContain(
				"has NOT been created yet",
			);
			expect(outcome.modelPayload.message.toLowerCase()).toContain("confirm");

			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call).toMatchObject({
				connectionId: "conn-1",
				provider: "google",
				// 7.5 — threaded from ctx.conversationId.
				conversationId: "conv-1",
			});
			expect(call?.op).toMatchObject({
				provider: "google",
				connectionId: "conn-1",
				action: "calendar.create_event",
				destructive: false,
				reversible: true,
			});
			const content = JSON.parse(call?.content ?? "{}");
			expect(content).toEqual({
				calendarId: "primary",
				event: {
					summary: "Standup",
					start: "2026-07-10T09:00:00-04:00",
					end: "2026-07-10T09:30:00-04:00",
					location: "Zoom",
				},
			});
			// Create never reads an existing event off the connector — no locality
			// gate call, no adapter fetch beyond the (mocked) pending-write write.
			expect(googleGetEventMock).not.toHaveBeenCalled();
		});

		it("allowWrites=false: returns a note and creates NO pending row", async () => {
			const conn = makeWritableGoogleConn({ allowWrites: false });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "create_event",
					title: "Standup",
					start: "2026-07-10T09:00:00Z",
					end: "2026-07-10T09:30:00Z",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("turned off");
			expect(outcome.modelPayload.message).toContain("settings");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("missing calendar.events write scope: returns a note asking to reconnect and grant write access, creates NO pending row", async () => {
			const conn = makeWritableGoogleConn({ oauthScopes: [] });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "create_event",
					title: "Standup",
					start: "2026-07-10T09:00:00Z",
					end: "2026-07-10T09:30:00Z",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("reconnect Google");
			expect(outcome.modelPayload.message).toContain("write access");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("an apple calendar connection missing its calendarUrls config is refused with a note, no pending row (6.2 now supports Apple writes, but only once discovery has actually populated the connection's config)", async () => {
			const conn = makeWritableGoogleConn({ provider: "apple", config: {} });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "create_event",
					title: "Standup",
					start: "2026-07-10T09:00:00Z",
					end: "2026-07-10T09:30:00Z",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("Apple");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("an unsupported provider (neither google nor apple) is refused, no pending row", async () => {
			const conn = makeWritableGoogleConn({ provider: "imap" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "create_event",
					title: "Standup",
					start: "2026-07-10T09:00:00Z",
					end: "2026-07-10T09:30:00Z",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("Google and Apple iCloud");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("requires title, start, and end — missing any of them returns a note with no pending row", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "create_event", title: "Standup" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("required");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});
	});

	describe("update_event / delete_event", () => {
		function existingEvent(
			overrides: Partial<
				import("$lib/server/services/connections/providers/google-calendar").CalendarEvent
			> = {},
		) {
			return {
				id: "evt-1",
				summary: "Therapy session — anxiety follow-up",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				location: "123 Clinic Rd",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
				...overrides,
			};
		}

		it("requires an eventId — missing it returns a note with no pending row and no googleGetEvent call", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "update_event", title: "New title" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("required");
			expect(googleGetEventMock).not.toHaveBeenCalled();
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("non-recurring event: update_event creates a pending row with the changed fields only", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(existingEvent());

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "update_event", eventId: "evt-1", location: "New Room" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call?.op).toMatchObject({
				action: "calendar.update_event",
				destructive: true,
				reversible: true,
				target: { id: "evt-1", label: "Therapy session — anxiety follow-up" },
			});
			const content = JSON.parse(call?.content ?? "{}");
			expect(content).toEqual({
				calendarId: "primary",
				eventId: "evt-1",
				event: { location: "New Room" },
			});
		});

		it("delete_event on a not-found event returns a note, no pending row", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(null);

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "delete_event", eventId: "evt-missing" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain(
				"couldn't find that event",
			);
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("a needs_reauth error fetching the target event maps to a graceful note, no pending row", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockRejectedValue(
				new GoogleCalendarError("nope", "needs_reauth"),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "update_event", eventId: "evt-1", location: "New Room" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("reconnected");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("recurring instance WITHOUT recurringScope: asks the user to choose, creates NO pending row", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(
				existingEvent({ recurringEventId: "evt-master" }),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "update_event", eventId: "evt-1", location: "New Room" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message.toLowerCase()).toContain("recurring");
			expect(outcome.modelPayload.message.toLowerCase()).toContain("series");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("recurring master WITHOUT recurringScope (detected via `recurrence`): also asks the user to choose, no pending row", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(
				existingEvent({ recurrence: ["RRULE:FREQ=WEEKLY"] }),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "delete_event", eventId: "evt-master" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message.toLowerCase()).toContain("recurring");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it('recurring MASTER with recurringScope "this_event": asks the user to pick an occurrence (or the whole series) instead, creates NO pending row — "this event only" can\'t apply to the series definition itself', async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(
				existingEvent({
					id: "evt-master",
					recurrence: ["RRULE:FREQ=WEEKLY"],
				}),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "update_event",
					eventId: "evt-master",
					location: "New Room",
					recurringScope: "this_event",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message.toLowerCase()).toContain(
				"occurrence",
			);
			expect(outcome.modelPayload.message.toLowerCase()).toContain("series");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it('recurring MASTER with recurringScope "this_event" on delete_event: same guard applies, creates NO pending row', async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(
				existingEvent({
					id: "evt-master",
					recurrence: ["RRULE:FREQ=WEEKLY"],
				}),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "delete_event",
					eventId: "evt-master",
					recurringScope: "this_event",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message.toLowerCase()).toContain(
				"occurrence",
			);
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it('recurring MASTER with recurringScope "series": still proceeds and creates a pending row (series-scoped writes on the master remain allowed)', async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(
				existingEvent({
					id: "evt-master",
					recurrence: ["RRULE:FREQ=WEEKLY"],
				}),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "update_event",
					eventId: "evt-master",
					location: "New Room",
					recurringScope: "series",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
		});

		it("recurring instance WITH recurringScope: proposes the pending write, carrying the scope through to content", async () => {
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(
				existingEvent({ recurringEventId: "evt-master" }),
			);

			const outcome = await runCalendarTool(
				"user-1",
				{
					action: "update_event",
					eventId: "evt-1",
					location: "New Room",
					recurringScope: "this_event",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			const content = JSON.parse(call?.content ?? "{}");
			expect(content).toEqual({
				calendarId: "primary",
				eventId: "evt-1",
				event: { location: "New Room" },
				recurringScope: "this_event",
			});
		});

		it("Option A on + cloud model: the update preview reads an existing event, but its raw summary/location are absent from the WHOLE model-facing payload", async () => {
			hasLocalDistillEnabledMock.mockResolvedValue(true);
			isCloudModelMock.mockResolvedValue(true);
			distillConnectorPayloadMock.mockResolvedValue({
				distilled: "A therapy appointment.",
			});
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(existingEvent());

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "update_event", eventId: "evt-1", location: "New Room" },
				"whichever-cloud-model",
			);

			expect(outcome.modelPayload.success).toBe(true);
			const serializedPayload = JSON.stringify(outcome.modelPayload);
			expect(serializedPayload).not.toContain("Therapy session");
			expect(serializedPayload).not.toContain("Clinic Rd");
			expect(outcome.modelPayload.message).toContain("A therapy appointment.");
			expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					capability: "calendar",
					rawText: expect.stringContaining("Therapy session"),
				}),
			);

			// The row actually persisted to the DB (createPendingWrite's `preview`
			// argument — what a future confirm-card UI would source) keeps the
			// REAL data; only the model-facing copy returned in modelPayload is
			// redacted. This is never sent back through the model.
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call?.preview.title).toContain("Therapy session");
		});

		it("Option A off: the update preview/message keep the real event title (no distill call)", async () => {
			hasLocalDistillEnabledMock.mockResolvedValue(false);
			isCloudModelMock.mockResolvedValue(true);
			const conn = makeWritableGoogleConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleGetEventMock.mockResolvedValue(existingEvent());

			const outcome = await runCalendarTool(
				"user-1",
				{ action: "update_event", eventId: "evt-1", location: "New Room" },
				"whichever-cloud-model",
			);

			expect(outcome.modelPayload.message).toContain("Therapy session");
			expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
		});
	});

	describe("Apple write actions (Issue 6.2)", () => {
		function makeWritableAppleConn(
			overrides: Partial<ConnectionPublic> = {},
		): ConnectionPublic {
			return makeConn({
				provider: "apple",
				allowWrites: true,
				config: {
					appleId: "alice@icloud.com",
					calendarUrls: ["https://p12-caldav.icloud.com/12345/calendars/home/"],
				},
				...overrides,
			});
		}

		function existingAppleEvent(
			overrides: Partial<
				import("$lib/server/services/connections/providers/google-calendar").CalendarEvent
			> = {},
		) {
			return {
				id: "evt-apple-1@icloud.com",
				summary: "Therapy session — anxiety follow-up",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				location: "123 Clinic Rd",
				htmlLink:
					"https://p12-caldav.icloud.com/12345/calendars/home/evt-apple-1.ics",
				etag: '"etag-1"',
				// The original resource text the corruption-safety fix's
				// preserve-and-patch update PATCHES in place (see
				// AppleCalendarWriteContent.originalIcs's doc comment) — a
				// realistic fixture so update tests exercise the real
				// isUpdate-requires-rawIcs gate rather than tripping it by
				// accident.
				rawIcs: [
					"BEGIN:VCALENDAR",
					"VERSION:2.0",
					"BEGIN:VEVENT",
					"UID:evt-apple-1@icloud.com",
					"DTSTAMP:20260701T120000Z",
					"SUMMARY:Therapy session — anxiety follow-up",
					"DTSTART:20260709T130000Z",
					"DTEND:20260709T133000Z",
					"LOCATION:123 Clinic Rd",
					"END:VEVENT",
					"END:VCALENDAR",
				].join("\r\n"),
				...overrides,
			};
		}

		beforeEach(() => {
			resolveConnectionsForCapabilityMock.mockReset();
			needsDisambiguationMock.mockReset();
			appleGetEventByUidMock.mockReset();
			hasLocalDistillEnabledMock.mockReset();
			isCloudModelMock.mockReset();
			distillConnectorPayloadMock.mockReset();
			createPendingWriteMock.mockReset();
			needsDisambiguationMock.mockReturnValue(false);
			hasLocalDistillEnabledMock.mockResolvedValue(false);
			isCloudModelMock.mockResolvedValue(false);
			createPendingWriteMock.mockImplementation(async (_userId, params) => ({
				id: "pending-1",
				preview: params.preview,
			}));
		});

		describe("create_event", () => {
			it("allowWrites=true + valid calendarUrls config: returns a PENDING result and creates a pending row with provider 'apple'", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "create_event",
						title: "Standup",
						start: "2026-07-10T09:00:00Z",
						end: "2026-07-10T09:30:00Z",
						location: "Zoom",
					},
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(true);
				expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
				expect(outcome.modelPayload.message).toContain("Apple iCloud Calendar");
				expect(outcome.modelPayload.message).toContain(
					"has NOT been created yet",
				);

				expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
				const call = createPendingWriteMock.mock.calls[0]?.[1];
				expect(call).toMatchObject({
					connectionId: "conn-1",
					provider: "apple",
				});
				expect(call?.op).toMatchObject({
					provider: "apple",
					action: "calendar.create_event",
					destructive: false,
				});
				const content = JSON.parse(call?.content ?? "{}");
				expect(content).toEqual({
					calendarUrl: "https://p12-caldav.icloud.com/12345/calendars/home/",
					event: {
						summary: "Standup",
						start: "2026-07-10T09:00:00Z",
						end: "2026-07-10T09:30:00Z",
						location: "Zoom",
					},
				});
			});

			it("allowWrites=false: returns a note and creates NO pending row", async () => {
				const conn = makeWritableAppleConn({ allowWrites: false });
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "create_event",
						title: "Standup",
						start: "2026-07-10T09:00:00Z",
						end: "2026-07-10T09:30:00Z",
					},
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(false);
				expect(outcome.modelPayload.message).toContain("turned off");
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});

			it("missing calendarUrls in config: returns a note and creates NO pending row", async () => {
				const conn = makeWritableAppleConn({ config: { appleId: "a@b.com" } });
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "create_event",
						title: "Standup",
						start: "2026-07-10T09:00:00Z",
						end: "2026-07-10T09:30:00Z",
					},
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(false);
				expect(outcome.modelPayload.message).toContain("Apple");
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});
		});

		describe("update_event / delete_event", () => {
			it("requires an eventId — missing it returns a note with no pending row and no appleGetEventByUid call", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

				const outcome = await runCalendarTool(
					"user-1",
					{ action: "update_event", title: "New title" },
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(false);
				expect(appleGetEventByUidMock).not.toHaveBeenCalled();
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});

			it("non-recurring event: update_event fetches by uid and creates a pending row carrying resourceHref/etag/uid and the FULL merged event (CalDAV PUT replaces the whole resource)", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(existingAppleEvent());

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "update_event",
						eventId: "evt-apple-1@icloud.com",
						location: "New Room",
					},
					LOCAL_MODEL_ID,
				);

				expect(appleGetEventByUidMock).toHaveBeenCalledWith(
					"user-1",
					"conn-1",
					"evt-apple-1@icloud.com",
				);
				expect(outcome.modelPayload.success).toBe(true);
				expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
				expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
				const call = createPendingWriteMock.mock.calls[0]?.[1];
				expect(call).toMatchObject({ provider: "apple" });
				expect(call?.op).toMatchObject({
					provider: "apple",
					action: "calendar.update_event",
					destructive: true,
					reversible: false,
				});
				const content = JSON.parse(call?.content ?? "{}");
				expect(content).toEqual({
					resourceHref:
						"https://p12-caldav.icloud.com/12345/calendars/home/evt-apple-1.ics",
					etag: '"etag-1"',
					uid: "evt-apple-1@icloud.com",
					// Corruption-safety fix: the executor PATCHES this original text
					// in place rather than regenerating a fresh VEVENT — see
					// AppleCalendarWriteContent.originalIcs's doc comment.
					originalIcs: existingAppleEvent().rawIcs,
					event: {
						summary: "Therapy session — anxiety follow-up",
						start: "2026-07-09T09:00:00-04:00",
						end: "2026-07-09T09:30:00-04:00",
						location: "New Room",
					},
					recurring: false,
				});
			});

			it("recurring event: update_event is refused BEFORE any pending write is created, even though the event was already fetched", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(
					existingAppleEvent({ recurrence: ["FREQ=WEEKLY"] }),
				);

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "update_event",
						eventId: "evt-apple-1@icloud.com",
						location: "New Room",
					},
					LOCAL_MODEL_ID,
				);

				expect(appleGetEventByUidMock).toHaveBeenCalledTimes(1);
				expect(outcome.modelPayload.success).toBe(false);
				expect(outcome.modelPayload.message.toLowerCase()).toContain(
					"recurring",
				);
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});

			it("recurring event: delete_event IS allowed, and the preview clearly states it deletes the whole series", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(
					existingAppleEvent({ recurrence: ["FREQ=WEEKLY"] }),
				);

				const outcome = await runCalendarTool(
					"user-1",
					{ action: "delete_event", eventId: "evt-apple-1@icloud.com" },
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(true);
				expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
				const call = createPendingWriteMock.mock.calls[0]?.[1];
				expect(call?.preview.warnings.join(" ")).toContain(
					"ENTIRE recurring series",
				);
				const content = JSON.parse(call?.content ?? "{}");
				expect(content).toMatchObject({ recurring: true });
			});

			it("delete_event on a not-found event returns a note, no pending row", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(null);

				const outcome = await runCalendarTool(
					"user-1",
					{ action: "delete_event", eventId: "evt-missing" },
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(false);
				expect(outcome.modelPayload.message).toContain(
					"couldn't find that event",
				);
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});

			it("a needs_reauth error fetching the target event maps to a graceful note, no pending row", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockRejectedValue(
					new AppleCalDavError("nope", "needs_reauth"),
				);

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "update_event",
						eventId: "evt-apple-1@icloud.com",
						location: "New Room",
					},
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(false);
				expect(outcome.modelPayload.message).toContain("reconnected");
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});

			it("an event missing an etag is refused rather than proposing an unconditional write, no pending row", async () => {
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(
					existingAppleEvent({ etag: undefined }),
				);

				const outcome = await runCalendarTool(
					"user-1",
					{ action: "delete_event", eventId: "evt-apple-1@icloud.com" },
					LOCAL_MODEL_ID,
				);

				expect(outcome.modelPayload.success).toBe(false);
				expect(createPendingWriteMock).not.toHaveBeenCalled();
			});

			it("Option A on + cloud model: the update preview reads an existing event, but its raw summary/location are absent from the WHOLE model-facing payload", async () => {
				hasLocalDistillEnabledMock.mockResolvedValue(true);
				isCloudModelMock.mockResolvedValue(true);
				distillConnectorPayloadMock.mockResolvedValue({
					distilled: "A therapy appointment.",
				});
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(existingAppleEvent());

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "update_event",
						eventId: "evt-apple-1@icloud.com",
						location: "New Room",
					},
					"whichever-cloud-model",
				);

				expect(outcome.modelPayload.success).toBe(true);
				const serializedPayload = JSON.stringify(outcome.modelPayload);
				expect(serializedPayload).not.toContain("Therapy session");
				expect(serializedPayload).not.toContain("Clinic Rd");
				expect(outcome.modelPayload.message).toContain(
					"A therapy appointment.",
				);

				const call = createPendingWriteMock.mock.calls[0]?.[1];
				expect(call?.preview.title).toContain("Therapy session");
			});

			it("Option A off: the update preview/message keep the real event title (no distill call)", async () => {
				hasLocalDistillEnabledMock.mockResolvedValue(false);
				isCloudModelMock.mockResolvedValue(true);
				const conn = makeWritableAppleConn();
				resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
				appleGetEventByUidMock.mockResolvedValue(existingAppleEvent());

				const outcome = await runCalendarTool(
					"user-1",
					{
						action: "update_event",
						eventId: "evt-apple-1@icloud.com",
						location: "New Room",
					},
					"whichever-cloud-model",
				);

				expect(outcome.modelPayload.message).toContain("Therapy session");
				expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Multi-calendar reads (Gap A5 + Trap C1). Before this, the schema exposed
// `calendarId` and honored it for writes, but every list_events/
// check_availability read silently hit `primary` regardless — a scoped read
// looked like it worked but returned the wrong calendar with no error. These
// tests pin that `calendarId` now threads through to googleListEvents /
// googleFreeBusy, that omitting it preserves the primary default, that the
// new list_calendars action surfaces discoverable ids, and that an Apple
// connection (which can't scope a CalDAV read) surfaces the limitation
// instead of silently misleading.
// ---------------------------------------------------------------------------
describe("runCalendarTool — multi-calendar reads (Gap A5 + Trap C1)", () => {
	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		googleListCalendarsMock.mockReset();
		appleListEventsMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		distillConnectorPayloadMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
	});

	it("list_events threads a non-primary calendarId through to googleListEvents (Trap C1: reads used to silently hit primary)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([]);

		await runCalendarTool(
			"user-1",
			{ action: "list_events", calendarId: "work@group.calendar.google.com" },
			LOCAL_MODEL_ID,
		);

		const call = googleListEventsMock.mock.calls[0]?.[2];
		expect(call?.calendarId).toBe("work@group.calendar.google.com");
	});

	it("list_events without a calendarId does not pin one, preserving the primary default", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListEventsMock.mockResolvedValue([]);

		await runCalendarTool("user-1", { action: "list_events" }, LOCAL_MODEL_ID);

		const call = googleListEventsMock.mock.calls[0]?.[2];
		expect(call?.calendarId).toBeUndefined();
	});

	it("check_availability scopes googleFreeBusy to a supplied calendarId", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleFreeBusyMock.mockResolvedValue([
			{ calendarId: "work@group.calendar.google.com", busy: [] },
		]);

		await runCalendarTool(
			"user-1",
			{
				action: "check_availability",
				calendarId: "work@group.calendar.google.com",
			},
			LOCAL_MODEL_ID,
		);

		const call = googleFreeBusyMock.mock.calls[0]?.[2];
		expect(call?.calendarIds).toEqual(["work@group.calendar.google.com"]);
	});

	it("check_availability without a calendarId leaves freeBusy on its primary default", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleFreeBusyMock.mockResolvedValue([{ calendarId: "primary", busy: [] }]);

		await runCalendarTool(
			"user-1",
			{ action: "check_availability" },
			LOCAL_MODEL_ID,
		);

		const call = googleFreeBusyMock.mock.calls[0]?.[2];
		expect(call?.calendarIds).toBeUndefined();
	});

	it("list_calendars returns the calendars from googleListCalendars so the model can discover ids", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		googleListCalendarsMock.mockResolvedValue([
			{ id: "primary", summary: "Alice", primary: true },
			{ id: "work@group.calendar.google.com", summary: "Work" },
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_calendars" },
			LOCAL_MODEL_ID,
		);

		expect(googleListCalendarsMock).toHaveBeenCalledWith("user-1", "conn-1");
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("list_calendars");
		expect(outcome.modelPayload.calendars).toEqual([
			{ id: "primary", summary: "Alice", primary: true },
			{ id: "work@group.calendar.google.com", summary: "Work" },
		]);
	});

	it("list_calendars surfaces ambiguity but still enumerates the first Google connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Google" });
		const connB = makeConn({ id: "conn-b", label: "Bob Google" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		googleListCalendarsMock.mockResolvedValue([
			{ id: "primary", summary: "Alice", primary: true },
		]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_calendars" },
			LOCAL_MODEL_ID,
		);

		expect(googleListCalendarsMock).toHaveBeenCalledWith("user-1", "conn-a");
		expect(outcome.modelPayload.message).toContain("2 Calendar connections");
	});

	it("list_events on an Apple connection ignores a non-primary calendarId (appleListEvents has no such param) and says it's using the default", async () => {
		const conn = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		appleListEventsMock.mockResolvedValue([]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_events", calendarId: "work@group.calendar.google.com" },
			LOCAL_MODEL_ID,
		);

		const call = appleListEventsMock.mock.calls[0]?.[2];
		expect(call).not.toHaveProperty("calendarId");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("default");
	});

	it("list_calendars on an Apple-only connection surfaces the CalDAV calendar collections and notes reads can't be scoped", async () => {
		const conn = makeConn({
			id: "conn-apple",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
			config: {
				calendarUrls: [
					"https://p12-caldav.icloud.com/12345/calendars/home/",
					"https://p12-caldav.icloud.com/12345/calendars/work/",
				],
			},
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_calendars" },
			LOCAL_MODEL_ID,
		);

		expect(googleListCalendarsMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.calendars.map((c) => c.summary)).toEqual([
			"home",
			"work",
		]);
		expect(outcome.modelPayload.message.toLowerCase()).toContain("scope");
	});

	// Task 9b
	it("list_calendars on a caldav-only connection surfaces the discovered calendar collections and notes reads can't be scoped", async () => {
		const conn = makeConn({
			id: "conn-caldav",
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: "alice",
			capabilities: ["calendar"],
			config: {
				calendarUrls: [
					"https://dav.example.com/dav/calendars/alice/personal/",
					"https://dav.example.com/dav/calendars/alice/work/",
				],
			},
		});
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runCalendarTool(
			"user-1",
			{ action: "list_calendars" },
			LOCAL_MODEL_ID,
		);

		expect(googleListCalendarsMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.calendars.map((c) => c.summary)).toEqual([
			"personal",
			"work",
		]);
		expect(outcome.modelPayload.message).not.toContain("Apple");
		expect(outcome.modelPayload.message.toLowerCase()).toContain("scope");
	});
});
