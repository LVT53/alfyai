// IMAP connect + read (5.4) — the Email connector. Unlike the CalDAV/HTTP
// providers elsewhere in this directory, IMAP is a stateful socket protocol,
// so this module pulls in `imapflow` (see package.json — a deliberate,
// justified exception to the no-new-deps rule; SMTP send in Phase 6.3 will
// add `nodemailer`). Every call opens a short-lived connection, does its
// work, and closes it again in a `finally` — nothing here holds a socket
// open across calls.
//
// \Seen safety: imapflow's `fetch`/`fetchOne`/`download` always issue
// `BODY.PEEK[...]` on the wire (see imapflow's lib/commands/fetch.js —
// every body/header fetch atom is built via `${commandKey}.PEEK`), so
// reading a message's envelope, flags, or body through those methods can
// never mark it \Seen. The mailbox is additionally opened `readOnly: true`
// as a second, structural guard: a read-only SELECT rejects any STORE the
// code might accidentally attempt. This module deliberately never calls
// `messageFlagsAdd`/`messageFlagsSet` at all.
//
// Testability: rather than depend on imapflow's full ~40-method class shape,
// this module defines its own narrow `ImapFlowLike` interface — only the
// handful of methods actually used — and adapts the real `ImapFlow` class to
// it in `createDefaultImapClient`. Tests substitute a plain object satisfying
// `ImapFlowLike` (via `vi.mock("imapflow", ...)`), so no real socket is ever
// opened in the test suite.
import { ImapFlow } from "imapflow";
import { registerConnectionAdapter } from "../adapters";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	getConnection,
	getConnectionSecret,
	setConnectionSecret,
	updateConnection,
} from "../store";

// ---------------------------------------------------------------------------
// Narrow client contract + message/body-structure shapes this module reads.
// Intentionally much smaller than imapflow's own types — only what's used.
// ---------------------------------------------------------------------------

export type ImapEnvelopeAddress = { name?: string; address?: string };

export type ImapEnvelope = {
	date?: Date | string;
	subject?: string;
	from?: ImapEnvelopeAddress[];
};

export type ImapBodyStructureNode = {
	part?: string;
	type: string;
	encoding?: string;
	size?: number;
	parameters?: Record<string, string>;
	disposition?: string;
	dispositionParameters?: Record<string, string>;
	childNodes?: ImapBodyStructureNode[];
};

// One mailbox as returned by imapflow's `list()` — narrowed to the three
// fields the read side actually uses (path to open, name to match, specialUse
// to resolve Sent/Archive/… by RFC 6154 flag). imapflow's real ListResponse
// carries far more (delimiter/flags/subscribed/…); this is the same
// narrow-interface posture as ImapFlowLike itself. Mirrors imap-write.ts's
// ImapMailboxListEntry, kept separate so the read/write client contracts stay
// independent.
export type ImapMailbox = {
	path: string;
	name: string;
	specialUse?: string;
};

// Attachment metadata surfaced on a read (GAP B5) — filename, MIME type, and
// server-reported size. Listing only: NO bytes are ever downloaded here (a
// larger follow-up), so callers learn an email HAS an attachment and what it
// is without this module fetching its content.
export type ImapAttachment = {
	filename: string;
	contentType: string;
	size?: number;
};

export type ImapFetchedMessage = {
	uid: number;
	envelope?: ImapEnvelope;
	flags?: Set<string>;
	internalDate?: Date | string;
	bodyStructure?: ImapBodyStructureNode;
	bodyParts?: Map<string, Buffer>;
};

export type ImapFlowLike = {
	connect(): Promise<void>;
	logout(): Promise<void>;
	close(): void;
	mailboxOpen(
		path: string,
		options?: { readOnly?: boolean },
	): Promise<{ exists?: number } | unknown>;
	search(
		query: Record<string, unknown>,
		options?: { uid?: boolean },
	): Promise<number[] | false>;
	fetch(
		range: number[] | string,
		query: Record<string, unknown>,
		options?: { uid?: boolean },
	): AsyncIterable<ImapFetchedMessage>;
	fetchOne(
		seq: number | string,
		query: Record<string, unknown>,
		options?: { uid?: boolean },
	): Promise<ImapFetchedMessage | false>;
	// LIST — read-only mailbox discovery (GAP B4). Used to enumerate folders
	// for `list_folders` and to resolve a named folder (Sent/Archive/…) to its
	// actual server path before opening it. imapflow's real `list()` returns a
	// wider ListResponse[]; this narrows to the fields this module reads.
	list(): Promise<ImapMailbox[]>;
};

