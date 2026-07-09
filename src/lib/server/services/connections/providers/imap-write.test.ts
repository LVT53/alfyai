import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ConnectionPublic,
	getConnection,
	getConnectionSecret,
	updateConnection,
} from "../store";
import {
	getWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";

// Issue 6.3 — the imap write-executor: the ONLY code path allowed to send
// mail or mutate a mailbox for the Email connector. Importing this module
// runs its top-level registerWriteExecutor({ provider: "imap", ... }) side
// effect (Issue 6.0's registry), exactly the way pending-writes.ts relies on
// it in production. Every test below dispatches through
// getWriteExecutor("imap") rather than calling any internal function
// directly, so these tests double as proof the registration actually
// happens. `createClient`/`createTransport` are injected directly through
// `execute`'s opts — no real IMAP/SMTP socket is ever opened here.
import {
	type ImapMailboxListEntry,
	type ImapWriteFlowLike,
	type ImapWriteOpt,
	imapMessageIdForOp,
	type NodemailerSendMailOptions,
	type NodemailerTransportLike,
} from "./imap-write";

vi.mock("../store", () => ({
	getConnection: vi.fn(),
	getConnectionSecret: vi.fn(),
	updateConnection: vi.fn(),
}));

const getConnectionMock = vi.mocked(getConnection);
const getConnectionSecretMock = vi.mocked(getConnectionSecret);
const updateConnectionMock = vi.mocked(updateConnection);

const USER_ID = "user-1";
const CONNECTION_ID = "conn-1";
const PASSWORD = "super-secret-app-password";

// Retrieved once and reused with a widened opts type — getWriteExecutor's own
// declared type only allows `{ fetch?: typeof fetch }` (Issue 6.0's shared
// WriteExecutor interface), but this module's registered `execute` actually
// accepts the wider ImapWriteOpt (see imap-write.ts's registerWriteExecutor
// call — method params are structurally bivariant, so a function accepting
// MORE optional fields than the interface requires still satisfies it). This
// cast documents that intentional widening for tests rather than fighting it
// with `as never` at every call site.
function imapExecutor(): {
	execute: (
		userId: string,
		connectionId: string,
		op: WriteOperation,
		content: string,
		opts?: ImapWriteOpt,
	) => Promise<WriteExecutionResult>;
} {
	const executor = getWriteExecutor("imap");
	if (!executor) throw new Error("imap write executor not registered");
	return executor as unknown as ReturnType<typeof imapExecutor>;
}

function makeConnection(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return {
		id: CONNECTION_ID,
		userId: USER_ID,
		provider: "imap",
		label: "Email",
		accountIdentifier: "alice@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: true,
		writeAllowlist: [],
		capabilities: ["email"],
		config: {
			email: "alice@example.com",
			imapHost: "imap.example.com",
			imapPort: 993,
			imapSecure: true,
			smtpHost: "smtp.example.com",
			smtpPort: 587,
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

function makeSendOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "imap",
		connectionId: CONNECTION_ID,
		action: "email.send",
		summary: 'Send "Hello" to bob@example.com',
		reversible: false,
		destructive: false,
		target: { label: "Hello → bob@example.com" },
		...overrides,
	};
}

function makeTrashOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "imap",
		connectionId: CONNECTION_ID,
		action: "email.trash",
		summary: 'Move "Invoice" to Trash',
		reversible: true,
		destructive: true,
		target: { id: "42", label: "Invoice" },
		...overrides,
	};
}

function makeFlagOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "imap",
		connectionId: CONNECTION_ID,
		action: "email.flag",
		summary: "Set seen on a message",
		reversible: true,
		destructive: false,
		target: { id: "42" },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Fake IMAP write client — no real socket is ever opened. Every method call
// is recorded so tests can assert exactly what the module did (in
// particular, that no expunge-style permanent-delete path is EVER taken —
// the fake deliberately has no `expunge` method at all, so any accidental
// call to it would throw "not a function" rather than silently succeed).
// ---------------------------------------------------------------------------

type FakeImapBehavior = {
	connect?: () => Promise<void> | void;
	mailboxOpen?: () => Promise<unknown> | unknown;
	list?: () => ImapMailboxListEntry[];
	messageMove?: (
		range: number[] | string,
		destination: string,
	) => { path: string } | false;
	messageFlagsAdd?: () => boolean;
	messageFlagsRemove?: () => boolean;
};

