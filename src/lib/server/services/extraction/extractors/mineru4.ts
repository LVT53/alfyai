/**
 * The MinerU 4.x `DocumentExtractor`.
 *
 * This is the ONLY file outside `services/mineru/` that knows the V1 protocol
 * exists, and the only place Phase 3's extractor seam meets it. Everything it
 * does is sequencing: the protocol lives in `mineru/client.ts`, the taxonomy in
 * `mineru/errors.ts`, the tier policy in `mineru/tier-policy.ts`, the zip and
 * the parse model in `mineru/result.ts`, and the on-disk bundle in
 * `mineru/bundle.ts`.
 *
 * Five properties are load-bearing, in the order they matter:
 *
 *  1. **Nothing moves before the server has been asked what it can do.** The
 *     capability read resolves the tier and the output formats first, so
 *     "Tier 'standard' not available in this server" is a refusal, not a 400
 *     after a 40 MB upload. A capability read that comes back as a 4xx is how a
 *     deployment still pointing at MinerU 3.x announces itself, and it is
 *     NON-RETRYABLE: there is no dual-protocol fallback (D3), so retrying a
 *     server that does not speak V1 only delays the honest message.
 *  2. **The handle is emitted before the first poll.** A worker that dies
 *     between `POST /v1/parse/jobs` and the first `GET` must RESUME that job on
 *     the next attempt rather than submit a second one.
 *  3. **Ids are never trusted across a MinerU restart (D7).** Every
 *     upload/file/job id 404s after one; the bytes survive as content-addressed
 *     blobs. `job_not_found` / `file_not_found` / `upload_not_found` therefore
 *     mean "re-`POST /v1/uploads` with the known sha256 and take the NEW
 *     file_id", never "fail". `handleUnknown` is raised only where the merged
 *     error table raises it: a file-level `parse_failed` whose message says the
 *     file was not found.
 *  4. **Only the zip is downloaded**, into a per-attempt temp directory that is
 *     removed on every exit path — success, failure, cancel, throw.
 *  5. **The bundle is written here, while the zip still exists.** The zip is
 *     gone by the time `persist.ts` runs, so the extractor writes
 *     `<sourceArtifactId>.parse/` and hands the manifest forward on
 *     `result.structured`; `persist.ts` patches the normalized artifact id in
 *     afterwards.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	type MineruParseBundleManifest,
	writeMineruParseBundle,
} from "$lib/server/services/mineru/bundle";
import {
	getMineruCapabilities,
	type MineruProbeClient,
	MineruProbeError,
	setMineruProbeClientFactory,
} from "$lib/server/services/mineru/capabilities";
import { MineruClient } from "$lib/server/services/mineru/client";
import {
	MINERU_OUTPUT_FORMATS,
	type MineruConfig,
	mineruDisplayOrigin,
	resolveMineruConfig,
} from "$lib/server/services/mineru/config";
import {
	isMineruApiError,
	isMineruForgottenIdError,
	mapMineruJobFailure,
	mineruErrorToExtractionError,
} from "$lib/server/services/mineru/errors";
import {
	MineruResultError,
	parseMineruResultZip,
	type StructuredExtractionResult,
} from "$lib/server/services/mineru/result";
import type { MineruJob } from "$lib/server/services/mineru/schemas";
import {
	assertMineruOutputFormatsSupported,
	decideOcrMode,
	decideTier,
	isMineruTierId,
	type MineruTierId,
} from "$lib/server/services/mineru/tier-policy";
import { getIntakeTierHint } from "$lib/shared/file-types";
import type {
	DocumentExtractor,
	ExtractDocumentRequest,
	ExtractDocumentResult,
	ExtractionHandle,
} from "../contracts";
import {
	DocumentExtractionError,
	EXTRACTION_HANDLE_VERSION,
} from "../contracts";

export const MINERU4_EXTRACTOR_NAME = "mineru4";

const LOG_PREFIX = "[EXTRACTION]";

/** One recovery pass per attempt. A second would be a loop, not a recovery. */
const MAX_FORGOTTEN_ID_RECOVERIES = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// The hand-off to `persist.ts`
// ---------------------------------------------------------------------------

