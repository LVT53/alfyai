import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { registerConnectionAdapter } from "../adapters";
import { assertPublicHttpsUrl } from "../host-locality";
import {
	basicAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
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
import { registerWriteExecutor } from "../write-executors";
import { resolveWriteTarget, type WriteOperation } from "../write-guard";

const USER_AGENT = "AlfyAI";

type FetchOpt = { fetch?: typeof fetch };

// jsdom is a real (non-dev) dependency already used server-side for HTML
// extraction (see web-research/extraction.ts) — reused here as a namespace-
// aware XML parser for WebDAV multistatus responses rather than pulling in a
// dedicated XML package. Loaded via createRequire (not a static import) so
// it stays a lazily-resolved CJS module the same way extraction.ts does.
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
	JSDOM: new (
		xml: string,
		options?: Record<string, unknown>,
	) => { window: { document: Document } };
};

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

type LoginV2StartResponse = {
	poll: { token: string; endpoint: string };
	login: string;
};

// Validates the shape of a Nextcloud login/v2 poll 200 response before it is
// ever used to create/update a connection. `server` is only checked for
// type (we never trust it for storage — see nextcloudConnectPoll below);
// `loginName`/`appPassword` must be non-empty strings since they become the
// account identifier and the encrypted secret.
function assertValidPollResponse(
	body: unknown,
): asserts body is { server: string; loginName: string; appPassword: string } {
	if (!body || typeof body !== "object") {
		throw new Error("Nextcloud login/v2 poll returned a malformed response");
	}
	const { server, loginName, appPassword } = body as Record<string, unknown>;
	if (typeof server !== "string") {
		throw new Error(
			"Nextcloud login/v2 poll response is missing a string 'server' field",
		);
	}
	if (typeof loginName !== "string" || loginName.length === 0) {
		throw new Error(
			"Nextcloud login/v2 poll response is missing a non-empty 'loginName'",
		);
	}
	if (typeof appPassword !== "string" || appPassword.length === 0) {
		throw new Error(
			"Nextcloud login/v2 poll response is missing a non-empty 'appPassword'",
		);
	}
}

export async function nextcloudConnectStart(
	serverUrl: string,
	opts?: FetchOpt,
): Promise<{
	loginUrl: string;
	pollToken: string;
	pollEndpoint: string;
	serverUrl: string;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const normalized = assertPublicHttpsUrl(serverUrl);

	const response = await fetchImpl(`${normalized}/index.php/login/v2`, {
		method: "POST",
		headers: { "User-Agent": USER_AGENT },
	});
	if (!response.ok) {
		throw new Error(
			`Nextcloud login/v2 start failed with status ${response.status}`,
		);
	}

	const body = (await response.json()) as LoginV2StartResponse;
	return {
		loginUrl: body.login,
		pollToken: body.poll.token,
		pollEndpoint: body.poll.endpoint,
		serverUrl: normalized,
	};
}

// Creates the connection on first successful poll, or refreshes an existing
// one (same userId+provider+loginName) on a re-poll/re-authorization instead
// of colliding on the store's unique index. Also guards against a race
// between the pre-check and the insert by catching the unique-constraint
// error and falling back to an update.
async function upsertNextcloudConnection(params: {
	userId: string;
	serverUrl: string;
	loginName: string;
	appPassword: string;
}): Promise<ConnectionPublic> {
	const config = { serverUrl: params.serverUrl, loginName: params.loginName };

	const existing = await findConnectionByAccount(
		params.userId,
		"nextcloud",
		params.loginName,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.appPassword);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config,
		});
		if (!updated) throw new Error("Failed to update existing connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: params.loginName,
			capabilities: ["files"],
			status: "connected",
			secret: params.appPassword,
			config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent poll that created the row first.
		const raced = await findConnectionByAccount(
			params.userId,
			"nextcloud",
			params.loginName,
		);
		if (!raced) throw err;
		await setConnectionSecret(params.userId, raced.id, params.appPassword);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
			config,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function nextcloudConnectPoll(
	params: {
		userId: string;
		serverUrl: string;
		pollToken: string;
	} & FetchOpt,
): Promise<
	{ status: "pending" } | { status: "connected"; connection: ConnectionPublic }
> {
	const fetchImpl = params.fetch ?? fetch;
	const serverUrl = assertPublicHttpsUrl(params.serverUrl);
	const pollEndpoint = `${serverUrl}/index.php/login/v2/poll`;

	const response = await fetchImpl(pollEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token: params.pollToken }).toString(),
	});

	if (response.status === 404) {
		return { status: "pending" };
	}
	if (!response.ok) {
		throw new Error(
			`Nextcloud login/v2 poll failed with status ${response.status}`,
		);
	}

	const body: unknown = await response.json();
	assertValidPollResponse(body);

	// The secret is ONLY the appPassword — serverUrl/loginName are non-secret
	// and go in `config` (config_json, 1.7), never bundled into the encrypted
	// secret blob. `config.serverUrl` is always the caller-validated
	// serverUrl, never the response body's `server` field (which is
	// untrusted and could otherwise be used to redirect future checkHealth
	// calls — carrying the decrypted secret — to an attacker-chosen host).
	const connection = await upsertNextcloudConnection({
		userId: params.userId,
		serverUrl,
		loginName: body.loginName,
		appPassword: body.appPassword,
	});

	return { status: "connected", connection };
}

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const serverUrl =
		typeof conn.config.serverUrl === "string" ? conn.config.serverUrl : "";
	const loginName =
		typeof conn.config.loginName === "string" ? conn.config.loginName : "";

	if (!serverUrl || !loginName) {
		return {
			status: "error",
			detail: "Connection is missing serverUrl or loginName in its config",
		};
	}

	try {
		const response = await fetchImpl(`${serverUrl}/ocs/v1.php/cloud/user`, {
			headers: {
				Authorization: `Basic ${Buffer.from(`${loginName}:${secret}`).toString("base64")}`,
				"OCS-APIRequest": "true",
			},
		});

		if (response.status === 200) {
			return { status: "connected", detail: null };
		}
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "Nextcloud rejected the stored app password",
			};
		}
		return {
			status: "error",
			detail: `Nextcloud returned an unexpected status (${response.status})`,
		};
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// No server-side revoke call exists for v1: deleting the stored app password
// (handled by the store layer when the connection row is removed) is
// sufficient to cut off access. Kept as an explicit no-op so the adapter
// contract is documented rather than silently absent.
async function disconnect(): Promise<void> {}

