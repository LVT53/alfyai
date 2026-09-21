// The MinerU-4 availability gate, client side (phase5-6 spec D6 / §3.5).
//
// The registry LABELS the entries that need a 4.x backend — ask
// `getMineru4GatedFileTypeIds()` for the list; this file deliberately does not
// repeat it, because a copy here is exactly the drift the registry exists to
// end. Whether the configured backend can actually parse them is a server fact
// (`GET /v1/health`, major >= 4), so this store holds nothing but the answer
// the server sent, and every UI surface derives its accept string from it
// through `buildAcceptAttribute(surface, $disabledFileTypeIds)`.
//
// **It fails OPEN, and that is the whole point of the default.** "Unknown" —
// no shell payload yet, a probe that never answered, a payload that arrived
// malformed — is an EMPTY set, which disables nothing. A momentary backend
// outage must never silently shrink the file picker (spec OQ9); only a probe
// that positively answers with a pre-4 version closes the gate, and a file
// that then fails anyway fails on the ledger with the Retry button the user
// already knows.
//
// Two writers, exactly as `upload-limits.ts` has:
//
//  1. the SSR shell payload (`app-shell.ts` -> `(app)/+layout.svelte`), read
//     through `readShellDisabledFileTypeIds` so the layout compiles before and
//     after P5-B adds the field — drag-and-drop partitioning and the picker's
//     `accept` both happen before any request is made;
//  2. the upload intent response, which is authoritative and lands first on
//     every real upload. P5-B adds `disabledFileTypeIds` to
//     `KnowledgeUploadIntentResponse` and calls `setDisabledFileTypeIds` next
//     to the existing `setMaxFileUploadSize(intent.maxFileUploadSize)` in
//     `$lib/client/api/knowledge.ts`.
//
// Writer 1 runs in `onMount`, NOT during SSR: this is module state, so a
// server-side write would be shared by every concurrent request. The cost is
// the same one the upload limit pays — server-rendered HTML always carries the
// open gate, and a closed one lands at hydration. An open gate is the safe
// frame to show.

import { type Readable, writable } from "svelte/store";

/** The frozen wire shape. Absent ⇒ `[]` ⇒ nothing is disabled. */
export const SHELL_DISABLED_FILE_TYPE_IDS_FIELD = "disabledFileTypeIds";

const EMPTY: ReadonlySet<string> = new Set<string>();

const gate = writable<ReadonlySet<string>>(EMPTY);

/**
 * Registry entry ids the backend currently refuses, for
 * `buildAcceptAttribute(surface, $disabledFileTypeIds)` and for
 * `partitionUploadableFiles`'s `disabledEntryIds`.
 *
 * A Set rather than an array, and the SAME Set while the answer has not
 * changed: `buildAcceptAttribute` is not memoised (it cannot be — the disabled
 * set moves with backend health), and both surfaces recompute their accept
 * string whenever this value's identity changes. Read-only by construction so
 * a component cannot write the gate it is supposed to obey.
 */
export const disabledFileTypeIds: Readable<ReadonlySet<string>> = {
	subscribe: gate.subscribe,
};

/**
 * Publish the server's answer. Anything that is not an array of non-empty
 * strings is ignored rather than written — a malformed payload must leave the
 * gate open, never guess it closed.
 *
 * Ids are not checked against `getMineru4GatedFileTypeIds()`: an id the
 * registry does not carry simply matches no entry in `buildAcceptAttribute`,
 * and refusing to store it would make a future server-side gate un-shippable
 * without a client release.
 */
export function setDisabledFileTypeIds(
	ids: readonly string[] | null | undefined,
): void {
	if (!Array.isArray(ids)) return;
	// Sorted, so the stored value is a function of the SET the server named and
	// not of the order it happened to serialise it in.
	const next = new Set(
		ids
			.filter((id): id is string => typeof id === "string")
			.map((id) => id.trim())
			.filter(Boolean)
			.sort(),
	);
	gate.update((current) => {
		if (current.size === next.size) {
			let same = true;
			for (const id of next) {
				if (!current.has(id)) {
					same = false;
					break;
				}
			}
			if (same) return current;
		}
		return next.size === 0 ? EMPTY : next;
	});
}

/**
 * Read the gate out of an SSR shell payload without depending on the field
 * existing yet: P5-B owns `AppShellData`, and this slice ships before it. Once
 * the field lands this is still the right reader — it is the one place that
 * states "absent means open".
 */
export function readShellDisabledFileTypeIds(
	shell: unknown,
): readonly string[] {
	if (!shell || typeof shell !== "object") return [];
	const value = (shell as Record<string, unknown>)[
		SHELL_DISABLED_FILE_TYPE_IDS_FIELD
	];
	if (!Array.isArray(value)) return [];
	return value.filter((id): id is string => typeof id === "string");
}

/** Test seam: restore the open gate. */
export function resetDisabledFileTypeIds(): void {
	gate.set(EMPTY);
}