export type ImapClientOptions = {
	host: string;
	port: number;
	secure: boolean;
	auth: { user: string; pass: string };
	connectionTimeout: number;
	socketTimeout: number;
	logger: false;
};

export type ImapClientFactory = (options: ImapClientOptions) => ImapFlowLike;

// Exported so providers/imap-write.ts (Issue 6.3) can adapt the SAME real
// ImapFlow class to its own, wider write-side client contract
// (ImapWriteFlowLike, which additionally needs list/messageMove/
// messageFlagsAdd/messageFlagsRemove — methods this read module deliberately
// never calls, see the \Seen safety doc comment above) without duplicating
// the "new ImapFlow(options) as unknown as ..." adaptation shim.
export function createDefaultImapClient(
	options: ImapClientOptions,
): ImapFlowLike {
	// The real ImapFlow class exposes far more than ImapFlowLike — it
	// structurally satisfies the narrow interface this module actually uses,
	// so this cast just adapts imapflow's broad public surface to that
	// contract rather than re-declaring it.
	return new ImapFlow(options) as unknown as ImapFlowLike;
}

export type ImapOpt = { createClient?: ImapClientFactory };

// ---------------------------------------------------------------------------
// Config + errors
// ---------------------------------------------------------------------------

export type ImapConnectionConfig = {
	email: string;
	imapHost: string;
	imapPort: number;
	imapSecure: boolean;
	smtpHost?: string;
	smtpPort?: number;
};

export type ImapErrorCode =
	| "invalid_credentials"
	| "needs_reauth"
	| "invalid_config"
	| "request_failed"
	| "connection_not_found"
	| "connection_failed"
	| "message_not_found"
	| "folder_not_found";

export class ImapError extends Error {
	constructor(
		message: string,
		public readonly code: ImapErrorCode,
	) {
		super(message);
		this.name = "ImapError";
	}
}

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_IMAP_SECURE = true;
const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 20_000;
// Exported: providers/imap-write.ts (6.3) opens the same default mailbox for
// its flag action (and as the starting point before resolving the Trash
// folder for its trash action) — same INBOX constant, not a re-declared copy.
export const INBOX = "INBOX";

// Bounds how many recent/search results a single call returns — mirrors the
// calendar tool's MAX_EVENTS posture (a caller-supplied `limit` narrows this,
// never widens it).
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

// Bounds a single message body: raw fetched bytes (pre-decode; base64 adds
// ~33% overhead so this is intentionally larger than the text cap below) and
// the final decoded/stripped text handed to callers.
const MAX_BODY_RAW_BYTES = 200_000;
const MAX_BODY_TEXT_CHARS = 20_000;

function clampLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_LIST_LIMIT;
	if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(Math.floor(requested), MAX_LIST_LIMIT);
}

// imapflow throws AuthenticationFailure (a real Error subclass with
// `authenticationFailed: true`) on a rejected LOGIN — this is the only signal
// this module trusts to distinguish "bad credentials" from any other
// connection/network failure. Deliberately never inspects `err.message`: a
// server's raw NO-response text is out of this module's control and must
// never be forwarded verbatim into a thrown error (no password, no server
// internals leak to the user or a log call site further up).
// Exported for providers/imap-write.ts (6.3) — the write executor's own
// auth-failure detection for connect/mailboxOpen/messageMove/messageFlags*
// errors is the identical imapflow signal, not a re-implementation.
export function isAuthFailure(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	return (
		(err as { authenticationFailed?: unknown }).authenticationFailed === true
	);
}

// Always closes the socket, preferring a graceful LOGOUT and falling back to
// a hard close if LOGOUT itself fails (e.g. the connection already dropped).
// Called from every connect/read code path's `finally` block — the
// connection is never left open.
// Exported for providers/imap-write.ts (6.3): its ImapWriteFlowLike extends
// this module's ImapFlowLike (see that file), so the exact same
// close-in-`finally` chokepoint applies to write connections too — no
// separate copy of this "always close, LOGOUT preferred, hard close as
// fallback" logic.
export async function closeClient(client: ImapFlowLike): Promise<void> {
	try {
		await client.logout();
	} catch {
		try {
			client.close();
		} catch {
			// Best-effort: nothing more can be done if even a hard close throws.
		}
	}
}