// ---------------------------------------------------------------------------
// READ methods (2.2): list / search / read / stat over Nextcloud WebDAV.
// No writes here — see Phase 4 for that. All requests are bounded (timeout +
// read-size cap) and every path is run through normalizeNextcloudPath before
// it is ever interpolated into a URL.
// ---------------------------------------------------------------------------

export type NcFile = {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: string | null;
	contentType: string | null;
	etag: string | null;
};

export type NextcloudFilesErrorCode =
	| "invalid_path"
	| "invalid_config"
	| "needs_reauth"
	| "not_found"
	| "too_large"
	| "request_failed"
	| "etag_mismatch"
	| "conflict"
	| "writes_disabled"
	| "connection_not_found";

export class NextcloudFilesError extends ConnectionHttpError<NextcloudFilesErrorCode> {
	constructor(message: string, code: NextcloudFilesErrorCode) {
		super(message, code);
		this.name = "NextcloudFilesError";
	}
}

// Timeout error for every WebDAV call routed through providerFetch — matches
// the wording the private fetchWithTimeout produced.
const nextcloudTimeout = (ms: number) =>
	new NextcloudFilesError(
		`Nextcloud request timed out after ${ms}ms`,
		"request_failed",
	);

const MAX_READ_BYTES = 25 * 1024 * 1024; // 25 MB — chat-context reads only.
// PROPFIND/SEARCH responses are metadata-only XML and should never
// legitimately approach this size; capped separately (and much lower than
// MAX_READ_BYTES) as defense-in-depth against a malicious/misbehaving server
// returning an unbounded multistatus body.
const MAX_MULTISTATUS_BYTES = 10 * 1024 * 1024; // 10 MB

// Normalizes a caller-supplied relative path against the user's Nextcloud
// files root and rejects any attempt to escape it with `..`. This is the
// single mandatory chokepoint every read method routes through before a URL
// is built — a path is NEVER interpolated into a request without first
// passing through here. Leading/trailing slashes and repeated slashes are
// collapsed; `.` segments are dropped; a `..` that would pop past the root
// throws rather than silently clamping, so a bug elsewhere can't quietly
// turn into a path-traversal read.
export function normalizeNextcloudPath(path: string): string {
	const stack: string[] = [];
	for (const raw of path.split("/")) {
		const segment = raw.trim();
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (stack.length === 0) {
				throw new NextcloudFilesError(
					"Path escapes the Nextcloud files root",
					"invalid_path",
				);
			}
			stack.pop();
			continue;
		}
		stack.push(segment);
	}
	return stack.join("/");
}

function nextcloudConfig(conn: ConnectionPublic): {
	serverUrl: string;
	loginName: string;
} {
	const serverUrl =
		typeof conn.config.serverUrl === "string" ? conn.config.serverUrl : "";
	const loginName =
		typeof conn.config.loginName === "string" ? conn.config.loginName : "";
	if (!serverUrl || !loginName) {
		throw new NextcloudFilesError(
			"Connection is missing serverUrl or loginName in its config",
			"invalid_config",
		);
	}
	return { serverUrl, loginName };
}

function filesRootUrl(serverUrl: string, loginName: string): string {
	return `${serverUrl}/remote.php/dav/files/${encodeURIComponent(loginName)}`;
}

