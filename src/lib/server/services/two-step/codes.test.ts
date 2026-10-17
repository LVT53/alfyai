import { createHash } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { describe, expect, it } from "vitest";
import {
	formatTotpKey,
	generateBackupCodes,
	generateTotpSecret,
	hashBackupCode,
	matchTotpStep,
	normalizeBackupCode,
	renderQrSvg,
	totpUri,
} from "./codes";

// The RFC 6238 appendix's SHA-1 vectors, with the secret's ASCII bytes as the
// key and the 6-digit truncation the app uses. A TOTP that does not match
// these is not TOTP, whatever else it does.
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
	[20000000000, "353130"],
];

describe("TOTP", () => {
	it("matches the RFC 6238 SHA-1 vectors", () => {
		for (const [seconds, code] of RFC_VECTORS) {
			expect(matchTotpStep(RFC_SECRET, code, new Date(seconds * 1000))).toBe(
				Math.floor(seconds / 30),
			);
		}
	});

	it("accepts one step either side, refuses two", () => {
		const step = 1000;
		// A code is 6 digits, so two of five steps can collide by chance; pick
		// a secret whose window and its neighbours are all different, so the
		// assertion below is about the window, never about a collision.
		const secret = (() => {
			for (;;) {
				const candidate = generateTotpSecret();
				const codes = [-2, -1, 0, 1, 2].map((distance) =>
					generateHOTP(candidate, BigInt(step + distance), 6),
				);
				if (new Set(codes).size === codes.length) return candidate;
			}
		})();

		for (const distance of [-1, 0, 1]) {
			const code = generateHOTP(secret, BigInt(step + distance), 6);
			expect(matchTotpStep(secret, code, new Date(step * 30_000 + 5_000))).toBe(
				step + distance,
			);
		}

		for (const distance of [-2, 2]) {
			const code = generateHOTP(secret, BigInt(step + distance), 6);
			expect(
				matchTotpStep(secret, code, new Date(step * 30_000 + 5_000)),
			).toBeNull();
		}
	});

	it("refuses a code that is not six digits", () => {
		const secret = generateTotpSecret();
		const now = new Date(1000 * 30_000);
		const code = generateHOTP(secret, 1000n, 6);

		expect(matchTotpStep(secret, "", now)).toBeNull();
		expect(matchTotpStep(secret, "12345", now)).toBeNull();
		expect(matchTotpStep(secret, `${code}0`, now)).toBeNull();
		expect(matchTotpStep(secret, `${code.slice(0, 5)}a`, now)).toBeNull();
	});

	it("is 20 random bytes, shown as a key in groups of four", () => {
		const secret = generateTotpSecret();
		expect(secret).toHaveLength(20);

		const key = formatTotpKey(secret);
		expect(key).toMatch(/^(?:[A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
		// The key is the secret's base32, so it decodes back to the same bytes.
		expect(decodeBase32IgnorePadding(key.replaceAll(" ", ""))).toEqual(secret);
	});

	it("builds the issuer's otpauth URI", () => {
		const secret = generateTotpSecret();
		const uri = totpUri(secret, "dora@example.com");

		expect(uri.startsWith("otpauth://totp/AlfyAI:")).toBe(true);
		expect(uri).toContain("issuer=AlfyAI");
		expect(uri).toContain("secret=");
		expect(uri).toContain("period=30");
		expect(uri).toContain("digits=6");
	});
});

describe("backup codes", () => {
	it("looks like XXXXX-XXXXX in Crockford base32", () => {
		const codes = generateBackupCodes();

		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		for (const code of codes) {
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
		}
	});

	it("a loosely typed backup code normalizes to the same code", () => {
		const canonical = "7KQ4M2XWP0";

		for (const typed of [
			"7kq4m 2xwp0",
			"7KQ4M2XWP0",
			"7KQ4M-2XWPO",
			"7kq4m-2xwp0",
			" 7KQ4M 2XWP0 ",
		]) {
			expect(normalizeBackupCode(typed)).toBe(canonical);
		}

		// I and L read as 1, O as 0 (RFC 4648's Crockford aliases).
		expect(normalizeBackupCode("IL0O0-00000")).toBe("1100000000");
		expect(normalizeBackupCode("O0O0O-0O0O0")).toBe("0000000000");
	});

	it("refuses a code that is not one", () => {
		expect(normalizeBackupCode("")).toBeNull();
		expect(normalizeBackupCode("7KQ4M-2XWP")).toBeNull();
		expect(normalizeBackupCode("7KQ4M-2XWP00")).toBeNull();
		// U is not in Crockford's alphabet (it would be read as V).
		expect(normalizeBackupCode("7KQ4M-2XWPU")).toBeNull();
	});

	it("the hash is keyed and stable", () => {
		const code = "7KQ4M2XWP0";
		const hash = hashBackupCode(code);

		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hashBackupCode(code)).toBe(hash);
		expect(hashBackupCode("R8D2T9MZQA")).not.toBe(hash);
		// A plain digest is not what is stored: the database copy alone must
		// not let someone test guesses against it.
		expect(hash).not.toBe(createHash("sha256").update(code).digest("hex"));
	});
});

describe("the setup QR", () => {
	it("is an inline SVG with no external reference", () => {
		const svg = renderQrSvg(totpUri(generateTotpSecret(), "dora@example.com"));

		expect(svg.startsWith("<svg")).toBe(true);
		// The only http in the markup is the SVG namespace, not a fetched URL.
		const withoutNamespace = svg.replace(
			'xmlns="http://www.w3.org/2000/svg"',
			"",
		);
		expect(withoutNamespace).not.toContain("http");
		expect(svg).not.toContain("href");
		expect(svg).not.toContain("<image");
	});
});
