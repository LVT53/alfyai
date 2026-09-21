/**
 * The MinerU 4.x V1 protocol client.
 *
 * It speaks exactly the nine calls the recorded fixtures exercise, validates
 * every body it reads, and does nothing else: no retries (the ledger owns
 * those), no caching (`capabilities.ts` owns that), no zip reading (Phase 4
 * owns that), no knowledge of artifacts, users or the database.
 *
 * Five rules it enforces so that callers do not have to:
 *
 *  - **The key is same-origin only.** `Authorization` is attached when, and
 *    only when, the request URL passes `isSameMineruOrigin`. `upload_url` and
 *    any redirect are server-supplied strings, and a server that points them
 *    somewhere else must not be handed a credential.
 *  - **Bytes stream.** The upload is piped from disk with `Content-Length` set
 *    from `stat`; the result zip is piped to disk with a byte cap. Neither is
 *    ever materialised in memory.
 *  - **A 200 is not automatically valid.** Every JSON body goes through a zod
 *    schema before a field is read.
 *  - **Nothing leaks.** The API key is scrubbed from every message, upstream
 *    bodies are truncated to 300 characters, and only the request PATH is kept
 *    on an error — never a full URL, never a header.
 *  - **Timeouts are ours.** Every call composes the caller's signal with an
 *    `AbortSignal.timeout`, so a hung server cannot pin a worker.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { ZodType } from "zod";
import {
	isSameMineruOrigin,
	MINERU_TIER_IDS,
	type MineruConfig,
	type MineruTierId,
	mineruUrl,
} from "./config";
import {
	MINERU_CLIENT_ERROR_CODES,
	MineruApiError,
	mineruApiErrorFromBody,
	redactMineruSecrets,
	truncateMineruBody,
} from "./errors";
import {
	isTerminalMineruJobStatus,
	type MineruHealth,
	type MineruJob,
	type MineruTier,
	type MineruUpload,
	type MineruUsage,
	mineruHealthSchema,
	mineruJobCancelSchema,
	mineruJobSchema,
	mineruTierListLenientSchema,
	mineruUploadSchema,
	mineruUsageSchema,
} from "./schemas";

const LOG_PREFIX = "[MINERU]";

/** Kept identical to `document-extraction.ts`'s prefix so log greps survive. */
export const MINERU_LOG_PREFIX = LOG_PREFIX;

/** Headers the server may NOT set on our upload PUT. */
const FORBIDDEN_UPLOAD_HEADERS = new Set([
	"authorization",
	"cookie",
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
	"proxy-authorization",
]);

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface MineruFileReader {
	stat(pathAbsolute: string): Promise<{ size: number }>;
	/** A fresh stream per call — the caller may re-PUT after a hash mismatch. */
	stream(pathAbsolute: string): ReadableStream<Uint8Array>;
	/** Streams the file through a sha256 digest without buffering it. */
	sha256(pathAbsolute: string): Promise<string>;
}

export interface MineruClientDeps {
	config: MineruConfig;
	/** Injected for tests. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Injected for tests. Defaults to node:fs streams. */
	fileReader?: MineruFileReader;
	now?: () => number;
	/** Injected for tests; the poll loop's only wait. */
	sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The default reader: `createReadStream`, `stat`, and a streaming digest. */
export function createNodeMineruFileReader(): MineruFileReader {
	return {
		async stat(pathAbsolute) {
			const stats = await stat(pathAbsolute);
			return { size: stats.size };
		},
		stream(pathAbsolute) {
			return Readable.toWeb(
				createReadStream(pathAbsolute),
			) as unknown as ReadableStream<Uint8Array>;
		},
		async sha256(pathAbsolute) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(pathAbsolute)) {
				hash.update(chunk as Buffer);
			}
			return hash.digest("hex");
		},
	};
}

// ---------------------------------------------------------------------------
// Call inputs
// ---------------------------------------------------------------------------

export interface CreateUploadInput {
	/** The artifact's DISPLAY name. Never a local path — see `uploadFilename`. */
	filename: string;
	bytes: number;
	mimeType: string;
	/** Always sent. Dedupe is free, and it is the restart recovery path (D7). */
	sha256sum: string;
	signal: AbortSignal;
}

