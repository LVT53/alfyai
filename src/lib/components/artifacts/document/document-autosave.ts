/**
 * The Document body's debounced save loop (Feature 2 · Artifacts, Slice 1,
 * T7), mirroring the injectable-delay shape `createDraftPersistence` already
 * uses for the composer's own draft save
 * (`src/lib/client/conversation-session.ts:426-429`): a factory, not a hook,
 * so `DocumentBody.svelte` can own one instance per mount and a test can
 * drive it with fake timers and a stub `save`.
 *
 * Pure — no DOM, no `@tiptap/*` — so it never counts against T7.8's
 * lazy-chunk boundary even though `DocumentBody.svelte` imports it eagerly.
 *
 * Failure handling lives here, once, per `slice-1.md §Failure modes`:
 *   - a transient failure (a thrown error — offline, a dropped connection)
 *     keeps retrying: the next `schedule(...)` call still queues a save.
 *   - `too_large` and `not_found` are NOT transient (`slice-1.md` T7.10/T7.11):
 *     `stop()` is called for the caller, and every further `schedule(...)` is
 *     a no-op until `resume()` — a 2 MiB document or a deleted artifact must
 *     never be retried on every keystroke.
 */

import type { SaveSummaryKind } from "$lib/shared/artifacts/version-summaries";

export interface DocumentAutosaveResult {
	ok: boolean;
	reason?: string;
	version?: number;
	/** RV-1B, coordinator item 6: the saved body's new hash, for the caller to remember as its next `baseHash`. */
	bodyHash?: string;
}

/**
 * What a save says about itself besides "the user typed". `summaryKind` names
 * one of the fixed version summaries (Undo of Alfy's change today); it stays
 * with the queued save for the whole debounce window — typing right after an
 * Undo is still part of that save — and applies to that one save only.
 */
export interface DocumentAutosaveSaveOptions {
	summaryKind?: SaveSummaryKind;
}

export interface DocumentAutosaveHandle {
	/** Queues `markdown` to save after the debounce delay. A no-op once stopped. */
	schedule: (markdown: string, options?: DocumentAutosaveSaveOptions) => void;
	/** Cancels any pending timer and saves immediately, if anything is queued. */
	flush: () => Promise<DocumentAutosaveResult | null>;
	/** Stops accepting new schedules (a non-transient refusal: too_large, not_found). */
	stop: () => void;
	/** Re-arms the loop after `stop()` — used once the deleted-document escape hatch lands on a new artifact. */
	resume: () => void;
	/** True once `stop()` has been called and `resume()` has not undone it. */
	readonly stopped: boolean;
}

export function createDocumentAutosave(options: {
	save: (
		markdown: string,
		saveOptions?: DocumentAutosaveSaveOptions,
	) => Promise<DocumentAutosaveResult>;
	onResult?: (result: DocumentAutosaveResult, markdown: string) => void;
	delayMs?: number;
}): DocumentAutosaveHandle {
	const delayMs = options.delayMs ?? 800;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: string | null = null;
	let pendingSummaryKind: SaveSummaryKind | undefined;
	let stopped = false;
	let inFlight: Promise<DocumentAutosaveResult> | null = null;

	function clearTimer(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	async function runSave(
		markdown: string,
		saveOptions?: DocumentAutosaveSaveOptions,
	): Promise<DocumentAutosaveResult> {
		// Called with the markdown alone when there is nothing more to say, so a
		// plain autosave reaches `save` exactly as it always has.
		const run = (
			saveOptions ? options.save(markdown, saveOptions) : options.save(markdown)
		).then(
			(result) => {
				options.onResult?.(result, markdown);
				return result;
			},
			(error: unknown) => {
				// A thrown error (network down, DNS failure, …) is the offline
				// case: transient, so the loop is left running for the next
				// scheduled save to retry.
				const result: DocumentAutosaveResult = {
					ok: false,
					reason: "offline",
				};
				options.onResult?.(result, markdown);
				void error;
				return result;
			},
		);
		inFlight = run;
		const result = await run;
		inFlight = null;
		return result;
	}

	/** Hands the queued save over — its markdown and the kind it carries — and empties the queue. */
	function takePending(): {
		markdown: string;
		saveOptions?: DocumentAutosaveSaveOptions;
	} | null {
		const markdown = pending;
		const summaryKind = pendingSummaryKind;
		pending = null;
		pendingSummaryKind = undefined;
		if (markdown === null) return null;
		return summaryKind
			? { markdown, saveOptions: { summaryKind } }
			: { markdown };
	}

	return {
		schedule(markdown: string, scheduleOptions?: DocumentAutosaveSaveOptions) {
			if (stopped) return;
			pending = markdown;
			// Sticky until this queue is saved: a later plain schedule inside the
			// same window must not turn an Undo's save back into an ordinary one.
			if (scheduleOptions?.summaryKind) {
				pendingSummaryKind = scheduleOptions.summaryKind;
			}
			clearTimer();
			timer = setTimeout(() => {
				timer = null;
				const next = takePending();
				if (next) void runSave(next.markdown, next.saveOptions);
			}, delayMs);
		},
		async flush() {
			clearTimer();
			const next = takePending();
			if (next) return runSave(next.markdown, next.saveOptions);
			return inFlight;
		},
		stop() {
			stopped = true;
			clearTimer();
			pending = null;
			pendingSummaryKind = undefined;
		},
		resume() {
			stopped = false;
		},
		get stopped() {
			return stopped;
		},
	};
}
