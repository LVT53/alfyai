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

// company/title are both optional because either can be absent on a given
// Google organizations entry (e.g. a title-less "works at Acme" entry, or a
// company-less freelance title) — v1 for Google only; Apple/CardDAV ORG/TITLE
// parsing is a documented follow-up (appleSearchContacts doesn't populate
// this field yet).
export type ContactOrganization = {
	company?: string;
	title?: string;
};

export type ContactMatch = {
	name: string;
	emails: string[];
	phones: string[];
	source: "google" | "apple";
	account?: string;
	organization?: ContactOrganization;
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
const GOOGLE_PEOPLE_API_BASE = "https://people.googleapis.com/v1";
const PEOPLE_SEARCH_CONTACTS_URL = `${GOOGLE_PEOPLE_API_BASE}/people:searchContacts`;
const GOOGLE_CONTACT_GROUPS_LIST_URL = `${GOOGLE_PEOPLE_API_BASE}/contactGroups`;
const GOOGLE_PEOPLE_BATCH_GET_URL = `${GOOGLE_PEOPLE_API_BASE}/people:batchGet`;
// people:batchGet's own resourceNames cap (RFC: "Maximum of 200 resource
// names") — also used as the contactGroups.get maxMembers ceiling since
// there's no point fetching more member resourceNames than a single
// batchGet call can resolve.
const MAX_GROUP_MEMBERS = 200;
// Contact groups are a small, per-user list (system groups + whatever the
// user has created) — a single un-paginated page comfortably covers v1's
// scope; full pagination is a documented follow-up if it ever doesn't.
const GROUP_LIST_PAGE_SIZE = 200;
const PEOPLE_READ_MASK = "names,emailAddresses,phoneNumbers,organizations";

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

// Picks the organization to surface when a Person has more than one (Google
// lets a contact carry several past/current employers): the entry flagged
// `current: true` wins, else the first entry — same "most relevant first"
// heuristic as picking `names[0]` for displayName above. Returns undefined
// (not an empty object) when there's nothing usable, so callers can
// `...(organization ? { organization } : {})` and keep the field absent
// entirely rather than `{}` on contacts with no org data.
function parseOrganization(value: unknown): ContactOrganization | undefined {
	if (!Array.isArray(value)) return undefined;
	const orgs = value.filter(isRecord);
	if (orgs.length === 0) return undefined;
	const current = orgs.find((org) => org.current === true) ?? orgs[0];
	const company =
		typeof current.name === "string" && current.name.length > 0
			? current.name
			: undefined;
	const title =
		typeof current.title === "string" && current.title.length > 0
			? current.title
			: undefined;
	if (!company && !title) return undefined;
	return { ...(company ? { company } : {}), ...(title ? { title } : {}) };
}

// Shared `Person` -> ContactMatch (minus source/account) mapping, reused by
// both parsePeopleSearchResults (`results: [{ person }]` envelope) and
// parsePeopleBatchGetResults (`responses: [{ person }]` envelope) below —
// the two People API calls wrap the same `Person` resource shape
// differently, but extract identical fields from it. Returns null (rather
// than a match with an empty name) when there's neither a name nor an
// email — there'd be nothing useful to disambiguate or contact them by.
function personToMatch(
	person: Record<string, unknown>,
): Omit<ContactMatch, "source" | "account"> | null {
	const names = Array.isArray(person.names) ? person.names : [];
	const firstName = names.find(isRecord);
	const name =
		firstName && typeof firstName.displayName === "string"
			? firstName.displayName
			: "";
	const emails = stringValues(person.emailAddresses, "value");
	const phones = stringValues(person.phoneNumbers, "value");
	if (!name && emails.length === 0) return null;
	const organization = parseOrganization(person.organizations);
	return { name, emails, phones, ...(organization ? { organization } : {}) };
}

// Maps People API `searchContacts` results (`{ results?: [{ person: {...} }] }`).
function parsePeopleSearchResults(
	body: unknown,
): Omit<ContactMatch, "source" | "account">[] {
	if (!isRecord(body) || !Array.isArray(body.results)) return [];

	const matches: Omit<ContactMatch, "source" | "account">[] = [];
	for (const entry of body.results) {
		if (!isRecord(entry) || !isRecord(entry.person)) continue;
		const match = personToMatch(entry.person);
		if (match) matches.push(match);
	}
	return matches;
}

// Maps People API `people:batchGet` results
// (`{ responses?: [{ person: {...} }] }`) — used to resolve a contact
// group's memberResourceNames (5.8 GAP B8 groups) into full ContactMatch[].
function parsePeopleBatchGetResults(
	body: unknown,
): Omit<ContactMatch, "source" | "account">[] {
	if (!isRecord(body) || !Array.isArray(body.responses)) return [];

	const matches: Omit<ContactMatch, "source" | "account">[] = [];
	for (const entry of body.responses) {
		if (!isRecord(entry) || !isRecord(entry.person)) continue;
		const match = personToMatch(entry.person);
		if (match) matches.push(match);
	}
	return matches;
}

type GoogleContactGroupSummary = {
	resourceName: string;
	name: string;
};

// Maps `contactGroups.list`'s `{ contactGroups?: [{ resourceName,
// formattedName, name, ... }] }` onto a minimal summary — `formattedName` is
// the user-visible, locale-formatted label (e.g. system groups render
// translated); it falls back to `name` for groups where formattedName is
// absent (older API behavior / custom groups without a formatted variant).
function parseContactGroupsList(body: unknown): GoogleContactGroupSummary[] {
	if (!isRecord(body) || !Array.isArray(body.contactGroups)) return [];

	const groups: GoogleContactGroupSummary[] = [];
	for (const entry of body.contactGroups) {
		if (!isRecord(entry)) continue;
		const resourceName =
			typeof entry.resourceName === "string" ? entry.resourceName : "";
		if (!resourceName) continue;
		const formattedName =
			typeof entry.formattedName === "string" ? entry.formattedName : "";
		const name = typeof entry.name === "string" ? entry.name : "";
		const label = formattedName || name;
		if (!label) continue;
		groups.push({ resourceName, name: label });
	}
	return groups;
}

// Maps `contactGroups.get`'s `{ memberResourceNames?: ["people/123", ...] }`
// (populated only when the request set `maxMembers` > 0).
function parseContactGroupMembers(body: unknown): string[] {
	if (!isRecord(body) || !Array.isArray(body.memberResourceNames)) return [];
	return body.memberResourceNames.filter(
		(value): value is string => typeof value === "string",
	);
}

// ---------------------------------------------------------------------------
// Shared Google People auth + response handling — used by googleSearchContacts
// AND googleSearchContactsByGroup below (org/groups, GAP B8), so the
// connection lookup / scope check / token refresh / 401-flagging logic lives
// in exactly one place rather than diverging across the two entry points.
// ---------------------------------------------------------------------------

async function googleContactsAuth(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<{ accessToken: string; conn: ConnectionPublic }> {
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

	try {
		const accessToken = await googleRefreshAccessToken(userId, connectionId, {
			fetch: opts?.fetch,
		});
		return { accessToken, conn };
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
}

// A 401 after a fresh token refresh means Google itself rejected the token
// (not just "expired") — flag the connection needs_reauth so the UI surfaces
// a reconnect prompt, same posture across every People API call this module
// makes (searchContacts, contactGroups.list/get, people:batchGet).
async function assertGoogleContactsResponseOk(
	userId: string,
	connectionId: string,
	response: Response,
	label: string,
): Promise<void> {
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
			`Google ${label} request failed with status ${response.status}`,
			"request_failed",
		);
	}
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

	const { accessToken, conn } = await googleContactsAuth(
		userId,
		connectionId,
		opts,
	);

	const runPeopleQuery = async (
		query: string,
	): Promise<Omit<ContactMatch, "source" | "account">[]> => {
		const url = new URL(PEOPLE_SEARCH_CONTACTS_URL);
		url.searchParams.set("query", query);
		url.searchParams.set("readMask", PEOPLE_READ_MASK);
		url.searchParams.set("pageSize", String(limit));

		const response = await fetchWithTimeout(fetchImpl, url.toString(), {
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		await assertGoogleContactsResponseOk(
			userId,
			connectionId,
			response,
			"searchContacts",
		);

		const body: unknown = await response.json().catch(() => null);
		return parsePeopleSearchResults(body);
	};

	// The People API's `searchContacts` serves from a per-user cache that is
	// COLD on the first call after a while and returns zero results until it's
	// warmed — a documented gotcha that surfaced in live use as a spurious "no
	// contacts found" on the first lookup. Google's prescribed remedy is a
	// warmup request with an empty query; so if the first real search comes
	// back empty, warm the cache and retry ONCE before concluding there are
	// genuinely no matches. The warm path (cache already primed) stays a single
	// request; only a cold miss pays for the warmup + retry.
	let matches = await runPeopleQuery(params.query);
	if (matches.length === 0) {
		await runPeopleQuery("").catch(() => []);
		matches = await runPeopleQuery(params.query);
	}

	return matches.slice(0, limit).map((match) => ({
		...match,
		source: "google" as const,
		account: conn.accountIdentifier,
	}));
}

// ---------------------------------------------------------------------------
// googleSearchContactsByGroup — GAP B8 groups/labels ("who's in my Family
// group"). Google-only for v1: resolving Apple/CardDAV group membership
// would need vCard KIND:group or CATEGORIES parsing, which appleSearchContacts
// doesn't do yet (documented follow-up).
// ---------------------------------------------------------------------------

// Finds a Google contact group whose user-visible name matches `groupName`
// (case-insensitive): an exact match wins; otherwise the first group whose
// name CONTAINS the query, so "who's in Family" also matches a group
// literally named "My Family". Returns null (not a thrown error) when
// nothing matches — "no group by that name" is an expected outcome the
// caller turns into an empty result, same posture as a lookup with zero
// contact matches.
async function findGoogleContactGroup(
	userId: string,
	connectionId: string,
	fetchImpl: typeof fetch,
	accessToken: string,
	groupName: string,
): Promise<GoogleContactGroupSummary | null> {
	const url = new URL(GOOGLE_CONTACT_GROUPS_LIST_URL);
	url.searchParams.set("groupFields", "name,formattedName,groupType,memberCount");
	url.searchParams.set("pageSize", String(GROUP_LIST_PAGE_SIZE));

	const response = await fetchWithTimeout(fetchImpl, url.toString(), {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	await assertGoogleContactsResponseOk(
		userId,
		connectionId,
		response,
		"contactGroups.list",
	);

	const body: unknown = await response.json().catch(() => null);
	const groups = parseContactGroupsList(body);

	const needle = groupName.trim().toLowerCase();
	const exact = groups.find((group) => group.name.trim().toLowerCase() === needle);
	if (exact) return exact;
	return (
		groups.find((group) => group.name.trim().toLowerCase().includes(needle)) ??
		null
	);
}

// Resolves ONE Google contact group's membership to full ContactMatch[]:
// contactGroups.list to find the group by name, contactGroups.get with
// maxMembers to fetch its memberResourceNames, then people:batchGet to turn
// those resourceNames into full contact records (name/email/phone/org).
// Read-only, same as googleSearchContacts — never adds/removes members.
export async function googleSearchContactsByGroup(
	userId: string,
	connectionId: string,
	params: { groupName: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const limit = params.limit ?? DEFAULT_LIMIT;

	const { accessToken, conn } = await googleContactsAuth(
		userId,
		connectionId,
		opts,
	);

	const group = await findGoogleContactGroup(
		userId,
		connectionId,
		fetchImpl,
		accessToken,
		params.groupName,
	);
	if (!group) return [];

	const groupUrl = new URL(`${GOOGLE_PEOPLE_API_BASE}/${group.resourceName}`);
	groupUrl.searchParams.set("maxMembers", String(MAX_GROUP_MEMBERS));
	groupUrl.searchParams.set("groupFields", "memberCount");

	const groupResponse = await fetchWithTimeout(fetchImpl, groupUrl.toString(), {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	await assertGoogleContactsResponseOk(
		userId,
		connectionId,
		groupResponse,
		"contactGroups.get",
	);
	const groupBody: unknown = await groupResponse.json().catch(() => null);
	const memberResourceNames = parseContactGroupMembers(groupBody).slice(
		0,
		MAX_GROUP_MEMBERS,
	);
	if (memberResourceNames.length === 0) return [];

	const batchUrl = new URL(GOOGLE_PEOPLE_BATCH_GET_URL);
	for (const resourceName of memberResourceNames) {
		batchUrl.searchParams.append("resourceNames", resourceName);
	}
	batchUrl.searchParams.set("personFields", PEOPLE_READ_MASK);

	const batchResponse = await fetchWithTimeout(fetchImpl, batchUrl.toString(), {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	await assertGoogleContactsResponseOk(
		userId,
		connectionId,
		batchResponse,
		"people.getBatchGet",
	);
	const batchBody: unknown = await batchResponse.json().catch(() => null);
	const matches = parsePeopleBatchGetResults(batchBody);

	return matches.slice(0, limit).map((match) => ({
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

// ---------------------------------------------------------------------------
// resolveContactsByGroup — GAP B8 groups/labels, merges across ALL of the
// user's contacts-capable connections the same way resolveContacts does.
// ---------------------------------------------------------------------------

// Dispatches a single connection to its provider's group-search function.
// Same graceful-degradation posture as searchConnection above: a failure
// here never fails the whole resolve, and providers without group support
// are silently skipped rather than dispatched.
async function searchConnectionByGroup(
	userId: string,
	conn: ConnectionPublic,
	params: { groupName: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	try {
		if (conn.provider === "google") {
			return await googleSearchContactsByGroup(userId, conn.id, params, opts);
		}
		// Apple/CardDAV contact-group resolution (vCard KIND:group /
		// CATEGORIES) is a documented v1 follow-up — no group-search function
		// exists for it yet, so it's silently skipped rather than dispatched,
		// same as Nextcloud CardDAV in searchConnection above.
		return [];
	} catch (err) {
		console.warn(
			`[contacts] ${conn.provider} connection ${conn.id} failed to resolve group "${params.groupName}": ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return [];
	}
}

// Resolves a named contact group ("Family", "Work", ...) across ALL of the
// user's contacts-capable connections, merged + de-duped the same way as
// resolveContacts. A group that doesn't exist on a given source (or a
// source that doesn't support groups at all) contributes zero matches
// rather than an error — the overall result is simply whatever the other
// sources found, same graceful-degradation contract as resolveContacts.
export async function resolveContactsByGroup(
	userId: string,
	params: { groupName: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	const limit = params.limit ?? DEFAULT_LIMIT;
	const connections = await resolveConnectionsForCapability(userId, "contacts");

	const perSourceResults = await Promise.all(
		connections.map((conn) => searchConnectionByGroup(userId, conn, params, opts)),
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
