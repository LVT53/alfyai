// IMAP/SMTP WRITE executor (Issue 6.3) — the ONLY code path that ever sends
// mail or mutates a mailbox for the Email connector. Registered via
// registerWriteExecutor (Issue 6.0) so confirmPendingWrite (pending-writes.ts)
// dispatches "imap" pending writes here, and only after the user has
// explicitly confirmed — the email chat tool (normal-chat-tools/email.ts)
// never imports this module; it only ever proposes a PENDING write via
// createPendingWrite. Nothing here executes at propose time.
//
// Three actions:
//   - "email.send"  — SMTP submission via nodemailer (a NEW, justified
//     dependency — see package.json and imap.ts's module doc comment, which
//     already flagged this as the planned 6.3 addition alongside imapflow).
//     Sending is the one action here that is NOT reversible: once nodemailer
//     hands the message to the SMTP server there is no "undo". Double-send
//     protection is layered, not a single mechanism: (1) confirmPendingWrite
//     claims a pending write's "pending" -> "executing" transition with a
//     single atomic UPDATE BEFORE this executor is ever called (Issue 6.0),
//     so two concurrent confirms for the SAME pending write can only ever
//     invoke this module once; (2) on top of that, every send carries a
//     deterministic Message-ID derived from the pending write's
//     idempotencyKey (imapMessageIdForOp below) — a pure function of the
//     WriteOperation — so even a send that somehow gets re-attempted (a crash
//     between nodemailer accepting the message and markPendingWriteExecuted
//     committing) carries an identical Message-ID a receiving/relaying server
//     or mail client can use to de-duplicate, rather than a fresh id every
//     time.
//   - "email.trash" — imapflow messageMove to the account's Trash/Deleted
//     mailbox. This module NEVER issues an EXPUNGE and NEVER sets \Deleted
//     purely to permanently remove a message — see executeTrash's doc
//     comment for why "move to Trash" is the only delete primitive this
//     module implements. If no Trash-like mailbox can be found, the write is
//     refused (`no_trash_folder`) rather than silently falling back to a
//     permanent delete.
//   - "email.flag"  — imapflow messageFlagsAdd/messageFlagsRemove for
//     \Seen/\Flagged, opened READ-WRITE (unlike imap.ts's read paths, which
//     are always readOnly).
//
// Every network call (SMTP transport, IMAP client) accepts an injectable
// factory so this module is fully testable against mocked servers — nothing
// here ever talks to a live mailbox in tests.
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { getConnection, getConnectionSecret, updateConnection } from "../store";
import {
	registerWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";
import {
	buildClientOptions,
	closeClient,
	type ImapClientOptions,
	type ImapFlowLike,
	INBOX,
	imapConfig,
	isAuthFailure,
} from "./imap";

// ---------------------------------------------------------------------------
// IMAP write client contract — extends imap.ts's read-only ImapFlowLike with
// the handful of mutating methods this module needs (list, to resolve the
// Trash mailbox; messageMove, messageFlagsAdd/Remove). imap.ts's own
// ImapFlowLike deliberately excludes these (its doc comment: "this module
// deliberately never calls messageFlagsAdd/messageFlagsSet at all") — kept as
// a genuinely separate, wider interface here rather than widening the shared
// one, so that invariant stays true on the read side.
// ---------------------------------------------------------------------------

export type ImapMailboxListEntry = {
	path: string;
	name: string;
	specialUse?: string;
};

export interface ImapWriteFlowLike extends ImapFlowLike {
	list(): Promise<ImapMailboxListEntry[]>;
	messageMove(
		range: number[] | string,
		destination: string,
		options?: { uid?: boolean },
	): Promise<{ path: string } | false>;
	messageFlagsAdd(
		range: number[] | string,
		flags: string[],
		options?: { uid?: boolean },
	): Promise<boolean>;
	messageFlagsRemove(
		range: number[] | string,
		flags: string[],
		options?: { uid?: boolean },
	): Promise<boolean>;
}

export type ImapWriteClientFactory = (
	options: ImapClientOptions,
) => ImapWriteFlowLike;

function createDefaultImapWriteClient(
	options: ImapClientOptions,
): ImapWriteFlowLike {
	// Same adaptation shim as imap.ts's createDefaultImapClient — the real
	// ImapFlow class structurally satisfies this module's wider write
	// contract too (it has list/messageMove/messageFlagsAdd/
	// messageFlagsRemove), this just documents the subset actually used.
	return new ImapFlow(options) as unknown as ImapWriteFlowLike;
}

// ---------------------------------------------------------------------------
// SMTP transport contract — this module's own narrow interface (mirrors
// ImapFlowLike's rationale in imap.ts: depend on the handful of methods
// actually used, not nodemailer's whole Transporter surface), adapted from
// the real nodemailer.createTransport in createDefaultTransport below. Tests
// substitute a plain object satisfying this interface — no real SMTP socket
// is ever opened in the test suite.
// ---------------------------------------------------------------------------

export type NodemailerSendMailOptions = {
	from: string;
	to: string;
	cc?: string;
	subject: string;
	text: string;
	inReplyTo?: string;
	references?: string;
	messageId: string;
};

export type NodemailerTransportLike = {
	sendMail(options: NodemailerSendMailOptions): Promise<unknown>;
	close(): void;
};

export type NodemailerTransportOptions = {
	host: string;
	port: number;
	secure: boolean;
	auth: { user: string; pass: string };
};

export type NodemailerTransportFactory = (
	options: NodemailerTransportOptions,
) => NodemailerTransportLike;

function createDefaultTransport(
	options: NodemailerTransportOptions,
): NodemailerTransportLike {
	return nodemailer.createTransport(
		options,
	) as unknown as NodemailerTransportLike;
}

// nodemailer's SMTP transport sets `err.code === "EAUTH"` specifically for a
// rejected AUTH command — the same "trust one structural signal, never the
// raw message text" posture as imap.ts's isAuthFailure (a server's raw
// SMTP response text is out of this module's control and must never be
// forwarded verbatim, and the password itself never appears in these errors
// to begin with).
function isSmtpAuthFailure(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	return (err as { code?: unknown }).code === "EAUTH";
}

export type ImapWriteOpt = {
	// Unused by this module (nothing here is fetch-based) — kept only so this
	// module's options type stays compatible with WriteExecutor's own
	// `opts?: { fetch?: typeof fetch }` shape that confirmPendingWrite always
	// passes through in production.
	fetch?: typeof fetch;
	createClient?: ImapWriteClientFactory;
	createTransport?: NodemailerTransportFactory;
};

// ---------------------------------------------------------------------------
// Deterministic Message-ID (double-send prevention, part 2 — see module doc
// comment above for part 1, the atomic claim). A pure function of the
// WriteOperation: the SAME pending write (or a byte-identical re-proposal)
// always derives the same Message-ID.
// ---------------------------------------------------------------------------

export function imapMessageIdForOp(op: WriteOperation): string {
	const hash = createHash("sha256").update(idempotencyKey(op)).digest("hex");
	return `<${hash}@alfyai.app>`;
}

// ---------------------------------------------------------------------------
// content parsing — the email tool (normal-chat-tools/email.ts) is the only
// producer of these shapes; this module is the only consumer.
// ---------------------------------------------------------------------------

type SendContent = {
	to: string;
	cc?: string;
	subject: string;
	body: string;
	inReplyTo?: string;
};

function parseSendContent(content: string): SendContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<SendContent>;
		if (
			typeof parsed.to !== "string" ||
			!parsed.to ||
			typeof parsed.subject !== "string" ||
			typeof parsed.body !== "string"
		) {
			return null;
		}
		return {
			to: parsed.to,
			...(typeof parsed.cc === "string" ? { cc: parsed.cc } : {}),
			subject: parsed.subject,
			body: parsed.body,
			...(typeof parsed.inReplyTo === "string"
				? { inReplyTo: parsed.inReplyTo }
				: {}),
		};
	} catch {
		return null;
	}
}