// `normalizedPath` must already have passed through normalizeNextcloudPath —
// this only URL-encodes each segment, it does not itself guard traversal.
function filesUrl(
	serverUrl: string,
	loginName: string,
	normalizedPath: string,
): string {
	const root = filesRootUrl(serverUrl, loginName);
	if (!normalizedPath) return root;
	const encoded = normalizedPath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${root}/${encoded}`;
}

// Shared 401 -> needs_reauth mapping so the caller (a tool/route) can react
// uniformly regardless of which WebDAV verb failed. Deliberately does not
// reference the password anywhere in the message.
function assertNotAuthFailure(response: Response): void {
	if (response.status === 401) {
		throw new NextcloudFilesError(
			"Nextcloud rejected the stored app password",
			"needs_reauth",
		);
	}
}

// Defense-in-depth cap on PROPFIND/SEARCH multistatus bodies, checked against
// the declared Content-Length before `response.text()` ever buffers the
// body — mirrors the read-size pre-check in nextcloudReadFile, just against
// a much smaller ceiling appropriate for XML metadata.
function assertMultistatusSizeWithinLimit(response: Response): void {
	const header = response.headers.get("Content-Length");
	if (!header) return;
	const declared = Number.parseInt(header, 10);
	if (Number.isFinite(declared) && declared > MAX_MULTISTATUS_BYTES) {
		const maxMb = MAX_MULTISTATUS_BYTES / (1024 * 1024);
		throw new NextcloudFilesError(
			`Nextcloud multistatus response exceeds the ${maxMb}MB size limit`,
			"too_large",
		);
	}
}

const DAV_NS = "DAV:";

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
	<d:prop>
		<d:displayname/>
		<d:getcontentlength/>
		<d:getlastmodified/>
		<d:getcontenttype/>
		<d:getetag/>
		<d:resourcetype/>
	</d:prop>
</d:propfind>`;

function textOf(el: Element | null | undefined): string | null {
	if (!el) return null;
	const text = el.textContent;
	if (text === null) return null;
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function firstNs(el: Element | Document, localName: string): Element | null {
	const found = el.getElementsByTagNameNS(DAV_NS, localName);
	return found.length > 0 ? (found[0] as Element) : null;
}

// Recovers the path relative to the user's files root from a `<d:href>`,
// independent of any scheme/host/subpath prefix Nextcloud may have put in
// front of it. Returns null (entry skipped) rather than guessing if the
// expected `/remote.php/dav/files/{loginName}/` marker isn't present.
function relativePathFromHref(href: string, loginName: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(href);
	} catch {
		decoded = href;
	}
	const marker = `/remote.php/dav/files/${loginName}/`;
	const idx = decoded.indexOf(marker);
	if (idx === -1) return null;
	return decoded.slice(idx + marker.length).replace(/\/+$/, "");
}

function parseResponseElement(
	responseEl: Element,
	loginName: string,
): NcFile | null {
	const href = textOf(firstNs(responseEl, "href"));
	if (!href) return null;
	const relPath = relativePathFromHref(href, loginName);
	if (relPath === null) return null;

	const propstats = Array.from(
		responseEl.getElementsByTagNameNS(DAV_NS, "propstat"),
	);
	const okPropstat =
		propstats.find((ps) => {
			const status = textOf(firstNs(ps, "status"));
			return status ? / 200 /.test(` ${status} `) : false;
		}) ?? propstats[0];
	const prop = okPropstat ? firstNs(okPropstat, "prop") : null;

	const displayName = prop ? textOf(firstNs(prop, "displayname")) : null;
	const resourcetype = prop ? firstNs(prop, "resourcetype") : null;
	const isDir = resourcetype
		? resourcetype.getElementsByTagNameNS(DAV_NS, "collection").length > 0
		: false;
	const contentLengthText = prop
		? textOf(firstNs(prop, "getcontentlength"))
		: null;
	const parsedSize = contentLengthText
		? Number.parseInt(contentLengthText, 10)
		: 0;
	const mtime = prop ? textOf(firstNs(prop, "getlastmodified")) : null;
	const contentType = prop ? textOf(firstNs(prop, "getcontenttype")) : null;
	const etag = prop ? textOf(firstNs(prop, "getetag")) : null;

	const segments = relPath.split("/").filter(Boolean);
	const name = displayName ?? segments[segments.length - 1] ?? "";

	return {
		name,
		path: relPath,
		isDir,
		size: Number.isFinite(parsedSize) ? parsedSize : 0,
		mtime,
		contentType,
		etag,
	};
}

// Parses a WebDAV 207 Multistatus response into NcFile[]. Namespace-aware
// (matches on the `DAV:` namespace URI, not on the `d:`/`D:` prefix some
// servers use) via jsdom's XML DOM rather than regexing the XML by hand.
function parseMultistatus(xml: string, loginName: string): NcFile[] {
	const dom = new JSDOM(xml, { contentType: "application/xml" });
	const doc = dom.window.document;
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));
	const files: NcFile[] = [];
	for (const responseEl of responses) {
		const file = parseResponseElement(responseEl, loginName);
		if (file) files.push(file);
	}
	return files;
}

async function propfind(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	depth: "0" | "1",
	opts?: FetchOpt,
): Promise<{ status: number; xml: string; normalizedPath: string }> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedPath = normalizeNextcloudPath(path);
	const url = filesUrl(serverUrl, loginName, normalizedPath);

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "PROPFIND",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"Content-Type": "text/xml; charset=utf-8",
			Depth: depth,
			"User-Agent": USER_AGENT,
		},
		body: PROPFIND_BODY,
	});

	assertNotAuthFailure(response);
	if (response.status === 207) {
		assertMultistatusSizeWithinLimit(response);
	}
	const xml = response.status === 207 ? await response.text() : "";
	return { status: response.status, xml, normalizedPath };
}

// Lists the immediate children of `path` (PROPFIND, Depth: 1). The folder's
// own entry (always present in a Depth-1 response) is filtered out so
// callers only see children.
export async function nextcloudListFolder(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	opts?: FetchOpt,
): Promise<NcFile[]> {
	const { status, xml, normalizedPath } = await propfind(
		conn,
		appPassword,
		path,
		"1",
		opts,
	);

	if (status === 404) {
		throw new NextcloudFilesError(
			`Folder not found: ${normalizedPath || "/"}`,
			"not_found",
		);
	}
	if (status !== 207) {
		throw new NextcloudFilesError(
			`Nextcloud PROPFIND failed with status ${status}`,
			"request_failed",
		);
	}

	const { loginName } = nextcloudConfig(conn);
	const entries = parseMultistatus(xml, loginName);
	return entries.filter((entry) => entry.path !== normalizedPath);
}

// Stats a single path (PROPFIND, Depth: 0). Returns null on 404 rather than
// throwing — "does this exist" is an expected outcome, not an error.
export async function nextcloudStat(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	opts?: FetchOpt,
): Promise<NcFile | null> {
	const { status, xml } = await propfind(conn, appPassword, path, "0", opts);

	if (status === 404) return null;
	if (status !== 207) {
		throw new NextcloudFilesError(
			`Nextcloud PROPFIND failed with status ${status}`,
			"request_failed",
		);
	}

	const { loginName } = nextcloudConfig(conn);
	const entries = parseMultistatus(xml, loginName);
	return entries[0] ?? null;
}

