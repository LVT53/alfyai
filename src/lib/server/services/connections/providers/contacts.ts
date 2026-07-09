// Name -> identity Contacts resolver (5.8): dispatches across the user's
// contacts-capable connections by provider and merges the results. v1
// sources are Google People (this file) and Apple CardDAV (appleSearchContacts,
// in providers/apple-caldav.ts — the CardDAV discovery/redirect/vCard parsing
// machinery already lives there). Nextcloud CardDAV / the generic "contacts"
// CardDAV provider (see registry.ts's CAPABILITY_META.contacts.providers)
// are a documented follow-up — resolveContacts skips connections from those
// providers rather than failing. Read-only, no separate connect flow: this
// reuses the existing google (5.1) and apple (5.3) connections. Every
// network call accepts an injectable `fetch` so this module is fully
// testable against mocked Google/Apple endpoints — nothing here ever talks
// to a live server in tests.

import { resolveConnectionsForCapability } from "../resolve";
import {
	type ConnectionPublic,
	getConnection,
	updateConnection,
} from "../store";
import { appleSearchContacts } from "./apple-caldav";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";

type FetchOpt = { fetch?: typeof fetch };

export type ContactMatch = {
	name: string;
	emails: string[];
	phones: string[];
	source: "google" | "apple";
	account?: string;
};

export type ContactsErrorCode =
	| "scope_missing"
	| "needs_reauth"
	| "connection_not_found"
	| "request_failed";

export class ContactsError extends Error {
	constructor(
		message: string,
		public readonly code: ContactsErrorCode,
	) {
		super(message);
		this.name = "ContactsError";
	}
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 10;
const GOOGLE_CONTACTS_SCOPE =
	"https://www.googleapis.com/auth/contacts.readonly";
const PEOPLE_SEARCH_CONTACTS_URL =
	"https://people.googleapis.com/v1/people:searchContacts";

// Bounds the People API call to ~15s via AbortController, same pattern as
// google-calendar.ts/apple-caldav.ts, so a slow/unreachable Google endpoint
// can't hang a chat turn indefinitely.
async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new ContactsError(
				`Google People request timed out after ${timeoutMs}ms`,
				"request_failed",
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValues(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const raw = entry[field];
		if (typeof raw === "string" && raw.length > 0) out.push(raw);
	}
	return out;
}

// Maps People API `searchContacts` results (`{ results?: [{ person: {...} }] }`)
// onto ContactMatch[], dropping any result with neither a name nor an email —
// there'd be nothing useful to disambiguate or contact them by.
function parsePeopleSearchResults(
	body: unknown,
): Omit<ContactMatch, "source" | "account">[] {
	if (!isRecord(body) || !Array.isArray(body.results)) return [];

	const matches: Omit<ContactMatch, "source" | "account">[] = [];
	for (const entry of body.results) {
		if (!isRecord(entry) || !isRecord(entry.person)) continue;
		const person = entry.person;
		const names = Array.isArray(person.names) ? person.names : [];
		const firstName = names.find(isRecord);
		const name =
			firstName && typeof firstName.displayName === "string"
				? firstName.displayName
				: "";
		const emails = stringValues(person.emailAddresses, "value");
		const phones = stringValues(person.phoneNumbers, "value");
		if (!name && emails.length === 0) continue;
		matches.push({ name, emails, phones });
	}
	return matches;
}

// ---------------------------------------------------------------------------
// googleSearchContacts
// ---------------------------------------------------------------------------

export async function googleSearchContacts(
	userId: string,
	connectionId: string,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const limit = params.limit ?? DEFAULT_LIMIT;

	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new ContactsError(
			"Google connection not found",
			"connection_not_found",
		);
	}

	// A Google connection made for calendar-only (or before contacts.readonly
	// was requested) won't have this scope — surface a typed signal instead
	// of calling the People API with an access token that will just 403/be
	// scoped out, so callers (resolveContacts) can tell the user to reconnect
	// Google to grant contacts access.
	if (!conn.oauthScopes.includes(GOOGLE_CONTACTS_SCOPE)) {
		throw new ContactsError(
			"This Google connection was not granted contacts access. Reconnect Google to grant contacts access.",
			"scope_missing",
		);
	}