class FakeImapWriteClient implements ImapWriteFlowLike {
	connectCalls = 0;
	logoutCalls = 0;
	closeCalls = 0;
	mailboxOpenCalls: { path: string; options?: { readOnly?: boolean } }[] = [];
	listCalls = 0;
	messageMoveCalls: { range: unknown; destination: string }[] = [];
	messageFlagsAddCalls: { range: unknown; flags: string[] }[] = [];
	messageFlagsRemoveCalls: { range: unknown; flags: string[] }[] = [];

	constructor(private behavior: FakeImapBehavior = {}) {}

	async connect(): Promise<void> {
		this.connectCalls++;
		await this.behavior.connect?.();
	}

	async logout(): Promise<void> {
		this.logoutCalls++;
	}

	close(): void {
		this.closeCalls++;
	}

	async mailboxOpen(
		path: string,
		options?: { readOnly?: boolean },
	): Promise<unknown> {
		this.mailboxOpenCalls.push({ path, options });
		return (await this.behavior.mailboxOpen?.()) ?? { exists: 0 };
	}

	// Not part of a read-only mailbox contract — kept only to satisfy
	// ImapFlowLike's shared surface; never used by any write test below.
	async search(): Promise<number[] | false> {
		return [];
	}

	fetch(): AsyncIterable<never> {
		return {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ done: true, value: undefined as never }),
				};
			},
		};
	}

	async fetchOne(): Promise<false> {
		return false;
	}

	async list(): Promise<ImapMailboxListEntry[]> {
		this.listCalls++;
		return this.behavior.list ? this.behavior.list() : [];
	}

	async messageMove(
		range: number[] | string,
		destination: string,
	): Promise<{ path: string } | false> {
		this.messageMoveCalls.push({ range, destination });
		return this.behavior.messageMove
			? this.behavior.messageMove(range, destination)
			: { path: destination };
	}

	async messageFlagsAdd(
		range: number[] | string,
		flags: string[],
	): Promise<boolean> {
		this.messageFlagsAddCalls.push({ range, flags });
		return this.behavior.messageFlagsAdd
			? this.behavior.messageFlagsAdd()
			: true;
	}

	async messageFlagsRemove(
		range: number[] | string,
		flags: string[],
	): Promise<boolean> {
		this.messageFlagsRemoveCalls.push({ range, flags });
		return this.behavior.messageFlagsRemove
			? this.behavior.messageFlagsRemove()
			: true;
	}
}

function createClientFactory(client: FakeImapWriteClient) {
	return () => client;
}

// ---------------------------------------------------------------------------
// Fake SMTP transport — no real socket is ever opened.
// ---------------------------------------------------------------------------

class FakeTransport implements NodemailerTransportLike {
	sendMailCalls: NodemailerSendMailOptions[] = [];
	closeCalls = 0;

	constructor(
		private behavior: {
			sendMail?: () => Promise<unknown> | unknown;
		} = {},
	) {}

	async sendMail(options: NodemailerSendMailOptions): Promise<unknown> {
		this.sendMailCalls.push(options);
		return this.behavior.sendMail
			? await this.behavior.sendMail()
			: { ok: true };
	}

	close(): void {
		this.closeCalls++;
	}
}

function createTransportFactory(transport: FakeTransport) {
	return () => transport;
}

function resetAllMocks() {
	getConnectionMock.mockReset();
	getConnectionSecretMock.mockReset();
	updateConnectionMock.mockReset();
	getConnectionMock.mockResolvedValue(makeConnection());
	getConnectionSecretMock.mockResolvedValue(PASSWORD);
}