export interface PutUploadContentInput {
	upload: MineruUpload;
	filePathAbsolute: string;
	signal: AbortSignal;
}

export interface CompleteUploadInput {
	uploadId: string;
	sha256sum: string;
	signal: AbortSignal;
}

export interface CreateJobInput {
	fileId: string;
	/** Omitted key when undefined. NEVER sent as null. */
	tier?: MineruTierId;
	/** Omitted when the configured mode is `auto`. NEVER sent as null. */
	ocrMode?: "txt" | "ocr";
	outputFormats: readonly string[];
	signal: AbortSignal;
}

export interface GetJobInput {
	jobId: string;
	signal: AbortSignal;
}

export interface PollJobInput {
	jobId: string;
	signal: AbortSignal;
	/** Whole-job deadline. Defaults to `config.jobTimeoutMs`. */
	deadlineMs?: number;
	/** Called after every poll, terminal included. */
	onPoll?: (job: MineruJob) => void;
}

export interface DownloadFileInput {
	fileId: string;
	destinationPathAbsolute: string;
	/** `output_files.<format>.bytes`. The download must match it exactly. */
	expectedBytes: number;
	signal: AbortSignal;
	/** Hard cap. Defaults to max(expectedBytes, config.bundleMaxBytes). */
	maxBytes?: number;
}

