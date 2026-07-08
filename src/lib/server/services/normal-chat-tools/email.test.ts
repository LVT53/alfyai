import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import {
	ImapError,
	imapListRecent,
	imapReadMessage,
	imapSearch,
} from "$lib/server/services/connections/providers/imap";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";

import { runEmailTool, sanitizeEmailToolInput } from "./email";

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveConnectionsForCapability: vi.fn(),
	needsDisambiguation: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/imap", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/imap")
	>("$lib/server/services/connections/providers/imap");
	return {
		...actual,
		imapListRecent: vi.fn(),
		imapSearch: vi.fn(),
		imapReadMessage: vi.fn(),
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
const imapListRecentMock = vi.mocked(imapListRecent);
const imapSearchMock = vi.mocked(imapSearch);
const imapReadMessageMock = vi.mocked(imapReadMessage);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);

const LOCAL_MODEL_ID = "model1";

function makeConn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "imap",
		label: "Email",
		accountIdentifier: "alice@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["email"],
		config: {},
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
	imapListRecentMock.mockReset();
	imapSearchMock.mockReset();
	imapReadMessageMock.mockReset();
	hasLocalDistillEnabledMock.mockReset();
	isCloudModelMock.mockReset();
	distillConnectorPayloadMock.mockReset();
	needsDisambiguationMock.mockReturnValue(false);
	hasLocalDistillEnabledMock.mockResolvedValue(false);
	isCloudModelMock.mockResolvedValue(false);
}

describe("sanitizeEmailToolInput", () => {
	it("trims optional fields and drops empty strings", () => {
		expect(
			sanitizeEmailToolInput({
				action: "search",
				query: "  invoice  ",
			}),
		).toEqual({ action: "search", query: "invoice" });
	});

	it("keeps uid/unseenOnly when present, even when falsy", () => {
		expect(
			sanitizeEmailToolInput({ action: "recent", unseenOnly: false }),
		).toEqual({ action: "recent", unseenOnly: false });
		expect(sanitizeEmailToolInput({ action: "read", uid: 0 })).toEqual({
			action: "read",
			uid: 0,
		});
	});
});

describe("runEmailTool", () => {
	beforeEach(resetAllMocks);

	it("returns a graceful note without throwing when there is no Email connection", async () => {
		resolveConnectionsForCapabilityMock.mockResolvedValue([]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "recent" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain(
			"don't have an Email connection",
		);
		expect(outcome.modelPayload.messages).toEqual([]);
		expect(outcome.modelPayload.citations).toEqual([]);
		expect(imapListRecentMock).not.toHaveBeenCalled();
	});

	it("surfaces ambiguity but still executes against the first (sorted) connection", async () => {
		const connA = makeConn({ id: "conn-a", label: "Alice Mail" });
		const connB = makeConn({ id: "conn-b", label: "Bob Mail" });
		resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
		needsDisambiguationMock.mockReturnValue(true);
		imapListRecentMock.mockResolvedValue([]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "recent" },
			LOCAL_MODEL_ID,
		);

		expect(imapListRecentMock).toHaveBeenCalledWith(
			"user-1",
			"conn-a",
			expect.objectContaining({}),
		);
		expect(outcome.modelPayload.message).toContain("2 Email connections");
		expect(outcome.modelPayload.message).toContain("Alice Mail");
		expect(outcome.modelPayload.message).toContain("Bob Mail");
	});

	it("recent: returns messages and citations with an empty (non-linking) url", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapListRecentMock.mockResolvedValue([
			{
				uid: 5,
				from: "Bob <bob@example.com>",
				subject: "Standup notes",
				date: "2026-07-08T09:00:00.000Z",
				seen: false,
			},
		]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "recent", unseenOnly: true },
			LOCAL_MODEL_ID,
		);

		expect(imapListRecentMock).toHaveBeenCalledWith("user-1", "conn-1", {
			unseenOnly: true,
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.messages).toEqual([
			{
				uid: 5,
				from: "Bob <bob@example.com>",
				subject: "Standup notes",
				date: "2026-07-08T09:00:00.000Z",
				seen: false,
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Standup notes", url: "" },
		]);
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				id: "email:5",
				title: "Standup notes",
				sourceType: "tool",
			}),
		]);
	});

	it("search: requires a query", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "search" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("search query is required");
		expect(imapSearchMock).not.toHaveBeenCalled();
	});

	it("search: forwards the query and returns matching messages", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapSearchMock.mockResolvedValue([
			{
				uid: 9,
				from: "billing@vendor.com",
				subject: "Invoice #123",
				date: "2026-07-01T00:00:00.000Z",
				seen: true,
			},
		]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "search", query: "invoice" },
			LOCAL_MODEL_ID,
		);

		expect(imapSearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			query: "invoice",
		});
		expect(outcome.modelPayload.action).toBe("search");
		expect(outcome.modelPayload.message).toContain("1 message");
	});

	it("read: requires a uid", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "read" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("uid is required");
		expect(imapReadMessageMock).not.toHaveBeenCalled();
	});

	it("read: returns the header and body text", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapReadMessageMock.mockResolvedValue({
			header: {
				uid: 42,
				from: "carol@example.com",
				subject: "Weekend plans",
				date: "2026-07-05T00:00:00.000Z",
				seen: true,
			},
			text: "Want to grab lunch on Saturday?",
		});

		const outcome = await runEmailTool(
			"user-1",
			{ action: "read", uid: 42 },
			LOCAL_MODEL_ID,
		);

		expect(imapReadMessageMock).toHaveBeenCalledWith("user-1", "conn-1", {
			uid: 42,
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.text).toBe("Want to grab lunch on Saturday?");
		expect(outcome.modelPayload.messages).toEqual([
			{
				uid: 42,
				from: "carol@example.com",
				subject: "Weekend plans",
				date: "2026-07-05T00:00:00.000Z",
				seen: true,
			},
		]);
		expect(outcome.modelPayload.citations).toEqual([
			{ label: "Weekend plans", url: "" },
		]);
	});

	it("maps needs_reauth adapter errors to a graceful note", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapListRecentMock.mockRejectedValue(
			new ImapError("The mailbox rejected the stored password", "needs_reauth"),
		);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "recent" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
	});

	it("maps generic adapter failures to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapSearchMock.mockRejectedValue(new Error("network exploded"));

		const outcome = await runEmailTool(
			"user-1",
			{ action: "search", query: "x" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("couldn't reach your email");
	});
});

