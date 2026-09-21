/**
 * The MinerU-4 availability gate (phase5-6 spec §3.5, D6, and the amended
 * OQ2).
 *
 * The registry only LABELS which entries need a 4.x backend
 * (`getMineru4GatedFileTypeIds`, `getMineru4FallbackFileTypeIds`,
 * `getIntakeFallbackRoute`). Whether the CONFIGURED backend actually is one is
 * a runtime fact, decided here from `getMineruStatusReport()` — the same
 * cached probe the admin status card reads.
 *
 * **Fails OPEN.** "Unknown" — no probe yet, a probe that errored, a probe that
 * timed out — disables nothing. Only a probe that POSITIVELY identifies a
 * pre-4.x backend closes the gate: a reachable `/v1/health` whose major
 * version is below 4, or a failure on `/v1/health` specifically shaped like
 * "this endpoint does not exist" (`capabilities.ts`'s `describeHealthFailure`
 * — a MinerU 3.x server has no `/v1` namespace at all, so this IS the
 * positive 3.x signal, not an ordinary outage). Every other failure —
 * timeout, DNS, connection refused, 5xx, an unconfigured `MINERU_API_URL` —
 * is "unknown" and leaves the gate open.
 *
 * **Never blocks the upload hot path on a network call.** `getMineruStatusReport`
 * itself is TTL-cached and de-dupes concurrent probes (`inFlight`), but on a
 * COLD cache it still awaits the probe before resolving. This module never
 * waits for that: it races the status read against an immediate "cache miss"
 * signal. A warm cache resolves within the same tick and wins the race; a
 * cold cache loses it, and this call answers "unknown" (open) while the probe
 * — already kicked off — keeps running in the background and populates
 * `capabilities.ts`'s own cache for the NEXT call. This is "the capabilities
 * module's own TTL logic" the phase5-6 spec refers to: nothing here
 * duplicates it, this module only declines to wait on it.
 */

import { getMineruStatusReport } from "$lib/server/services/mineru/capabilities";
import {
	getIntakeFallbackRoute,
	getIntakeRoute,
	getMineru4GatedFileTypeIds,
	type IntakeRoute,
} from "$lib/shared/file-types";

export interface UploadFormatGate {
	/** Registry entry ids currently refused. Empty when the backend is fine or unknown. */
	readonly disabledEntryIds: ReadonlySet<string>;
	/** `null` when nothing is disabled. */
	readonly reason: "backend_version" | null;
	/** The reported version string, when known. `null` on an unreachable probe. */
	readonly backendVersion: string | null;
	readonly checkedAt: string;
}

const OPEN_REASON: UploadFormatGate["reason"] = null;

function openGate(checkedAt: string): UploadFormatGate {
	return {
		disabledEntryIds: new Set(),
		reason: OPEN_REASON,
		backendVersion: null,
		checkedAt,
	};
}

/** "4.0.4" -> 4; "v3.9" -> 3; anything unparsable -> null (treated as unknown). */
function parseMajorVersion(version: string): number | null {
	const match = /^\s*v?(\d+)/i.exec(version);
	if (!match) return null;
	const major = Number(match[1]);
	return Number.isFinite(major) ? major : null;
}

/**
 * True only for a probe outcome that POSITIVELY identifies a pre-4.x backend.
 * Everything else — including every flavour of "could not tell" — is false,
 * which is what keeps the gate open by default (OQ9).
 */
function isPositivelyPreMineru4(report: {
	reachable: boolean;
	version: string | null;
	error: { code: string; message: string } | null;
}): boolean {
	if (report.reachable) {
		const major = report.version ? parseMajorVersion(report.version) : null;
		return major !== null && major < 4;
	}
	// Unreachable: only `capabilities.ts`'s own "this is not a MinerU 4
	// server" signal counts. That code is set exclusively from a failed
	// `/v1/health` call (every other failure keeps `report.error` null or a
	// different code), and `describeHealthFailure` attaches it precisely when
	// the transport failure looks like "no /v1 namespace at all" — the shape
	// of a MinerU 3.x response. An unconfigured server, a timeout, a DNS
	// failure or a 5xx all map to a different code and stay "unknown".
	//
	// The code is `backend_misconfigured`. It used to be `protocol`, and a
	// later slice split the two apart precisely so that "MINERU_API_URL does
	// not point at a MinerU 4 server" could be said by name
	// (`capabilities.ts`'s `describeHealthFailure`). `protocol` is kept here
	// only so that a future probe path that still raises the older code closes
	// the gate as it always did; on this branch `describeHealthFailure`
	// rewrites every `/v1/health` `protocol` failure, so the live signal is
	// `backend_misconfigured`.
	const code = report.error?.code;
	return code === "backend_misconfigured" || code === "protocol";
}

const CACHE_MISS = Symbol("upload-format-gate:cache-miss");

/**
 * Reads `getMineruStatusReport()` without ever blocking on the network call
 * it may need to make. See the module docstring.
 */
async function readStatusReportWithoutBlocking(): Promise<Awaited<
	ReturnType<typeof getMineruStatusReport>
> | null> {
	const statusPromise = getMineruStatusReport();
	// `getMineruStatusReport` never actually rejects (an unreachable probe is
	// a report, not a throw), but if that ever changes this must not become an
	// unhandled rejection just because we stopped awaiting it below.
	statusPromise.catch(() => undefined);

	const result = await Promise.race([
		statusPromise,
		new Promise<typeof CACHE_MISS>((resolve) => {
			setImmediate(() => resolve(CACHE_MISS));
		}),
	]);
	return result === CACHE_MISS ? null : result;
}

/**
 * The upload-time answer: which registry entries to refuse right now.
 *
 * Never throws, never awaits a network round trip. Safe to call on every
 * upload request — concurrent calls share `getMineruStatusReport`'s own
 * single in-flight probe.
 */
export async function getUploadFormatGate(): Promise<UploadFormatGate> {
	const report = await readStatusReportWithoutBlocking();
	if (!report) return openGate(new Date().toISOString());
	if (!isPositivelyPreMineru4(report)) return openGate(report.checkedAt);

	return {
		disabledEntryIds: new Set(getMineru4GatedFileTypeIds()),
		reason: "backend_version",
		backendVersion: report.reachable ? report.version : null,
		checkedAt: report.checkedAt,
	};
}

/**
 * `getIntakeRoute`, adjusted for the gate: unchanged when the gate is open or
 * this entry carries no fallback, degraded to intake.fallbackRoute (today
 * only the HTML entry, to direct-text) when the gate has positively closed on
 * a pre-4.x backend.
 *
 * A gated entry with no fallback route (the five formats getMineru4GatedFileTypeIds
 * names) is not expected to reach here at all — the upload routes refuse it
 * at admission — but if it does, its base route is returned unchanged:
 * refusing uploads is the admission layer's job, not this one's.
 */
export function resolveEffectiveIntakeRoute(
	filename: string,
	mimeType: string | null,
	gate: Pick<UploadFormatGate, "reason">,
): IntakeRoute {
	const baseRoute = getIntakeRoute(filename, mimeType);
	if (gate.reason !== "backend_version") return baseRoute;
	return getIntakeFallbackRoute(filename, mimeType) ?? baseRoute;
}