interface RequestOptions {
	method: "GET" | "POST" | "DELETE";
	path: `/v1/${string}`;
	body?: unknown;
	signal: AbortSignal;
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class MineruClient {
	readonly config: MineruConfig;
	private readonly fetchImpl: typeof fetch;
	private readonly fileReader: MineruFileReader;
	private readonly now: () => number;
	private readonly sleepImpl: (
		ms: number,
		signal: AbortSignal,
	) => Promise<void>;

	constructor(deps: MineruClientDeps) {
		this.config = deps.config;
		this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
		this.fileReader = deps.fileReader ?? createNodeMineruFileReader();
		this.now = deps.now ?? Date.now;
		this.sleepImpl = deps.sleepImpl ?? defaultSleep;
	}

	// -- capability reads (the shape `MineruProbeClient` expects) ------------

	async getHealth(signal: AbortSignal): Promise<MineruHealth> {
		const body = await this.requestJson({
			method: "GET",
			path: "/v1/health",
			signal,
		});
		return this.parseBody(mineruHealthSchema, body, "/v1/health");
	}

	/**
	 * Rows whose `id` this app does not know are DROPPED, not fatal: a MinerU
	 * that grows a fifth tier must not take every extraction down at the
	 * capability read.
	 */
	async getTiers(signal: AbortSignal): Promise<MineruTier[]> {
		const body = await this.requestJson({
			method: "GET",
			path: "/v1/tiers",
			signal,
		});
		const parsed = this.parseBody(
			mineruTierListLenientSchema,
			body,
			"/v1/tiers",
		);
		// The vocabulary is config.ts's, never a second copy of the four ids.
		const known = new Set<string>(MINERU_TIER_IDS);
		return parsed.data.filter((tier): tier is MineruTier => known.has(tier.id));
	}

	async getUsage(signal: AbortSignal): Promise<MineruUsage> {
		const body = await this.requestJson({
			method: "GET",
			path: "/v1/usage",
			signal,
		});
		return this.parseBody(mineruUsageSchema, body, "/v1/usage");
	}

	// -- uploads -------------------------------------------------------------

	/**
	 * `POST /v1/uploads`.
	 *
	 * `status === "completed"` is a sha256 dedupe hit: `file` is populated,
	 * `upload_url` is null, and the PUT and the complete are both skipped. That
	 * is also what makes restart recovery free — the bytes outlive the ids.
	 */
	async createUpload(input: CreateUploadInput): Promise<MineruUpload> {
		const body = await this.requestJson({
			method: "POST",
			path: "/v1/uploads",
			signal: input.signal,
			body: {
				filename: uploadFilename(input.filename),
				bytes: input.bytes,
				mime_type: input.mimeType,
				purpose: "parse",
				sha256sum: input.sha256sum,
			},
		});
		return this.parseBody(mineruUploadSchema, body, "/v1/uploads");
	}

	/**
	 * `PUT upload.upload_url`, streamed from disk.
	 *
	 * Returns void: the server answers 200 with an EMPTY body and no
	 * `content-type`, and it answers 200 for the WRONG bytes too — a hash
	 * mismatch only surfaces at `complete`.
	 */
	async putUploadContent(input: PutUploadContentInput): Promise<void> {
		const target = this.resolveUploadUrl(input.upload);
		const { size } = await this.fileReader.stat(input.filePathAbsolute);

		const headers = new Headers({ "content-type": "application/octet-stream" });
		for (const [name, value] of Object.entries(
			input.upload.upload_headers ?? {},
		)) {
			if (FORBIDDEN_UPLOAD_HEADERS.has(name.toLowerCase())) continue;
			headers.set(name, value);
		}
		headers.set("content-length", String(size));
		this.applyAuth(headers, target);

		const method = input.upload.upload_method ?? "PUT";
		const response = await this.send(
			target,
			{
				method,
				headers,
				body: this.fileReader.stream(input.filePathAbsolute),
				duplex: "half",
			},
			input.signal,
			this.config.transferTimeoutMs,
			uploadPathFor(input.upload.id),
		);

		if (!response.ok) {
			throw await this.errorFromResponse(
				response,
				uploadPathFor(input.upload.id),
			);
		}
		// The body is empty, but it must still be drained so the socket is freed.
		await response.arrayBuffer().catch(() => undefined);
	}

	/** `POST /v1/uploads/{id}/complete`. 400 `file_hash_mismatch` lands HERE. */
	async completeUpload(input: CompleteUploadInput): Promise<MineruUpload> {
		const path =
			`/v1/uploads/${encodeURIComponent(input.uploadId)}/complete` as const;
		const body = await this.requestJson({
			method: "POST",
			path,
			signal: input.signal,
			body: { sha256sum: input.sha256sum },
		});
		return this.parseBody(mineruUploadSchema, body, path);
	}

	// -- parse jobs ----------------------------------------------------------

	/**
	 * `POST /v1/parse/jobs`. Resolves on the 202 — which proves nothing: an
	 * unknown `file_id` is accepted here and fails inside the job.
	 *
	 * The body carries `files`, `output_formats` and at most `tier` and
	 * `ocr_mode`. It NEVER carries `page_range` (a non-PDF page range is a 202
	 * followed by a file-level failure, and we have no page-selection feature)
	 * and NEVER `callback` (`health.features.webhook` is false; it is a hard
	 * 400 even with a valid key).
	 */
	async createJob(input: CreateJobInput): Promise<MineruJob> {
		const body: Record<string, unknown> = {
			files: [{ source: { type: "file_id", file_id: input.fileId } }],
			output_formats: [...input.outputFormats],
		};
		// Assigned only when defined: `tier: null` and `ocr_mode: null` are both
		// 400s, so an omitted key is the only way to say "you decide".
		if (input.tier !== undefined) body.tier = input.tier;
		if (input.ocrMode !== undefined) body.ocr_mode = input.ocrMode;

		const parsed = await this.requestJson({
			method: "POST",
			path: "/v1/parse/jobs",
			signal: input.signal,
			body,
		});
		return this.parseBody(mineruJobSchema, parsed, "/v1/parse/jobs");
	}

	async getJob(input: GetJobInput): Promise<MineruJob> {
		const path = `/v1/parse/jobs/${encodeURIComponent(input.jobId)}` as const;
		const body = await this.requestJson({
			method: "GET",
			path,
			signal: input.signal,
		});
		return this.parseBody(mineruJobSchema, body, path);
	}

	/**
	 * Polls to a terminal status with exponential backoff between
	 * `pollMinMs` and `pollMaxMs`.
	 *
	 * This is the client's ONLY internal loop. It does not interpret the
	 * terminal job — `mapMineruJobFailure` in `errors.ts` does that, because a
	 * `completed` job can still carry a failed file.
	 */
	async pollJob(input: PollJobInput): Promise<MineruJob> {
		const deadline =
			this.now() + (input.deadlineMs ?? this.config.jobTimeoutMs);
		let wait = Math.max(1, this.config.pollMinMs);

		for (;;) {
			const job = await this.getJob({
				jobId: input.jobId,
				signal: input.signal,
			});
			input.onPoll?.(job);
			if (isTerminalMineruJobStatus(job.status)) return job;

			if (this.now() >= deadline) {
				throw new MineruApiError({
					code: MINERU_CLIENT_ERROR_CODES.jobDeadline,
					message: `MinerU job ${input.jobId} did not finish within ${
						input.deadlineMs ?? this.config.jobTimeoutMs
					}ms.`,
					requestPath: `/v1/parse/jobs/${input.jobId}`,
				});
			}

			const remaining = deadline - this.now();
			await this.sleepImpl(
				Math.min(wait, Math.max(1, remaining)),
				input.signal,
			);
			wait = Math.min(
				Math.round(wait * 1.5),
				Math.max(1, this.config.pollMaxMs),
			);
		}
	}

	/**
	 * `DELETE /v1/parse/jobs/{id}`.
	 *
	 * Swallows 404 `job_not_found` and 409 `job_already_terminal`: both mean
	 * there is nothing left to cancel, which is the goal. Never throws for a
	 * cancel that is merely late.
	 */
	async cancelJob(input: GetJobInput): Promise<void> {
		const path = `/v1/parse/jobs/${encodeURIComponent(input.jobId)}` as const;
		const response = await this.send(
			mineruUrl(this.config, path),
			{ method: "DELETE", headers: this.baseHeaders(path) },
			input.signal,
			this.config.requestTimeoutMs,
			path,
		);

		if (response.status === 404 || response.status === 409) {
			await response.arrayBuffer().catch(() => undefined);
			return;
		}
		if (!response.ok) throw await this.errorFromResponse(response, path);

		const body = await this.readJson(response, path);
		// Parsed for its shape only; the caller has nothing to do with it.
		this.parseBody(mineruJobCancelSchema, body, path);
	}

	// -- downloads -----------------------------------------------------------

	/**
	 * `GET /v1/files/{id}/content`, streamed to disk.
	 *
	 * Locally this always streams a 200 as `application/octet-stream` with no
	 * `Content-Disposition`; a 302 is advertised in the schema and never used,
	 * so it is followed exactly once, validated as http(s), and the key travels
	 * with it only when the redirect stays on MinerU's own origin.
	 *
	 * Never sniffs the content type: the caller knows what it asked for.
	 */
	async downloadFile(input: DownloadFileInput): Promise<{ bytes: number }> {
		const path =
			`/v1/files/${encodeURIComponent(input.fileId)}/content` as const;
		const cap = Math.max(
			input.maxBytes ?? this.config.bundleMaxBytes,
			input.expectedBytes,
		);

		let response = await this.send(
			mineruUrl(this.config, path),
			{
				method: "GET",
				headers: this.baseHeaders(path),
				redirect: "manual",
			},
			input.signal,
			this.config.transferTimeoutMs,
			path,
		);

		if (isRedirect(response.status)) {
			response = await this.followDownloadRedirect(response, input, path);
		}

		if (!response.ok) throw await this.errorFromResponse(response, path);
		if (!response.body) {
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
				message: "MinerU returned an empty download body.",
				status: response.status,
				requestPath: path,
			});
		}

