// The App-facing view of the artifact_kv store (Feature 2 · Artifacts,
// Slice 2): the two functions the kv route calls, and the ONLY module in this
// slice that knows the five refusal reasons the bridge speaks
// (`artifacts.app.storage.*`, Contracts).
//
// `kv.setKv` refuses over ARTIFACT_KV_MAX_KEYS / _KEY_MAX_CHARS /
// _VALUE_MAX_BYTES / _TOTAL_MAX_BYTES and returns only a boolean
// (slice-0.md §The boundary), so this layer pre-checks the same bounds
// itself to have a REASON to report — pre-checking a DIFFERENT number than
// the store enforces would be a lie the app hears once and then the store
// enforces silently anyway; `APP_KV_LIMITS` therefore derives every field
// from `../limits`, never restating one, and a test pins the equality.
import { listKv, setKv } from "../kv";
import {
	ARTIFACT_KV_KEY_MAX_CHARS,
	ARTIFACT_KV_MAX_KEYS,
	ARTIFACT_KV_TOTAL_MAX_BYTES,
	ARTIFACT_KV_VALUE_MAX_BYTES,
} from "../limits";
import { getArtifact } from "../record";
import type { ArtifactScopeOptions } from "../types";

export const APP_KV_LIMITS = {
	maxKeys: ARTIFACT_KV_MAX_KEYS, // 200
	maxKeyLength: ARTIFACT_KV_KEY_MAX_CHARS, // 128
	maxValueBytes: ARTIFACT_KV_VALUE_MAX_BYTES, // 256 * 1024
	maxTotalBytes: ARTIFACT_KV_TOTAL_MAX_BYTES, // 512 * 1024 (ruling 48)
} as const;

export type AppKvRefusalReason =
	| "invalid_key"
	| "too_large"
	| "too_many_keys"
	| "not_serialisable"
	| "not_found";

export type AppKvReadResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: "invalid_key" | "not_found" };

export type AppKvWriteResult =
	| { ok: true }
	| { ok: false; reason: AppKvRefusalReason };

type Target = {
	userId: string;
	artifactId: string;
	key: string;
} & ArtifactScopeOptions;

function isValidAppKey(key: string): boolean {
	// Array.from, not .length: a surrogate pair must count as one character,
	// the same rule kv.ts's own isValidKey uses — a key at the boundary must
	// not be judged differently by the two layers that both check it.
	return key.length > 0 && Array.from(key).length <= APP_KV_LIMITS.maxKeyLength;
}

/**
 * `undefined`, a function and a symbol make `JSON.stringify` return
 * `undefined` (not throw); a circular reference or a `BigInt` throw. Both
 * outcomes are `not_serialisable`, never a throw that reaches the caller.
 */
function stringifyAppValue(value: unknown): string | null {
	try {
		const json = JSON.stringify(value);
		return typeof json === "string" ? json : null;
	} catch {
		return null;
	}
}

/** Resolves the artifact through the caller's scope and confirms it is an App — the one gate every accessor below shares. */
async function resolveApp(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
) {
	const artifact = await getArtifact(params);
	return artifact && artifact.kind === "app" ? artifact : null;
}

export async function readAppValue(params: Target): Promise<AppKvReadResult> {
	if (!isValidAppKey(params.key)) return { ok: false, reason: "invalid_key" };
	const app = await resolveApp(params);
	if (!app) return { ok: false, reason: "not_found" };

	const rows = await listKv(params);
	const row = rows.find((candidate) => candidate.key === params.key);
	if (!row) return { ok: true, value: null };
	try {
		return { ok: true, value: JSON.parse(row.valueJson) };
	} catch {
		// setKv only ever stores valid JSON; a row that fails to parse here
		// would mean the stored bytes were corrupted some other way. Treat it
		// the same as "nothing stored" rather than surfacing a parser error to
		// the app.
		return { ok: true, value: null };
	}
}

/**
 * Four checks, then one store call (Contracts). The count and the total are
 * READ-then-write, not one transaction spanning this whole function —
 * `setKv` owns its own transaction and this layer must not open a second one
 * behind the facade. The worst case under a race between two writes from the
 * SAME app is one value over `maxTotalBytes`, bounded by a single write, with
 * the store's own per-value and per-key caps still holding; this is a
 * statement about the layering, not a claim of atomicity this function does
 * not have.
 */
export async function writeAppValue(
	params: Target & { value: unknown },
): Promise<AppKvWriteResult> {
	if (!isValidAppKey(params.key)) return { ok: false, reason: "invalid_key" };
	const valueJson = stringifyAppValue(params.value);
	if (valueJson === null) return { ok: false, reason: "not_serialisable" };
	const valueBytes = Buffer.byteLength(valueJson, "utf8");
	if (valueBytes > APP_KV_LIMITS.maxValueBytes) {
		return { ok: false, reason: "too_large" };
	}

	const app = await resolveApp(params);
	if (!app) return { ok: false, reason: "not_found" };

	const rows = await listKv(params);
	const existing = rows.find((row) => row.key === params.key);
	const isNewKey = !existing;
	if (isNewKey && rows.length >= APP_KV_LIMITS.maxKeys) {
		return { ok: false, reason: "too_many_keys" };
	}
	const otherBytes = rows
		.filter((row) => row.key !== params.key)
		.reduce((sum, row) => sum + Buffer.byteLength(row.valueJson, "utf8"), 0);
	if (otherBytes + valueBytes > APP_KV_LIMITS.maxTotalBytes) {
		return { ok: false, reason: "too_large" };
	}

	const written = await setKv({ ...params, valueJson });
	// setKv's own boolean cannot distinguish "the scoped read returned
	// nothing" from "one of its own caps refused" — the pre-checks above
	// already covered the specific reasons this layer can name, so a `false`
	// here (a race between the pre-check and the write, most plausibly) is
	// reported as not_found rather than guessing a more specific reason.
	return written ? { ok: true } : { ok: false, reason: "not_found" };
}
