import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import type { ContactMatch } from "$lib/server/services/connections/providers/contacts";
import { resolveContacts } from "$lib/server/services/connections/providers/contacts";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import { runContactsTool, sanitizeContactsToolInput } from "./contacts";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/contacts", () => ({
	resolveContacts: vi.fn(),
}));
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const resolveContactsMock = vi.mocked(resolveContacts);
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
		capabilities: ["contacts"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeMatch(overrides: Partial<ContactMatch> = {}): ContactMatch {
	return {
		name: "Zsombor Kovács",
		emails: ["zsombor@example.com"],
		phones: [],
		source: "google",
		account: "alice@example.com",
		...overrides,
	};
}

beforeEach(() => {
	resolveConnectionsForCapabilityMock.mockReset();
	resolveContactsMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
});

describe("sanitizeContactsToolInput", () => {
	it("trims the query", () => {
		expect(
			sanitizeContactsToolInput({ action: "lookup", query: "  Zsombor  " }),
		).toEqual({ action: "lookup", query: "Zsombor" });
	});
});

describe("runContactsTool", () => {
	it("returns a graceful note without throwing when there is no Contacts connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runContactsTool(
			"user-1",
			{ action: "lookup", query: "Zsombor" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have a Contacts-capable connection",
		);
		expect(outcome.modelPayload.contacts).toEqual([]);
		expect(resolveContactsMock).not.toHaveBeenCalled();
	});

	it("returns a graceful 'no contact found' note when resolveContacts finds nothing", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		resolveContactsMock.mockResolvedValue([]);

		const outcome = await runContactsTool(
			"user-1",
			{ action: "lookup", query: "Nobody" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toContain(
			'No contact found matching "Nobody"',
		);
		expect(outcome.modelPayload.contacts).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
	});

	it("returns the single match directly when exactly one person matches", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		const match = makeMatch();
		resolveContactsMock.mockResolvedValue([match]);

		const outcome = await runContactsTool(
			"user-1",
			{ action: "lookup", query: "Zsombor" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.contacts).toEqual([match]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Zsombor Kovács", url: "" },
		]);
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Zsombor Kovács" }),
		]);
	});

	it("surfaces disambiguation when more than one distinct person matches", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		const matches = [
			makeMatch({ name: "Zsombor Kovács", emails: ["zsombor.k@example.com"] }),
			makeMatch({ name: "Zsombor Nagy", emails: ["zsombor.n@example.com"] }),
		];
		resolveContactsMock.mockResolvedValue(matches);

		const outcome = await runContactsTool(
			"user-1",
			{ action: "lookup", query: "Zsombor" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toContain("2 matching contacts");
		expect(outcome.modelPayload.message.toLowerCase()).toContain(
			"ask the user",
		);
		expect(outcome.modelPayload.contacts).toEqual(matches);
	});

	it("degrades gracefully (no throw) when resolveContacts itself rejects", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		resolveContactsMock.mockRejectedValue(new Error("boom"));

		const outcome = await runContactsTool(
			"user-1",
			{ action: "lookup", query: "Zsombor" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).not.toContain("boom");
		expect(outcome.modelPayload.contacts).toEqual([]);
	});
});

describe("runContactsTool — locality Option A distillation gate (whole-payload posture)", () => {
	const match = makeMatch({
		name: "Zsombor Kovács",
		emails: ["zsombor@example.com"],
		phones: ["+36-20-123-4567"],
	});

	beforeEach(() => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([makeConn()]);
		resolveContactsMock.mockResolvedValue([match]);
	});

	async function lookupOnce() {
		return runContactsTool(
			"user-1",
			{ action: "lookup", query: "Zsombor" },
			"whichever-model",
		);
	}

	it("Option A off: raw contact details are returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await lookupOnce();

		expect(outcome.modelPayload.contacts).toEqual([match]);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw contact details are returned unchanged and distill is not called", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await lookupOnce();

		expect(outcome.modelPayload.contacts).toEqual([match]);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the WHOLE model-facing payload has no raw name/email/phone — contacts array is wiped, citations redacted; Sources-tab candidates keep the real values", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One matching contact.",
		});

		const outcome = await lookupOnce();

		// The single most important assertion: no raw PII anywhere in the whole
		// model-facing payload, not just `contacts` — also not through
		// `citations` as a side channel.
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Zsombor Kovács");
		expect(serializedPayload).not.toContain("zsombor@example.com");
		expect(serializedPayload).not.toContain("+36-20-123-4567");
		expect(outcome.modelPayload.contacts).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Contact 1", url: "" },
		]);
		expect(outcome.modelPayload.message).toContain("One matching contact.");
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "contacts",
				rawText: expect.stringContaining("Zsombor Kovács"),
			}),
		);
		// The user's own Sources-tab candidates (recorded before the gate runs,
		// a different user-facing channel) may keep the real name.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Zsombor Kovács" }),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw contact details are withheld, not leaked", async () => {
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await lookupOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("Zsombor Kovács");
		expect(serializedPayload).not.toContain("zsombor@example.com");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Zsombor Kovács" }),
		]);
	});

	it("does not run the distill gate at all when there are zero matches (nothing raw to protect)", async () => {
		resolveContactsMock.mockResolvedValue([]);
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await lookupOnce();

		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
		expect(outcome.modelPayload.success).toBe(true);
	});
});
