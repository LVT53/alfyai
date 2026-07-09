import {
	createCipheriv,
	createDecipheriv,
	pbkdf2Sync,
	randomBytes,
} from "node:crypto";
import { config } from "../../env";

const ALGORITHM = "aes-256-gcm";
// Distinct salt from providers.ts ("alfyai-providers") so a connection secret
// key can never be derived from (or confused with) a provider API key.
const SALT = "alfyai-connections";
const IV_LENGTH = 16;

export type EncryptedSecret = {
	ciphertext: string;
	iv: string;
	authTag: string;
};

function deriveEncryptionKey(secret: string): Buffer {
	return pbkdf2Sync(secret, SALT, 100000, 32, "sha256");
}

export function encryptConnectionSecret(plaintext: string): EncryptedSecret {
	const key = deriveEncryptionKey(config.sessionSecret);
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	return {
		ciphertext: ciphertext.toString("base64"),
		iv: iv.toString("base64"),
		authTag: authTag.toString("base64"),
	};
}

export function decryptConnectionSecret(secret: EncryptedSecret): string {
	// Any failure here (bad key, tampered ciphertext/iv/authTag, malformed
	// base64) must fail closed. We deliberately swallow the underlying error
	// and throw a generic message so nothing about the secret or the crypto
	// internals ever reaches a log or an API response.
	try {
		const key = deriveEncryptionKey(config.sessionSecret);
		const iv = Buffer.from(secret.iv, "base64");
		const ciphertext = Buffer.from(secret.ciphertext, "base64");
		const authTag = Buffer.from(secret.authTag, "base64");
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);
		return (
			decipher.update(ciphertext).toString("utf8") + decipher.final("utf8")
		);
	} catch {
		throw new Error("Failed to decrypt connection secret");
	}
}
