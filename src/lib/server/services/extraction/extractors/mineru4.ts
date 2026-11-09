/**
 * The MinerU 4.1 `DocumentExtractor`.
 *
 * This is the ONLY file outside `services/mineru/` that knows the `/v1/tasks`
 * protocol exists, and the only place the extractor seam meets it. Everything it
 * does is sequencing: the protocol lives in `mineru/client.ts`, the taxonomy in
 * `mineru/errors.ts`, the tier policy in `mineru/tier-policy.ts`, the zip and
 * the parse model in `mineru/result.ts`, and the on-disk bundle in
 * `mineru/bundle.ts`.
 *
 * One attempt is one task with one file (S2): create it, PUT the bytes if the
 * receipt hands out an upload link (a hash-cache hit does not), poll it, download
 * the one ZIP, write the bundle. Eight properties are load-bearing, in the order
 * they matter:
 *
 *  1. **Nothing is asked for before the server has been asked what it can do.**
 *     The capability read resolves "auto" to a tier (S4), and refuses a server
 *     that speaks an older protocol (4.0.x answers health like a healthy server
 *     and then answers our manifest with a 400). A capability read that comes
 *     back as `backend_misconfigured` is how a deployment pointing at something
 *     that is not MinerU 4 announces itself, and it is NON-RETRYABLE: there is no
 *     dual-protocol fallback (S1), so retrying only delays the honest message.
 *  2. **The handle is emitted as soon as the remote task exists**, before the
 *     PUT and so before the first poll. A worker that dies between
 *     `POST /v1/tasks` and the first `GET` must RESUME that task on the next
 *     attempt (re-sending the bytes if they never landed) rather than create a
 *     second one; the server keeps an unfinished upload link for an hour.
 *  3. **Ids are never trusted across a MinerU restart (S6).** A restart forgets
 *     every task, every file and the hash cache. `task_not_found`,
 *     `file_not_found`, `upload_not_found` and `upload_expired` therefore mean
 *     "create the task again and upload again", never "fail", and the recovery is
 *     bounded: a server that forgets every time ends in a retryable failure, not
 *     a loop. The same goes for a task that is still waiting for bytes that will
 *     not come, and for a file that no longer matches what the task declared.
 *  4. **Another protocol's voice is an outage, not a verdict (S6, R14).** The
 *     seconds between a deploy and the URL flip meet a 4.0.12 that refuses our
 *     manifest in its own error shape. That is `unavailable`: the patient outage
 *     walk carries the document across, and the handle is kept.
 *  5. **A settled task is spent.** Whatever a finished task failed on, it cannot
 *     change its mind: the error says so (`handleUnknown`) and the ledger clears
 *     the handle, so the next attempt creates a fresh task instead of resuming a
 *     dead one. Resuming survives only where the remote task is still alive: a
 *     lost claim, a stale-worker reclaim, a shutdown, a transport error.
 *  6. **MinerU's own words are an operator's.** `files[].error.message` and the
 *     validation dumps travel in `details`, never in the sentence a person reads;
 *     that sentence comes from the taxonomy code (`extractionErrorMessage`).
 *  7. **Only the ZIP is downloaded**, into a per-attempt temp directory that is
 *     removed on every exit path: success, failure, cancel, throw.
 *  8. **The bundle is written here, while the zip still exists.** The zip is
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
	MineruProbeError,
	setMineruProbeClientFactory,
} from "$lib/server/services/mineru/capabilities";
import { MineruClient } from "$lib/server/services/mineru/client";
import {
	type MineruConfig,
	resolveMineruConfig,
} from "$lib/server/services/mineru/config";
import {
	isMineruApiError,
	isMineruForgottenIdError,
	MINERU_CLIENT_ERROR_CODES,
	MineruApiError,
	mapMineruTaskFailure,
	mineruErrorToExtractionError,
	mineruWaitingUpload,
	pickMineruTaskFile,
	redactMineruSecrets,
	truncateMineruBody,
} from "$lib/server/services/mineru/errors";
import {
	MineruResultError,
	parseMineruResultZip,
	type StructuredExtractionResult,
} from "$lib/server/services/mineru/result";
import type {
	MineruTaskDetail,
	MineruUploadLink,
} from "$lib/server/services/mineru/schemas";
import { scheduleMineruTempSweep } from "$lib/server/services/mineru/temp-sweep";
import {
	decideOcrMode,
	decideTier,
	isMineruTierId,
	type MineruTierId,
} from "$lib/server/services/mineru/tier-policy";
import {
	fileExtension,
	getIntakeTierHint,
	resolveEntry,
} from "$lib/shared/file-types";
import type {
	DocumentExtractor,
	ExtractDocumentRequest,
	ExtractDocumentResult,
	ExtractionHandle,
} from "../contracts";
import {
	abortDiscardsRemoteWork,
	DocumentExtractionError,
	EXTRACTION_HANDLE_VERSION,
	extractionErrorMessage,
} from "../contracts";

export const MINERU4_EXTRACTOR_NAME = "mineru4";

const LOG_PREFIX = "[EXTRACTION]";

/**
 * One time per attempt a task may be created again because the server forgot it,
 * or because it can never get its bytes. A second would be a loop, not a
 * recovery: past this the failure is the ledger's to retry, with its own budget.
 */