describe("runEmailTool — locality Option A distillation gate", () => {
	beforeEach(resetAllMocks);

	function seedRecent() {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapListRecentMock.mockResolvedValue([
			{
				uid: 1,
				from: "Dr. Smith <smith@clinic.example>",
				subject: "Your lab results — follow up needed",
				date: "2026-07-08T09:00:00.000Z",
				seen: false,
			},
		]);
	}

	async function listOnce() {
		return runEmailTool("user-1", { action: "recent" }, "whichever-model");
	}

	it("Option A off: raw message details are returned unchanged and distill is not called", async () => {
		seedRecent();
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(true);

		const outcome = await listOnce();

		expect(outcome.modelPayload.messages[0]?.subject).toBe(
			"Your lab results — follow up needed",
		);
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + local model: raw message details are returned unchanged and distill is not called", async () => {
		seedRecent();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(false);

		const outcome = await listOnce();

		expect(outcome.modelPayload.messages[0]?.from).toContain("Dr. Smith");
		expect(distillConnectorPayloadMock).not.toHaveBeenCalled();
	});

	it("Option A on + cloud model: the ENTIRE model-bound payload carries only the distilled summary — raw subject/sender absent, citations preserved on the Sources tab", async () => {
		seedRecent();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One unread message about a medical follow-up.",
		});

		const outcome = await listOnce();

		// The single most important assertion: the raw subject/sender must not
		// appear ANYWHERE in the whole model-facing payload — not just
		// `messages`, but also `citations`.
		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("lab results");
		expect(serializedPayload).not.toContain("Dr. Smith");
		expect(serializedPayload).not.toContain("smith@clinic.example");
		expect(outcome.modelPayload.messages[0]?.subject).toBeUndefined();
		expect(outcome.modelPayload.messages[0]?.from).toBeUndefined();
		expect(outcome.modelPayload.message).toContain(
			"One unread message about a medical follow-up.",
		);
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				capability: "email",
				rawText: expect.stringContaining("lab results"),
			}),
		);
		// The MODEL-facing citation label is redacted — the raw subject must
		// never reach the cloud model through this side channel.
		expect(outcome.modelPayload.citations).toEqual([
			expect.objectContaining({
				label: "Email message at 2026-07-08T09:00:00.000Z",
				url: "",
			}),
		]);
		// The user's own Sources-tab candidates may keep the real subject,
		// since that's the user's own data on their own screen.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "Your lab results — follow up needed",
			}),
		]);
	});

	it("Option A on + cloud model + distill unavailable: raw details are withheld, not leaked", async () => {
		seedRecent();
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({ unavailable: true });

		const outcome = await listOnce();

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("lab results");
		expect(serializedPayload).not.toContain("Dr. Smith");
		expect(outcome.modelPayload.message).toContain("withheld");
		expect(outcome.candidates).toEqual([
			expect.objectContaining({
				title: "Your lab results — follow up needed",
			}),
		]);
	});

	it("Option A on + cloud model, read action: the message body text is dropped from the model payload entirely", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapReadMessageMock.mockResolvedValue({
			header: {
				uid: 7,
				from: "therapist@clinic.example",
				subject: "Session recap",
				date: "2026-07-06T00:00:00.000Z",
				seen: true,
			},
			text: "Notes from today's anxiety therapy session: ...",
		});
		hasLocalDistillEnabledMock.mockResolvedValue(true);
		isCloudModelMock.mockResolvedValue(true);
		distillConnectorPayloadMock.mockResolvedValue({
			distilled: "One message summarizing a prior appointment.",
		});

		const outcome = await runEmailTool(
			"user-1",
			{ action: "read", uid: 7 },
			"whichever-model",
		);

		const serializedPayload = JSON.stringify(outcome.modelPayload);
		expect(serializedPayload).not.toContain("anxiety therapy");
		expect(serializedPayload).not.toContain("Session recap");
		expect(serializedPayload).not.toContain("therapist@clinic.example");
		expect(outcome.modelPayload.text).toBeUndefined();
		expect(distillConnectorPayloadMock).toHaveBeenCalledWith(
			expect.objectContaining({
				rawText: expect.stringContaining("anxiety therapy"),
			}),
		);
		// Sources tab keeps the real subject.
		expect(outcome.candidates).toEqual([
			expect.objectContaining({ title: "Session recap" }),
		]);
	});
});