describe("imap write-executor — email.trash (safe delete, never EXPUNGE)", () => {
	beforeEach(resetAllMocks);

	it("moves the uid to the mailbox flagged \\Trash and never issues a permanent-delete path", async () => {
		const client = new FakeImapWriteClient({
			list: () => [
				{ path: "INBOX", name: "INBOX" },
				{ path: "Trash", name: "Trash", specialUse: "\\Trash" },
			],
		});

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: true, detail: "moved to trash" });
		expect(client.messageMoveCalls).toEqual([
			{ range: [42], destination: "Trash" },
		]);
		// Structural proof no expunge-style call ever happens: the fake client
		// has no `expunge` method at all, so an accidental call to it would
		// have thrown "is not a function" and failed this test.
		expect(
			(client as unknown as { expunge?: unknown }).expunge,
		).toBeUndefined();
		expect(client.mailboxOpenCalls).toEqual([
			{ path: "INBOX", options: { readOnly: false } },
		]);
		expect(client.logoutCalls).toBe(1);
	});

	it("falls back to a mailbox literally named Trash/Deleted Messages when no \\Trash special-use flag is present", async () => {
		const client = new FakeImapWriteClient({
			list: () => [
				{ path: "INBOX", name: "INBOX" },
				{ path: "INBOX.Deleted Messages", name: "Deleted Messages" },
			],
		});

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result.ok).toBe(true);
		expect(client.messageMoveCalls).toEqual([
			{ range: [42], destination: "INBOX.Deleted Messages" },
		]);
	});

	it("refuses with no_trash_folder when no Trash-like mailbox exists — never falls back to a permanent delete", async () => {
		const client = new FakeImapWriteClient({ list: () => [] });

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: false, reason: "no_trash_folder" });
		expect(client.messageMoveCalls).toEqual([]);
		expect(client.logoutCalls).toBe(1);
	});

	it("treats an already-gone uid (messageMove resolves false) as idempotent success", async () => {
		const client = new FakeImapWriteClient({
			list: () => [{ path: "Trash", name: "Trash", specialUse: "\\Trash" }],
			messageMove: () => false,
		});

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: true, detail: "already moved" });
	});

	it("closes the connection even when the write fails, and flags needs_reauth on an auth failure without leaking the password", async () => {
		const client = new FakeImapWriteClient({
			connect: () => {
				throw { authenticationFailed: true };
			},
		});

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(client.logoutCalls).toBe(1);
		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
		expect(JSON.stringify(result)).not.toContain(PASSWORD);
		expect(JSON.stringify(updateConnectionMock.mock.calls)).not.toContain(
			PASSWORD,
		);
	});

	it("refuses without ever opening a connection when no secret is stored", async () => {
		getConnectionSecretMock.mockResolvedValue(null);
		const client = new FakeImapWriteClient();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(client.connectCalls).toBe(0);
	});

	it("refuses connection_not_found when the connection no longer exists", async () => {
		getConnectionMock.mockResolvedValue(null);
		const client = new FakeImapWriteClient();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			JSON.stringify({ uid: 42 }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: false, reason: "connection_not_found" });
		expect(client.connectCalls).toBe(0);
	});
});

describe("imap write-executor — email.flag", () => {
	beforeEach(resetAllMocks);

	it("sets \\Seen when flag=seen, value=true", async () => {
		const client = new FakeImapWriteClient();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeFlagOp(),
			JSON.stringify({ uid: 42, flag: "seen", value: true }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: true, detail: "set seen" });
		expect(client.messageFlagsAddCalls).toEqual([
			{ range: [42], flags: ["\\Seen"] },
		]);
		expect(client.messageFlagsRemoveCalls).toEqual([]);
		expect(client.logoutCalls).toBe(1);
	});

	it("clears \\Flagged when flag=flagged, value=false", async () => {
		const client = new FakeImapWriteClient();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeFlagOp(),
			JSON.stringify({ uid: 42, flag: "flagged", value: false }),
			{ createClient: createClientFactory(client) },
		);

		expect(result).toEqual({ ok: true, detail: "cleared flagged" });
		expect(client.messageFlagsRemoveCalls).toEqual([
			{ range: [42], flags: ["\\Flagged"] },
		]);
		expect(client.messageFlagsAddCalls).toEqual([]);
	});

	it("closes the connection after a flag change", async () => {
		const client = new FakeImapWriteClient();

		await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeFlagOp(),
			JSON.stringify({ uid: 42, flag: "seen", value: true }),
			{ createClient: createClientFactory(client) },
		);

		expect(client.logoutCalls).toBe(1);
	});
});