/**
 * What travels on `ExtractDocumentResult.structured`.
 *
 * It is a `StructuredExtractionResult` — flat, so `structured.outline`,
 * `structured.pageCount`, `structured.effectiveTier` and the rest read exactly
 * as §4.4/§4.5 of the spec writes them — PLUS the bundle manifest, which is the
 * only place `extractionBundleBytes` / `extractionImagesOmitted` /
 * `extractionFigureCount` can come from. `bundle` is null when the request
 * carried no `userId`/`sourceArtifactId` (a generated-file readback), in which
 * case no bundle was written and no bundle-derived metadata exists.
 *
 * The ledger never inspects it. `persist.ts` narrows it structurally rather
 * than importing this module, so no request path pays for `jszip`.
 */
export interface Mineru4StructuredPayload extends StructuredExtractionResult {
	bundle: MineruParseBundleManifest | null;
}

/** The narrowing `persist.ts` performs, exported so a test can prove it holds. */
export function isMineru4StructuredPayload(
	value: unknown,
): value is Mineru4StructuredPayload {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Mineru4StructuredPayload>;
	return (
		typeof candidate.parserVersion === "string" &&
		typeof candidate.markdown === "string" &&
		typeof candidate.pageCount === "number" &&
		Array.isArray(candidate.pages) &&
		Array.isArray(candidate.blocks) &&
		Array.isArray(candidate.outline)
	);
}

// ---------------------------------------------------------------------------
// The capability probe seam
// ---------------------------------------------------------------------------

/**
 * Routes `capabilities.ts`'s probe through the real protocol client.
 *
 * NOT a bare `new MineruClient({config})`, although the three method signatures
 * match: `capabilities.ts` recognises only its own `MineruProbeError` and maps
 * every other `Error` to `unavailable` (retryable), so a bare client would turn
 * a 404 from a MinerU 3.x server — the one failure that must be permanent —
 * into an outage that retries forever. Translating here keeps that file, which
 * this slice does not own, untouched.
 */
function createProbeClient(config: MineruConfig): MineruProbeClient {
	const client = new MineruClient({ config });
	const origin = mineruDisplayOrigin(config);

	async function guard<T>(
		path: "/v1/health" | "/v1/tiers" | "/v1/usage",
		run: () => Promise<T>,
	): Promise<T> {
		try {
			return await run();
		} catch (error) {
			throw toProbeError(error, path, origin);
		}
	}

	return {
		getHealth: (signal) => guard("/v1/health", () => client.getHealth(signal)),
		getTiers: (signal) => guard("/v1/tiers", () => client.getTiers(signal)),
		getUsage: (signal) => guard("/v1/usage", () => client.getUsage(signal)),
	};
}

/**
 * A 4xx on `/v1/health` is the MinerU 3.x signature: the 3.x server has no
 * `/v1` namespace at all, so the probe gets a 404 rather than a version. Saying
 * so by name is the difference between an admin reading "unreachable" and an
 * admin reading "this is not a MinerU 4 server".
 */
function toProbeError(
	error: unknown,
	path: string,
	origin: string,
): MineruProbeError {
	if (error instanceof MineruProbeError) return error;

	const mapping = mineruErrorToExtractionError(error);
	if (
		path === "/v1/health" &&
		mapping.code === "protocol" &&
		isMineruApiError(error) &&
		error.status !== null &&
		error.status >= 400 &&
		error.status < 500
	) {
		return new MineruProbeError(
			"protocol",
			`${origin} answered ${error.status} for /v1/health, so it is not a MinerU 4 server. MinerU 3.x is no longer supported; point MINERU_API_URL at a MinerU 4 endpoint.`,
		);
	}
	return new MineruProbeError(mapping.code, mapping.message);
}

let probeFactoryInstalled = false;

/**
 * Installed at module init, as the S0 hand-off asks. Idempotent so an HMR
 * re-evaluation cannot leave two factories fighting over the same cache.
 */
export function installMineruProbeClientFactory(): void {
	if (probeFactoryInstalled) return;
	probeFactoryInstalled = true;
	setMineruProbeClientFactory((config) => createProbeClient(config));
}

installMineruProbeClientFactory();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `<stem>.md` — verbatim from the retired 3.x client, unchanged output. */
export function toNormalizedName(originalName: string): string {
	const stem = basename(originalName, extname(originalName));
	return `${stem || "document"}.md`;
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw canceledError();
}

