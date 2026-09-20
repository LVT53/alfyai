// The per-file upload limit, as the server reports it (spec section 4.3).
//
// It replaces four hardcoded `100 * 1024 * 1024` / `maxUploadMb = 100` copies
// in the composer and the knowledge list. Three writers feed it:
//
//  1. the shell payload (`app-shell.ts` -> `(app)/+layout.svelte`), because
//     drag-and-drop partitioning happens before any request is made;
//  2. the upload intent response, which is authoritative and lands first on
//     every real upload;
//  3. a 413 from that intent, which reports the limit that refused the file.
//
// Writer 1 runs in `onMount`, NOT during SSR: this is module state, so a
// server-side write would be shared by every concurrent request. The cost is
// that server-rendered HTML always carries the default below and the real
// limit lands at hydration — a deployment that lowered `MAX_FILE_UPLOAD_SIZE`
// shows the default for one frame, and keeps showing it with JS off. Moving
// the seed into the component body would fix that and reintroduce the shared
// mutable state; it is a deliberate trade, not an oversight.
//
// Until a writer arrives the registry default applies, which is the same
// number `MAX_FILE_UPLOAD_SIZE` defaults to in `src/lib/server/env.ts`.

import { derived, writable } from "svelte/store";
import { DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES } from "$lib/shared/file-types";

export const maxFileUploadSizeBytes = writable<number>(
	DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES,
);

/** Whole megabytes, for the copy that says "max {max}MB per file". */
export const maxFileUploadSizeMb = derived(maxFileUploadSizeBytes, (bytes) =>
	Math.round(bytes / (1024 * 1024)),
);

/**
 * Publish a server-reported limit. A missing, non-finite or non-positive value
 * is ignored rather than written: an admin lowering the limit should propagate,
 * but a malformed payload must never make every file look too large.
 */
export function setMaxFileUploadSize(bytes: number | undefined | null): void {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
		return;
	}
	maxFileUploadSizeBytes.set(Math.floor(bytes));
}

/** Test seam: restore the pre-SSR default. */
export function resetMaxFileUploadSize(): void {
	maxFileUploadSizeBytes.set(DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES);
}
