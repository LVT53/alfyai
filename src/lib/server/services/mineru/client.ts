/**
 * The MinerU 4.1 `/v1/tasks` protocol client.
 *
 * It speaks exactly the calls the captured fixtures exercise, validates every
 * body it reads, and does nothing else: no retries (the ledger owns those), no
 * caching (`capabilities.ts` owns that), no zip reading (`result.ts` owns that),
 * no knowledge of artifacts, users or the database.
 *
 *     createTask   POST /v1/tasks                       202, the receipt
 *     putTaskFile  PUT  {files[].upload.url}            only when an upload link is present
 *     getTask      GET  /v1/tasks/{id}
 *     pollTask     getTask until the task is terminal
 *     cancelTask   POST /v1/tasks/{id}/cancel
 *     downloadFile GET  {files[].result_url}            one ZIP per file
 *
 * Rules it enforces so that callers do not have to:
 *
 *  - **The key is same-origin only (S7).** `Authorization` is attached when, and
 *    only when, the request URL passes `isSameMineruOrigin`. `upload.url` and
 *    `result_url` come out of MinerU's own answers, so a URL on any other
 *    origin is refused BEFORE a byte or a credential is sent.
 *  - **Redirects are refused, except for one download hop.** Every call is made
 *    with `redirect: "manual"`: fetch's default follows a 3xx to any origin and
 *    sends a POST body again, and the manifest (extension, size, hash) is not
 *    something undici strips the way it strips `Authorization`. The JSON calls
 *    and the upload PUT turn a 3xx into `protocol_untrusted_redirect`; only the
 *    result download follows one, once, and only to the configured origin.
 *  - **The request body is built here (S5).** `createTask` writes the body from
 *    fixed keys, so what the 4.1 server rejects with a 400 (`page_range: null`,
 *    `ocr_mode: null`, `include_model_output`, `client_file_id`, `file_id`, any
 *    `output_formats` but `["default"]`) cannot be sent, whatever it is handed.
 *  - **Bytes stream.** The upload is piped from disk with `Content-Length` set
 *    from `stat`; the result ZIP is piped to disk under a byte cap. Neither is
 *    ever materialised in memory.
 *  - **A 200 is not automatically valid.** Every JSON body goes through a zod
 *    schema before a field is read.
 *  - **Nothing leaks.** The API key is scrubbed from every message, upstream
 *    bodies are truncated to 300 characters, and only the request PATH is kept
 *    on an error: never a full URL, never a header.
 *  - **Timeouts are ours.** Every call composes the caller's signal with an
 *    `AbortSignal.timeout`, so a hung server cannot pin a worker.
 *  - **Creation is not retried here.** `POST /v1/tasks` is not idempotent and
 *    there is no list endpoint: a task whose 202 was lost cannot be found again,
 *    it just waits out its hour. Retrying is the ledger's decision, made with
 *    the error's classification in hand.
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
	MINERU_MAX_DOWNLOAD_BYTES,
	MINERU_TASK_OUTPUT_FORMATS,
	MINERU_TIER_IDS,
	type MineruConfig,
	type MineruTierId,
	mineruUrl,
} from "./config";
import {
	MINERU_CLIENT_ERROR_CODES,
	MineruApiError,
	mineruApiErrorFromBody,
	mineruFileWaitingError,
	pickMineruTaskFile,
	redactMineruSecrets,
	truncateMineruBody,
} from "./errors";
import {
	isTerminalMineruTaskStatus,
	type MineruCancelTaskResponse,
	type MineruCreateTaskResponse,
	type MineruHealth,
	type MineruTaskDetail,
	type MineruTier,
	type MineruUploadFileResponse,
	type MineruUploadLink,
	type MineruUsage,
	mineruCancelTaskResponseSchema,
	mineruCreateTaskResponseSchema,
	mineruHealthSchema,
	mineruTaskDetailSchema,
	mineruTierListLenientSchema,
	mineruUploadFileResponseSchema,
	mineruUsageSchema,
} from "./schemas";

const LOG_PREFIX = "[MINERU]";

/** Headers the server may NOT set on our upload PUT: the transport owns them. */
const FORBIDDEN_UPLOAD_HEADERS = new Set([
	"authorization",
	"cookie",
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
	"proxy-authorization",
]);