// Exported for providers/imap-write.ts (6.3) — write connections are opened
// with the exact same host/port/secure/auth/timeout shape as read
// connections, just with `readOnly: false` passed to mailboxOpen at the call
// site instead of a different client-options shape.
export function buildClientOptions(
	host: string,
	port: number,
	secure: boolean,
	email: string,
	password: string,
): ImapClientOptions {
	return {
		host,
		port,
		secure,
		auth: { user: email, pass: password },
		connectionTimeout: CONNECT_TIMEOUT_MS,
		socketTimeout: SOCKET_TIMEOUT_MS,
		logger: false,
	};
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertImapConnection(params: {
	userId: string;
	email: string;
	password: string;
	config: ImapConnectionConfig;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"imap",
		params.email,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.password);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw new Error("Failed to update existing Email connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "imap",
			label: "Email",
			accountIdentifier: params.email,
			capabilities: ["email"],
			status: "connected",
			secret: params.password,
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt that created the row
		// first — same pattern as apple-caldav.ts's upsertAppleConnection.
		const raced = await findConnectionByAccount(
			params.userId,
			"imap",
			params.email,
		);
		if (!raced) throw err;
		await setConnectionSecret(params.userId, raced.id, params.password);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw err;
		return updated;
	}
}

// Two connect paths (see issue brief): manual (host/port/secure supplied by
// the caller — an app password for Gmail/iCloud, or the mailbox password for
// an own-domain/on-box account) and, as a future nice-to-have, autodiscovery
// from the email address or an on-box default mail host. No config currently
// exposes "this box's own mail host", so v1 treats every connect as manual —
// `imapHost` is required from the caller; only `imapPort`/`imapSecure` get
// sane defaults (993/true).
export async function imapConnect(
	params: {
		userId: string;
		email: string;
		imapHost: string;
		imapPort?: number;
		imapSecure?: boolean;
		password: string;
		smtpHost?: string;
		smtpPort?: number;
	} & ImapOpt,
): Promise<{ connection: ConnectionPublic }> {
	const email = params.email.trim();
	const imapHost = params.imapHost.trim();
	if (!email) {
		throw new ImapError("An email address is required", "invalid_config");
	}
	if (!imapHost) {
		throw new ImapError("An IMAP host is required", "invalid_config");
	}
	const imapPort = params.imapPort ?? DEFAULT_IMAP_PORT;
	if (!Number.isInteger(imapPort) || imapPort <= 0 || imapPort > 65535) {
		throw new ImapError("A valid IMAP port is required", "invalid_config");
	}
	const imapSecure = params.imapSecure ?? DEFAULT_IMAP_SECURE;
	const password = params.password;
	if (!password) {
		throw new ImapError("A mailbox password is required", "invalid_config");
	}

	const createClient = params.createClient ?? createDefaultImapClient;
	const client = createClient(
		buildClientOptions(imapHost, imapPort, imapSecure, email, password),
	);

	try {
		await client.connect();
		// SELECT/STATUS INBOX validates both the credentials AND that the
		// mailbox is reachable, matching the issue's "LOGIN + SELECT/STATUS"
		// connect-time validation requirement.
		await client.mailboxOpen(INBOX, { readOnly: true });
	} catch (err) {
		if (isAuthFailure(err)) {
			throw new ImapError("Invalid mailbox credentials", "invalid_credentials");
		}
		throw new ImapError(
			"Could not connect to the mailbox. Check the host, port, and TLS setting.",
			"connection_failed",
		);
	} finally {
		await closeClient(client);
	}

	const config: ImapConnectionConfig = {
		email,
		imapHost,
		imapPort,
		imapSecure,
		...(params.smtpHost ? { smtpHost: params.smtpHost } : {}),
		...(params.smtpPort ? { smtpPort: params.smtpPort } : {}),
	};
	const connection = await upsertImapConnection({
		userId: params.userId,
		email,
		password,
		config,
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type EmailHeader = {
	uid: number;
	from: string;
	subject: string;
	date: string;
	seen: boolean;
	snippet?: string;
};

// Exported for providers/imap-write.ts (6.3) — the write executor reads the
// SAME stored config shape (including smtpHost/smtpPort, used only by the
// send action) rather than re-parsing conn.config itself.
export function imapConfig(conn: ConnectionPublic): ImapConnectionConfig {
	const email = typeof conn.config.email === "string" ? conn.config.email : "";
	const imapHost =
		typeof conn.config.imapHost === "string" ? conn.config.imapHost : "";
	if (!email || !imapHost) {
		throw new ImapError(
			"Connection is missing email or imapHost in its config",
			"invalid_config",
		);
	}
	const imapPort =
		typeof conn.config.imapPort === "number"
			? conn.config.imapPort
			: DEFAULT_IMAP_PORT;
	const imapSecure =
		typeof conn.config.imapSecure === "boolean"
			? conn.config.imapSecure
			: DEFAULT_IMAP_SECURE;
	const smtpHost =
		typeof conn.config.smtpHost === "string" ? conn.config.smtpHost : undefined;
	const smtpPort =
		typeof conn.config.smtpPort === "number" ? conn.config.smtpPort : undefined;
	return {
		email,
		imapHost,
		imapPort,
		imapSecure,
		...(smtpHost ? { smtpHost } : {}),
		...(smtpPort ? { smtpPort } : {}),
	};
}

// Maps a folder NAME the model might use to its RFC 6154 SPECIAL-USE flag, so
// "Sent"/"Archive"/"Junk"/… resolve to the server's actual mailbox path even
// when it's literally called something else ("Sent Items", "[Gmail]/All
// Mail", …). Resolution tries this flag first, then a name/path match —
// mirroring the SPECIAL-USE-first-then-name order imap-write.ts already uses
// for the Trash mailbox (resolveTrashMailbox).
const FOLDER_SPECIAL_USE: Record<string, string> = {
	sent: "\\Sent",
	"sent mail": "\\Sent",
	"sent items": "\\Sent",
	archive: "\\Archive",
	archived: "\\Archive",
	drafts: "\\Drafts",
	draft: "\\Drafts",
	junk: "\\Junk",
	spam: "\\Junk",
	trash: "\\Trash",
	bin: "\\Trash",
	deleted: "\\Trash",
	"deleted messages": "\\Trash",
	"deleted items": "\\Trash",
	all: "\\All",
	"all mail": "\\All",
	flagged: "\\Flagged",
	starred: "\\Flagged",
};

function isInboxName(folder: string): boolean {
	return folder.trim().toLowerCase() === "inbox";
}

// Resolves the folder a read should open. Empty/INBOX short-circuits WITHOUT a
// LIST round-trip (the common case, and what every default read still does).
// Otherwise LISTs the account's mailboxes and resolves SPECIAL-USE-first, then
// by an exact case-insensitive name or path match. A folder that matches
// nothing is a clear folder_not_found rather than silently opening an
// unintended mailbox — the model can call list_folders to discover valid names.
async function resolveFolderPath(
	client: ImapFlowLike,
	folder: string | undefined,
): Promise<string> {
	const wanted = folder?.trim();
	if (!wanted || isInboxName(wanted)) return INBOX;

	const lower = wanted.toLowerCase();
	const mailboxes = await client.list();

	const specialUse = FOLDER_SPECIAL_USE[lower];
	if (specialUse) {
		const bySpecial = mailboxes.find((mbx) => mbx.specialUse === specialUse);
		if (bySpecial) return bySpecial.path;
	}
	const byName = mailboxes.find(
		(mbx) =>
			mbx.name.toLowerCase() === lower || mbx.path.toLowerCase() === lower,
	);
	if (byName) return byName.path;

	throw new ImapError("Mailbox folder not found", "folder_not_found");
}

// Opens a fresh connection scoped to one call, runs `run`, and always closes
// the connection afterwards (success or failure) — the one chokepoint every
// read function below routes through. `folder` (GAP B4) selects which mailbox
// to open, defaulting to INBOX; it is resolved SPECIAL-USE-first then by name.
// An auth failure mid-op marks the connection needs_reauth (mirrors
// google.ts/apple-caldav.ts) before rethrowing.
async function withImapConnection<T>(
	userId: string,
	connectionId: string,
	folder: string | undefined,
	opts: ImapOpt | undefined,
	run: (client: ImapFlowLike) => Promise<T>,
): Promise<T> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new ImapError("Email connection not found", "connection_not_found");
	}
	const password = await getConnectionSecret(userId, connectionId);
	if (!password) {
		throw new ImapError(
			"No password stored for this email connection",
			"needs_reauth",
		);
	}
	const { email, imapHost, imapPort, imapSecure } = imapConfig(conn);

	const createClient = opts?.createClient ?? createDefaultImapClient;
	const client = createClient(
		buildClientOptions(imapHost, imapPort, imapSecure, email, password),
	);

	try {
		await client.connect();
		const mailboxPath = await resolveFolderPath(client, folder);
		await client.mailboxOpen(mailboxPath, { readOnly: true });
		return await run(client);
	} catch (err) {
		if (err instanceof ImapError) throw err;
		if (isAuthFailure(err)) {
			const detail = "The mailbox rejected the stored password";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new ImapError(detail, "needs_reauth");
		}
		throw new ImapError("Failed to reach the mailbox", "request_failed");
	} finally {
		await closeClient(client);
	}
}

function formatFrom(envelope: ImapEnvelope | undefined): string {
	const from = envelope?.from?.[0];
	if (!from) return "";
	if (from.name && from.address) return `${from.name} <${from.address}>`;
	return from.address ?? from.name ?? "";
}

function formatDate(msg: ImapFetchedMessage): string {
	const raw = msg.envelope?.date ?? msg.internalDate;
	if (!raw) return "";
	const date = raw instanceof Date ? raw : new Date(raw);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toEmailHeader(msg: ImapFetchedMessage): EmailHeader {
	return {
		uid: msg.uid,
		from: formatFrom(msg.envelope),
		subject: msg.envelope?.subject ?? "(no subject)",
		date: formatDate(msg),
		seen: msg.flags?.has("\\Seen") ?? false,
	};
}

// Fetches ENVELOPE + FLAGS for a set of UIDs and maps them to EmailHeader,
// most-recent-first. Uses `{ uid: true }` throughout (never a bare sequence
// fetch), and imapflow's fetch always issues BODY.PEEK-style atoms for any
// body/header data — no call here can ever mark a message \Seen (see module
// doc comment).
async function fetchHeadersForUids(
	client: ImapFlowLike,
	uids: number[],
	limit: number,
): Promise<EmailHeader[]> {
	if (uids.length === 0) return [];
	const capped = uids.slice(-limit);
	const headers: EmailHeader[] = [];
	for await (const msg of client.fetch(
		capped,
		{ envelope: true, flags: true, uid: true },
		{ uid: true },
	)) {
		headers.push(toEmailHeader(msg));
	}
	headers.sort((a, b) => b.uid - a.uid);
	return headers.slice(0, limit);
}

export async function imapListRecent(
	userId: string,
	connectionId: string,
	params: { limit?: number; unseenOnly?: boolean; folder?: string } = {},
	opts?: ImapOpt,
): Promise<EmailHeader[]> {
	const limit = clampLimit(params.limit);
	return withImapConnection(
		userId,
		connectionId,
		params.folder,
		opts,
		async (client) => {
			const searchQuery: Record<string, unknown> = params.unseenOnly
				? { seen: false }
				: { all: true };
			const uids = await client.search(searchQuery, { uid: true });
			if (!uids || uids.length === 0) return [];
			return fetchHeadersForUids(client, uids, limit);
		},
	);
}

// The structured criteria a search/count can be built from (A2). `query` is the
// free-text portion (whole-message TEXT, word-AND'd — see imapSearch);
// from/subject are native IMAP header-text keys; since/before are date bounds.
export type ImapSearchCriteria = {
	query?: string;
	from?: string;
	subject?: string;
	since?: string;
	before?: string;
};

// imapflow's search-compiler treats SINCE/BEFORE specially ONLY when the value
// is a real Date (its WITHIN-extension path and BEFORE next-day adjustment both
// gate on `isDate(value)`). A bare "YYYY-MM-DD"/ISO string would bypass that and
// rely on a looser fallback, so normalize any user-supplied date string into a
// Date here; imapflow then emits the canonical "DD-Mon-YYYY" SEARCH term.
// Returns undefined for an unparseable value so one bad date is ignored rather
// than poisoning the whole query.
function normalizeSearchDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

// Builds the NON-text portion of an imapflow search object (from/subject/since/
// before) from the structured criteria. This object is spread into each
// per-word TEXT search so every criterion AND's together — IMAP search terms
// are implicitly AND'd. Text (`query`) is handled separately by the callers.
function buildSearchBase(params: ImapSearchCriteria): Record<string, unknown> {
	const base: Record<string, unknown> = {};
	const from = params.from?.trim();
	const subject = params.subject?.trim();
	if (from) base.from = from;
	if (subject) base.subject = subject;
	const since = normalizeSearchDate(params.since);
	const before = normalizeSearchDate(params.before);
	if (since) base.since = since;
	if (before) base.before = before;
	return base;
}

// Splits the free-text `query` into its whitespace-separated words. IMAP
// `SEARCH TEXT <string>` matches only a single contiguous substring, so a
// multi-word query issued as one TEXT term ("invoice from acme") almost never
// matches — instead each word becomes its own TEXT term and the per-word UID
// sets are intersected by the callers (semantically identical to `TEXT a TEXT
// b`, which imapflow cannot express as one query object).
function queryWords(query: string | undefined): string[] {
	return (query ?? "").trim().split(/\s+/).filter(Boolean);
}

// Runs one `{ ...base, text: word }` SEARCH per word and returns the
// intersection of the per-word UID sets, or null when there are no words (the
// caller then does a single structured-only search). Any word with zero matches
// short-circuits to an empty intersection since the AND can never be satisfied.
async function searchWordIntersection(
	client: ImapFlowLike,
	base: Record<string, unknown>,
	words: string[],
): Promise<number[] | null> {
	if (words.length === 0) return null;
	let matched: number[] | null = null;
	for (const word of words) {
		const uids = await client.search({ ...base, text: word }, { uid: true });
		if (!uids || uids.length === 0) return [];
		if (matched === null) {
			matched = uids;
		} else {
			const keep = new Set(uids);
			matched = matched.filter((uid) => keep.has(uid));
			if (matched.length === 0) return [];
		}
	}
	return matched;
}

export async function imapSearch(
	userId: string,
	connectionId: string,
	params: ImapSearchCriteria & { limit?: number; folder?: string },
	opts?: ImapOpt,
): Promise<EmailHeader[]> {
	const limit = clampLimit(params.limit);
	const base = buildSearchBase(params);
	const words = queryWords(params.query);
	// Nothing to search on at all — no free-text words AND no structured filter.
	// Preserves the prior "blank query -> [] without opening a connection".
	if (words.length === 0 && Object.keys(base).length === 0) return [];

	return withImapConnection(
		userId,
		connectionId,
		params.folder,
		opts,
		async (client) => {
			// No free-text words: a single SEARCH built purely from the structured
			// keys (e.g. "emails from Anna since Monday", no free text).
			if (words.length === 0) {
				const uids = await client.search(base, { uid: true });
				if (!uids || uids.length === 0) return [];
				return fetchHeadersForUids(client, uids, limit);
			}

			const matched = await searchWordIntersection(client, base, words);
			if (!matched || matched.length === 0) return [];
			return fetchHeadersForUids(client, matched, limit);
		},
	);
}

// Returns the NUMBER of messages matching a search WITHOUT fetching any
// headers/bodies (A4). An IMAP SEARCH already returns every matching UID, so
// `uids.length` is a free, exact count that is never bounded by the
// recent/search list caps (DEFAULT_LIST_LIMIT/MAX_LIST_LIMIT) — those only
// bound how many headers a list FETCHes, which a count never does. Answers
// "how many unread emails do I have?" (`{ unseenOnly: true }`) accurately even
// when there are hundreds. `unseenOnly` AND's `SEEN false` onto any structured
// criteria; with no criteria and no unseenOnly it counts everything (SEARCH
// ALL).
export async function imapCount(
	userId: string,
	connectionId: string,
	params: ImapSearchCriteria & { unseenOnly?: boolean; folder?: string } = {},
	opts?: ImapOpt,
): Promise<number> {
	const base = buildSearchBase(params);
	if (params.unseenOnly) base.seen = false;
	const words = queryWords(params.query);

	return withImapConnection(
		userId,
		connectionId,
		params.folder,
		opts,
		async (client) => {
			// No free-text words: a single SEARCH whose UID count is the answer. An
			// empty base means "count everything" -> SEARCH ALL.
			if (words.length === 0) {
				const searchQuery =
					Object.keys(base).length > 0 ? base : { all: true };
				const uids = await client.search(searchQuery, { uid: true });
				return uids ? uids.length : 0;
			}

			// Free-text words AND together exactly as in imapSearch, but only the
			// SIZE of the final UID set is needed — no header fetch ever happens.
			const matched = await searchWordIntersection(client, base, words);
			return matched ? matched.length : 0;
		},
	);
}

// ---------------------------------------------------------------------------
// Minimal MIME text extraction — hand-rolled, no dependency (same rationale
// as apple-caldav.ts's iCal parser: a full MIME/charset library is out of
// scope for a read-only v1). Only decodes the two transfer encodings emails
// actually use in practice (base64, quoted-printable) and only cares about
// the first text/plain part (falling back to text/html, stripped of tags).
// ---------------------------------------------------------------------------

function findTextPart(
	node: ImapBodyStructureNode | undefined,
): { part: string; encoding?: string; charset?: string; html: boolean } | null {
	if (!node) return null;
	if (!node.childNodes || node.childNodes.length === 0) {
		// Single-part message: imapflow (and the IMAP BODY[] grammar) address
		// the body of a non-multipart message as "TEXT", not the structural
		// part id "1" — mirrors imapflow's own download() special-case.
		const type = node.type.toLowerCase();
		if (type === "text/plain" || type === "text/html") {
			return {
				part: "TEXT",
				encoding: node.encoding,
				charset: node.parameters?.charset,
				html: type === "text/html",
			};
		}
		return null;
	}

	let htmlFallback: ReturnType<typeof findTextPart> = null;
	for (const child of node.childNodes) {
		const type = child.type.toLowerCase();
		if (type === "text/plain" && child.part) {
			return {
				part: child.part,
				encoding: child.encoding,
				charset: child.parameters?.charset,
				html: false,
			};
		}
		if (type === "text/html" && child.part && !htmlFallback) {
			htmlFallback = {
				part: child.part,
				encoding: child.encoding,
				charset: child.parameters?.charset,
				html: true,
			};
		}
		// Recurse into nested multipart nodes (e.g. multipart/alternative
		// inside multipart/mixed).
		const nested = findTextPart(child);
		if (nested && !nested.html) return nested;
		if (nested?.html && !htmlFallback) htmlFallback = nested;
	}
	return htmlFallback;
}

function decodeQuotedPrintable(
	input: string,
	bufferEncoding: BufferEncoding,
): string {
	// Soft line breaks ("=\r\n" or "=\n") are removed entirely; "=XX" is a
	// hex-escaped byte.
	const withoutSoftBreaks = input.replace(/=\r?\n/g, "");
	const bytes: number[] = [];
	for (let i = 0; i < withoutSoftBreaks.length; i++) {
		const ch = withoutSoftBreaks[i];
		if (
			ch === "=" &&
			/^[0-9A-Fa-f]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))
		) {
			bytes.push(Number.parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			bytes.push(ch.charCodeAt(0));
		}
	}
	// Decode the reconstructed bytes with the message's resolved charset (the
	// same charset-aware BufferEncoding the base64/plaintext branches use) —
	// a quoted-printable body in iso-8859-1 (e.g. "caf=E9") must be read as
	// latin1, not hardcoded utf-8, or non-ASCII bytes become mojibake.
	return Buffer.from(bytes).toString(bufferEncoding);
}

function decodeBodyBuffer(
	buffer: Buffer,
	encoding: string | undefined,
	charset: string | undefined,
): string {
	const normalizedEncoding = (encoding ?? "7bit").toLowerCase();
	const normalizedCharset = (charset ?? "utf-8").toLowerCase();
	// Only a handful of Buffer-supported charset aliases are handled — good
	// enough for the common case; anything exotic falls back to utf-8 rather
	// than pulling in an iconv dependency.
	const bufferEncoding: BufferEncoding =
		normalizedCharset === "iso-8859-1" || normalizedCharset === "latin1"
			? "latin1"
			: normalizedCharset === "us-ascii"
				? "ascii"
				: "utf8";

	if (normalizedEncoding === "base64") {
		return Buffer.from(buffer.toString("ascii"), "base64").toString(
			bufferEncoding,
		);
	}
	if (normalizedEncoding === "quoted-printable") {
		return decodeQuotedPrintable(buffer.toString("ascii"), bufferEncoding);
	}
	return buffer.toString(bufferEncoding);
}

function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars).trimEnd()}...`;
}

// Walks the (already-fetched) bodyStructure and LISTS attachment parts — their
// filename, MIME type, and server-reported size (GAP B5). NO bytes are ever
// downloaded (that is a deliberately larger follow-up); this answers "does this
// email have an attachment?" / "what's attached?" from structure alone. A leaf
// part counts as an attachment when it is explicitly `Content-Disposition:
// attachment` OR carries a filename/name parameter (covers inline parts a mail
// client still shows as attachments); the multipart containers and the
// disposition-less text/html body parts are skipped.
function collectAttachments(
	node: ImapBodyStructureNode | undefined,
): ImapAttachment[] {
	if (!node) return [];
	const out: ImapAttachment[] = [];
	const walk = (n: ImapBodyStructureNode): void => {
		if (n.childNodes && n.childNodes.length > 0) {
			for (const child of n.childNodes) walk(child);
			return;
		}
		const disposition = n.disposition?.toLowerCase();
		const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
		const isAttachment = disposition === "attachment" || Boolean(filename);
		if (!isAttachment) return;
		out.push({
			filename: filename ?? "(unnamed)",
			contentType: n.type.toLowerCase(),
			...(typeof n.size === "number" ? { size: n.size } : {}),
		});
	};
	walk(node);
	return out;
}

