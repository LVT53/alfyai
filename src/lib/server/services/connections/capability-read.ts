import type { Capability } from "./registry";
import {
	needsDisambiguation,
	pickDefaultConnection,
	resolveConnectionsForCapability,
	selectConnection,
} from "./resolve";
import type { ConnectionPublic } from "./store";

// ── The resolve → disambiguation → pick seam ────────────────────
//
// Every capability tool (calendar/files/email/photos/media/location, and the
// single-provider repos) opens with the SAME ~30-line preamble: resolve the
// user's connections for a capability, bail with a "not connected" message if
// there are none, honor an explicit `account` selector (bailing with a "which
// one did you mean" message when it matches nothing), and otherwise fall back
// to a deterministic default (writable-preferring for writes). This seam owns
// that dance once so each tool shrinks to its own logic plus one call.
//
// It lives in its own module (rather than resolve.ts) so a tool test that
// mocks resolve.ts's primitives (resolveConnectionsForCapability, …) still
// intercepts the calls this seam makes into them — an in-module call inside
// resolve.ts would bypass such a mock.
//
// It returns a discriminated result rather than a message so the exact
// per-capability "not connected" / no-match strings stay at each tool's call
// site (they differ per tool and must be preserved verbatim): the caller maps
// `not-connected`/`no-match` onto its own payload, and unwraps `ok` for the
// real `fn` result. `fn` receives the picked connection plus the same
// `{ ambiguous, connections }` context the tools already thread through their
// outcome builders for the "using X; pass account:… for Y" disambiguation note.
export type CapabilityConnectionResult<R> =
	| { kind: "not-connected" }
	| { kind: "no-match"; selector: string; connections: ConnectionPublic[] }
	| { kind: "ok"; value: R };

export async function withCapabilityConnection<R>(
	userId: string,
	capability: Capability,
	opts: { account?: string | null; forWrite?: boolean },
	fn: (
		conn: ConnectionPublic,
		ctx: { ambiguous: boolean; connections: ConnectionPublic[] },
	) => Promise<R>,
): Promise<CapabilityConnectionResult<R>> {
	const connections = await resolveConnectionsForCapability(userId, capability);
	if (connections.length === 0) return { kind: "not-connected" };

	const ambiguous = needsDisambiguation(connections);
	const selected = selectConnection(connections, opts.account);
	if (opts.account && !selected) {
		return { kind: "no-match", selector: opts.account, connections };
	}
	const conn =
		selected ?? pickDefaultConnection(connections, { forWrite: opts.forWrite });
	// pickDefaultConnection only returns null for an empty list, already handled
	// above — this guard mirrors each tool's own defensive re-check and keeps the
	// non-null narrowing local.
	if (!conn) return { kind: "not-connected" };

	return { kind: "ok", value: await fn(conn, { ambiguous, connections }) };
}
