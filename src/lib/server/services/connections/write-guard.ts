import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Write-guard core (Issue 4.1) — the "corruption firewall" every connection
// write goes through before any provider-specific I/O happens. This module
// is intentionally pure and provider-agnostic: no WebDAV/HTTP specifics, no
// database access, no network calls. Every write adapter (4.2, 6.x) is
// expected to route through resolveWriteTarget + buildWritePreview +
// idempotencyKey + requiresConfirm before touching a real provider.
// ---------------------------------------------------------------------------

export type WriteTarget = {
	path?: string;
	id?: string;
	label?: string;
	// Populated by the caller from resolveWriteTarget's result when the
	// target is path-based. Absent (or undefined) means either the target
	// isn't path-based (id/label only) or the caller hasn't run it through
	// resolveWriteTarget. A "corruption firewall" must never treat "unknown"
	// as "safe": buildWritePreview treats a path-bearing target with this
	// flag unset as UNVERIFIED (surfaced as `withinAllowlist: null` plus a
	// warning), never as an implicit `true`. Only an explicit `true` (as
	// produced by resolveWriteTarget) suppresses the warning.
	withinAllowlist?: boolean;
};

export type WriteOperation = {
	provider: string; // ConnectionProvider value
	connectionId: string;
	action: string; // e.g. "files.put", "files.delete", "calendar.create_event"
	summary: string; // human sentence: "Upload report.pdf to /AlfyAI"
	reversible: boolean; // does the platform keep a trash/version so this can be undone?
	destructive: boolean; // overwrite/delete/expunge etc.
	target?: WriteTarget;
	payloadFingerprint?: string; // stable hash input for identical-payload dedup (optional)
};

export type WritePreview = {
	title: string;
	detail: string;
	reversible: boolean;
	destructive: boolean;
	withinAllowlist: boolean | null; // null when not path-based
	warnings: string[]; // e.g. "outside your allowed folder", "not reversible"
};

const DEFAULT_AREA = "/AlfyAI";

// Normalizes a caller-supplied path against a trusted (already-normalized)
// root concept — collapses repeated slashes, drops `.` segments, and
// resolves `..` segments in-place. A `..` that would pop past the start of
// the path throws rather than silently clamping, so a bug upstream can never
// quietly turn into a path-traversal write. This mirrors the guarantees of
// the Nextcloud read adapter's normalizeNextcloudPath (2.2) but is kept
// local and provider-agnostic — this module must not import anything
// WebDAV/provider-specific.
function normalizeAllowlistPath(path: string): string {
	// Percent-decode before splitting into segments so an encoded escape
	// (`%2e%2e`, or an encoded separator like `..%2f..`) can't disguise a
	// `..` segment from the traversal check below. Malformed sequences are
	// left as-is rather than throwing here — decodeURIComponent's own error
	// is not a security signal, only genuine `..` segments are.
	let decoded = path;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		decoded = path;
	}
	const stack: string[] = [];
	for (const raw of decoded.split("/")) {
		const segment = raw.trim();
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (stack.length === 0) {
				throw new Error(
					`Path escapes the allowed root: ${JSON.stringify(path)}`,
				);
			}
			stack.pop();
			continue;
		}
		stack.push(segment);
	}
	return `/${stack.join("/")}`;
}

// True iff `path` (already normalized) is the allowlist root itself or a
// descendant of it. Deliberately requires a `/` boundary so a sibling with a
// shared string prefix (e.g. "/AlfyAI2") is never mistaken for a descendant
// of "/AlfyAI".
function isUnderRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

// Path-based destination resolution. `allowlist` = the connection's allowed
// root paths (e.g. ["/AlfyAI"]); `requestedPath` = a path the user
// explicitly named (or undefined); `defaultArea` = where unspecified writes
// land (default: first allowlist entry or "/AlfyAI").
//
// Design rule: an explicit user-named location is ALWAYS honored (never
// silently redirected), even when it falls outside the allowlist — the
// caller is expected to surface `withinAllowlist: false` as a warning via
// buildWritePreview rather than block it here. Only path traversal is a hard
// reject, never "outside the allowlist".
export function resolveWriteTarget(params: {
	allowlist: string[];
	requestedPath?: string;
	defaultArea?: string;
}): { path: string; withinAllowlist: boolean } {
	const normalizedAllowlist = params.allowlist.map(normalizeAllowlistPath);

	if (params.requestedPath !== undefined) {
		const path = normalizeAllowlistPath(params.requestedPath);
		const withinAllowlist = normalizedAllowlist.some((root) =>
			isUnderRoot(path, root),
		);
		return { path, withinAllowlist };
	}

	const fallback = params.defaultArea ?? normalizedAllowlist[0] ?? DEFAULT_AREA;
	const path = normalizeAllowlistPath(fallback);
	return { path, withinAllowlist: true };
}

function describeTarget(target: WriteTarget | undefined): string {
	if (!target) return "(no target)";
	return target.path ?? target.label ?? target.id ?? "(no target)";
}

// Composes a clear, human-facing confirm preview from a write operation.
// `warnings` surfaces the two situations that matter most for a
// "corruption firewall": an unrecoverable destructive change, and a target
// outside the connection's allowed area.
export function buildWritePreview(op: WriteOperation): WritePreview {
	const hasPath = op.target?.path !== undefined;
	const explicitFlag = op.target?.withinAllowlist;
	// Only an explicit true/false (as produced by resolveWriteTarget) is
	// trusted. A path-bearing target with the flag unset is UNVERIFIED, not
	// "assumed safe" — it surfaces as null (unknown), same as a non-path
	// target, but with its own warning so it's never mistaken for "no
	// allowlist concept applies here".
	const withinAllowlist: boolean | null = !hasPath
		? null
		: explicitFlag === true
			? true
			: explicitFlag === false
				? false
				: null;

	const warnings: string[] = [];
	if (op.destructive && !op.reversible) {
		warnings.push("This will overwrite/delete and may not be recoverable");
	}
	if (withinAllowlist === false) {
		warnings.push("Outside your allowed area");
	}
	if (hasPath && explicitFlag === undefined) {
		warnings.push(
			"Allowlist status could not be verified for this destination.",
		);
	}

	return {
		title: op.summary,
		detail: `${op.action} — ${describeTarget(op.target)}`,
		reversible: op.reversible,
		destructive: op.destructive,
		withinAllowlist,
		warnings,
	};
}

// Stable key for retry-dedup: hash of provider+connectionId+action+target+
// payloadFingerprint. Target fields are pulled out explicitly (rather than
// hashing op.target as-is) so key order in the object literal callers happen
// to construct never changes the hash — only the salient values do.
// `withinAllowlist` is deliberately excluded: it's informational metadata
// about the target, not part of the target's identity for dedup purposes.
export function idempotencyKey(op: WriteOperation): string {
	const canonical = JSON.stringify({
		provider: op.provider,
		connectionId: op.connectionId,
		action: op.action,
		target: {
			path: op.target?.path ?? null,
			id: op.target?.id ?? null,
			label: op.target?.label ?? null,
		},
		payloadFingerprint: op.payloadFingerprint ?? null,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

// All connection writes require explicit confirm (design rule). Returns
// true always — destructive ops don't skip confirmation, they carry a
// stronger warning surfaced via buildWritePreview instead.
export function requiresConfirm(_op: WriteOperation): boolean {
	return true;
}