		let bytes = 0;
		const source = Readable.fromWeb(
			response.body as unknown as NodeReadableStream<Uint8Array>,
		);
		try {
			await pipeline(
				(async function* capped() {
					for await (const chunk of source) {
						const buffer = chunk as Buffer;
						bytes += buffer.byteLength;
						if (bytes > cap) {
							throw new MineruApiError({
								code: MINERU_CLIENT_ERROR_CODES.downloadTooLarge,
								message: `MinerU download exceeded ${cap} bytes.`,
								requestPath: path,
								details: { cap, expectedBytes: input.expectedBytes },
							});
						}
						yield buffer;
					}
				})(),
				createWriteStream(input.destinationPathAbsolute),
			);
		} catch (error) {
			await rm(input.destinationPathAbsolute, { force: true }).catch(
				() => undefined,
			);
			throw error;
		}

		if (bytes !== input.expectedBytes) {
			await rm(input.destinationPathAbsolute, { force: true }).catch(
				() => undefined,
			);
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.byteCountMismatch,
				message: `MinerU download was ${bytes} bytes, the job promised ${input.expectedBytes}.`,
				requestPath: path,
				details: { bytes, expectedBytes: input.expectedBytes },
			});
		}

		return { bytes };
	}

	// -- helpers -------------------------------------------------------------

	/** Streams the local file through a sha256 digest. Never buffers it. */
	sha256(filePathAbsolute: string): Promise<string> {
		return this.fileReader.sha256(filePathAbsolute);
	}

	/** `stat` only — the size the upload declares and the PUT sends. */
	statFile(filePathAbsolute: string): Promise<{ size: number }> {
		return this.fileReader.stat(filePathAbsolute);
	}

	private baseHeaders(pathOrUrl: string): Headers {
		const headers = new Headers({ accept: "application/json" });
		this.applyAuth(
			headers,
			pathOrUrl.startsWith("/")
				? mineruUrl(this.config, pathOrUrl as `/v1/${string}`)
				: pathOrUrl,
		);
		return headers;
	}

	/** The key travels to MinerU's own origin and nowhere else. */
	private applyAuth(headers: Headers, url: string): void {
		if (!this.config.apiKey) return;
		if (!isSameMineruOrigin(this.config, url)) return;
		headers.set("authorization", `Bearer ${this.config.apiKey}`);
	}

	private resolveUploadUrl(upload: MineruUpload): string {
		const raw = upload.upload_url;
		if (!raw) {
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
				message: "MinerU returned a pending upload without an upload_url.",
				requestPath: uploadPathFor(upload.id),
			});
		}

		// A relative upload_url is resolved against MINERU_API_URL; an absolute
		// one is taken as-is and then checked. Both end up at the same guard.
		let resolved: URL;
		try {
			resolved = new URL(raw, `${this.config.baseUrl}/`);
		} catch {
			throw untrustedUploadUrl(raw, upload.id);
		}
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
			throw untrustedUploadUrl(raw, upload.id);
		}
		if (!isSameMineruOrigin(this.config, resolved.toString())) {
			// Host only. The path may carry an id; the key is never in here.
			console.warn(
				`${LOG_PREFIX} refusing an upload_url on a foreign origin: ${resolved.host}`,
			);
			throw untrustedUploadUrl(resolved.host, upload.id);
		}
		return resolved.toString();
	}

	private async followDownloadRedirect(
		response: Response,
		input: DownloadFileInput,
		path: string,
	): Promise<Response> {
		const location = response.headers.get("location");
		await response.arrayBuffer().catch(() => undefined);
		if (!location) {
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.untrustedRedirect,
				message: "MinerU redirected a download without a Location header.",
				status: response.status,
				requestPath: path,
			});
		}

		let target: URL;
		try {
			target = new URL(
				location,
				mineruUrl(this.config, path as `/v1/${string}`),
			);
		} catch {
			throw untrustedRedirect(location, path);
		}
		if (target.protocol !== "http:" && target.protocol !== "https:") {
			throw untrustedRedirect(target.protocol, path);
		}

		// Cross-origin is allowed for a download — the bytes are public — but the
		// key stays behind. `applyAuth` already refuses to attach it.
		const headers = new Headers({ accept: "application/octet-stream" });
		this.applyAuth(headers, target.toString());

		return this.send(
			target.toString(),
			{ method: "GET", headers, redirect: "error" },
			input.signal,
			this.config.transferTimeoutMs,
			path,
		);
	}

	private async requestJson(options: RequestOptions): Promise<unknown> {
		const url = mineruUrl(this.config, options.path);
		const headers = this.baseHeaders(options.path);
		if (options.body !== undefined) {
			headers.set("content-type", "application/json");
		}

		const response = await this.send(
			url,
			{
				method: options.method,
				headers,
				body:
					options.body === undefined ? undefined : JSON.stringify(options.body),
			},
			options.signal,
			options.timeoutMs ?? this.config.requestTimeoutMs,
			options.path,
		);

		if (!response.ok)
			throw await this.errorFromResponse(response, options.path);
		return this.readJson(response, options.path);
	}

	/**
	 * One fetch, with the caller's signal composed with our own deadline.
	 *
	 * Nothing here retries. A transient failure is the ledger's problem, and a
	 * client that retried silently would multiply every timeout by three.
	 */
	private async send(
		url: string,
		init: RequestInit & { duplex?: "half" },
		signal: AbortSignal,
		timeoutMs: number,
		path: string,
	): Promise<Response> {
		const composed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		try {
			return await this.fetchImpl(url, { ...init, signal: composed });
		} catch (error) {
			// Rethrow abort and timeout untouched: `mapMineruError` reads their
			// names to tell "the user cancelled" from "we ran out of patience".
			if (isAbortName((error as { name?: unknown } | null)?.name)) throw error;
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.transportUnreachable,
				message: redactMineruSecrets(
					error instanceof Error ? error.message : String(error),
					this.config.apiKey,
				),
				requestPath: path,
				cause: error,
			});
		}
	}

	private async readJson(response: Response, path: string): Promise<unknown> {
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.invalidJson,
				message: `MinerU ${path} returned a ${response.status} that is not JSON.`,
				status: response.status,
				requestPath: path,
				bodyExcerpt: this.safeExcerpt(text),
				cause: error,
			});
		}
	}

	private parseBody<T>(schema: ZodType<T>, body: unknown, path: string): T {
		const parsed = schema.safeParse(body);
		if (parsed.success) return parsed.data;
		throw new MineruApiError({
			code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
			message: `MinerU ${path} returned a body this client cannot read.`,
			requestPath: path,
			details: {
				// Three issues is enough to debug a shape change and short enough
				// that a 400-block document cannot end up in a log line.
				zodIssues: parsed.error.issues.slice(0, 3).map((issue) => ({
					path: issue.path.join("."),
					code: issue.code,
					message: issue.message,
				})),
			},
		});
	}

	private async errorFromResponse(
		response: Response,
		path: string,
	): Promise<MineruApiError> {
		const text = await response.text().catch(() => "");
		return mineruApiErrorFromBody({
			status: response.status,
			// Scrubbed BEFORE it can reach a message, an excerpt or a log line.
			bodyText: redactMineruSecrets(text, this.config.apiKey),
			path,
			retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
		});
	}

	private safeExcerpt(text: string): string {
		return truncateMineruBody(redactMineruSecrets(text, this.config.apiKey));
	}

	// Aliases for the names the slice brief used. `createJob` / `getJob` /
	// `cancelJob` are the spec's §2.4 names and the ones to prefer.
	createParseJob(input: CreateJobInput): Promise<MineruJob> {
		return this.createJob(input);
	}
	getParseJob(input: GetJobInput): Promise<MineruJob> {
		return this.getJob(input);
	}
	cancelParseJob(input: GetJobInput): Promise<void> {
		return this.cancelJob(input);
	}
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

