import {
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { encodeBase32UpperCaseNoPadding } from "@oslojs/encoding";
import { createTOTPKeyURI, generateHOTP } from "@oslojs/otp";
import { renderSVG } from "uqr";
import { config } from "../../env";

/**
 * The code and key primitives of two-step sign-in: TOTP, the one-time backup
 * codes and the setup QR. No database, no session, no request — everything
 * here is a pure function of its arguments (plus `SESSION_SECRET`, for the
 * keyed backup-code hash), so the RFC vectors and the normalization rules can
 * be tested without any app state.
 */

/** RFC 6238's step: a code is the same for 30 seconds. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * The accepted window at sign-in and in Settings: the current step and one
 * either side. Three steps, so a phone whose clock is a few seconds off still
 * works, and a code is valid for 90 seconds at most.
 */
const TOTP_WINDOW_STEPS = 1;
/** 160 bits, the size RFC 4226 recommends for an HMAC-SHA1 key. */
const TOTP_SECRET_BYTES = 20;

/** How many one-time codes a person gets at setup (and at a regeneration). */
export const BACKUP_CODE_COUNT = 10;
/** Crockford's base32: no I, L, O or U, so it survives being read aloud or typed. */
const BACKUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_GROUP = 5;
/**
 * HKDF's domain separation for the backup-code hash key. The info label is
 * the plan's; the salt is a second, app-local label so the key is not the one
 * any other SESSION_SECRET-derived value uses.
 */
const BACKUP_CODE_HKDF_SALT = "alfyai-two-step";
const BACKUP_CODE_HKDF_INFO = "alfyai-backup-codes-v1";

/** A new TOTP secret: 20 random bytes, never derived from the account. */
export function generateTotpSecret(): Uint8Array {
	return new Uint8Array(randomBytes(TOTP_SECRET_BYTES));
}

/**
 * The secret as a person types it into an authenticator app: base32, no
 * padding, in groups of four. The spaces are presentation only; every reader
 * strips them (`decodeBase32IgnorePadding(secret.replaceAll(" ", ""))`).
 */
export function formatTotpKey(secret: Uint8Array): string {
	return (
		encodeBase32UpperCaseNoPadding(secret)
			.match(/.{1,4}/g)
			?.join(" ") ?? ""
	);
}

/**
 * The `otpauth://` URI the QR encodes. `@oslojs/otp` writes the standard
 * parameters (algorithm SHA1, period 30, digits 6, issuer AlfyAI) and
 * percent-encodes the account name, so an address with a plus sign or an
 * `@` in it still scans.
 *
 * An absolute `imageUrl` adds the `image` parameter, a widely supported
 * extension of the Key URI Format that apps ignoring it simply skip (Google
 * Authenticator among them). The phone fetches the image; this server never
 * does, so the QR itself still contains no fetched content.
 */
export function totpUri(
	secret: Uint8Array,
	accountName: string,
	imageUrl?: string,
): string {
	const uri = createTOTPKeyURI(
		"AlfyAI",
		accountName,
		secret,
		TOTP_STEP_SECONDS,
		TOTP_DIGITS,
	);
	if (!imageUrl || !isAbsoluteHttpUrl(imageUrl)) return uri;
	return `${uri}&image=${encodeURIComponent(imageUrl)}`;
}

/** The provider mark has to be fetchable by the phone, not a path we resolve. */
function isAbsoluteHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Which RFC 6238 step a six-digit code belongs to, or null.
 *
 * The window is the current step and one either side, and every candidate is
 * compared in constant time; a code outside the window, of the wrong length or
 * not numeric is refused without ever being compared. The caller decides what
 * to do with the step: the replay guard stores the largest step it accepted.
 */
export function matchTotpStep(
	secret: Uint8Array,
	code: string,
	now: Date,
): number | null {
	if (!/^[0-9]{6}$/.test(code)) return null;

	const currentStep = Math.floor(now.getTime() / (TOTP_STEP_SECONDS * 1000));
	const typed = Buffer.from(code, "utf8");

	// All three candidates are checked, and none of the comparisons is
	// skipped once a match is found: the work does not depend on how wrong
	// the code is.
	let matched: number | null = null;
	for (
		let step = currentStep - TOTP_WINDOW_STEPS;
		step <= currentStep + TOTP_WINDOW_STEPS;
		step++
	) {
		if (step < 0) continue;
		const expected = Buffer.from(
			generateHOTP(secret, BigInt(step), TOTP_DIGITS),
			"utf8",
		);
		const sameLength = expected.length === typed.length;
		const equal = sameLength && timingSafeEqual(expected, typed);
		if (equal && matched === null) matched = step;
	}

	return matched;
}

/**
 * Ten new backup codes, each ten Crockford-base32 characters, shown
 * `XXXXX-XXXXX`. Distinct within the set (a person asked for ten codes, not
 * nine and a duplicate).
 *
 * The alphabet is exactly 32 characters, so masking a random byte with 31
 * picks each character with equal probability — no modulo bias.
 */
export function generateBackupCodes(
	count: number = BACKUP_CODE_COUNT,
): string[] {
	const codes = new Set<string>();
	while (codes.size < count) {
		const bytes = randomBytes(BACKUP_CODE_LENGTH);
		let characters = "";
		for (const byte of bytes) {
			characters += BACKUP_CODE_ALPHABET[byte & 31];
		}
		codes.add(formatBackupCode(characters));
	}
	return [...codes];
}

function formatBackupCode(characters: string): string {
	return `${characters.slice(0, BACKUP_CODE_GROUP)}-${characters.slice(
		BACKUP_CODE_GROUP,
	)}`;
}

/**
 * A typed backup code as the canonical ten characters it was issued as, or
 * null when it is not one.
 *
 * Case, spaces and hyphens are ignored, and the Crockford aliases are folded:
 * `O` is `0`, `I` and `L` are `1`. That is the whole point of the alphabet —
 * a code read off paper and typed loosely still works. The returned value is
 * what `hashBackupCode` hashes; it never carries the display hyphen.
 */
export function normalizeBackupCode(input: string): string | null {
	const folded = input
		.toUpperCase()
		.replaceAll(/[\s-]/g, "")
		.replaceAll("O", "0")
		.replaceAll("I", "1")
		.replaceAll("L", "1");

	if (folded.length !== BACKUP_CODE_LENGTH) return null;
	for (const character of folded) {
		if (!BACKUP_CODE_ALPHABET.includes(character)) return null;
	}
	return folded;
}

let backupCodeKey: Buffer | null = null;

/**
 * The HMAC key for backup codes: HKDF-SHA256 over `SESSION_SECRET`, with the
 * `alfyai-backup-codes-v1` info label the plan names. A copy of the database
 * on its own therefore holds nothing a guess can be tested against — the
 * attacker needs the server's secret too.
 */
function deriveBackupCodeKey(): Buffer {
	if (!backupCodeKey) {
		backupCodeKey = Buffer.from(
			hkdfSync(
				"sha256",
				config.sessionSecret,
				BACKUP_CODE_HKDF_SALT,
				BACKUP_CODE_HKDF_INFO,
				32,
			),
		);
	}
	return backupCodeKey;
}

/** HMAC-SHA256 of a normalized backup code, as lowercase hex. */
export function hashBackupCode(normalized: string): string {
	return createHmac("sha256", deriveBackupCodeKey())
		.update(normalized, "utf8")
		.digest("hex");
}

/**
 * Constant-time comparison of a stored hash with the hash of a typed code.
 * Equal-length hex strings only; a malformed stored value is simply not equal
 * (never a throw — a corrupt row must not become a 500 at sign-in).
 */
export function backupCodeHashMatches(
	storedHash: string,
	typedNormalized: string,
): boolean {
	const expected = Buffer.from(storedHash, "utf8");
	const actual = Buffer.from(hashBackupCode(typedNormalized), "utf8");
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(expected, actual);
}

/**
 * The setup QR: an SVG drawn here, from the URI, with no external reference
 * of any kind beyond the SVG namespace. `uqr` is a pure encoder, so nothing
 * about the secret leaves the server to draw it.
 */
export function renderQrSvg(uri: string): string {
	return renderSVG(uri, {
		ecc: "M",
		border: 2,
		pixelSize: 8,
		blackColor: "#1f1d1a",
		whiteColor: "#ffffff",
	});
}
