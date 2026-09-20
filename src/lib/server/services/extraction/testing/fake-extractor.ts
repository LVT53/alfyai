// A scripted extractor, so a test can drive every row of the state machine
// without a backend, a network or a real clock.
//
// It lives in `src/` rather than in a test file because more than one test file
// needs it and because the slices that come after this one will need it too —
// a fake that only exists inside one `.test.ts` gets copied, and copies drift.

import type {
	ExtractionErrorCode,
	ExtractionPhase,
} from "$lib/shared/extraction-status";
import type {
	DocumentExtractor,
	ExtractDocumentRequest,
	ExtractDocumentResult,
	ExtractionHandle,
} from "../contracts";
import { DocumentExtractionError } from "../contracts";

export type FakeExtractorStep =
	| {
			kind: "succeed";
			text?: string;
			afterMs?: number;
			phases?: ExtractionPhase[];
			pageCount?: number;
			structured?: unknown;
	  }
	| {
			kind: "throw";
			code: ExtractionErrorCode;
			retryable?: boolean;
			retryAfterMs?: number;
			handleUnknown?: boolean;
			afterMs?: number;
	  }
	/** Never resolves until the signal aborts. */
	| { kind: "hang" }
	/** Throws `protocol` + `handleUnknown` when handed a handle to resume. */
	| { kind: "forget-handle" };

export interface FakeExtractorScript {
	/** Per-attempt behaviour, consumed in order. The last step repeats. */
	steps: FakeExtractorStep[];
	/** Emit a handle as soon as this phase is reported. */
	emitHandleAfterPhase?: ExtractionPhase;
	name?: string;
	supportsResume?: boolean;
}

export interface FakeExtractorCall {
	resumed: boolean;
	handle: ExtractionHandle | null;
	request: ExtractDocumentRequest;
}

export type FakeExtractor = DocumentExtractor & {
	readonly calls: FakeExtractorCall[];
	readonly cancelCalls: ExtractionHandle[];
	/** Set to make `cancel` reject, proving a failing cancel never fails a job. */
	cancelShouldThrow: boolean;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(
					new DocumentExtractionError({
						code: "canceled",
						message: "Extraction was canceled.",
						retryable: false,
					}),
				);
			},
			{ once: true },
		);
	});
}

export function createFakeExtractor(
	script: FakeExtractorScript,
): FakeExtractor {
	const calls: FakeExtractorCall[] = [];
	const cancelCalls: ExtractionHandle[] = [];
	const name = script.name ?? "fake";
	let index = 0;

	const extractor: FakeExtractor = {
		name,
		supportsResume: script.supportsResume ?? true,
		calls,
		cancelCalls,
		cancelShouldThrow: false,

		async extract(
			request: ExtractDocumentRequest,
		): Promise<ExtractDocumentResult> {
			const resumeHandle = request.resumeHandle ?? null;
			calls.push({
				resumed: resumeHandle !== null,
				handle: resumeHandle,
				request,
			});

			const step = script.steps[Math.min(index, script.steps.length - 1)];
			index += 1;

			if (step.kind === "forget-handle") {
				if (resumeHandle) {
					throw new DocumentExtractionError({
						code: "protocol",
						message: "The backend no longer knows this job.",
						retryable: true,
						handleUnknown: true,
					});
				}
				return finish(request, { kind: "succeed" });
			}

			for (const phase of step.kind === "succeed"
				? (step.phases ?? (["uploading", "parsing", "downloading"] as const))
				: (["uploading", "parsing"] as const)) {
				request.onProgress({
					phase,
					handle:
						script.emitHandleAfterPhase === phase
							? { extractor: name, version: 1, remoteJobId: `remote-${phase}` }
							: undefined,
				});
			}

			// Phases are emitted BEFORE a hang, so a cancel test can wait for the
			// handle to be persisted and then cancel a job that is genuinely
			// mid-flight rather than one that never started.
			if (step.kind === "hang") {
				await new Promise<never>((_resolve, reject) => {
					request.signal.addEventListener(
						"abort",
						() =>
							reject(
								new DocumentExtractionError({
									code: "canceled",
									message: "Extraction was canceled.",
									retryable: false,
								}),
							),
						{ once: true },
					);
				});
				throw new Error("unreachable");
			}

			if (step.afterMs) {
				await sleep(step.afterMs, request.signal);
			}

			if (step.kind === "throw") {
				throw new DocumentExtractionError({
					code: step.code,
					message: `fake extractor threw ${step.code}`,
					retryable: step.retryable,
					retryAfterMs: step.retryAfterMs,
					handleUnknown: step.handleUnknown,
				});
			}

			return finish(request, step);
		},

		async cancel(handle: ExtractionHandle): Promise<void> {
			cancelCalls.push(handle);
			if (extractor.cancelShouldThrow) {
				throw new Error("fake remote cancel failed");
			}
		},
	};

	function finish(
		request: ExtractDocumentRequest,
		step: Extract<FakeExtractorStep, { kind: "succeed" }>,
	): ExtractDocumentResult {
		return {
			text: step.text ?? `extracted ${request.fileName}`,
			normalizedName: `${request.fileName}.md`,
			mimeType: "text/markdown",
			...(step.pageCount === undefined ? {} : { pageCount: step.pageCount }),
			...(step.structured === undefined ? {} : { structured: step.structured }),
			handle: { extractor: name, version: 1, remoteJobId: "remote-final" },
		};
	}

	return extractor;
}