function canceledError(): DocumentExtractionError {
	return new DocumentExtractionError({
		code: "canceled",
		message: "Extraction was canceled.",
		retryable: false,
	});
}

/** Structural, for the same reason `contracts.ts` gives. */
function isAbortLike(error: unknown): boolean {
	const name = (error as { name?: unknown } | null)?.name;
	return name === "AbortError";
}

/**
 * A capability read that failed.
 *
 * `protocol` is forced non-retryable here, against the taxonomy's default:
 * every way a *capability read* produces `protocol` is a permanent statement
 * about the endpoint — a 4xx, a body that is not JSON, a server without
 * `/v1/health`. The spec's own fallback for an unclassified 4xx
 * (`errors.ts` `fallback:4xx`) is `protocol`, non-retryable, for exactly this
 * reason. `unavailable` (connection refused) stays retryable, because that one
 * really is an outage.
 */
function probeFailureToExtractionError(
	error: MineruProbeError,
): DocumentExtractionError {
	return new DocumentExtractionError({
		code: error.code,
		message: error.message,
		retryable: error.code === "protocol" ? false : undefined,
		details: { stage: "capabilities" },
		cause: error,
	});
}

function resultErrorToExtractionError(
	error: MineruResultError,
): DocumentExtractionError {
	return new DocumentExtractionError({
		code: error.taxonomy,
		message: error.message,
		retryable: error.retryable,
		details: { mineruResultCode: error.code, ...error.details },
		cause: error,
	});
}

/** The re-extract override (§4.10), read defensively out of opaque hints. */
export function readHintedTier(
	hints: Readonly<Record<string, unknown>> | null | undefined,
): MineruTierId | null {
	const raw = hints?.tier;
	return typeof raw === "string" && isMineruTierId(raw) ? raw : null;
}

interface HandleState {
	remoteJobId: string | null;
	remoteFileId: string | null;
	uploadId: string | null;
	outputZipFileId: string | null;
	requestedTier: MineruTierId | null;
}

function emptyHandleState(): HandleState {
	return {
		remoteJobId: null,
		remoteFileId: null,
		uploadId: null,
		outputZipFileId: null,
		requestedTier: null,
	};
}

function toHandle(state: HandleState, sha256: string): ExtractionHandle {
	return {
		extractor: MINERU4_EXTRACTOR_NAME,
		version: EXTRACTION_HANDLE_VERSION,
		remoteJobId: state.remoteJobId,
		remoteFileId: state.remoteFileId,
		data: {
			uploadId: state.uploadId,
			sha256,
			outputZipFileId: state.outputZipFileId,
			requestedTier: state.requestedTier,
		},
	};
}

function readHandleState(handle: ExtractionHandle | null | undefined): {
	state: HandleState;
	sha256: string | null;
} {
	const state = emptyHandleState();
	if (!handle) return { state, sha256: null };

	state.remoteJobId = handle.remoteJobId ?? null;
	state.remoteFileId = handle.remoteFileId ?? null;

	const data = handle.data ?? {};
	if (typeof data.uploadId === "string") state.uploadId = data.uploadId;
	if (typeof data.outputZipFileId === "string") {
		state.outputZipFileId = data.outputZipFileId;
	}
	if (
		typeof data.requestedTier === "string" &&
		isMineruTierId(data.requestedTier)
	) {
		state.requestedTier = data.requestedTier;
	}
	const sha = typeof data.sha256 === "string" ? data.sha256 : null;
	return { state, sha256: sha && SHA256_PATTERN.test(sha) ? sha : null };
}