	let accessToken: string;
	try {
		accessToken = await googleRefreshAccessToken(userId, connectionId, {
			fetch: opts?.fetch,
		});
	} catch (err) {
		if (err instanceof GoogleOAuthError) {
			if (err.code === "connection_not_found") {
				throw new ContactsError(err.message, "connection_not_found");
			}
			if (err.code === "needs_reauth" || err.code === "invalid_grant") {
				throw new ContactsError(err.message, "needs_reauth");
			}
			throw new ContactsError(err.message, "request_failed");
		}
		throw new ContactsError(
			err instanceof Error
				? err.message
				: "Failed to obtain a Google access token",
			"request_failed",
		);
	}

	const url = new URL(PEOPLE_SEARCH_CONTACTS_URL);
	url.searchParams.set("query", params.query);
	url.searchParams.set("readMask", "names,emailAddresses,phoneNumbers");
	url.searchParams.set("pageSize", String(limit));

	const response = await fetchWithTimeout(fetchImpl, url.toString(), {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (response.status === 401) {
		const detail = "Google rejected the access token for this Contacts request";
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: detail,
		});
		throw new ContactsError(detail, "needs_reauth");
	}
	if (!response.ok) {
		throw new ContactsError(
			`Google People request failed with status ${response.status}`,
			"request_failed",
		);
	}

	const body: unknown = await response.json().catch(() => null);
	return parsePeopleSearchResults(body)
		.slice(0, limit)
		.map((match) => ({
			...match,
			source: "google" as const,
			account: conn.accountIdentifier,
		}));
}

// ---------------------------------------------------------------------------
// resolveContacts — merges across ALL of the user's contacts-capable
// connections.
// ---------------------------------------------------------------------------

function dedupeKey(match: ContactMatch): string {
	const name = match.name.trim().toLowerCase();
	const firstEmail = (match.emails[0] ?? "").trim().toLowerCase();
	return `${name}|${firstEmail}`;
}

// Dispatches a single connection to its provider's search function. A
// failure here (needs_reauth, scope_missing, a CardDAV timeout, ...) must
// never fail the whole resolve — it's caught and logged (the underlying
// typed errors never carry a token/password in their message, see
// ContactsError/AppleCalDavError/GoogleOAuthError call sites, so this is
// safe to surface to operator logs) and treated as "this source found
// nothing", letting the other sources' matches still come through.
async function searchConnection(
	userId: string,
	conn: ConnectionPublic,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	try {
		if (conn.provider === "google") {
			return await googleSearchContacts(userId, conn.id, params, opts);
		}
		if (conn.provider === "apple") {
			return await appleSearchContacts(userId, conn.id, params, opts);
		}
		// Nextcloud CardDAV / the generic "contacts" CardDAV provider are a
		// documented v1 follow-up (see registry.ts's
		// CAPABILITY_META.contacts.providers) — no search function exists for
		// them yet, so they're silently skipped rather than dispatched.
		return [];
	} catch (err) {
		console.warn(
			`[contacts] ${conn.provider} connection ${conn.id} failed to resolve: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return [];
	}
}

// Resolves across ALL of the user's contacts-capable connections, merged +
// de-duped by (lowercased name + first email). One source erroring never
// fails the whole resolve (see searchConnection above) — the other sources'
// matches are still returned.
export async function resolveContacts(
	userId: string,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	const limit = params.limit ?? DEFAULT_LIMIT;
	const connections = await resolveConnectionsForCapability(userId, "contacts");

	const perSourceResults = await Promise.all(
		connections.map((conn) => searchConnection(userId, conn, params, opts)),
	);

	const merged: ContactMatch[] = [];
	const seen = new Set<string>();
	for (const results of perSourceResults) {
		for (const match of results) {
			const key = dedupeKey(match);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(match);
			if (merged.length >= limit) return merged;
		}
	}
	return merged;
}