const MAX_RECREATES = 1;

/**
 * One time per attempt a waiting task is sent its bytes again with the link it
 * hands out. If the file is still waiting after that, the task is not worth more
 * of this attempt.
 */
const MAX_REUPLOADS = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Written into the handle's `data`, and required to read one back.
 *
 * A handle the 4.0 client stored names a job and an upload of a protocol that no
 * longer exists, and 4.1 ids look the same (`job_…`, `file-…`): resuming one
 * would poll a stranger's task, or ask an old server for it. Anything without
 * this mark is not ours to resume.
 */
const HANDLE_PROTOCOL = "tasks/1";

// ---------------------------------------------------------------------------
// The hand-off to `persist.ts`
// ---------------------------------------------------------------------------

/**
 * What travels on `ExtractDocumentResult.structured`.
 *
 * It is a `StructuredExtractionResult`, flat, so `structured.outline`,
 * `structured.pageCount`, `structured.effectiveTier` and the rest read exactly
 * as §4.4/§4.5 of the spec writes them, PLUS the bundle manifest, which is the
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

let probeFactoryInstalled = false;

/**
 * Installed at module init, as the S0 hand-off asks. Idempotent so an HMR
 * re-evaluation cannot leave two factories fighting over the same cache.
 *
 * A BARE client, with no translating adapter: the probe runs every failure
 * through `mapMineruError` itself and names the "not a MinerU 4 server" case, so
 * the built-in fetch probe behind the admin card gets the same verdicts as this
 * one instead of a second opinion.
 */
export function installMineruProbeClientFactory(): void {
	if (probeFactoryInstalled) return;
	probeFactoryInstalled = true;
	setMineruProbeClientFactory((config) => new MineruClient({ config }));
}

installMineruProbeClientFactory();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `<stem>.md`, verbatim from the retired 3.x client, unchanged output. */
export function toNormalizedName(originalName: string): string {
	const stem = basename(originalName, extname(originalName));
	return `${stem || "document"}.md`;
}

/**
 * The name MinerU is told the file has (S3): `document.<ext>`, with the
 * registry's extension for the type, never the user's own.
 *
 * 4.1 refuses `/`, `\`, `:` and control characters in a name, routes by the
 * extension, and keeps the rest byte for byte (D17, D18), so a Mac name with a
 * colon would be a 400 and a user's name is none of MinerU's business. The
 * extension is the registry's (`photo.JPEG` and `scan.jfif` are both `jpg`),
 * and where the registry says MinerU reads another spelling of the type than
 * its canonical one (`intake.remoteExtension`: a TIFF is told .tiff, which
 * MinerU accepts, and not the canonical .tif, which it has never accepted),
 * that one. A file the registry does not know keeps its own extension, if it is
 * a plain word, and otherwise goes without one.
 */