/** The zip output ref on a terminal, usable job. */
function zipOutput(job: MineruJob): { file_id: string; bytes: number } {
	const ref = job.files[0]?.output_files?.zip;
	if (!ref) {
		// Unreachable: `mapMineruJobFailure` already refuses a completed job
		// without the requested output. Kept so a future change cannot make the
		// null deref the first thing anyone notices.
		throw new DocumentExtractionError({
			code: "protocol",
			message: "MinerU reported a completed job without a result zip.",
			retryable: true,
		});
	}
	return ref;
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export interface Mineru4ExtractorOptions {
	/** Test seam. Defaults to a client built from `resolveMineruConfig()`. */
	createClient?: (config: MineruConfig) => MineruClient;
	/** Test seam. Defaults to `resolveMineruConfig()`. */
	resolveConfig?: () => MineruConfig;
	/**
	 * Where the per-attempt download directory is created. Defaults to the OS
	 * temp directory. A test seam, so a test can assert the directory is gone
	 * without racing every other process that writes to `/tmp`.
	 */
	tempDirRoot?: string;
	now?: () => number;
}

export function createMineru4Extractor(
	options: Mineru4ExtractorOptions = {},
): DocumentExtractor {
	const resolveConfig = options.resolveConfig ?? (() => resolveMineruConfig());
	const createClient =
		options.createClient ??
		((config: MineruConfig) => new MineruClient({ config }));
	const now = options.now ?? Date.now;

	async function cancelRemoteJob(
		client: MineruClient,
		jobId: string | null,
	): Promise<void> {
		if (!jobId) return;
		try {
			// A fresh signal on purpose: the caller's is already aborted, and a
			// cancel issued on an aborted signal cancels nothing.
			await client.cancelJob({ jobId, signal: AbortSignal.timeout(5_000) });
		} catch (error) {
			console.warn(`${LOG_PREFIX} MinerU job cancel failed`, {
				extractor: MINERU4_EXTRACTOR_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		name: MINERU4_EXTRACTOR_NAME,
		supportsResume: true,

		async extract(
			request: ExtractDocumentRequest,
		): Promise<ExtractDocumentResult> {
			assertNotAborted(request.signal);

			const config = resolveConfig();
			const client = createClient(config);
			const deadlineAt = now() + config.jobTimeoutMs;

			// -- 1. capabilities, before a byte moves --------------------------
			let capabilities: Awaited<ReturnType<typeof getMineruCapabilities>>;
			try {
				// The config is passed explicitly so one attempt reads the runtime
				// configuration exactly once, rather than letting the cache probe
				// re-read it and possibly disagree with the client beside it.
				capabilities = await getMineruCapabilities(request.signal, {
					config,
				});
			} catch (error) {
				if (isAbortLike(error)) throw canceledError();
				if (error instanceof MineruProbeError) {
					throw probeFailureToExtractionError(error);
				}
				throw mineruErrorToExtractionError(error, {
					context: "MinerU capability read failed",
				});
			}

			// -- 2. tier and formats, before a byte moves ----------------------
			let tier: MineruTierId | undefined;
			try {
				assertMineruOutputFormatsSupported(
					MINERU_OUTPUT_FORMATS,
					capabilities.outputFormats,
				);
				const decision = decideTier({
					intakeTierHint:
						getIntakeTierHint(request.fileName, request.mimeType) ?? null,
					configuredTier: config.defaultTier,
					availableTiers: capabilities.tiers,
					hintedTier: readHintedTier(request.hints),
				});
				tier = decision.tier;
				console.info(`${LOG_PREFIX} MinerU tier decided`, {
					extractor: MINERU4_EXTRACTOR_NAME,
					tier: decision.tier ?? null,
					reason: decision.reason,
				});
			} catch (error) {
				throw mineruErrorToExtractionError(error, {
					context: "MinerU cannot run this document",
				});
			}
			const ocrMode = decideOcrMode(config.ocrMode);

			// -- 3. the digest: reuse the ledger's, compute only when absent ---
			const supplied = request.contentSha256?.trim().toLowerCase() ?? "";
			const resumed = readHandleState(request.resumeHandle);
			let sha256 = SHA256_PATTERN.test(supplied) ? supplied : resumed.sha256;
			if (!sha256) {
				assertNotAborted(request.signal);
				sha256 = await client.sha256(request.filePathAbsolute);
			}

			const state = resumed.state;
			state.requestedTier = tier ?? state.requestedTier;

			// The temp directory is per ATTEMPT and is removed on every exit path.
			let tempDir: string | null = null;
			let canceledByUs = false;

			// A phase is never reported BACKWARDS.
			//
			// The ledger's state machine refuses `parsing → uploading`, and the
			// worker reads that refusal as "this attempt lost its claim" and aborts
			// the signal — which a restart recovery would otherwise trigger on
			// itself, turning a recoverable server restart into a canceled
			// document. Re-submitting after a forgotten id genuinely does upload
			// again, but the JOB has not gone backwards, so the report is clamped
			// to the furthest phase this attempt has already announced. Repeating a
			// phase is legal and is a pure heartbeat.
			const PHASE_ORDER = { uploading: 0, parsing: 1, downloading: 2 } as const;
			let reported: keyof typeof PHASE_ORDER | null = null;

			const emit = (
				phase: keyof typeof PHASE_ORDER,
				withHandle: boolean,
			): void => {
				const effective =
					reported && PHASE_ORDER[reported] > PHASE_ORDER[phase]
						? reported
						: phase;
				reported = effective;
				request.onProgress({
					phase: effective,
					...(withHandle ? { handle: toHandle(state, sha256 as string) } : {}),
				});
			};

			async function submitFresh(): Promise<void> {
				emit("uploading", false);
				assertNotAborted(request.signal);

				const { size } = await client.statFile(request.filePathAbsolute);
				const upload = await client.createUpload({
					filename: request.fileName,
					bytes: size,
					mimeType: request.mimeType ?? "application/octet-stream",
					sha256sum: sha256 as string,
					signal: request.signal,
				});
				state.uploadId = upload.id;

				let fileId = upload.file?.id ?? null;
				if (upload.status !== "completed" || !fileId) {
					// A fresh upload: PUT the bytes, then finalise. A dedupe hit skips
					// both — the bytes are already there under this sha256, which is
					// also what makes restart recovery free.
					await client.putUploadContent({
						upload,
						filePathAbsolute: request.filePathAbsolute,
						signal: request.signal,
					});
					const completed = await client.completeUpload({
						uploadId: upload.id,
						sha256sum: sha256 as string,
						signal: request.signal,
					});
					fileId = completed.file?.id ?? null;
				}

				if (!fileId) {
					throw new DocumentExtractionError({
						code: "protocol",
						message: "MinerU completed an upload without returning a file id.",
						retryable: true,
					});
				}
				state.remoteFileId = fileId;

				const job = await client.createJob({
					fileId,
					...(tier === undefined ? {} : { tier }),
					...(ocrMode === undefined ? {} : { ocrMode }),
					outputFormats: MINERU_OUTPUT_FORMATS,
					signal: request.signal,
				});
				state.remoteJobId = job.job_id;
				state.outputZipFileId = null;

				// BEFORE the first poll: a worker that dies here must resume this
				// job, not submit a second one.
				emit("parsing", true);
			}

			async function runOnce(): Promise<ExtractDocumentResult> {
				if (state.remoteJobId) {
					// Resuming. Announce ownership of the existing job before polling
					// it, so the ledger's status and handle are current either way.
					emit("parsing", true);
					// A forgotten id surfaces here and is handled by the caller.
					await client.getJob({
						jobId: state.remoteJobId,
						signal: request.signal,
					});
				} else {
					await submitFresh();
				}

				const jobId = state.remoteJobId as string;
				const remaining = deadlineAt - now();
				if (remaining <= 0) {
					await cancelRemoteJob(client, jobId);
					throw new DocumentExtractionError({
						code: "timeout",
						message: `MinerU job ${jobId} exceeded the ${config.jobTimeoutMs}ms deadline.`,
						retryable: true,
					});
				}

				let job: MineruJob;
				try {
					job = await client.pollJob({
						jobId,
						signal: request.signal,
						deadlineMs: remaining,
					});
				} catch (error) {
					if (
						isMineruApiError(error) &&
						error.code === "client_job_deadline_exceeded"
					) {
						// The remote is still working on something nobody will read.
						await cancelRemoteJob(client, jobId);
					}
					throw error;
				}

				const failure = mapMineruJobFailure(job, { canceledByUs });
				if (failure) {
					throw new DocumentExtractionError({
						code: failure.taxonomy,
						message: `MinerU job ${jobId} failed: ${
							job.files[0]?.error?.message ?? failure.reason
						}`,
						retryable: failure.retryable,
						handleUnknown: failure.handleUnknown,
						details: { mineruRule: failure.rule, jobStatus: job.status },
					});
				}

				const output = zipOutput(job);
				state.outputZipFileId = output.file_id;
				emit("downloading", true);

				tempDir ??= await mkdtemp(
					join(options.tempDirRoot ?? tmpdir(), "alfyai-mineru4-"),
				);
				const zipPathAbsolute = join(tempDir, "result.zip");
				await client.downloadFile({
					fileId: output.file_id,
					destinationPathAbsolute: zipPathAbsolute,
					expectedBytes: output.bytes,
					signal: request.signal,
				});

				let parsed: Awaited<ReturnType<typeof parseMineruResultZip>>;
				try {
					parsed = await parseMineruResultZip({
						zipPathAbsolute,
						jobTier: job.tier,
						serverParserVersion: job.files[0]?.parse?.parser_version ?? null,
						sourceFilename: request.fileName,
						sourceMimeType: request.mimeType,
					});
				} catch (error) {
					if (error instanceof MineruResultError) {
						throw resultErrorToExtractionError(error);
					}
					throw error;
				}

				// The zip is deleted with the temp directory the moment this call
				// returns, so the bundle has to be written here rather than in
				// `persist.ts`.
				let manifest: MineruParseBundleManifest | null = null;
				if (request.userId && request.sourceArtifactId) {
					manifest = await writeMineruParseBundle({
						userId: request.userId,
						sourceArtifactId: request.sourceArtifactId,
						zipPathAbsolute,
						result: parsed.result,
						maxBytes: config.bundleMaxBytes,
					});
				}

				const structured: Mineru4StructuredPayload = {
					...parsed.result,
					bundle: manifest,
				};

				return {
					text: parsed.result.markdown,
					normalizedName: toNormalizedName(request.fileName),
					mimeType: "text/markdown",
					pageCount: parsed.result.pageCount,
					handle: toHandle(state, sha256 as string),
					structured,
				};
			}

			try {
				let recoveries = 0;
				for (;;) {
					try {
						return await runOnce();
					} catch (error) {
						if (isAbortLike(error) || request.signal.aborted) throw error;
						if (
							isMineruForgottenIdError(error) &&
							recoveries < MAX_FORGOTTEN_ID_RECOVERIES
						) {
							// D7: the server restarted. Every id is gone; the bytes are
							// not. Forget them and submit again — `createUpload` with the
							// same sha256 answers `completed` with a NEW file_id, so this
							// costs one round trip, not a re-upload.
							recoveries += 1;
							console.info(`${LOG_PREFIX} MinerU forgot an id, recovering`, {
								extractor: MINERU4_EXTRACTOR_NAME,
								mineruCode: isMineruApiError(error) ? error.code : null,
							});
							state.remoteJobId = null;
							state.remoteFileId = null;
							state.uploadId = null;
							state.outputZipFileId = null;
							continue;
						}
						throw error;
					}
				}
			} catch (error) {
				if (isAbortLike(error) || request.signal.aborted) {
					canceledByUs = true;
					await cancelRemoteJob(client, state.remoteJobId);
					throw canceledError();
				}
				if (error instanceof DocumentExtractionError) throw error;
				if (error instanceof MineruResultError) {
					throw resultErrorToExtractionError(error);
				}
				throw mineruErrorToExtractionError(error, {
					context: "MinerU extraction failed",
					details: { fileName: undefined },
				});
			} finally {
				if (tempDir) {
					await rm(tempDir, { recursive: true, force: true }).catch(
						() => undefined,
					);
				}
			}
		},

		/** Best effort remote cleanup on a user cancel. Must never throw. */
		async cancel(
			handle: ExtractionHandle,
			signal?: AbortSignal,
		): Promise<void> {
			const { state } = readHandleState(handle);
			if (!state.remoteJobId) return;
			try {
				const client = createClient(resolveConfig());
				await client.cancelJob({
					jobId: state.remoteJobId,
					signal: signal ?? AbortSignal.timeout(5_000),
				});
			} catch (error) {
				console.warn(`${LOG_PREFIX} MinerU cancel failed`, {
					extractor: MINERU4_EXTRACTOR_NAME,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

export const mineru4Extractor: DocumentExtractor = createMineru4Extractor();