/** 4.1 refuses a longer `file_name`. */
const MAX_TASK_FILE_NAME_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface MineruFileReader {
	stat(pathAbsolute: string): Promise<{ size: number }>;
	/** A fresh stream per call: the caller may PUT again after a failed one. */
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

export interface CreateTaskInput {
	/**
	 * What MinerU is told the file is called (S3: `document.<ext>`, the extension
	 * is what it routes by). Never a local path: directories, control characters
	 * and the colon 4.1 refuses are dropped here.
	 */
	fileName: string;
	/** The size of the file, as `statFile` reports it. */
	bytes: number;
	/** Always sent (S2): the same bytes later skip the PUT, through the hash cache. */
	sha256sum: string;
	/** Omitted key when undefined. NEVER sent as null. */
	tier?: MineruTierId;
	/** Omitted key when undefined. NEVER sent as null (D19). */
	ocrMode?: "txt" | "ocr";
	signal: AbortSignal;
}

export interface PutTaskFileInput {
	/** The `upload` object of the receipt (or of a snapshot that still lists one). */
	upload: MineruUploadLink;
	filePathAbsolute: string;
	signal: AbortSignal;
}

export interface TaskInput {
	taskId: string;
	signal: AbortSignal;
}

export interface PollTaskInput extends TaskInput {
	/**
	 * The file this caller submitted (default: the first, the only one a one-file
	 * task has). The poll stops with `client_file_waiting_for_bytes` if THIS file
	 * is still `waiting-file`.
	 */
	fileId?: string | null;
	/** Whole-job deadline. Defaults to `config.jobTimeoutMs`. */
	deadlineMs?: number;
	/** Called after every poll, terminal included. */
	onPoll?: (task: MineruTaskDetail) => void;
}

export interface DownloadFileInput {
	/** `files[].result_url` of a completed file. Followed only on the configured origin. */
	resultUrl: string;
	destinationPathAbsolute: string;
	signal: AbortSignal;
	/**
	 * Cap in bytes, always clamped to `MINERU_MAX_DOWNLOAD_BYTES`. The default IS
	 * that ceiling, not `bundleMaxBytes`: the budget bounds what is KEPT after
	 * filtering, and the ZIP also carries `middle_json.json` and every image, so
	 * it is routinely bigger.
	 */
	maxBytes?: number;
}

interface RequestOptions {
	method: "GET" | "POST";
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

	// -- tasks ---------------------------------------------------------------

	/**
	 * `POST /v1/tasks` with one file (S2), answering 202.
	 *
	 * The receipt says what to do next. `status: "waiting-file"` and an `upload`
	 * object on the file: PUT the bytes there. `status: "pending"` and NO `upload`
	 * object: the server already holds these bytes (the hash cache) and the task
	 * is queued; PUT nothing. Either way the receipt holds exactly one file; a
	 * different count is a protocol error.
	 *
	 * The body is built from fixed keys (see the file header): `files`, the one
	 * `output_formats` this client ever asks for, and `tier` / `ocr_mode` only
	 * when given a string.
	 */
	async createTask(input: CreateTaskInput): Promise<MineruCreateTaskResponse> {
		const body: Record<string, unknown> = {
			files: [
				{
					file_name: taskFileName(input.fileName),
					bytes: input.bytes,
					sha256sum: input.sha256sum,
				},
			],
			output_formats: [...MINERU_TASK_OUTPUT_FORMATS],
		};
		// `typeof` rather than `!== undefined`: a caller that ignores the types and
		// hands over `null` must still send nothing (`tier: null` is a trap and
		// `ocr_mode: null` is a 400), and "omitted" is the only way to say "you decide".
		if (typeof input.tier === "string") body.tier = input.tier;
		if (typeof input.ocrMode === "string") body.ocr_mode = input.ocrMode;

		const parsed = await this.requestJson({
			method: "POST",
			path: "/v1/tasks",
			signal: input.signal,
			body,
		});
		const receipt = this.parseBody(
			mineruCreateTaskResponseSchema,
			parsed,
			"/v1/tasks",
		);
		if (receipt.files.length !== 1) {
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
				message: `MinerU /v1/tasks answered a one-file task with ${receipt.files.length} files.`,
				requestPath: "/v1/tasks",
			});
		}
		return receipt;
	}

	/**
	 * `PUT {upload.url}`, streamed from disk with `Content-Length` set from `stat`.
	 *
	 * The URL is the server's, so it is followed only on the configured origin
	 * (S7) and the key goes only there. `upload.headers` are sent as given; the
	 * ones the transport owns (`Authorization`, `Content-Length`, `Host`, ...) are
	 * ours. Answers 200 `{task_id, file_id, status}`; a repeat PUT answers 200
	 * too, with the file's current status. A wrong length or hash is a 400 and
	 * leaves the file waiting, so the same link can be used again.
	 */
	async putTaskFile(
		input: PutTaskFileInput,
	): Promise<MineruUploadFileResponse> {
		const target = this.resolveServerUrl(input.upload.url, "upload");
		const path = target.pathname;
		const { size } = await this.fileReader.stat(input.filePathAbsolute);

		const headers = new Headers({ "content-type": "application/octet-stream" });
		for (const [name, value] of Object.entries(input.upload.headers)) {
			if (FORBIDDEN_UPLOAD_HEADERS.has(name.toLowerCase())) continue;
			try {
				headers.set(name, value);
			} catch {
				// A name or value the platform will not carry is the server's mistake.
			}
		}
		headers.set("content-length", String(size));
		this.applyAuth(headers, target.toString());

		const response = await this.send(
			target.toString(),
			{
				method: "PUT",
				headers,
				body: this.fileReader.stream(input.filePathAbsolute),
				duplex: "half",
				// The bytes go where the link says, and nowhere else.
				redirect: "manual",
			},
			input.signal,
			this.config.transferTimeoutMs,
			path,
		);

		if (isRedirect(response.status)) {
			return refuseRedirect(response, "an upload", path);
		}
		if (!response.ok) throw await this.errorFromResponse(response, path);
		return this.parseBody(
			mineruUploadFileResponseSchema,
			await this.readJson(response, path),
			path,
		);
	}

	async getTask(input: TaskInput): Promise<MineruTaskDetail> {
		const path = taskPath(input.taskId);
		const body = await this.requestJson({
			method: "GET",
			path,
			signal: input.signal,
		});
		return this.parseBody(mineruTaskDetailSchema, body, path);
	}

	/**
	 * Polls to a terminal status (`completed`, `partial`, `failed`, `canceled`)
	 * with exponential backoff between `pollMinMs` and `pollMaxMs`.
	 *
	 * This is the client's ONLY internal loop. It does not interpret the terminal
	 * task: `mapMineruTaskFailure` in `errors.ts` does that, because a task's
	 * status is not its file's (a `partial` task holds a good file). It does stop
	 * early, with `client_file_waiting_for_bytes` (see `mineruWaitingUpload`), when
	 * the submitted file is still waiting for its bytes.
	 */
	async pollTask(input: PollTaskInput): Promise<MineruTaskDetail> {
		const deadline =
			this.now() + (input.deadlineMs ?? this.config.jobTimeoutMs);
		let wait = Math.max(1, this.config.pollMinMs);

		for (;;) {
			const task = await this.getTask({
				taskId: input.taskId,
				signal: input.signal,
			});
			input.onPoll?.(task);
			if (isTerminalMineruTaskStatus(task.status)) return task;

			// In a one-file task only a PUT moves the file out of `waiting-file`, and
			// the caller does the PUT before it polls. Finding it still waiting means
			// the PUT never landed (a transport error or a timeout during it, a worker
			// restart before its 200, or a 400 that left the file waiting): polling on
			// would run to the whole-job deadline, minutes of nothing. Stop, and hand
			// over the link the snapshot carries so the caller can PUT again.
			const submitted = pickMineruTaskFile(task, input.fileId);
			if (submitted?.status === "waiting-file") {
				throw mineruFileWaitingError(input.taskId, submitted);
			}

			if (this.now() >= deadline) {
				throw new MineruApiError({
					code: MINERU_CLIENT_ERROR_CODES.jobDeadline,
					message: `MinerU task ${input.taskId} did not finish within ${
						input.deadlineMs ?? this.config.jobTimeoutMs
					}ms.`,
					requestPath: taskPath(input.taskId),
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
	 * `POST /v1/tasks/{id}/cancel`. Resolves with the settled receipt, or `null`
	 * when there was nothing left to cancel.
	 *
	 * Swallows 404 (a restart forgot the task, or it never existed) and 409
	 * `task_already_terminal` (it already ended, `partial` included): both mean
	 * the goal is met. Every file that had not finished is `canceled`, the running
	 * ones too, while a file that had finished stays `completed` and its result
	 * stays downloadable (spike D24).
	 */
	async cancelTask(input: TaskInput): Promise<MineruCancelTaskResponse | null> {
		const path = `${taskPath(input.taskId)}/cancel` as const;
		const response = await this.send(
			mineruUrl(this.config, path),
			{
				method: "POST",
				headers: this.baseHeaders(path),
				redirect: "manual",
			},
			input.signal,
			this.config.requestTimeoutMs,
			path,
		);

		if (isRedirect(response.status)) {
			return refuseRedirect(response, "a request to the API", path);
		}
		if (response.status === 404 || response.status === 409) {
			await response.arrayBuffer().catch(() => undefined);
			return null;
		}
		if (!response.ok) throw await this.errorFromResponse(response, path);
		return this.parseBody(
			mineruCancelTaskResponseSchema,
			await this.readJson(response, path),
			path,
		);
	}

	// -- downloads -----------------------------------------------------------

	/**
	 * `GET {result_url}`, streamed to disk: the ZIP of one completed file.
	 *
	 * The URL is the server's, so it is followed only on the configured origin
	 * (S7), key attached there and nowhere else. A redirect is followed at most
	 * once and only to that origin; anywhere else is refused. The server states
	 * the size in `Content-Length`: a result that announces more than the cap is
	 * refused before a byte is read, a stream that outgrows the cap is cut, and a
	 * stream that is not the length announced is discarded.
	 *
	 * Never sniffs the content type: the caller knows it asked for a ZIP.
	 */
	async downloadFile(input: DownloadFileInput): Promise<{ bytes: number }> {
		const cap = Math.min(
			input.maxBytes ?? MINERU_MAX_DOWNLOAD_BYTES,
			MINERU_MAX_DOWNLOAD_BYTES,
		);
		let target = this.resolveServerUrl(input.resultUrl, "result");
		let response = await this.fetchResult(target, input.signal);

		if (isRedirect(response.status)) {
			target = await this.redirectTarget(response, target);
			response = await this.fetchResult(target, input.signal);
			if (isRedirect(response.status)) {
				await response.arrayBuffer().catch(() => undefined);
				throw untrustedRedirect("a second redirect", target.pathname);
			}
		}

		const path = target.pathname;
		if (!response.ok) throw await this.errorFromResponse(response, path);
		if (!response.body) {
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
				message: "MinerU returned an empty download body.",
				status: response.status,
				requestPath: path,
			});
		}

		// The server says how big the result is before it sends it. Believe it only
		// to say no: a result that announces more than the reader will ever open
		// cannot become a parse, so it is refused before a byte moves.
		const announced = parseContentLength(
			response.headers.get("content-length"),
		);
		if (announced !== null && announced > cap) {
			await response.body.cancel().catch(() => undefined);
			throw downloadTooLarge(cap, announced, path);
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
						if (bytes > cap) throw downloadTooLarge(cap, announced, path);
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

		// `Content-Length` counts the bytes on the wire. If anything between us and
		// MinerU encoded them (a gzip middleware may wrap any route), fetch hands
		// over the DECODED body and the two are different numbers on purpose, so
		// they have to agree only when nothing was encoded.
		const encoded =
			(response.headers.get("content-encoding") ?? "identity")
				.trim()
				.toLowerCase() !== "identity";
		if (!encoded && announced !== null && bytes !== announced) {
			await rm(input.destinationPathAbsolute, { force: true }).catch(
				() => undefined,
			);
			throw new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.byteCountMismatch,
				message: `MinerU download was ${bytes} bytes, the server announced ${announced}.`,
				requestPath: path,
				details: { bytes, announced },
			});
		}

		return { bytes };
	}

	// -- helpers -------------------------------------------------------------

	/** Streams the local file through a sha256 digest. Never buffers it. */
	sha256(filePathAbsolute: string): Promise<string> {
		return this.fileReader.sha256(filePathAbsolute);
	}

	/** `stat` only: the size the task declares and the PUT sends. */
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

	/**
	 * A URL out of one of MinerU's answers (`upload.url`, `result_url`), resolved
	 * (a relative one against `MINERU_API_URL`) and refused unless it is plain
	 * http(s), carries no credentials, and sits on the configured origin (S7).
	 */
	private resolveServerUrl(raw: string, kind: "upload" | "result"): URL {
		const refuse = (what: string) =>
			untrustedServerUrl(
				kind === "upload" ? "upload.url" : "result_url",
				what,
				kind,
			);

		let resolved: URL;
		try {
			resolved = new URL(raw, `${this.config.baseUrl}/`);
		} catch {
			throw refuse("not a URL");
		}
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
			throw refuse(resolved.protocol);
		}
		if (resolved.username || resolved.password) {
			throw refuse("credentials in the URL");
		}
		if (!isSameMineruOrigin(this.config, resolved.toString())) {
			// Host only. The path may carry an id; the key is never in here.
			console.warn(
				`${LOG_PREFIX} refusing ${kind === "upload" ? "an upload" : "a result"} URL on a foreign origin: ${resolved.host}`,
			);
			throw refuse(resolved.host);
		}
		return resolved;
	}

	private fetchResult(target: URL, signal: AbortSignal): Promise<Response> {
		const headers = new Headers({ accept: "application/zip" });
		this.applyAuth(headers, target.toString());
		return this.send(
			target.toString(),
			{ method: "GET", headers, redirect: "manual" },
			signal,
			this.config.transferTimeoutMs,
			target.pathname,
		);
	}

	/** Where a redirect points, if (and only if) that is the configured origin. */
	private async redirectTarget(response: Response, from: URL): Promise<URL> {
		const location = response.headers.get("location");
		await response.arrayBuffer().catch(() => undefined);
		if (!location) throw untrustedRedirect("no Location header", from.pathname);

		let target: URL;
		try {
			target = new URL(location, from);
		} catch {
			throw untrustedRedirect("not a URL", from.pathname);
		}
		if (
			(target.protocol !== "http:" && target.protocol !== "https:") ||
			target.username ||
			target.password ||
			!isSameMineruOrigin(this.config, target.toString())
		) {
			throw untrustedRedirect(target.host || target.protocol, from.pathname);
		}
		return target;
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
				// Answered by the configured origin or not at all: see the file header.
				redirect: "manual",
			},
			options.signal,
			options.timeoutMs ?? this.config.requestTimeoutMs,
			options.path,
		);

		if (isRedirect(response.status)) {
			return refuseRedirect(response, "a request to the API", options.path);
		}
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
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