// Fix 3 (write-safety hardening) — `uidValidity`, when present, is INBOX's
// UIDVALIDITY as captured at propose time (email.ts's imapGetInboxUidValidity
// call). Optional so a pending write from before this fix (or a propose
// whose capture itself came back null) still parses; a missing value is
// never treated as a mismatch by uidValidityChanged below — see its doc
// comment.
type TrashContent = { uid: number; uidValidity?: string };

function parseTrashContent(content: string): TrashContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<TrashContent>;
		if (typeof parsed.uid !== "number") return null;
		return {
			uid: parsed.uid,
			...(typeof parsed.uidValidity === "string"
				? { uidValidity: parsed.uidValidity }
				: {}),
		};
	} catch {
		return null;
	}
}

type FlagContent = {
	uid: number;
	flag: "seen" | "flagged";
	value: boolean;
	uidValidity?: string;
};

function parseFlagContent(content: string): FlagContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<FlagContent>;
		if (
			typeof parsed.uid !== "number" ||
			(parsed.flag !== "seen" && parsed.flag !== "flagged") ||
			typeof parsed.value !== "boolean"
		) {
			return null;
		}
		return {
			uid: parsed.uid,
			flag: parsed.flag,
			value: parsed.value,
			...(typeof parsed.uidValidity === "string"
				? { uidValidity: parsed.uidValidity }
				: {}),
		};
	} catch {
		return null;
	}
}

