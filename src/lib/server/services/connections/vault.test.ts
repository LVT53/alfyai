import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncryptedSecret } from "./vault";

const originalEnv = process.env;

afterEach(() => {
	process.env = { ...originalEnv };
	vi.resetModules();
});

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

describe("encryptConnectionSecret / decryptConnectionSecret", () => {
	it("round-trips an arbitrary secret exactly", async () => {
		const { encryptConnectionSecret, decryptConnectionSecret } = await import(
			"./vault"
		);
		const original = "sk-refresh-token-abc123";
		const encrypted = encryptConnectionSecret(original);
		expect(decryptConnectionSecret(encrypted)).toBe(original);
	});

	it("round-trips unicode and long tokens exactly", async () => {
		const { encryptConnectionSecret, decryptConnectionSecret } = await import(
			"./vault"
		);
		const unicode = "秘密トークン🔐-résumé-Ключ";
		const long = `${"a".repeat(4096)}-refresh-token-${"z".repeat(4096)}`;

		expect(decryptConnectionSecret(encryptConnectionSecret(unicode))).toBe(
			unicode,
		);
		expect(decryptConnectionSecret(encryptConnectionSecret(long))).toBe(long);
	});

	it("produces ciphertext distinct from the plaintext, with non-empty base64 iv/authTag", async () => {
		const { encryptConnectionSecret } = await import("./vault");
		const plaintext = "super-secret-value";
		const { ciphertext, iv, authTag } = encryptConnectionSecret(plaintext);

		expect(ciphertext).not.toBe(plaintext);
		expect(ciphertext.length).toBeGreaterThan(0);
		expect(iv.length).toBeGreaterThan(0);
		expect(authTag.length).toBeGreaterThan(0);
		expect(iv).toMatch(BASE64_RE);
		expect(authTag).toMatch(BASE64_RE);
		expect(ciphertext).toMatch(BASE64_RE);
	});

	it("uses a random IV so repeated encryptions of the same plaintext differ", async () => {
		const { encryptConnectionSecret } = await import("./vault");
		const plaintext = "same-secret-every-time";
		const a = encryptConnectionSecret(plaintext);
		const b = encryptConnectionSecret(plaintext);

		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it("throws (fails closed) when the ciphertext is tampered with, without leaking the plaintext", async () => {
		const { encryptConnectionSecret, decryptConnectionSecret } = await import(
			"./vault"
		);
		const plaintext = "do-not-leak-me";
		const encrypted = encryptConnectionSecret(plaintext);
		const tampered: EncryptedSecret = {
			...encrypted,
			ciphertext: flipLastByteBase64(encrypted.ciphertext),
		};

		let thrown: unknown;
		try {
			decryptConnectionSecret(tampered);
			throw new Error("expected decryptConnectionSecret to throw");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).not.toContain(plaintext);
	});

	it("throws (fails closed) when the IV is tampered with, without leaking the plaintext", async () => {
		const { encryptConnectionSecret, decryptConnectionSecret } = await import(
			"./vault"
		);
		const plaintext = "do-not-leak-me-either";
		const encrypted = encryptConnectionSecret(plaintext);
		const tampered: EncryptedSecret = {
			...encrypted,
			iv: flipLastByteBase64(encrypted.iv),
		};

		expect(() => decryptConnectionSecret(tampered)).toThrow();
		try {
			decryptConnectionSecret(tampered);
		} catch (error) {
			expect((error as Error).message).not.toContain(plaintext);
		}
	});

	it("throws (fails closed) when the authTag is tampered with, without leaking the plaintext", async () => {
		const { encryptConnectionSecret, decryptConnectionSecret } = await import(
			"./vault"
		);
		const plaintext = "yet-another-secret";
		const encrypted = encryptConnectionSecret(plaintext);
		const tampered: EncryptedSecret = {
			...encrypted,
			authTag: flipLastByteBase64(encrypted.authTag),
		};

		expect(() => decryptConnectionSecret(tampered)).toThrow();
		try {
			decryptConnectionSecret(tampered);
		} catch (error) {
			expect((error as Error).message).not.toContain(plaintext);
		}
	});

	it("throws when decrypting a secret that was encrypted under a different SESSION_SECRET", async () => {
		process.env.SESSION_SECRET = "session-secret-one-1234567890";
		vi.resetModules();
		const first = await import("./vault");
		const encrypted = first.encryptConnectionSecret("cross-key-secret");

		process.env.SESSION_SECRET = "session-secret-two-0987654321";
		vi.resetModules();
		const second = await import("./vault");

		expect(() => second.decryptConnectionSecret(encrypted)).toThrow();
	});
});

function flipLastByteBase64(value: string): string {
	const buffer = Buffer.from(value, "base64");
	if (buffer.length === 0) {
		throw new Error("cannot tamper with an empty buffer");
	}
	buffer[buffer.length - 1] ^= 0xff;
	return buffer.toString("base64");
}