/**
 * The name sent upstream is a NAME, never a path.
 *
 * `data/knowledge/<userId>/<uuid>.pdf` would otherwise travel to the server,
 * appear in its logs, and come back in `files[].file_name`: a leaked local
 * layout and a user id for no benefit at all. 4.1 rejects `/`, `\`, `:` and
 * control characters outright (D18), so those are dropped rather than sent to
 * be refused, and an over-long name keeps its extension, which is what MinerU
 * routes by. Callers are expected to pass `document.<ext>` (S3); this is the
 * floor under that, not a substitute for it.
 */
function taskFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// Control characters are dropped by code point rather than by a regex
	// range: a CR or LF in a filename is how a log line or a header gets
	// forged, and a literal control range in a regex is a lint error anyway.
	const cleaned = Array.from(base)
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f && character !== ":";
		})
		.join("")
		.trim();
	if (cleaned.length === 0) return "document";
	if (cleaned.length <= MAX_TASK_FILE_NAME_LENGTH) return cleaned;
	const dot = cleaned.lastIndexOf(".");
	const extension =
		dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
	return `${cleaned.slice(0, MAX_TASK_FILE_NAME_LENGTH - extension.length)}${extension}`;
}

function taskPath(taskId: string): `/v1/tasks/${string}` {
	return `/v1/tasks/${encodeURIComponent(taskId)}`;
}

