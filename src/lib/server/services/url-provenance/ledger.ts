/**
 * The per-user source ledger: which hosts, and which exact Brave thumbnail
 * addresses, this user's own tools have returned.
 *
 * The model reads pages, emails and files a stranger may have written, so an
 * address it picks on its own (a favicon of any host it names, a picture it
 * links to) can carry private data to whoever owns the address. The server
 * therefore answers a request for a host's icon or a search picture only when a
 * tool returned that host or that exact address to THIS user
 * (docs/plans/exfil-channels). This module is that memory.
 *
 * In memory only, on purpose. An incognito conversation promises that nothing it
 * touched is written down, and the ledger is read on every favicon request, so it
 * lives and dies with the process: nothing here imports the database or the
 * file system, and `url-provenance.test.ts` holds it to that. After a restart it
 * is empty and is filled again by the next read of a conversation (the backfill
 * in `sources.ts`).
 *
 * Bounded three ways, least recently used first out: users, hosts per user and
 * thumbnails per user, so neither a busy account nor many accounts can grow it
 * without limit.
 */
import { isBraveThumbnailUrl, provenanceKey } from "$lib/shared/url-provenance";

/** How many users' ledgers are kept at once; the least recently used goes first. */
export const LEDGER_MAX_USERS = 200;
/** How many hosts one user's ledger keeps. */
export const LEDGER_MAX_HOSTS_PER_USER = 2_000;
/** How many Brave thumbnail addresses one user's ledger keeps. */
export const LEDGER_MAX_THUMBNAILS_PER_USER = 1_000;

interface UserLedger {
	/** Normalized hosts, in the order they were last seen (oldest first). */
	hosts: Map<string, true>;
	/** `provenanceKey`s of Brave thumbnail addresses, oldest first. */
	thumbnails: Map<string, true>;
}

// A `Map` iterates in insertion order, so "delete then set" is "most recently
// used" and the first key is the one to drop.
const ledgers = new Map<string, UserLedger>();

// Dotted DNS labels (letters, digits, inner hyphens): what a URL parser writes a
// host as. An IP literal in brackets, a port or a path is not one.
const HOST_SHAPE =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The form a host is kept and asked for in: trimmed, lowercase, without a
 * leading `www.` (what the favicon proxy and `sourceHostOf` call a host). Null
 * for anything that is not shaped like one.
 */
function normalizeHost(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const host = raw
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
	return host.length <= 253 && HOST_SHAPE.test(host) ? host : null;
}

function touch<K>(map: Map<K, true>, key: K, limit: number): void {
	map.delete(key);
	map.set(key, true);
	while (map.size > limit) {
		const oldest = map.keys().next();
		if (oldest.done) return;
		map.delete(oldest.value);
	}
}

function ledgerFor(userId: string, create: boolean): UserLedger | null {
	if (!userId) return null;
	const existing = ledgers.get(userId);
	if (existing) {
		// Used just now: move it to the recent end.
		ledgers.delete(userId);
		ledgers.set(userId, existing);
		return existing;
	}
	if (!create) return null;
	const created: UserLedger = { hosts: new Map(), thumbnails: new Map() };
	ledgers.set(userId, created);
	while (ledgers.size > LEDGER_MAX_USERS) {
		const oldest = ledgers.keys().next();
		if (oldest.done) break;
		ledgers.delete(oldest.value);
	}
	return created;
}

/** Remembers that tools returned these hosts to this user. */
export function recordLedgerHosts(
	userId: string,
	hosts: Iterable<unknown>,
): void {
	let ledger: UserLedger | null = null;
	for (const raw of hosts) {
		const host = normalizeHost(raw);
		if (!host) continue;
		ledger ??= ledgerFor(userId, true);
		if (!ledger) return;
		touch(ledger.hosts, host, LEDGER_MAX_HOSTS_PER_USER);
	}
}

/**
 * Remembers that a search returned these exact Brave thumbnail addresses to
 * this user. Anything that is not an address on Brave's image proxy is ignored.
 */
export function recordLedgerThumbnails(
	userId: string,
	thumbnails: Iterable<unknown>,
): void {
	let ledger: UserLedger | null = null;
	for (const raw of thumbnails) {
		if (!isBraveThumbnailUrl(raw)) continue;
		const key = provenanceKey(raw);
		if (!key) continue;
		ledger ??= ledgerFor(userId, true);
		if (!ledger) return;
		touch(ledger.thumbnails, key, LEDGER_MAX_THUMBNAILS_PER_USER);
	}
}

/** Whether a tool returned this host to this user. */
export function ledgerHasHost(userId: string, host: unknown): boolean {
	const normalized = normalizeHost(host);
	if (!normalized) return false;
	const ledger = ledgerFor(userId, false);
	if (!ledger?.hosts.has(normalized)) return false;
	touch(ledger.hosts, normalized, LEDGER_MAX_HOSTS_PER_USER);
	return true;
}

/** Whether a search returned exactly this Brave thumbnail address to this user. */
export function ledgerHasThumbnail(
	userId: string,
	thumbnail: unknown,
): boolean {
	if (!isBraveThumbnailUrl(thumbnail)) return false;
	const key = provenanceKey(thumbnail);
	if (!key) return false;
	const ledger = ledgerFor(userId, false);
	if (!ledger?.thumbnails.has(key)) return false;
	touch(ledger.thumbnails, key, LEDGER_MAX_THUMBNAILS_PER_USER);
	return true;
}

/** Forgets everything. Tests only: nothing in the app clears the ledger. */
export function resetLedgerForTests(): void {
	ledgers.clear();
}
