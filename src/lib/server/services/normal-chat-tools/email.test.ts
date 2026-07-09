import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	ImapError,
	imapCount,
	imapListRecent,
	imapReadMessage,
	imapSearch,
} from "$lib/server/services/connections/providers/imap";
import { imapMessageIdForOp } from "$lib/server/services/connections/providers/imap-write";
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
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	createPendingWrite: vi.fn(),
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
		imapCount: vi.fn(),
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
const imapCountMock = vi.mocked(imapCount);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const distillConnectorPayloadMock = vi.mocked(distillConnectorPayload);
const createPendingWriteMock = vi.mocked(createPendingWrite);

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
		hasWriteSecret: false,
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
	imapCountMock.mockReset();
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

	it("A2 search: threads from/subject/since/before through to imapSearch", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapSearchMock.mockResolvedValue([]);

		await runEmailTool(
			"user-1",
			{
				action: "search",
				query: "report",
				from: "anna@example.com",
				subject: "invoice",
				since: "2026-07-01",
				before: "2026-07-31",
			},
			LOCAL_MODEL_ID,
		);

		// The tool forwards the raw strings; imap.ts normalizes the dates.
		expect(imapSearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			query: "report",
			from: "anna@example.com",
			subject: "invoice",
			since: "2026-07-01",
			before: "2026-07-31",
		});
	});

	it("A2 search: works with only a sender filter (no free-text query)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapSearchMock.mockResolvedValue([
			{
				uid: 9,
				from: "anna@example.com",
				subject: "Re: report",
				date: "2026-07-02T00:00:00.000Z",
				seen: false,
			},
		]);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "search", from: "anna@example.com" },
			LOCAL_MODEL_ID,
		);

		expect(imapSearchMock).toHaveBeenCalledWith("user-1", "conn-1", {
			from: "anna@example.com",
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.message).toContain("1 message");
	});

	it("A2 search: still fails with no query AND no filter", async () => {
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

	it("A4 count: counts unread by default and reports the FULL number (not the list cap)", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapCountMock.mockResolvedValue(200);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "count" },
			LOCAL_MODEL_ID,
		);

		expect(imapCountMock).toHaveBeenCalledWith("user-1", "conn-1", {
			unseenOnly: true,
		});
		expect(outcome.modelPayload.success).toBe(true);
		expect(outcome.modelPayload.action).toBe("count");
		expect(outcome.modelPayload.count).toBe(200);
		expect(outcome.modelPayload.message).toContain("200");
		expect(outcome.modelPayload.message).toContain("unread");
		// A count returns no per-message rows/citations to fetch or leak.
		expect(outcome.modelPayload.messages).toEqual([]);
		expect(imapListRecentMock).not.toHaveBeenCalled();
	});

	it("A4 count: unseenOnly=false counts the whole mailbox", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapCountMock.mockResolvedValue(4210);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "count", unseenOnly: false },
			LOCAL_MODEL_ID,
		);

		expect(imapCountMock).toHaveBeenCalledWith("user-1", "conn-1", {
			unseenOnly: false,
		});
		expect(outcome.modelPayload.count).toBe(4210);
		expect(outcome.modelPayload.message).not.toContain("unread");
	});

	it("A4 count: counts a search when filters are supplied", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapCountMock.mockResolvedValue(7);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "count", from: "anna@example.com", since: "2026-07-01" },
			LOCAL_MODEL_ID,
		);

		expect(imapCountMock).toHaveBeenCalledWith("user-1", "conn-1", {
			from: "anna@example.com",
			since: "2026-07-01",
		});
		expect(outcome.modelPayload.count).toBe(7);
	});

	it("A4 count: maps adapter errors to a graceful note without throwing", async () => {
		const conn = makeConn();
		resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
		imapCountMock.mockRejectedValue(
			new ImapError("The mailbox rejected the stored password", "needs_reauth"),
		);

		const outcome = await runEmailTool(
			"user-1",
			{ action: "count" },
			LOCAL_MODEL_ID,
		);

		expect(outcome.modelPayload.success).toBe(false);
		expect(outcome.modelPayload.message).toContain("reconnected");
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

describe("runEmailTool — write actions (Issue 6.3)", () => {
	function makeWritableConn(
		overrides: Partial<ConnectionPublic> = {},
	): ConnectionPublic {
		return makeConn({ allowWrites: true, ...overrides });
	}

	beforeEach(resetAllMocks);

	describe("send", () => {
		it("allowWrites=false: returns a note and creates NO pending row, no secret decrypted, no read", async () => {
			const conn = makeWritableConn({ allowWrites: false, label: "Work Mail" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "send", to: "bob@example.com", subject: "Hi", body: "Hello" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("Work Mail");
			expect(outcome.modelPayload.message).toContain("turned off");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
			expect(imapReadMessageMock).not.toHaveBeenCalled();
		});

		it("requires to/subject/body", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "send", to: "bob@example.com" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain(
				"recipient, subject, and body",
			);
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("allowWrites=true: creates a PENDING row (never sends inline) and returns pendingWriteId + preview; the message states sending cannot be undone", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{
					action: "send",
					to: "bob@example.com",
					cc: "carol@example.com",
					subject: "Hello",
					body: "Hi Bob!",
				},
				LOCAL_MODEL_ID,
				"conv-1",
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
			expect(outcome.modelPayload.preview).toBeDefined();
			expect(outcome.modelPayload.preview?.reversible).toBe(false);
			expect(outcome.modelPayload.message).toContain("has NOT been sent yet");
			expect(outcome.modelPayload.message).toContain("cannot be undone");

			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call).toMatchObject({
				connectionId: "conn-1",
				provider: "imap",
				// 7.5 — threaded from ctx.conversationId.
				conversationId: "conv-1",
			});
			expect(call?.op).toMatchObject({
				provider: "imap",
				connectionId: "conn-1",
				action: "email.send",
				destructive: false,
				reversible: false,
			});
			expect(JSON.parse(call?.content ?? "{}")).toEqual({
				to: "bob@example.com",
				cc: "carol@example.com",
				subject: "Hello",
				body: "Hi Bob!",
			});
			// No uid given -> no read of an existing message.
			expect(imapReadMessageMock).not.toHaveBeenCalled();
		});

		it("reply (uid given), Option A off: the base message names the original subject in plain text", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			imapReadMessageMock.mockResolvedValue({
				header: {
					uid: 7,
					from: "alice@example.com",
					subject: "Original topic",
					date: "2026-07-01T00:00:00.000Z",
					seen: true,
				},
				text: "irrelevant",
			});

			const outcome = await runEmailTool(
				"user-1",
				{
					action: "send",
					uid: 7,
					to: "alice@example.com",
					subject: "Re: Original topic",
					body: "Sounds good.",
				},
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.message).toContain(
				'Replying to "Original topic"',
			);
		});

		it("reply (uid given), Option A on + cloud: the raw ORIGINAL (connector-read) subject never appears anywhere in the model payload, even though the user's own composed subject/body legitimately do", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			// Deliberately a DIFFERENT string than the composed subject below, so
			// the test can distinguish "connector-read data that must be
			// redacted" from "the user's own compose input this turn, which
			// Option A never touches" (see the module doc comment on proposeSend).
			imapReadMessageMock.mockResolvedValue({
				header: {
					uid: 7,
					from: "therapist@clinic.example",
					subject: "Your therapy session recap — anxiety treatment plan",
					date: "2026-07-01T00:00:00.000Z",
					seen: true,
				},
				text: "irrelevant",
			});
			hasLocalDistillEnabledMock.mockResolvedValue(true);
			isCloudModelMock.mockResolvedValue(true);
			distillConnectorPayloadMock.mockResolvedValue({
				distilled: "A reply to a prior appointment message.",
			});

			const outcome = await runEmailTool(
				"user-1",
				{
					action: "send",
					uid: 7,
					to: "therapist@clinic.example",
					subject: "Following up",
					body: "Thanks, see you then.",
				},
				"whichever-model",
			);

			const serializedPayload = JSON.stringify(outcome.modelPayload);
			expect(serializedPayload).not.toContain("anxiety treatment plan");
			expect(serializedPayload).not.toContain(
				"Your therapy session recap — anxiety treatment plan",
			);
			expect(outcome.modelPayload.message).toContain(
				"A reply to a prior appointment message.",
			);
			// The user's own compose input this turn (to/subject/body) legitimately
			// appears — Option A only ever gates connector-READ data.
			expect(outcome.modelPayload.message).toContain("Following up");
			// The pending write itself still carries the real to/subject/body —
			// those are the user's own compose input this turn, not redacted.
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(JSON.parse(call?.content ?? "{}")).toMatchObject({
				subject: "Following up",
			});
		});

		it("payloadFingerprint: same subject+to but DIFFERENT bodies produce DIFFERENT idempotencyKeys (and Message-IDs), fixing the collision that would otherwise silently drop the second send", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			await runEmailTool(
				"user-1",
				{
					action: "send",
					to: "bob@example.com",
					subject: "Hi",
					body: "First body",
				},
				LOCAL_MODEL_ID,
			);
			await runEmailTool(
				"user-1",
				{
					action: "send",
					to: "bob@example.com",
					subject: "Hi",
					body: "Second, totally different body",
				},
				LOCAL_MODEL_ID,
			);

			expect(createPendingWriteMock).toHaveBeenCalledTimes(2);
			const keyA = createPendingWriteMock.mock.calls[0]?.[1]?.idempotencyKey;
			const keyB = createPendingWriteMock.mock.calls[1]?.[1]?.idempotencyKey;
			expect(keyA).toBeDefined();
			expect(keyB).toBeDefined();
			expect(keyA).not.toBe(keyB);

			const opA = createPendingWriteMock.mock.calls[0]?.[1]?.op;
			const opB = createPendingWriteMock.mock.calls[1]?.[1]?.op;
			expect(opA).toBeDefined();
			expect(opB).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted defined above
			expect(imapMessageIdForOp(opA!)).not.toBe(imapMessageIdForOp(opB!));
		});

		it("payloadFingerprint: a byte-identical retry (same to/cc/subject/body/inReplyTo) produces the SAME idempotencyKey and Message-ID — a true retry stays dedupable", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			const sendInput = {
				action: "send" as const,
				to: "bob@example.com",
				cc: "carol@example.com",
				subject: "Hi",
				body: "Identical body",
			};

			await runEmailTool("user-1", sendInput, LOCAL_MODEL_ID);
			await runEmailTool("user-1", { ...sendInput }, LOCAL_MODEL_ID);

			expect(createPendingWriteMock).toHaveBeenCalledTimes(2);
			const keyA = createPendingWriteMock.mock.calls[0]?.[1]?.idempotencyKey;
			const keyB = createPendingWriteMock.mock.calls[1]?.[1]?.idempotencyKey;
			expect(keyA).toBeDefined();
			expect(keyA).toBe(keyB);

			const opA = createPendingWriteMock.mock.calls[0]?.[1]?.op;
			const opB = createPendingWriteMock.mock.calls[1]?.[1]?.op;
			// biome-ignore lint/style/noNonNullAssertion: asserted defined above
			expect(imapMessageIdForOp(opA!)).toBe(imapMessageIdForOp(opB!));
		});
	});

	describe("trash", () => {
		it("allowWrites=false: returns a note, creates NO pending row, and never reads the message", async () => {
			const conn = makeWritableConn({ allowWrites: false, label: "Work Mail" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "trash", uid: 42 },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("turned off");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
			expect(imapReadMessageMock).not.toHaveBeenCalled();
		});

		it("requires a uid", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "trash" },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("uid is required");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("allowWrites=true: reads the message header for the preview, creates a PENDING row (never moves the message inline)", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			imapReadMessageMock.mockResolvedValue({
				header: {
					uid: 42,
					from: "billing@vendor.com",
					subject: "Invoice #123",
					date: "2026-07-01T00:00:00.000Z",
					seen: true,
				},
				text: "irrelevant",
			});

			const outcome = await runEmailTool(
				"user-1",
				{ action: "trash", uid: 42 },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
			expect(outcome.modelPayload.message).toContain("has NOT been moved yet");
			expect(imapReadMessageMock).toHaveBeenCalledWith("user-1", "conn-1", {
				uid: 42,
			});

			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call?.op).toMatchObject({
				provider: "imap",
				connectionId: "conn-1",
				action: "email.trash",
				destructive: true,
				reversible: true,
			});
			expect(call?.op.target).toEqual({ id: "42", label: "Invoice #123" });
			expect(JSON.parse(call?.content ?? "{}")).toEqual({ uid: 42 });
			// The DB-persisted preview keeps the real subject — never redacted.
			expect(call?.preview.title).toContain("Invoice #123");
		});

		it("maps a message-not-found/adapter error to a graceful note and creates no pending row", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			imapReadMessageMock.mockRejectedValue(
				new ImapError("Message not found", "message_not_found"),
			);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "trash", uid: 999 },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("couldn't be found");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("Option A on + cloud: the whole model-facing payload (message + preview) never contains the raw subject read off the connector; the DB row still does", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			imapReadMessageMock.mockResolvedValue({
				header: {
					uid: 5,
					from: "clinic@example.com",
					subject: "Your lab results are ready",
					date: "2026-07-01T00:00:00.000Z",
					seen: false,
				},
				text: "irrelevant",
			});
			hasLocalDistillEnabledMock.mockResolvedValue(true);
			isCloudModelMock.mockResolvedValue(true);
			distillConnectorPayloadMock.mockResolvedValue({
				distilled: "A message about medical results.",
			});

			const outcome = await runEmailTool(
				"user-1",
				{ action: "trash", uid: 5 },
				"whichever-model",
			);

			const serializedModelPayload = JSON.stringify(outcome.modelPayload);
			expect(serializedModelPayload).not.toContain("lab results");
			expect(outcome.modelPayload.preview?.title).not.toContain("lab results");
			expect(outcome.modelPayload.message).toContain(
				"A message about medical results.",
			);

			// The row persisted to the DB keeps the REAL subject — a separate
			// channel from what the model sees.
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call?.preview.title).toContain("lab results");
			expect(call?.op.target?.label).toContain("lab results");
		});
	});

	describe("flag", () => {
		it("allowWrites=false: returns a note and creates NO pending row", async () => {
			const conn = makeWritableConn({ allowWrites: false, label: "Work Mail" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "flag", uid: 42, flag: "seen", value: true },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(outcome.modelPayload.message).toContain("turned off");
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("requires uid, flag, and value", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "flag", uid: 42 },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(false);
			expect(createPendingWriteMock).not.toHaveBeenCalled();
		});

		it("allowWrites=true: creates a PENDING row for the flag change (never applies it inline), no message read needed", async () => {
			const conn = makeWritableConn();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);

			const outcome = await runEmailTool(
				"user-1",
				{ action: "flag", uid: 42, flag: "flagged", value: false },
				LOCAL_MODEL_ID,
			);

			expect(outcome.modelPayload.success).toBe(true);
			expect(outcome.modelPayload.pendingWriteId).toBe("pending-1");
			expect(outcome.modelPayload.message).toContain(
				"has NOT been applied yet",
			);

			expect(createPendingWriteMock).toHaveBeenCalledTimes(1);
			const call = createPendingWriteMock.mock.calls[0]?.[1];
			expect(call?.op).toMatchObject({
				provider: "imap",
				connectionId: "conn-1",
				action: "email.flag",
				destructive: false,
				reversible: true,
			});
			expect(JSON.parse(call?.content ?? "{}")).toEqual({
				uid: 42,
				flag: "flagged",
				value: false,
			});
			expect(imapReadMessageMock).not.toHaveBeenCalled();
		});
	});
});
