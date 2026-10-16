/**
 * What counts as the same email address, in one place for everything that asks:
 * the server (it stores an address trimmed and lowercased, and does not call
 * the same address in other letters a change) and the Profile card (which asks
 * for the account password only when the address is a change). Two copies
 * drift: a card that asked for a password the server then ignored, and showed
 * an address the server does not hold, is the failure mode this file exists to
 * prevent.
 *
 * Client-safe: no server imports, no DB, no env.
 */

/** An address the way the server stores and compares it: trimmed and lowercased. */
export function normalizeEmailAddress(value: string): string {
	return value.trim().toLowerCase();
}

/** Are these the same address, whatever the letters' case and the spaces around it? */
export function isSameEmailAddress(first: string, second: string): boolean {
	return normalizeEmailAddress(first) === normalizeEmailAddress(second);
}