/**
 * The name sent upstream is the DISPLAY name only.
 *
 * `data/knowledge/<userId>/<uuid>.pdf` would otherwise travel to the server,
 * appear in its logs, and come back in `files[].name` — leaking a local layout
 * and a user id for no benefit at all.
 */
export function uploadFilename(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// Control characters are dropped by code point rather than by a regex
	// range: a CR or LF in a filename is how a log line or a header gets
	// forged, and a literal control range in a regex is a lint error anyway.
	const cleaned = Array.from(base)
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 255) : "document";
}

function uploadPathFor(uploadId: string): string {
	return `/v1/uploads/${uploadId}/content`;
}

function untrustedUploadUrl(
	hostOrUrl: string,
	uploadId: string,
): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.untrustedUploadUrl,
		message: `MinerU returned an upload_url this client will not use (${hostOrUrl}).`,
		requestPath: uploadPathFor(uploadId),
	});
}

function untrustedRedirect(target: string, path: string): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.untrustedRedirect,
		message: `MinerU redirected a download somewhere this client will not follow (${target}).`,
		requestPath: path,
	});
}

function isRedirect(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	);
}

function isAbortName(name: unknown): boolean {
	return name === "AbortError" || name === "TimeoutError";
}

/** `Retry-After` is seconds or an HTTP date. Both are honoured. */
export function retryAfterMs(header: string | null): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.round(seconds * 1000);
	const date = Date.parse(header);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - Date.now());
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