describe("imap write-executor — email.send (SMTP submission)", () => {
	beforeEach(resetAllMocks);

	it("calls sendMail exactly once with the right to/subject/body and a deterministic Message-ID, then closes the transport", async () => {
		const transport = new FakeTransport();
		const op = makeSendOp();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({
				to: "bob@example.com",
				subject: "Hello",
				body: "Hi Bob!",
			}),
			{ createTransport: createTransportFactory(transport) },
		);

		expect(result).toEqual({ ok: true, detail: "sent" });
		expect(transport.sendMailCalls).toEqual([
			{
				from: "alice@example.com",
				to: "bob@example.com",
				subject: "Hello",
				text: "Hi Bob!",
				messageId: imapMessageIdForOp(op),
			},
		]);
		expect(transport.closeCalls).toBe(1);
	});

	it("derives the SAME Message-ID for the same WriteOperation (idempotencyKey-derived, deterministic, not random)", () => {
		const opA = makeSendOp();
		const opB = makeSendOp();
		expect(imapMessageIdForOp(opA)).toBe(imapMessageIdForOp(opB));

		// Re-derive independently via the exported idempotencyKey to prove
		// imapMessageIdForOp is a pure hash of it — mirrors
		// appleEventUidForOp/googleEventIdForOp's own tests.
		const expectedHash = createHash("sha256")
			.update(idempotencyKey(opA))
			.digest("hex");
		expect(imapMessageIdForOp(opA)).toBe(`<${expectedHash}@alfyai.app>`);

		// A different WriteOperation (different subject/target) must derive a
		// DIFFERENT Message-ID — otherwise unrelated sends would collide.
		const opC = makeSendOp({ target: { label: "Different → someone-else" } });
		expect(imapMessageIdForOp(opC)).not.toBe(imapMessageIdForOp(opA));
	});

	it("passes cc and inReplyTo through when provided", async () => {
		const transport = new FakeTransport();
		const op = makeSendOp();

		await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({
				to: "bob@example.com",
				cc: "carol@example.com",
				subject: "Re: Hello",
				body: "Following up",
				inReplyTo: "<original@example.com>",
			}),
			{ createTransport: createTransportFactory(transport) },
		);

		expect(transport.sendMailCalls[0]).toMatchObject({
			cc: "carol@example.com",
			inReplyTo: "<original@example.com>",
			// A reply must also carry References so clients thread it correctly.
			references: "<original@example.com>",
		});
	});

	it("maps an SMTP auth failure (EAUTH) to needs_reauth, flags the connection, and never leaks the password", async () => {
		const transport = new FakeTransport({
			sendMail: () => {
				throw Object.assign(new Error("Invalid login"), { code: "EAUTH" });
			},
		});

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeSendOp(),
			JSON.stringify({
				to: "bob@example.com",
				subject: "Hello",
				body: "Hi Bob!",
			}),
			{ createTransport: createTransportFactory(transport) },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(transport.closeCalls).toBe(1);
		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
		expect(JSON.stringify(result)).not.toContain(PASSWORD);
		expect(JSON.stringify(updateConnectionMock.mock.calls)).not.toContain(
			PASSWORD,
		);
	});

	it("refuses missing_smtp_config when the connection has no smtpHost/smtpPort stored", async () => {
		getConnectionMock.mockResolvedValue(
			makeConnection({
				config: {
					email: "alice@example.com",
					imapHost: "imap.example.com",
					imapPort: 993,
					imapSecure: true,
				},
			}),
		);
		const transport = new FakeTransport();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeSendOp(),
			JSON.stringify({
				to: "bob@example.com",
				subject: "Hello",
				body: "Hi Bob!",
			}),
			{ createTransport: createTransportFactory(transport) },
		);

		expect(result).toEqual({ ok: false, reason: "missing_smtp_config" });
		expect(transport.sendMailCalls).toEqual([]);
	});

	it("refuses needs_reauth without opening a transport when no secret is stored", async () => {
		getConnectionSecretMock.mockResolvedValue(null);
		const transport = new FakeTransport();

		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeSendOp(),
			JSON.stringify({
				to: "bob@example.com",
				subject: "Hello",
				body: "Hi Bob!",
			}),
			{ createTransport: createTransportFactory(transport) },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(transport.sendMailCalls).toEqual([]);
	});
});

describe("imap write-executor — unsupported/malformed content", () => {
	beforeEach(resetAllMocks);

	it("refuses unsupported_operation for an unrecognized action", async () => {
		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			{
				provider: "imap",
				connectionId: CONNECTION_ID,
				action: "email.unknown",
				summary: "x",
				reversible: true,
				destructive: false,
			},
			"{}",
		);
		expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
	});

	it("refuses unsupported_operation for malformed JSON content", async () => {
		const result = await imapExecutor().execute(
			USER_ID,
			CONNECTION_ID,
			makeTrashOp(),
			"not json",
		);
		expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
	});
});