// Fix 3 — true iff the pending write's captured UIDVALIDITY (from propose
// time) no longer matches INBOX's CURRENT one (re-read at execute time,
// inside the write connection). A captured value that is MISSING (a legacy
// pending write, or a propose whose capture itself failed) is never treated
// as a mismatch — this only guards against a CONFIRMED epoch change, not the
// absence of a signal, mirroring Fix 1's NULL-is-never-expired posture.
function uidValidityChanged(
	captured: string | undefined,
	current: { uidValidity?: bigint },
): boolean {
	if (captured === undefined) return false;
	return (
		current.uidValidity === undefined ||
		current.uidValidity.toString() !== captured
	);
}

// ---------------------------------------------------------------------------
// Shared IMAP write connection chokepoint — mirrors imap.ts's
// withImapConnection exactly (connect, do the work, close in `finally`,
// flag needs_reauth on an auth failure) but opens the mailbox READ-WRITE
// (`readOnly: false`), since every caller here mutates the mailbox.
// ---------------------------------------------------------------------------

type ImapWriteFailure =
	| { ok: false; reason: "connection_not_found" }
	| { ok: false; reason: "needs_reauth" }
	| { ok: false; reason: "request_failed" };

// `run`'s second param carries the mailboxOpen() result (Fix 3 —
// executeTrash/executeFlag read `.uidValidity` off it to re-check against
// the value captured at propose time; executeSend never uses this
// chokepoint at all, so it is unaffected).
async function withImapWriteConnection<T>(
	userId: string,
	connectionId: string,
	mailboxPath: string,
	opts: ImapWriteOpt | undefined,
	run: (
		client: ImapWriteFlowLike,
		mailbox: { exists?: number; uidValidity?: bigint },
	) => Promise<T>,
): Promise<T | ImapWriteFailure> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) return { ok: false, reason: "connection_not_found" };
	const password = await getConnectionSecret(userId, connectionId);
	if (!password) return { ok: false, reason: "needs_reauth" };
	const { email, imapHost, imapPort, imapSecure } = imapConfig(conn);

	const createClient = opts?.createClient ?? createDefaultImapWriteClient;
	const client = createClient(
		buildClientOptions(imapHost, imapPort, imapSecure, email, password),
	);

	try {
		await client.connect();
		const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: false });
		return await run(client, mailbox);
	} catch (err) {
		if (isAuthFailure(err)) {
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: "The mailbox rejected the stored password",
			});
			return { ok: false, reason: "needs_reauth" };
		}
		return { ok: false, reason: "request_failed" };
	} finally {
		await closeClient(client);
	}
}

// ---------------------------------------------------------------------------
// email.trash — MOVE to Trash, never a permanent delete.
//
// NON-NEGOTIABLE: this function never issues IMAP EXPUNGE, and never sets
// \Deleted purely to expunge it afterwards. The ONLY mutating IMAP command
// this function issues is messageMove to a resolved Trash mailbox. If no
// Trash-like mailbox can be found on the account, the write is refused
// (`no_trash_folder`) — it does NOT fall back to \Deleted+EXPUNGE or any
// other permanent-removal path. A uid that no longer exists (already moved
// or deleted through some other client) is treated as idempotent success,
// not a failure to surface a second time.
// ---------------------------------------------------------------------------

const TRASH_NAME_PATTERN = /^(trash|deleted messages|deleted items|bin)$/i;

async function resolveTrashMailbox(
	client: ImapWriteFlowLike,
): Promise<string | null> {
	const mailboxes = await client.list();
	const bySpecialUse = mailboxes.find((mbx) => mbx.specialUse === "\\Trash");
	if (bySpecialUse) return bySpecialUse.path;
	const byName = mailboxes.find((mbx) => TRASH_NAME_PATTERN.test(mbx.name));
	return byName ? byName.path : null;
}

async function executeTrash(
	userId: string,
	connectionId: string,
	content: string,
	opts?: ImapWriteOpt,
): Promise<WriteExecutionResult> {
	const parsed = parseTrashContent(content);
	if (!parsed) return { ok: false, reason: "unsupported_operation" };

	return withImapWriteConnection(
		userId,
		connectionId,
		INBOX,
		opts,
		async (client, mailbox): Promise<WriteExecutionResult> => {
			// Fix 3 — a `uid` is only valid within the UIDVALIDITY epoch it was
			// captured under; if INBOX's epoch changed since propose time, this
			// uid can no longer be trusted to reference the intended message.
			// Refuse rather than act on it.
			if (uidValidityChanged(parsed.uidValidity, mailbox)) {
				return { ok: false, reason: "uidvalidity_changed" };
			}

			const trashPath = await resolveTrashMailbox(client);
			if (!trashPath) return { ok: false, reason: "no_trash_folder" };

			// messageMove resolves to `false` when the given uid no longer exists
			// in the source mailbox — already moved/deleted by some other client,
			// which is idempotent success, not a failure.
			const moved = await client.messageMove([parsed.uid], trashPath, {
				uid: true,
			});
			return moved
				? { ok: true, detail: "moved to trash" }
				: { ok: true, detail: "already moved" };
		},
	);
}