export async function imapReadMessage(
	userId: string,
	connectionId: string,
	params: { uid: number; folder?: string },
	opts?: ImapOpt,
): Promise<{ header: EmailHeader; text: string; attachments: ImapAttachment[] }> {
	return withImapConnection(
		userId,
		connectionId,
		params.folder,
		opts,
		async (client) => {
			const metaMsg = await client.fetchOne(
				params.uid,
				{ envelope: true, flags: true, uid: true, bodyStructure: true },
				{ uid: true },
			);
			if (!metaMsg) {
				throw new ImapError("Message not found", "message_not_found");
			}

			const header = toEmailHeader(metaMsg);
			const attachments = collectAttachments(metaMsg.bodyStructure);
			const textPart = findTextPart(metaMsg.bodyStructure);
			if (!textPart) {
				return { header, text: "", attachments };
			}

			const bodyMsg = await client.fetchOne(
				params.uid,
				{
					bodyParts: [{ key: textPart.part, maxLength: MAX_BODY_RAW_BYTES }],
				},
				{ uid: true },
			);
			// imapflow LOWERCASES every FETCH response part key when building the
			// returned bodyParts Map (tools.js formatMessageResponse). A single-part
			// body is requested as "TEXT" but comes back keyed "text", so the lookup
			// must be case-insensitive; numeric multipart ids ("1", "1.2") are
			// unaffected since toLowerCase() leaves them unchanged.
			const raw = bodyMsg
				? bodyMsg.bodyParts?.get(textPart.part.toLowerCase())
				: undefined;
			if (!raw) {
				return { header, text: "", attachments };
			}

			const decoded = decodeBodyBuffer(
				raw,
				textPart.encoding,
				textPart.charset,
			);
			const plainText = textPart.html ? stripHtml(decoded) : decoded;
			return {
				header,
				text: truncate(plainText, MAX_BODY_TEXT_CHARS),
				attachments,
			};
		},
	);
}