// Reads a file's bytes (GET). Refuses anything over MAX_READ_BYTES — checked
// against the Content-Length header up front where present (so an oversized
// file is rejected without buffering it), and again against the actual
// decoded size as a fallback for chunked responses with no Content-Length.
export async function nextcloudReadFile(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	opts?: FetchOpt,
): Promise<{
	bytes: Uint8Array;
	etag: string | null;
	contentType: string | null;
	// Last-Modified from the GET response headers (RFC 1123 date string), so a
	// single-file read can surface the same modification time list/search
	// expose from PROPFIND — needed for "is this the newest version" style
	// follow-ups. Null when the server omits the header.
	mtime: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedPath = normalizeNextcloudPath(path);
	if (!normalizedPath) {
		throw new NextcloudFilesError(
			"Cannot read the files root as a file",
			"invalid_path",
		);
	}
	const url = filesUrl(serverUrl, loginName, normalizedPath);

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "GET",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"User-Agent": USER_AGENT,
		},
	});

	assertNotAuthFailure(response);
	if (response.status === 404) {
		throw new NextcloudFilesError(
			`File not found: ${normalizedPath}`,
			"not_found",
		);
	}
	if (!response.ok) {
		throw new NextcloudFilesError(
			`Nextcloud GET failed with status ${response.status}`,
			"request_failed",
		);
	}

	const maxMb = MAX_READ_BYTES / (1024 * 1024);
	const contentLengthHeader = response.headers.get("Content-Length");
	if (contentLengthHeader) {
		const declared = Number.parseInt(contentLengthHeader, 10);
		if (Number.isFinite(declared) && declared > MAX_READ_BYTES) {
			throw new NextcloudFilesError(
				`File exceeds the ${maxMb}MB read limit`,
				"too_large",
			);
		}
	}

	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_READ_BYTES) {
		throw new NextcloudFilesError(
			`File exceeds the ${maxMb}MB read limit`,
			"too_large",
		);
	}

	return {
		bytes: new Uint8Array(buffer),
		etag: response.headers.get("ETag"),
		contentType: response.headers.get("Content-Type"),
		mtime: response.headers.get("Last-Modified"),
	};
}

function escapeXmlText(value: string): string {
	return value.replace(/[&<>]/g, (ch) => {
		if (ch === "&") return "&amp;";
		if (ch === "<") return "&lt;";
		return "&gt;";
	});
}