function untrustedServerUrl(
	field: string,
	what: string,
	kind: "upload" | "result",
): MineruApiError {
	return new MineruApiError({
		code:
			kind === "upload"
				? MINERU_CLIENT_ERROR_CODES.untrustedUploadUrl
				: MINERU_CLIENT_ERROR_CODES.untrustedResultUrl,
		message: `MinerU returned a ${field} this client will not use (${what}).`,
	});
}

function untrustedRedirect(what: string, path: string): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.untrustedRedirect,
		message: `MinerU redirected ${path} somewhere this client will not follow (${what}).`,
		requestPath: path,
	});
}

/**
 * A 3xx this client does not follow. The request was made with `redirect:
 * "manual"`, so it arrives as an answer; its body is drained so the connection
 * is not left holding it, and it becomes the error.
 */
async function refuseRedirect(
	response: Response,
	what: string,
	path: string,
): Promise<never> {
	await response.arrayBuffer().catch(() => undefined);
	throw untrustedRedirect(what, path);
}

function downloadTooLarge(
	cap: number,
	announced: number | null,
	path: string,
): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.downloadTooLarge,
		message:
			announced !== null && announced > cap
				? `MinerU announced a ${announced} byte result, over the ${cap} byte ceiling.`
				: `MinerU download exceeded ${cap} bytes.`,
		requestPath: path,
		details: { cap, announced },
	});
}

/** A Content-Length that is a plain non-negative integer, else null. */
function parseContentLength(header: string | null): number | null {
	if (header === null || !/^\d+$/.test(header.trim())) return null;
	return Number(header.trim());
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