// ---------------------------------------------------------------------------
// Folder discovery (GAP B4) — lists the account's mailboxes with their
// SPECIAL-USE flags so the model can discover folder names ("what folders do I
// have?") and map "Sent"/"Archive"/… to the server's real path. Read-only:
// the LIST command mutates nothing; the connection still opens INBOX read-only
// via withImapConnection as a structural guard (no mailbox content is read).
// ---------------------------------------------------------------------------

export type ImapFolder = {
	path: string;
	name: string;
	specialUse?: string;
};

export async function imapListFolders(
	userId: string,
	connectionId: string,
	opts?: ImapOpt,
): Promise<ImapFolder[]> {
	return withImapConnection(
		userId,
		connectionId,
		undefined,
		opts,
		async (client) => {
			const mailboxes = await client.list();
			return mailboxes.map((mbx) => ({
				path: mbx.path,
				name: mbx.name,
				...(mbx.specialUse ? { specialUse: mbx.specialUse } : {}),
			}));
		},
	);
}

// ---------------------------------------------------------------------------
// Adapter — connect + NOOP-equivalent (a fresh LOGIN + SELECT INBOX, same
// cheap validation imapConnect itself does) to confirm the stored password
// still works.
// ---------------------------------------------------------------------------

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: ImapOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	let config: ImapConnectionConfig;
	try {
		config = imapConfig(conn);
	} catch {
		// Generic, controlled detail — never forward a raw error message into
		// statusDetail (mirrors imapConnect's non-auth path).
		return {
			status: "error",
			detail: "This email connection is missing required configuration.",
		};
	}

	const createClient = opts?.createClient ?? createDefaultImapClient;
	const client = createClient(
		buildClientOptions(
			config.imapHost,
			config.imapPort,
			config.imapSecure,
			config.email,
			secret,
		),
	);
	try {
		await client.connect();
		await client.mailboxOpen(INBOX, { readOnly: true });
		return { status: "connected", detail: null };
	} catch (err) {
		if (isAuthFailure(err)) {
			return {
				status: "needs_reauth",
				detail: "The mailbox rejected the stored password",
			};
		}
		// Generic, controlled detail — a server's raw NO/BYE text (or any
		// imapflow error message) must never be forwarded verbatim into
		// statusDetail, same posture as imapConnect's non-auth path.
		return {
			status: "error",
			detail:
				"Could not connect to the mailbox. Check the host, port, and TLS setting.",
		};
	} finally {
		await closeClient(client);
	}
}

// Not annotated as `: ConnectionAdapter` — same rationale as
// appleAdapter/nextcloudFilesAdapter: that annotation would narrow
// checkHealth's call signature to the interface's (secret, conn) shape and
// break the mocked-client tests that pass a third `{ createClient }` opts
// arg.
export const imapAdapter = {
	provider: "imap" as const,
	checkHealth,
};

registerConnectionAdapter(imapAdapter satisfies ConnectionAdapter);