// Escapes SQL LIKE metacharacters (`%`, `_`) in the caller-supplied query so
// they're matched as literal characters rather than wildcards once wrapped
// in our own `%...%` pattern below — e.g. a query of "50% off" should search
// for that literal string, not "50" + any-chars + " off". Backslash is
// escaped first so a query already containing one doesn't get reinterpreted.
// This is independent of (and applied before) escapeXmlText, which only
// guards against XML injection, not LIKE-pattern semantics.
function escapeLikeWildcards(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function searchRequestBody(loginName: string, query: string): string {
	const scopeHref = `/files/${encodeURIComponent(loginName)}/`;
	const literal = `%${escapeXmlText(escapeLikeWildcards(query))}%`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:">
	<d:basicsearch>
		<d:select>
			<d:prop>
				<d:displayname/>
				<d:getcontentlength/>
				<d:getlastmodified/>
				<d:getcontenttype/>
				<d:getetag/>
				<d:resourcetype/>
			</d:prop>
		</d:select>
		<d:from>
			<d:scope>
				<d:href>${scopeHref}</d:href>
				<d:depth>infinity</d:depth>
			</d:scope>
		</d:from>
		<d:where>
			<d:like>
				<d:prop><d:displayname/></d:prop>
				<d:literal>${literal}</d:literal>
			</d:like>
		</d:where>
	</d:basicsearch>
</d:searchrequest>`;
}

// Server-side full-text-ish filename search via the WebDAV SEARCH method
// (RFC 5323 basicsearch), scoped to the user's files collection. Preferred
// over a client-side PROPFIND walk: it's a single round trip, Nextcloud does
// the tree walk itself, and there's no risk of an unbounded/expensive
// recursive crawl on this server. If SEARCH is ever found to be unreliable
// against some Nextcloud versions, the documented fallback is a
// depth-limited, node-capped PROPFIND walk — NOT unbounded recursion.
export async function nextcloudSearch(
	conn: ConnectionPublic,
	appPassword: string,
	query: string,
	opts?: FetchOpt,
): Promise<NcFile[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const url = `${serverUrl}/remote.php/dav/`;

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "SEARCH",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"Content-Type": "text/xml; charset=utf-8",
			"User-Agent": USER_AGENT,
		},
		body: searchRequestBody(loginName, query),
	});

	assertNotAuthFailure(response);
	if (response.status !== 207) {
		throw new NextcloudFilesError(
			`Nextcloud SEARCH failed with status ${response.status}`,
			"request_failed",
		);
	}
	assertMultistatusSizeWithinLimit(response);

	const xml = await response.text();
	return parseMultistatus(xml, loginName);
}

// Suggestions returned by nextcloudListFolders default to top-level (or the
// single requested level) and are capped well below the multistatus size
// guard — a folder with thousands of children shouldn't inflate the
// dropdown the settings UI renders from.
const MAX_LIST_FOLDERS = 200;

export type NextcloudFolderSuggestion = { path: string; name: string };

// User-scoped folder listing (Redesign R9) — the write-allowlist folder
// editor's suggestion feature needs child FOLDERS ONLY, without the caller
// (a SvelteKit route) ever touching the connection row or the decrypted
// secret directly. Mirrors the load-connection -> decrypt-secret -> typed-
// error shape of executeNextcloudWrite below, but for a read instead of a
// write, and returns normalized absolute paths (e.g. "/Documents") rather
// than the root-relative NcFile[] nextcloudListFolder (above) returns.
export async function nextcloudListFolders(
	userId: string,
	connectionId: string,
	params?: { path?: string },
	opts?: FetchOpt,
): Promise<NextcloudFolderSuggestion[]> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new NextcloudFilesError(
			"Connection not found",
			"connection_not_found",
		);
	}
	if (conn.provider !== "nextcloud" || !conn.capabilities.includes("files")) {
		throw new NextcloudFilesError(
			"Connection does not support Nextcloud folder listing",
			"invalid_config",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new NextcloudFilesError(
			"Nextcloud connection needs re-authorization",
			"needs_reauth",
		);
	}

	const entries = await nextcloudListFolder(
		conn,
		appPassword,
		params?.path ?? "",
		opts,
	);

	return entries
		.filter((entry) => entry.isDir)
		.slice(0, MAX_LIST_FOLDERS)
		.map((entry) => ({ path: `/${entry.path}`, name: entry.name }));
}

// ---------------------------------------------------------------------------
// WRITE methods (4.2) — put / move / delete over Nextcloud WebDAV, guarded by
// the write-guard (4.1) at the executeNextcloudWrite chokepoint below. Every
// path here still routes through normalizeNextcloudPath first; nothing new
// is exempt from that guard just because it mutates instead of reads.
// ---------------------------------------------------------------------------

// 5 MB per chunk for chunked upload v2 — bounds how much of the payload is
// ever held as a single in-flight request body, independent of how large the
// overall file is.
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
// Files at or below this size go through a single PUT; anything larger uses
// chunked upload v2 so an interrupted upload can never leave a partial file
// at the destination path.
const DEFAULT_CHUNKED_THRESHOLD_BYTES = 10 * 1024 * 1024;

function uploadsRootUrl(
	serverUrl: string,
	loginName: string,
	transferId: string,
): string {
	return `${serverUrl}/remote.php/dav/uploads/${encodeURIComponent(loginName)}/${transferId}`;
}

// A 412 on a conditional write (If-Match) means the file changed since the
// caller last read its etag — this must throw rather than fall back to an
// unconditional PUT, or a "safe" overwrite would silently clobber a
// concurrent edit.
function assertNotEtagMismatch(response: Response): void {
	if (response.status === 412) {
		throw new NextcloudFilesError(
			"Nextcloud rejected the write: the file changed since it was last read (etag mismatch)",
			"etag_mismatch",
		);
	}
}

async function directPut(
	fetchImpl: typeof fetch,
	loginName: string,
	appPassword: string,
	url: string,
	bytes: Uint8Array,
	ifMatch: string | undefined,
): Promise<{ etag: string | null }> {
	const headers: Record<string, string> = {
		Authorization: basicAuthHeader(loginName, appPassword),
		"Content-Type": "application/octet-stream",
		"User-Agent": USER_AGENT,
	};
	if (ifMatch) headers["If-Match"] = ifMatch;

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "PUT",
		headers,
		// Buffer.from copies into a Uint8Array<ArrayBuffer> — the DOM fetch
		// typings' BodyInit rejects a plain Uint8Array<ArrayBufferLike> (the
		// type callers of this module pass) even though undici accepts it at
		// runtime.
		body: Buffer.from(bytes),
	});

	assertNotAuthFailure(response);
	assertNotEtagMismatch(response);
	if (!response.ok) {
		throw new NextcloudFilesError(
			`Nextcloud PUT failed with status ${response.status}`,
			"request_failed",
		);
	}
	return { etag: response.headers.get("ETag") };
}

// Chunked upload v2: MKCOL a per-transfer scratch collection, PUT each
// (bounded-size) chunk into it in order, then MOVE the assembled `.file`
// pseudo-entry to the real destination. This is the pattern Nextcloud's own
// clients use for large files specifically because a plain PUT that dies
// partway through leaves a truncated file at the destination path — the
// chunked scratch space is invisible to readers until the final MOVE
// succeeds atomically.
async function chunkedPut(
	fetchImpl: typeof fetch,
	serverUrl: string,
	loginName: string,
	appPassword: string,
	destinationUrl: string,
	bytes: Uint8Array,
	ifMatch: string | undefined,
): Promise<{ etag: string | null }> {
	const transferId = randomUUID();
	const uploadsRoot = uploadsRootUrl(serverUrl, loginName, transferId);

	const mkcolResponse = await providerFetch(uploadsRoot, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "MKCOL",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"User-Agent": USER_AGENT,
		},
	});
	assertNotAuthFailure(mkcolResponse);
	if (!mkcolResponse.ok) {
		throw new NextcloudFilesError(
			`Nextcloud chunked-upload MKCOL failed with status ${mkcolResponse.status}`,
			"request_failed",
		);
	}

	const chunkCount = Math.max(
		1,
		Math.ceil(bytes.byteLength / CHUNK_SIZE_BYTES),
	);
	for (let index = 0; index < chunkCount; index++) {
		const start = index * CHUNK_SIZE_BYTES;
		const end = Math.min(start + CHUNK_SIZE_BYTES, bytes.byteLength);
		const chunk = bytes.subarray(start, end);
		const chunkUrl = `${uploadsRoot}/${String(index + 1).padStart(5, "0")}`;

		const chunkResponse = await providerFetch(chunkUrl, {
			fetch: fetchImpl,
			timeoutError: nextcloudTimeout,
			method: "PUT",
			headers: {
				Authorization: basicAuthHeader(loginName, appPassword),
				"Content-Type": "application/octet-stream",
				"User-Agent": USER_AGENT,
			},
			body: Buffer.from(chunk),
		});
		assertNotAuthFailure(chunkResponse);
		if (!chunkResponse.ok) {
			throw new NextcloudFilesError(
				`Nextcloud chunk upload failed with status ${chunkResponse.status}`,
				"request_failed",
			);
		}
	}

	const assembleHeaders: Record<string, string> = {
		Authorization: basicAuthHeader(loginName, appPassword),
		Destination: destinationUrl,
		"OC-Total-Length": String(bytes.byteLength),
		"User-Agent": USER_AGENT,
	};
	if (ifMatch) assembleHeaders["If-Match"] = ifMatch;

	const moveResponse = await providerFetch(`${uploadsRoot}/.file`, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "MOVE",
		headers: assembleHeaders,
	});
	assertNotAuthFailure(moveResponse);
	assertNotEtagMismatch(moveResponse);
	if (!moveResponse.ok) {
		throw new NextcloudFilesError(
			`Nextcloud chunked-upload assembly failed with status ${moveResponse.status}`,
			"request_failed",
		);
	}
	return { etag: moveResponse.headers.get("ETag") };
}

// Writes `bytes` to `path`. Small payloads (<= chunkedThreshold, default
// 10MB) go through a single PUT; larger ones use chunked upload v2 (see
// chunkedPut) so an interrupted upload can never corrupt the destination.
// When `ifMatch` is supplied, a 412 from Nextcloud throws `etag_mismatch`
// rather than silently falling back to an unconditional write.
export async function nextcloudPutFile(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	bytes: Uint8Array,
	opts?: {
		ifMatch?: string;
		chunkedThreshold?: number;
	} & FetchOpt,
): Promise<{ etag: string | null }> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedPath = normalizeNextcloudPath(path);
	if (!normalizedPath) {
		throw new NextcloudFilesError(
			"Cannot write to the files root as a file",
			"invalid_path",
		);
	}
	const destinationUrl = filesUrl(serverUrl, loginName, normalizedPath);
	const threshold = opts?.chunkedThreshold ?? DEFAULT_CHUNKED_THRESHOLD_BYTES;

	if (bytes.byteLength > threshold) {
		return chunkedPut(
			fetchImpl,
			serverUrl,
			loginName,
			appPassword,
			destinationUrl,
			bytes,
			opts?.ifMatch,
		);
	}
	return directPut(
		fetchImpl,
		loginName,
		appPassword,
		destinationUrl,
		bytes,
		opts?.ifMatch,
	);
}

// Moves/renames a file. `Overwrite: F` (the WebDAV default posture here)
// unless the caller explicitly opts in — a MOVE onto an existing path
// without permission comes back as a typed `conflict` error, never a silent
// clobber of the destination.
export async function nextcloudMoveFile(
	conn: ConnectionPublic,
	appPassword: string,
	fromPath: string,
	toPath: string,
	opts?: { overwrite?: boolean } & FetchOpt,
): Promise<void> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedFrom = normalizeNextcloudPath(fromPath);
	const normalizedTo = normalizeNextcloudPath(toPath);
	if (!normalizedFrom || !normalizedTo) {
		throw new NextcloudFilesError(
			"Cannot move the files root itself",
			"invalid_path",
		);
	}
	const fromUrl = filesUrl(serverUrl, loginName, normalizedFrom);
	const toUrl = filesUrl(serverUrl, loginName, normalizedTo);

	const response = await providerFetch(fromUrl, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "MOVE",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			Destination: toUrl,
			Overwrite: opts?.overwrite ? "T" : "F",
			"User-Agent": USER_AGENT,
		},
	});

	assertNotAuthFailure(response);
	if (response.status === 412) {
		throw new NextcloudFilesError(
			"Nextcloud refused to overwrite an existing file at the destination",
			"conflict",
		);
	}
	if (response.status === 404) {
		throw new NextcloudFilesError(
			`File not found: ${normalizedFrom}`,
			"not_found",
		);
	}
	if (!response.ok) {
		throw new NextcloudFilesError(
			`Nextcloud MOVE failed with status ${response.status}`,
			"request_failed",
		);
	}
}

// Deletes a file via a plain WebDAV DELETE. Nextcloud's server-side default
// is to move the item into the user's trashbin rather than purge it — this
// function issues exactly that request and nothing else; it never adds a
// permanent-delete parameter, so the operation stays reversible from the
// Nextcloud UI regardless of what AlfyAI's own confirm flow does upstream.
export async function nextcloudDeleteFile(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	opts?: FetchOpt,
): Promise<void> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedPath = normalizeNextcloudPath(path);
	if (!normalizedPath) {
		throw new NextcloudFilesError(
			"Cannot delete the files root itself",
			"invalid_path",
		);
	}
	const url = filesUrl(serverUrl, loginName, normalizedPath);

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "DELETE",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"User-Agent": USER_AGENT,
		},
	});

	assertNotAuthFailure(response);
	if (response.status === 404) {
		throw new NextcloudFilesError(
			`File not found: ${normalizedPath}`,
			"not_found",
		);
	}
	if (!response.ok) {
		throw new NextcloudFilesError(
			`Nextcloud DELETE failed with status ${response.status}`,
			"request_failed",
		);
	}
}

// Creates an empty folder via a WebDAV MKCOL (GAP B9a). Non-destructive: MKCOL
// on an already-existing collection comes back 405 (Method Not Allowed) and a
// missing intermediate parent comes back 409 (Conflict) — both are surfaced as
// a typed `conflict` rather than silently succeeding or clobbering anything.
// Deleting the created folder fully undoes this, so the op is reversible. The
// path routes through normalizeNextcloudPath first like every other write.
export async function nextcloudCreateFolder(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	opts?: FetchOpt,
): Promise<void> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedPath = normalizeNextcloudPath(path);
	if (!normalizedPath) {
		throw new NextcloudFilesError(
			"Cannot create the files root itself",
			"invalid_path",
		);
	}
	const url = filesUrl(serverUrl, loginName, normalizedPath);

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "MKCOL",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"User-Agent": USER_AGENT,
		},
	});

	assertNotAuthFailure(response);
	if (response.status === 405) {
		throw new NextcloudFilesError(
			`A folder already exists at ${normalizedPath}`,
			"conflict",
		);
	}
	if (response.status === 409) {
		throw new NextcloudFilesError(
			`Cannot create ${normalizedPath}: an intermediate parent folder does not exist`,
			"conflict",
		);
	}
	if (!response.ok) {
		throw new NextcloudFilesError(
			`Nextcloud MKCOL failed with status ${response.status}`,
			"request_failed",
		);
	}
}

// Creates a PUBLIC share link for a file via the OCS Shares API (GAP B9b).
// shareType=3 is a public link — this deliberately creates public exposure of
// the file, so the caller MUST have surfaced a public-link warning in the
// confirm preview before this ever runs. Returns the public URL parsed from
// the OCS response. `?format=json` makes the OCS envelope parseable without an
// XML round-trip. Optional password/expiry the OCS API supports are future
// work (see the tool layer's share_link action doc comment). The path is the
// file's path relative to the user's files root, sent to OCS with a leading
// slash (its expected form).
export async function nextcloudCreateShareLink(
	conn: ConnectionPublic,
	appPassword: string,
	path: string,
	opts?: FetchOpt,
): Promise<string> {
	const fetchImpl = opts?.fetch ?? fetch;
	const { serverUrl, loginName } = nextcloudConfig(conn);
	const normalizedPath = normalizeNextcloudPath(path);
	if (!normalizedPath) {
		throw new NextcloudFilesError(
			"Cannot share the files root itself as a public link",
			"invalid_path",
		);
	}
	const ocsPath = `/${normalizedPath}`;
	const url = `${serverUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`;

	const response = await providerFetch(url, {
		fetch: fetchImpl,
		timeoutError: nextcloudTimeout,
		method: "POST",
		headers: {
			Authorization: basicAuthHeader(loginName, appPassword),
			"Content-Type": "application/x-www-form-urlencoded",
			"OCS-APIRequest": "true",
			"User-Agent": USER_AGENT,
		},
		// shareType=3 => public link.
		body: new URLSearchParams({ path: ocsPath, shareType: "3" }).toString(),
	});

	assertNotAuthFailure(response);
	if (response.status === 404) {
		throw new NextcloudFilesError(
			`File not found: ${normalizedPath}`,
			"not_found",
		);
	}
	if (!response.ok) {
		throw new NextcloudFilesError(
			`Nextcloud share-create failed with status ${response.status}`,
			"request_failed",
		);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new NextcloudFilesError(
			"Nextcloud returned a malformed share response",
			"request_failed",
		);
	}
	const shareUrl = (body as { ocs?: { data?: { url?: unknown } } })?.ocs?.data
		?.url;
	if (typeof shareUrl !== "string" || shareUrl.length === 0) {
		throw new NextcloudFilesError(
			"Nextcloud share response did not include a public URL",
			"request_failed",
		);
	}
	return shareUrl;
}

// Fix 2 (write-safety hardening) — `null` means "could not confirm", not
// "no". Every caller MUST treat null the same as `false` (conservative):
// buildWritePreview only trusts an explicit `true` to suppress its "may not
// be recoverable" warning, and files.ts's saveOutcome mirrors that.
export type NextcloudVersioningStatus = boolean | null;

// Probes the Nextcloud OCS capabilities endpoint to find out whether the
// server-side Versions app is enabled — the save/put propose path
// (normal-chat-tools/files.ts) uses this so its `reversible` claim on an
// overwrite is TRUTHFUL rather than the previous unconditional `true`
// (overwrite recovery only actually works when the server keeps versions).
// Deliberately never throws: any failure (network, non-2xx, malformed body,
// a server too old to report this capability) degrades to `null`
// ("unknown"), which callers must treat as NOT confirmed reversible — this
// function must never let an inconclusive probe read as "safe".
export async function nextcloudCheckVersioningEnabled(
	conn: ConnectionPublic,
	appPassword: string,
	opts?: FetchOpt,
): Promise<NextcloudVersioningStatus> {
	const fetchImpl = opts?.fetch ?? fetch;
	try {
		const { serverUrl, loginName } = nextcloudConfig(conn);
		const response = await providerFetch(
			`${serverUrl}/ocs/v2.php/cloud/capabilities?format=json`,
			{
				fetch: fetchImpl,
				timeoutError: nextcloudTimeout,
				method: "GET",
				headers: {
					Authorization: basicAuthHeader(loginName, appPassword),
					"OCS-APIRequest": "true",
					"User-Agent": USER_AGENT,
				},
			},
		);
		if (!response.ok) return null;
		const body = (await response.json()) as {
			ocs?: {
				data?: { capabilities?: { files?: { versioning?: unknown } } };
			};
		};
		const versioning = body?.ocs?.data?.capabilities?.files?.versioning;
		return typeof versioning === "boolean" ? versioning : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Guarded execute service (4.2) — the single chokepoint a chat-tool write
// action (4.3) is expected to call through. Confirmation is assumed to have
// already happened upstream; this function's job is the hard `allowWrites`
// gate plus safe, typed execution. It never throws: every adapter error
// (typed or not) is mapped to `{ ok: false, reason }` so a caller can surface
// it directly without risking a raw error (and its message) leaking further
// than intended — in particular, the decrypted app password is never placed
// in a thrown message or a returned reason string.
// ---------------------------------------------------------------------------

export type NextcloudWriteRequest =
	| {
			kind: "put";
			requestedPath?: string;
			bytes: Uint8Array;
			ifMatch?: string;
			contentSummary: string;
	  }
	| { kind: "move"; fromPath: string; toPath: string }
	| { kind: "delete"; path: string }
	| { kind: "create_folder"; requestedPath?: string }
	| { kind: "share_link"; path: string };

export async function executeNextcloudWrite(
	userId: string,
	connectionId: string,
	req: NextcloudWriteRequest,
	opts?: FetchOpt,
): Promise<
	| { ok: true; etag?: string | null; url?: string }
	| { ok: false; reason: string }
> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		return { ok: false, reason: "connection_not_found" };
	}
	// Hard gate — checked before the secret is ever decrypted and before any
	// adapter method (and therefore any fetch) is invoked. Nothing below this
	// line runs when writes are disabled.
	if (conn.allowWrites !== true) {
		return { ok: false, reason: "writes_disabled" };
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		return { ok: false, reason: "needs_reauth" };
	}

	try {
		switch (req.kind) {
			case "put": {
				const target = resolveWriteTarget({
					allowlist: conn.writeAllowlist,
					requestedPath: req.requestedPath,
					defaultArea: conn.writeAllowlist[0],
				});
				const result = await nextcloudPutFile(
					conn,
					appPassword,
					target.path,
					req.bytes,
					{ ifMatch: req.ifMatch, fetch: opts?.fetch },
				);
				return { ok: true, etag: result.etag };
			}
			case "move": {
				await nextcloudMoveFile(conn, appPassword, req.fromPath, req.toPath, {
					fetch: opts?.fetch,
				});
				return { ok: true };
			}
			case "delete": {
				await nextcloudDeleteFile(conn, appPassword, req.path, {
					fetch: opts?.fetch,
				});
				return { ok: true };
			}
			case "create_folder": {
				const target = resolveWriteTarget({
					allowlist: conn.writeAllowlist,
					requestedPath: req.requestedPath,
					defaultArea: conn.writeAllowlist[0],
				});
				await nextcloudCreateFolder(conn, appPassword, target.path, {
					fetch: opts?.fetch,
				});
				return { ok: true };
			}
			case "share_link": {
				const url = await nextcloudCreateShareLink(
					conn,
					appPassword,
					req.path,
					{ fetch: opts?.fetch },
				);
				return { ok: true, url };
			}
			default: {
				const exhaustive: never = req;
				throw new Error(
					`Unhandled Nextcloud write kind: ${JSON.stringify(exhaustive)}`,
				);
			}
		}
	} catch (err) {
		if (err instanceof NextcloudFilesError) {
			return { ok: false, reason: err.code };
		}
		// Never surface a raw error message here: it could (in principle)
		// originate from a layer that interpolated the password into an
		// Error before this chokepoint existed. Only a generic, fixed reason
		// is returned for anything not already a typed NextcloudFilesError.
		return { ok: false, reason: "request_failed" };
	}
}

// Not annotated as `: ConnectionAdapter` — that would narrow checkHealth's
// call signature to the interface's (secret, conn) shape and break the
// mocked-fetch tests that pass a third `{ fetch }` opts arg. The object is
// still structurally a valid ConnectionAdapter, which is all
// registerConnectionAdapter (typed on that interface) requires.
export const nextcloudFilesAdapter = {
	provider: "nextcloud" as const,
	checkHealth,
	disconnect,
};

registerConnectionAdapter(nextcloudFilesAdapter satisfies ConnectionAdapter);

// ---------------------------------------------------------------------------
// Write-executor registration (Issue 6.0, GAP A1/B9) — maps a confirmed
// WriteOperation onto the shape executeNextcloudWrite needs. Supported tool
// write actions: "files.put" (files.ts "save"), "files.move" (move + rename),
// "files.delete" (delete-to-trash), "files.create_folder" (MKCOL, GAP B9a),
// and "files.share_link" (OCS public link, GAP B9b). Any other action returns
// null and is refused as unsupported_operation rather than silently
// mis-executed. This mapping previously lived inline in pending-writes.ts's
// confirmPendingWrite; it moved here so it sits behind the write-executor
// registry instead of being hardwired into the generic confirm flow (see
// write-executors.ts).
//
// For "files.move" the source + destination are carried in `content` as JSON
// (`{ fromPath, toPath }`) — the same "structured payload in content" pattern
// the calendar/immich/imap executors use — since a WriteTarget has only one
// path slot (used here for the destination, so the write-guard preview and
// allowlist check apply to where the file LANDS). For "files.delete" the
// single target path is `op.target.path`; content is unused.
// ---------------------------------------------------------------------------

function toNextcloudWriteRequest(
	op: WriteOperation,
	content: string,
): NextcloudWriteRequest | null {
	if (op.action === "files.put") {
		const MAX_SUMMARY_CHARS = 200;
		const contentSummary =
			content.length > MAX_SUMMARY_CHARS
				? `${content.slice(0, MAX_SUMMARY_CHARS)}…`
				: content;
		return {
			kind: "put",
			requestedPath: op.target?.path,
			bytes: new TextEncoder().encode(content),
			contentSummary,
		};
	}

	if (op.action === "files.move") {
		let parsed: { fromPath?: unknown; toPath?: unknown };
		try {
			parsed = JSON.parse(content) as { fromPath?: unknown; toPath?: unknown };
		} catch {
			return null;
		}
		if (
			typeof parsed.fromPath !== "string" ||
			typeof parsed.toPath !== "string"
		) {
			return null;
		}
		return { kind: "move", fromPath: parsed.fromPath, toPath: parsed.toPath };
	}

	if (op.action === "files.delete") {
		const path = op.target?.path;
		if (!path) return null;
		return { kind: "delete", path };
	}

	// GAP B9a — MKCOL. Mirrors "files.put": the (already resolveWriteTarget-
	// resolved) target path is passed as requestedPath and re-resolved against
	// the allowlist inside executeNextcloudWrite, so an unspecified target lands
	// in the safe default area. `content` is unused.
	if (op.action === "files.create_folder") {
		return { kind: "create_folder", requestedPath: op.target?.path };
	}

	// GAP B9b — OCS public share link. The single target path is op.target.path
	// (like files.delete); content is unused.
	if (op.action === "files.share_link") {
		const path = op.target?.path;
		if (!path) return null;
		return { kind: "share_link", path };
	}

	return null;
}

registerWriteExecutor({
	provider: "nextcloud",
	async execute(userId, connectionId, op, content, opts) {
		const request = toNextcloudWriteRequest(op, content);
		if (!request) return { ok: false, reason: "unsupported_operation" };
		const result = await executeNextcloudWrite(
			userId,
			connectionId,
			request,
			opts,
		);
		// share_link returns a public URL — surface it through the standard
		// WriteExecutionResult `detail` field (the shared registry shape has no
		// `url` slot) so the confirm flow can relay it to the user.
		if (result.ok && result.url !== undefined) {
			return { ok: true, etag: result.etag ?? null, detail: result.url };
		}
		return result;
	},
});