// ---------------------------------------------------------------------------
// email.flag — \Seen / \Flagged, opened READ-WRITE.
// ---------------------------------------------------------------------------

function toImapFlagName(flag: "seen" | "flagged"): string {
	return flag === "seen" ? "\\Seen" : "\\Flagged";
}

async function executeFlag(
	userId: string,
	connectionId: string,
	content: string,
	opts?: ImapWriteOpt,
): Promise<WriteExecutionResult> {
	const parsed = parseFlagContent(content);
	if (!parsed) return { ok: false, reason: "unsupported_operation" };

	const imapFlag = toImapFlagName(parsed.flag);
	return withImapWriteConnection(
		userId,
		connectionId,
		INBOX,
		opts,
		async (client, mailbox): Promise<WriteExecutionResult> => {
			// Fix 3 — same UIDVALIDITY re-check as executeTrash above.
			if (uidValidityChanged(parsed.uidValidity, mailbox)) {
				return { ok: false, reason: "uidvalidity_changed" };
			}

			if (parsed.value) {
				await client.messageFlagsAdd([parsed.uid], [imapFlag], { uid: true });
			} else {
				await client.messageFlagsRemove([parsed.uid], [imapFlag], {
					uid: true,
				});
			}
			return {
				ok: true,
				detail: `${parsed.value ? "set" : "cleared"} ${parsed.flag}`,
			};
		},
	);
}

// ---------------------------------------------------------------------------
// email.send — SMTP submission via nodemailer. Sending is never inline: this
// only ever runs after the user has explicitly confirmed the PENDING
// proposal the email tool created (see normal-chat-tools/email.ts).
// ---------------------------------------------------------------------------

async function executeSend(
	userId: string,
	connectionId: string,
	op: WriteOperation,
	content: string,
	opts?: ImapWriteOpt,
): Promise<WriteExecutionResult> {
	const parsed = parseSendContent(content);
	if (!parsed) return { ok: false, reason: "unsupported_operation" };

	const conn = await getConnection(userId, connectionId);
	if (!conn) return { ok: false, reason: "connection_not_found" };
	const password = await getConnectionSecret(userId, connectionId);
	if (!password) return { ok: false, reason: "needs_reauth" };

	const { email, smtpHost, smtpPort } = imapConfig(conn);
	if (!smtpHost || !smtpPort) {
		return { ok: false, reason: "missing_smtp_config" };
	}

	const createTransport = opts?.createTransport ?? createDefaultTransport;
	const transport = createTransport({
		host: smtpHost,
		port: smtpPort,
		secure: smtpPort === 465,
		auth: { user: email, pass: password },
	});

	try {
		await transport.sendMail({
			from: email,
			to: parsed.to,
			...(parsed.cc ? { cc: parsed.cc } : {}),
			subject: parsed.subject,
			text: parsed.body,
			// A reply must set BOTH In-Reply-To and References (RFC 5322 §3.6.4)
			// so receiving clients thread it under the original; setting only
			// In-Reply-To leaves many clients unable to place the message in its
			// conversation. We only have the parent's Message-ID, so References
			// carries that same id (the minimal correct chain).
			...(parsed.inReplyTo
				? { inReplyTo: parsed.inReplyTo, references: parsed.inReplyTo }
				: {}),
			messageId: imapMessageIdForOp(op),
		});
		return { ok: true, detail: "sent" };
	} catch (err) {
		if (isSmtpAuthFailure(err)) {
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail:
					"The mail server rejected the stored password for sending",
			});
			return { ok: false, reason: "needs_reauth" };
		}
		return { ok: false, reason: "request_failed" };
	} finally {
		// Always close the transport's pooled/kept-alive connection — same
		// "never leave a socket open" posture as closeClient for IMAP.
		transport.close();
	}
}

// ---------------------------------------------------------------------------
// registration (Issue 6.0) — imported for its side effect by pending-writes
// .ts, the same way providers/{google-calendar,apple-caldav}-write.ts are
// (see the comment above that import for why this needs to happen on that
// exact import path).
// ---------------------------------------------------------------------------

registerWriteExecutor({
	provider: "imap",
	async execute(userId, connectionId, op, content, opts?: ImapWriteOpt) {
		switch (op.action) {
			case "email.send":
				return executeSend(userId, connectionId, op, content, opts);
			case "email.trash":
				return executeTrash(userId, connectionId, content, opts);
			case "email.flag":
				return executeFlag(userId, connectionId, content, opts);
			default:
				return { ok: false, reason: "unsupported_operation" };
		}
	},
});
