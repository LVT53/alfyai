import { createHash } from "node:crypto";

/**
 * sha256 hex of the exact stored string — the one body hasher the family has.
 *
 * This hashes bytes, deliberately. Ruling 12's canonical form belongs to each
 * kind's INPUT: slice 1 canonicalises Markdown blocks before hashing them and
 * slice 3 canonicalises board JSON (stable key order), and both call this
 * function rather than adding a second hasher.
 */
export function hashArtifactBody(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}