export function canonicalTaskFileName(
	fileName: string,
	mimeType: string | null,
): string {
	const entry = resolveEntry(fileName, mimeType);
	const own = fileExtension(fileName);
	const extension =
		entry?.intake.remoteExtension ??
		entry?.extensions[0] ??
		(/^[a-z0-9]{1,16}$/.test(own) ? own : "");
	return extension ? `document.${extension}` : "document";
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw canceledError();
}

function canceledError(): DocumentExtractionError {
	return new DocumentExtractionError({
		code: "canceled",
		message: extractionErrorMessage("canceled", "Extraction was canceled."),
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
 * about the endpoint (a 4xx, a body that is not JSON, a server without
 * `/v1/health`). The spec's own fallback for an unclassified 4xx
 * (`errors.ts` `fallback:4xx`) is `protocol`, non-retryable, for exactly this
 * reason. `unavailable` (connection refused, a 4.0.x answering health) stays
 * retryable, because that one really is an outage, or about to end.
 */
function probeFailureToExtractionError(
	error: MineruProbeError,
): DocumentExtractionError {
	return new DocumentExtractionError({
		code: error.code,
		// `backend_misconfigured` carries the endpoint and the fix, which is more
		// useful than the generic sentence; everything else takes the code's.
		message:
			error.code === "backend_misconfigured"
				? error.message
				: extractionErrorMessage(error.code, error.message),
		retryable: error.code === "protocol" ? false : undefined,
		details: { stage: "capabilities", rawMessage: error.message },
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

/**
 * The SOFT tier preference (Phase 6 D10), read the same defensive way.
 *
 * A separate key from `tier` on purpose: this one degrades when the server does
 * not offer the tier, and conflating them would turn a generated-file readback
 * into a permanent `tier_unavailable` failure the moment a server dropped
 * `flash`.
 */
export function readPreferredTier(
	hints: Readonly<Record<string, unknown>> | null | undefined,
): MineruTierId | null {
	const raw = hints?.preferredTier;
	return typeof raw === "string" && isMineruTierId(raw) ? raw : null;
}

interface HandleState {
	/** The task id. */
	remoteJobId: string | null;
	/** The id of the one file in it. */
	remoteFileId: string | null;
	requestedTier: MineruTierId | null;
}

function emptyHandleState(): HandleState {
	return { remoteJobId: null, remoteFileId: null, requestedTier: null };
}

function toHandle(state: HandleState, sha256: string): ExtractionHandle {
	return {
		extractor: MINERU4_EXTRACTOR_NAME,
		version: EXTRACTION_HANDLE_VERSION,
		remoteJobId: state.remoteJobId,
		remoteFileId: state.remoteFileId,
		data: {
			protocol: HANDLE_PROTOCOL,
			sha256,
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

	const data = handle.data ?? {};
	// Not one of ours (the 4.0 client's, or no protocol at all): nothing in it is
	// worth resuming, and its digest is not worth trusting either.
	if (data.protocol !== HANDLE_PROTOCOL) return { state, sha256: null };

	// A task and a file, or neither: half a handle names nothing.
	if (handle.remoteJobId && handle.remoteFileId) {
		state.remoteJobId = handle.remoteJobId;
		state.remoteFileId = handle.remoteFileId;
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

/**
 * The task we hold cannot go on and must be created again, from a fresh look at
 * the file when `rehash` says the file itself is what changed. Never leaves this
 * module: the recovery loop turns it back into `cause` once it has no recovery
 * left to spend.
 */
class StaleTask extends Error {
	readonly name = "StaleTask";
	readonly cause: unknown;
	readonly rehash: boolean;
	readonly reason: string;

	constructor(reason: string, cause: unknown, rehash = false) {
		super(reason);
		this.cause = cause;
		this.rehash = rehash;
		this.reason = reason;
	}
}

/** The PUT said the bytes are not the bytes the task declared. */
function isUploadMismatch(error: unknown): boolean {
	return (
		isMineruApiError(error) &&
		(error.code === "upload_size_mismatch" ||
			error.code === "file_hash_mismatch")
	);
}

function isDeadlineError(error: unknown): boolean {
	return (
		isMineruApiError(error) &&
		error.code === MINERU_CLIENT_ERROR_CODES.jobDeadline
	);
}

function isFileWaitingError(error: unknown): boolean {
	return (
		isMineruApiError(error) &&
		error.code === MINERU_CLIENT_ERROR_CODES.fileWaitingForBytes
	);
}

/** What an operator may read of MinerU's own words: scrubbed and cut. */
function forOperators(text: string, apiKey: string): string {
	return truncateMineruBody(redactMineruSecrets(text, apiKey));
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

	async function cancelRemoteTask(
		client: MineruClient,
		taskId: string | null,
	): Promise<void> {
		if (!taskId) return;
		try {
			// A fresh signal on purpose: the caller's is already aborted, and a
			// cancel issued on an aborted signal cancels nothing. A task that already
			// ended (409) or that the server forgot (404) resolves to null: the goal
			// is met either way.
			await client.cancelTask({ taskId, signal: AbortSignal.timeout(5_000) });
		} catch (error) {
			console.warn(`${LOG_PREFIX} MinerU task cancel failed`, {
				extractor: MINERU4_EXTRACTOR_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		name: MINERU4_EXTRACTOR_NAME,
		supportsResume: true,
		// `extract` cancels the remote task itself when the abort says
		// `user-cancel` (see the catch below), so the worker must not do it again.
		cancelsOnAbort: true,

		async extract(
			request: ExtractDocumentRequest,
		): Promise<ExtractDocumentResult> {
			assertNotAborted(request.signal);

			// Debris from a process that was KILLED. Every ordinary exit path
			// removes the per-attempt download directory and the half-written
			// bundle; a SIGKILL removes neither, and the bundle temp directory in
			// particular is inside `data/`, is up to MINERU_BUNDLE_MAX_BYTES, and
			// is deliberately skipped by the orphan report so nothing even names
			// it. Throttled to once per six hours per process, age-gated well past
			// any live job, and fire-and-forget: it must never delay an extraction.
			scheduleMineruTempSweep(
				options.tempDirRoot ? { tempRootAbsolute: options.tempDirRoot } : {},
			);

			const config = resolveConfig();
			// Annotated so Fallow can tell this is a MineruClient: it does not follow the
			// return type of `createClient`, and `statFile` is called here and nowhere else.
			const client: MineruClient = createClient(config);
			// The whole attempt, upload through download. The default is five minutes:
			// the first Standard job after a MinerU start takes about 8 s and the first
			// Basic about 10 s more (spike section 5), so anything above a minute has
			// room for a cold start and a poll or two on top of it.
			const deadlineAt = now() + config.jobTimeoutMs;

			// -- 1. capabilities, before anything is asked for -------------------
			let capabilities: Awaited<ReturnType<typeof getMineruCapabilities>>;
			try {
				// The config is passed explicitly so one attempt reads the runtime
				// configuration exactly once, rather than letting the cache probe
				// re-read it and possibly disagree with the client beside it.
				capabilities = await getMineruCapabilities(request.signal, { config });
			} catch (error) {
				if (isAbortLike(error)) throw canceledError();
				if (error instanceof MineruProbeError) {
					throw probeFailureToExtractionError(error);
				}
				throw mineruErrorToExtractionError(error, {
					context: "MinerU capability read failed",
				});
			}

			// -- 2. the tier and the name, before anything is asked for ----------
			let tier: MineruTierId | undefined;
			try {
				const decision = decideTier({
					intakeTierHint:
						getIntakeTierHint(request.fileName, request.mimeType) ?? null,
					configuredTier: config.defaultTier,
					availableTiers: capabilities.tiers,
					hintedTier: readHintedTier(request.hints),
					preferredTier: readPreferredTier(request.hints),
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
			const taskFileName = canonicalTaskFileName(
				request.fileName,
				request.mimeType,
			);

			// -- 3. the digest: reuse the ledger's, compute only when absent -----
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

			// A phase is never reported BACKWARDS.
			//
			// The ledger's state machine refuses `parsing → uploading`, and the worker
			// reads that refusal as "this attempt lost its claim" and aborts the
			// signal, which a restart recovery would otherwise trigger on itself,
			// turning a recoverable server restart into a canceled document.
			// Creating the task again after a forgotten id genuinely does upload
			// again, but the JOB has not gone backwards, so the report is clamped to
			// the furthest phase this attempt has already announced. Repeating a
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

			/** The bytes, to the link a task hands out. A mismatch is a stale task. */
			async function putBytes(upload: MineruUploadLink): Promise<void> {
				try {
					await client.putTaskFile({
						upload,
						filePathAbsolute: request.filePathAbsolute,
						signal: request.signal,
					});
				} catch (error) {
					// 400 `upload_size_mismatch` / `file_hash_mismatch`: the file on
					// disk is not what the task declared, the task stays waiting (D13)
					// and the same link refuses the same bytes again. Declare it again.
					if (isUploadMismatch(error)) {
						throw new StaleTask("upload-refused", error, true);
					}
					throw error;
				}
			}

			/** Create the task (S2, S3, S4, S5), hand over the bytes if asked for them. */
			async function submitFresh(rehash: boolean): Promise<void> {
				emit("uploading", false);
				assertNotAborted(request.signal);

				// What the task declares is what the file is NOW, not what the ledger
				// remembers: after a refused upload, a fresh stat and a fresh digest.
				if (rehash) sha256 = await client.sha256(request.filePathAbsolute);
				const { size } = await client.statFile(request.filePathAbsolute);
				if (size <= 0) {
					// A task of zero bytes is a 400 (D22), and the server's refusal would
					// read as a fault of the service. The file is empty; say so.
					throw new DocumentExtractionError({
						code: "empty_result",
						message: extractionErrorMessage(
							"empty_result",
							"The file is empty.",
						),
						retryable: false,
					});
				}

				let receipt: Awaited<ReturnType<MineruClient["createTask"]>>;
				try {
					receipt = await client.createTask({
						fileName: taskFileName,
						bytes: size,
						sha256sum: sha256 as string,
						...(tier === undefined ? {} : { tier }),
						...(ocrMode === undefined ? {} : { ocrMode }),
						signal: request.signal,
					});
				} catch (error) {
					// 400 `upload_size_mismatch` at create: the declared size contradicts
					// the bytes the hash cache holds for that digest, so the file is not
					// the one the ledger hashed. Look at it again.
					if (isUploadMismatch(error)) {
						throw new StaleTask("declaration-refused", error, true);
					}
					throw error;
				}

				const file = receipt.files[0];
				if (!file) {
					throw new MineruApiError({
						code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
						message: "MinerU answered a task without its file.",
						requestPath: "/v1/tasks",
					});
				}
				state.remoteJobId = receipt.task_id;
				state.remoteFileId = file.file_id;
				console.info(`${LOG_PREFIX} MinerU task created`, {
					extractor: MINERU4_EXTRACTOR_NAME,
					taskId: receipt.task_id,
					fileId: file.file_id,
					// No upload link: the server already holds these bytes.
					cacheHit: !file.upload,
					tier: tier ?? null,
				});

				// As soon as the task exists, BEFORE the PUT: a worker that dies while
				// the bytes are on their way must resume this task, not create another.
				emit("uploading", true);

				if (file.upload) await putBytes(file.upload);
				emit("parsing", true);
			}

			/**
			 * Poll the one file to a settled task. A file still waiting for bytes
			 * (the PUT never landed: a worker died, a transfer failed) is sent them
			 * again with the link the task hands out, once; without a link, or when
			 * the link is refused, the task is stale.
			 */
			async function pollSettled(): Promise<MineruTaskDetail> {
				let reuploads = 0;
				for (;;) {
					const taskId = state.remoteJobId as string;
					const remaining = deadlineAt - now();
					if (remaining <= 0) {
						await cancelRemoteTask(client, taskId);
						throw new MineruApiError({
							code: MINERU_CLIENT_ERROR_CODES.jobDeadline,
							message: `MinerU task ${taskId} did not finish within ${config.jobTimeoutMs}ms.`,
						});
					}
					try {
						return await client.pollTask({
							taskId,
							fileId: state.remoteFileId,
							signal: request.signal,
							deadlineMs: remaining,
						});
					} catch (error) {
						if (isDeadlineError(error)) {
							// The remote is still working on something nobody will read.
							await cancelRemoteTask(client, taskId);
							throw error;
						}
						if (!isFileWaitingError(error)) throw error;

						const link = mineruWaitingUpload(error);
						if (link && reuploads < MAX_REUPLOADS) {
							reuploads += 1;
							console.info(
								`${LOG_PREFIX} MinerU task is waiting for its bytes`,
								{
									extractor: MINERU4_EXTRACTOR_NAME,
									taskId,
								},
							);
							emit("uploading", true);
							await putBytes(link);
							emit("parsing", true);
							continue;
						}
						throw new StaleTask("waiting-for-bytes", error);
					}
				}
			}

			async function runOnce(rehash: boolean): Promise<ExtractDocumentResult> {
				if (state.remoteJobId && state.remoteFileId) {
					// Resuming. Announce ownership of the existing task before polling
					// it, so the ledger's status and handle are current either way. A
					// forgotten id surfaces from the first poll and is handled by the
					// caller.
					emit("parsing", true);
				} else {
					await submitFresh(rehash);
				}

				const task = await pollSettled();
				const taskId = state.remoteJobId as string;
				const file = pickMineruTaskFile(task, state.remoteFileId);

				const failure = mapMineruTaskFailure(task, {
					fileId: state.remoteFileId,
				});
				if (failure) {
					throw new DocumentExtractionError({
						code: failure.taxonomy,
						// MinerU's own sentence ("Failed to load document (PDFium: …)") is
						// an operator's line, not an answer to "what do I do now": the
						// person reads the code's, and the operator reads `details`.
						message: extractionErrorMessage(failure.taxonomy, failure.reason),
						retryable: failure.retryable,
						handleUnknown: failure.handleUnknown,
						details: {
							mineruRule: failure.rule,
							taskId,
							taskStatus: task.status,
							fileStatus: file?.status ?? null,
							...(file?.error?.code ? { mineruCode: file.error.code } : {}),
							...(file?.error?.message
								? {
										rawMessage: forOperators(file.error.message, config.apiKey),
									}
								: {}),
						},
					});
				}

				const resultUrl = file?.result_url;
				if (!file || !resultUrl) {
					// Unreachable: `mapMineruTaskFailure` returns null only for a
					// completed file that carries a `result_url`. Kept so a future
					// change cannot make the null deref the first thing anyone notices.
					throw new DocumentExtractionError({
						code: "protocol",
						message: extractionErrorMessage(
							"protocol",
							"No result to download.",
						),
						retryable: true,
						handleUnknown: true,
					});
				}

				emit("downloading", true);

				tempDir ??= await mkdtemp(
					join(options.tempDirRoot ?? tmpdir(), "alfyai-mineru4-"),
				);
				const zipPathAbsolute = join(tempDir, "result.zip");
				await client.downloadFile({
					resultUrl,
					destinationPathAbsolute: zipPathAbsolute,
					signal: request.signal,
				});

				let parsed: Awaited<ReturnType<typeof parseMineruResultZip>>;
				try {
					parsed = await parseMineruResultZip({
						zipPathAbsolute,
						// The tier the FILE ran at, per the server (a native document always
						// says `flash`, spike gotcha 12), not the one that was asked for.
						jobTier: file.parse?.tier ?? state.requestedTier,
						serverParserVersion: file.parse?.parser_version ?? null,
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
						userQuotaBytes: config.bundleUserQuotaBytes,
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

			/**
			 * A client failure as the ledger's error. `spent` says the remote task is
			 * dead (the server forgot it, or we cancelled it), so the ledger clears the
			 * handle and the next attempt creates a fresh task instead of resuming it.
			 */
			function failureFrom(
				error: unknown,
				spent: boolean,
			): DocumentExtractionError {
				if (error instanceof DocumentExtractionError) return error;
				if (error instanceof MineruResultError) {
					return resultErrorToExtractionError(error);
				}
				if (isMineruApiError(error) && error.wrongProtocol) {
					// The URL still points at the old server, or at a proxy in front of
					// the wrong thing (S6, R14). Retried with the outage budget; said here
					// so that an operator can see why a document is waiting.
					console.warn(
						`${LOG_PREFIX} MinerU answered in another protocol's voice`,
						{
							extractor: MINERU4_EXTRACTOR_NAME,
							wrongProtocol: error.wrongProtocol,
							httpStatus: error.status,
							path: error.requestPath,
						},
					);
				}
				const mapped = mineruErrorToExtractionError(error, {
					context: "MinerU extraction failed",
				});
				if (!spent || mapped.handleUnknown) return mapped;
				return new DocumentExtractionError({
					code: mapped.code,
					message: mapped.message,
					retryable: mapped.retryable,
					retryAfterMs: mapped.retryAfterMs,
					handleUnknown: true,
					details: mapped.details,
					cause: mapped.cause,
				});
			}

			try {
				let recreates = 0;
				let rehash = false;
				for (;;) {
					try {
						return await runOnce(rehash);
					} catch (error) {
						if (isAbortLike(error) || request.signal.aborted) throw error;

						const stale = error instanceof StaleTask ? error : null;
						const forgotten = isMineruForgottenIdError(error);
						if ((stale || forgotten) && recreates < MAX_RECREATES) {
							// S6: the server restarted (every id is gone, the hash cache
							// too), or the task can never get its bytes. Forget the ids and
							// create the task again, from a fresh look at the file if the
							// file is what changed.
							recreates += 1;
							rehash = stale?.rehash ?? false;
							const cause = stale?.cause ?? error;
							console.info(`${LOG_PREFIX} MinerU forgot an id, recovering`, {
								extractor: MINERU4_EXTRACTOR_NAME,
								reason: stale?.reason ?? "forgotten-id",
								mineruCode: isMineruApiError(cause) ? cause.code : null,
							});
							state.remoteJobId = null;
							state.remoteFileId = null;
							continue;
						}
						// Out of recoveries: the underlying failure is the ledger's, marked
						// as one about a task that is dead and must not be resumed.
						if (stale) throw failureFrom(stale.cause, true);
						if (forgotten) throw failureFrom(error, true);
						throw error;
					}
				}
			} catch (error) {
				if (isAbortLike(error) || request.signal.aborted) {
					// ONLY a user cancel may destroy the remote task.
					//
					// A lost claim, a stale-worker reclaim and a process shutdown all
					// abort this same signal, and for all three the remote task is the
					// thing the NEXT attempt resumes from: the handle was emitted as
					// soon as it existed precisely so a restart costs one poll rather
					// than a second upload and a second parse. Cancelling it here turned
					// every deploy restart during `parsing` into a full re-parse of
					// every in-flight document, and turned a stale sweep into a race that
					// killed the task the new claimant had just picked up.
					if (abortDiscardsRemoteWork(request.signal)) {
						await cancelRemoteTask(client, state.remoteJobId);
					}
					throw canceledError();
				}
				throw failureFrom(error, isDeadlineError(error));
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
				await client.cancelTask({
					taskId: state.remoteJobId,
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
