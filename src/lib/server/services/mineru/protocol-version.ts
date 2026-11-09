/**
 * Which MinerU releases speak the protocol this client speaks.
 *
 * `/v1/tasks` with a JSON manifest, a PUT to the link the server hands back, and
 * one ZIP per file from `result_url` is MinerU 4.1. MinerU 4.0.x already mounts a
 * `/v1/tasks` of its own (R14) in an older shape, answers `/v1/health` with a
 * healthy-looking 200, and then refuses our manifest with a 400: a version check
 * is the only way to tell it apart BEFORE a document is sent to it.
 *
 * A leaf on purpose, with no imports: the capability probe reads it, and so does
 * the tool-health probe of the document backend, and neither should drag the
 * other's dependencies in.
 */

/**
 * `true` when this version serves our protocol (4.1 and newer), `false` when it
 * is a release of an older one (4.0.x, 3.x), and `null` when the string is not a
 * version we can read. Callers treat `null` as "no evidence against it": the
 * protocol client's own errors say the rest.
 */
export function mineruSpeaksTasksProtocol(version: string): boolean | null {
	const match = /^\s*v?(\d+)\.(\d+)/i.exec(version);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return major > 4 || (major === 4 && minor >= 1);
}
