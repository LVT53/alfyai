/**
 * An in-process MinerU 4.0.4 V1 server, for tests.
 *
 * It speaks REAL HTTP on an ephemeral loopback port rather than impersonating
 * `fetch`, because the three things most likely to be wrong in this client are
 * things a fake `fetch` cannot exercise: a streamed request body with
 * `duplex: "half"`, a streamed response piped to disk, and the
 * `Authorization`-only-on-our-own-origin rule (which needs two origins that
 * both resolve — `127.0.0.1` and `localhost` on the same port).
 *
 * Every behaviour below mirrors a recorded fixture, including the ones that
 * are surprising: the PUT answers 200 for the wrong bytes, the hash mismatch
 * surfaces only at `complete`, a bad `file_id` is accepted with a 202 and fails
 * inside the job, the terminal `output_files` map lists all seven formats with
 * `null` for the unrequested ones, and `restart()` forgets every identifier
 * while the content-addressed bytes survive — so a re-`POST /v1/uploads` with a
 * known sha256 still returns `completed`, with a NEW `file_id`.
 *
 * Control API (everything a test needs, and nothing that hides a bug):
 *
 * ```ts
 * const server = await createFakeMineruServer({ fixtureInput: "docx" });
 * server.baseUrl;            // "http://127.0.0.1:<port>" — feed it to MineruConfig
 * server.crossOriginBaseUrl; // same port, hostname "localhost" — a FOREIGN origin
 * server.requests;           // every request, in order: method, path, json, headers
 * server.jobs;               // jobId -> { status, tier }
 * server.restart();          // forget all ids, keep the bytes
 * server.setOptions({ … });  // change behaviour mid-test
 * await server.close();
 * ```
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MINERU_OCR_MODES,
	MINERU_OUTPUT_FORMATS,
	type MineruTierId,
} from "../config";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/fixtures/mineru-v1` — six levels up from `services/mineru/testing/`. */
export const MINERU_FIXTURE_ROOT = join(
	HERE,
	"../../../../../../fixtures/mineru-v1",
);

/**
 * A directory name under `fixtures/mineru-v1/`: one of the nine recorded
 * inputs (pdf, docx, xlsx, pptx, html, csv, epub, png, jpg) or flash-pdf, the
 * same PDF parsed by a flash-tier server.
 *
 * Deliberately a plain string rather than a union of those names: a union of
 * file extensions inside a module is exactly the ad-hoc file-type map that
 * `shared/file-types/no-ad-hoc-maps.test.ts` exists to forbid, and this module
 * classifies FIXTURE DIRECTORIES, not user files. A wrong name fails loudly on
 * the first read.
 */
export type FakeMineruFixtureInput = string;

/** The default fixture directory: the three-page PDF. */
const DEFAULT_FIXTURE_INPUT = "pdf";

/** Recorded probes are stored one per JSON file under `errors/`. */
const PROBE_SUFFIX = ".json";

/** What a job does once it reaches a terminal state. */
export type FakeMineruJobOutcome =
	| "completed"
	/** `status: "completed"` but `output_files.zip` is null. */
	| "completed-without-zip"
	/** UNVERIFIED upstream — no recorded fixture is a multi-file job. */
	| "partial"
	/** Job `failed`, no file-level error at all. */
	| "failed"
	/** Job `failed` with a file-level error (default: `parse_failed`). */
	| "file-failed";

export interface FakeMineruFailure {
	/** Matched as a prefix of the request path. */
	path: string;
	method?: string;
	/** 1-based. Omitted ⇒ every matching request fails. */
	nth?: number;
	/** A probe name under `fixtures/mineru-v1/errors/`, with or without a suffix. */
	fixture: string;
}

export interface FakeMineruServerOptions {
	/** Tiers the fake advertises. Default `["flash","basic"]`. */
	tiers?: readonly MineruTierId[];
	/** Simulated parse time. The poll loop must survive it. Default 0. */
	parseDelayMs?: number;
	/** Never reach a terminal status — for cancel and deadline tests. */
	neverFinish?: boolean;
	failures?: ReadonlyArray<FakeMineruFailure>;
	/** Bytes persist, ids do not — exactly the recorded restart semantics. */
	restartAfterMs?: number;
	/** Which input fixture directory answers downloads. Defaults to the PDF. */
	fixtureInput?: FakeMineruFixtureInput;
	/** When set, everything but `/v1/health` demands this bearer token. */
	apiKey?: string;
	jobOutcome?: FakeMineruJobOutcome;
	/**
	 * The file-level error a `file-failed` job reports. Defaults to the generic
	 * `parse_failed` / "Parse failed". 4.0.4 says a great deal more than that —
	 * "Failed to load document (PDFium: Data format error)." for a damaged PDF —
	 * and the verdict turns entirely on the wording.
	 */
	fileError?: { code?: string; message?: string };
	/** Serve `/v1/files/{id}/content` as a 302 instead of a stream. */
	redirectDownloads?: "same-origin" | "cross-origin";
}

export interface FakeMineruRequest {
	method: string;
	path: string;
	/** Parsed JSON request body, when there was one. */
	json?: unknown;
	/** Byte length of a non-JSON body (the upload PUT). Never its content. */
	bodyBytes?: number;
	headers: Record<string, string>;
}

export interface FakeMineruServer {
	readonly baseUrl: string;
	/** The same server on a hostname that is NOT the configured origin. */
	readonly crossOriginBaseUrl: string;
	readonly port: number;
	/** Drop-in for `fetch`, for a caller that wants the spec's shape. */
	readonly fetchImpl: typeof fetch;
	readonly requests: ReadonlyArray<FakeMineruRequest>;
	readonly jobs: ReadonlyMap<string, { status: string; tier: string }>;
	/** sha256 → byte length. Survives `restart()`. */
	readonly blobs: ReadonlyMap<string, number>;
	/** Forgets every upload/file/job id; keeps the content-addressed blobs. */
	restart(): void;
	/** Change behaviour mid-test. */
	setOptions(patch: FakeMineruServerOptions): void;
	/** Clears the request log and the failure counters. */
	resetLog(): void;
	close(): Promise<void>;
}

interface UploadRecord {
	id: string;
	bytes: number;
	filename: string;
	mimeType: string;
	sha256sum: string | null;
	status: "pending" | "completed" | "cancelled";
	received: Buffer | null;
	fileId: string | null;
	createdAt: number;
}

interface FileRecord {
	id: string;
	filename: string;
	purpose: "parse" | "parse_output";
	sha256sum: string | null;
	bytes: number;
	/** Absolute path of the fixture artifact this id serves, for outputs. */
	artifactPath: string | null;
}

interface JobRecord {
	id: string;
	fileId: string;
	fileName: string;
	tier: MineruTierId;
	outputFormats: string[];
	createdAt: number;
	polls: number;
	canceled: boolean;
	/** Set when the job must fail on a file-level error. */
	fileError: {
		type: string;
		code: string;
		message: string;
		param: string | null;
	} | null;
	outputFileIds: Partial<Record<string, string>> | null;
}

const ARTIFACTS = {
	markdown: "markdown.md",
	middle_json: "middle_json.json",
	structured_content: "structured_content.json",
	zip: "result.zip",
} as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function createFakeMineruServer(
	initialOptions: FakeMineruServerOptions = {},
): Promise<FakeMineruServer> {
	let options: FakeMineruServerOptions = { ...initialOptions };
	const requests: FakeMineruRequest[] = [];
	const blobs = new Map<string, Buffer>();
	let uploads = new Map<string, UploadRecord>();
	let files = new Map<string, FileRecord>();
	let jobs = new Map<string, JobRecord>();
	const failureCounts = new Map<string, number>();
	let sequence = 0;

	const nextId = (prefix: string) => {
		sequence += 1;
		return `${prefix}${String(sequence).padStart(12, "0")}`;
	};

	const fixtureDir = () =>
		join(MINERU_FIXTURE_ROOT, options.fixtureInput ?? DEFAULT_FIXTURE_INPUT);

	/**
	 * Whether this input needs a quality tier, read from the fixture rather
	 * than from a hard-coded list: `extensions.mineru.tier` records what
	 * actually parsed the file, and it is flash for every Office/HTML/CSV/EPUB
	 * input even inside a basic job.
	 */
	function fixtureNeedsQualityTier(): boolean {
		try {
			const structured = JSON.parse(
				readFileSync(join(fixtureDir(), "structured_content.json"), "utf8"),
			) as { extensions?: { mineru?: { tier?: string } } };
			return (structured.extensions?.mineru?.tier ?? "flash") !== "flash";
		} catch {
			return false;
		}
	}

	function tiers(): readonly MineruTierId[] {
		return options.tiers ?? ["flash", "basic"];
	}

	function jsonResponse(
		res: ServerResponse,
		status: number,
		body: unknown,
	): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(payload),
		});
		res.end(payload);
	}

	function errorResponse(
		res: ServerResponse,
		status: number,
		type: string,
		code: string,
		message: string,
		param: string | null = null,
	): void {
		jsonResponse(res, status, { error: { type, code, message, param } });
	}

	function fixtureFailure(
		res: ServerResponse,
		method: string,
		path: string,
	): boolean {
		for (const [index, failure] of (options.failures ?? []).entries()) {
			if (failure.method && failure.method !== method) continue;
			if (!path.startsWith(failure.path)) continue;
			const key = `${index}`;
			const seen = (failureCounts.get(key) ?? 0) + 1;
			failureCounts.set(key, seen);
			if (failure.nth !== undefined && failure.nth !== seen) continue;
			const name = failure.fixture.includes(".")
				? failure.fixture
				: `${failure.fixture}${PROBE_SUFFIX}`;
			const probe = JSON.parse(
				readFileSync(join(MINERU_FIXTURE_ROOT, "errors", name), "utf8"),
			) as { http_status: number; body: unknown };
			jsonResponse(res, probe.http_status, probe.body);
			return true;
		}
		return false;
	}

	function authorized(req: IncomingMessage, path: string): boolean {
		if (!options.apiKey) return true;
		if (path === "/v1/health") return true;
		return req.headers.authorization === `Bearer ${options.apiKey}`;
	}

	function uploadResponse(upload: UploadRecord, host: string): unknown {
		const file = upload.fileId ? files.get(upload.fileId) : null;
		return {
			id: upload.id,
			object: "upload",
			bytes: upload.bytes,
			created_at: Math.floor(upload.createdAt / 1000),
			expires_at: Math.floor(upload.createdAt / 1000) + 3600,
			filename: upload.filename,
			purpose: "parse",
			mime_type: upload.mimeType,
			sha256sum: upload.sha256sum,
			status: upload.status,
			upload_url:
				upload.status === "pending"
					? `http://${host}/v1/uploads/${upload.id}/content`
					: null,
			upload_method: upload.status === "pending" ? "PUT" : null,
			upload_headers:
				upload.status === "pending"
					? { "Content-Type": upload.mimeType }
					: null,
			file: file
				? {
						id: file.id,
						object: "file",
						bytes: file.bytes,
						created_at: Math.floor(upload.createdAt / 1000),
						expires_at: Math.floor(upload.createdAt / 1000) + 3600,
						filename: file.filename,
						purpose: file.purpose,
						sha256sum: file.sha256sum,
					}
				: null,
		};
	}

	function mintOutputFiles(job: JobRecord): Partial<Record<string, string>> {
		if (job.outputFileIds) return job.outputFileIds;
		const minted: Partial<Record<string, string>> = {};
		for (const format of job.outputFormats) {
			const artifact = ARTIFACTS[format as keyof typeof ARTIFACTS];
			if (!artifact) continue;
			const path = join(fixtureDir(), artifact);
			const id = nextId("file-");
			files.set(id, {
				id,
				filename: `${job.fileName}.${format}`,
				purpose: "parse_output",
				sha256sum: null,
				bytes: statSync(path).size,
				artifactPath: path,
			});
			minted[format] = id;
		}
		job.outputFileIds = minted;
		return minted;
	}

	function jobStatus(job: JobRecord): string {
		if (job.canceled) return "canceled";
		if (options.neverFinish) return job.polls > 1 ? "running" : "queued";
		const elapsed = Date.now() - job.createdAt;
		if (elapsed < (options.parseDelayMs ?? 0)) {
			return job.polls > 1 ? "running" : "queued";
		}
		if (job.fileError) return "failed";
		switch (options.jobOutcome ?? "completed") {
			case "failed":
				return "failed";
			case "file-failed":
				return "failed";
			case "partial":
				return "partial";
			default:
				return "completed";
		}
	}

	function jobResponse(job: JobRecord, atCreate = false): unknown {
		// A create is ALWAYS a 202 `queued`, even for an unknown file id: the
		// server accepts the job and only fails it once the engine looks.
		const status = atCreate ? "queued" : jobStatus(job);
		const terminal = ["completed", "partial", "failed", "canceled"].includes(
			status,
		);
		const outcome = options.jobOutcome ?? "completed";
		const fileError =
			(terminal ? job.fileError : null) ??
			(terminal && outcome === "file-failed"
				? {
						type: "engine_error",
						code: options.fileError?.code ?? "parse_failed",
						message: options.fileError?.message ?? "Parse failed",
						param: null,
					}
				: null);

		const succeeded =
			terminal && !fileError && status !== "failed" && status !== "canceled";
		const outputs = succeeded ? mintOutputFiles(job) : null;

		const outputFiles = outputs
			? {
					markdown: outputRef(outputs.markdown),
					middle_json: outputRef(outputs.middle_json),
					structured_content: outputRef(outputs.structured_content),
					html: null,
					latex: null,
					docx: null,
					zip:
						outcome === "completed-without-zip" ? null : outputRef(outputs.zip),
				}
			: null;

		return {
			job_id: job.id,
			status,
			created_at: new Date(job.createdAt).toISOString(),
			started_at: terminal ? new Date(job.createdAt).toISOString() : null,
			finished_at: terminal ? new Date().toISOString() : null,
			tier: job.tier,
			output_formats: job.outputFormats,
			access_level: options.apiKey ? "registered" : "anonymous",
			progress: {
				completed: succeeded ? 1 : 0,
				failed: terminal && !succeeded ? 1 : 0,
				total: 1,
			},
			files: [
				{
					file_id: job.fileId,
					name: job.fileName,
					// "" while queued, a normalised range once terminal — NOT null.
					page_range: terminal && succeeded ? "1-1" : "",
					status: terminal ? (succeeded ? "completed" : "failed") : status,
					parse: succeeded
						? {
								model_used: null,
								duration_ms: 12,
								parser_version: "4.0.4",
							}
						: null,
					output_files: outputFiles,
					error: fileError,
				},
			],
			links: {
				self: `/v1/parse/jobs/${job.id}`,
				cancel: `/v1/parse/jobs/${job.id}`,
			},
		};
	}

	function outputRef(fileId: string | undefined): unknown {
		if (!fileId) return null;
		const file = files.get(fileId);
		if (!file) return null;
		return { file_id: file.id, bytes: file.bytes };
	}

	async function readBody(req: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			if (!res.headersSent) {
				errorResponse(res, 500, "engine_error", "internal", String(error));
			} else {
				res.end();
			}
		});
	});

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const method = req.method ?? "GET";
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const path = url.pathname;
		const raw = await readBody(req);

		let json: unknown;
		if (raw.length > 0 && !path.endsWith("/content")) {
			try {
				json = JSON.parse(raw.toString("utf8"));
			} catch {
				json = undefined;
			}
		}
		requests.push({
			method,
			path,
			json,
			bodyBytes: raw.length,
			headers: Object.fromEntries(
				Object.entries(req.headers).map(([k, v]) => [k, String(v ?? "")]),
			),
		});

		if (!authorized(req, path)) {
			errorResponse(
				res,
				401,
				"authentication_error",
				"invalid_api_key",
				"Invalid or missing API key",
			);
			return;
		}
		if (fixtureFailure(res, method, path)) return;

		// -- capability reads -------------------------------------------------
		if (method === "GET" && path === "/v1/health") {
			jsonResponse(res, 200, {
				status: "ok",
				version: "4.0.4",
				features: {
					webhook: false,
					output_formats: [...MINERU_OUTPUT_FORMATS],
					sources: ["file_id", "url", "inline"],
				},
			});
			return;
		}
		if (method === "GET" && path === "/v1/tiers") {
			jsonResponse(res, 200, {
				object: "list",
				data: tiers().map((id) => ({
					id,
					description:
						id === "flash"
							? "Fast local text extraction."
							: "Basic parsing with local lightweight models.",
					current_model: id === "flash" ? "flash" : "hybrid-basic",
				})),
			});
			return;
		}
		if (method === "GET" && path === "/v1/usage") {
			jsonResponse(res, 200, {
				object: "usage",
				access_level: options.apiKey ? "registered" : "anonymous",
				current: { pages_processed: 0, files_processed: 0, jobs_created: 0 },
				limits: {
					max_pages_per_file: 1000,
					max_file_size_bytes: 209715200,
					max_files_per_job: 100,
					max_concurrent_jobs: 1,
					max_file_retention_days: null,
				},
			});
			return;
		}

		// -- uploads -----------------------------------------------------------
		if (method === "POST" && path === "/v1/uploads") {
			handleCreateUpload(res, json, String(req.headers.host));
			return;
		}
		const putMatch = /^\/v1\/uploads\/([^/]+)\/content$/.exec(path);
		if (method === "PUT" && putMatch) {
			handlePutContent(res, putMatch[1], raw);
			return;
		}
		const completeMatch = /^\/v1\/uploads\/([^/]+)\/complete$/.exec(path);
		if (method === "POST" && completeMatch) {
			handleComplete(res, completeMatch[1], json, String(req.headers.host));
			return;
		}

		// -- jobs ---------------------------------------------------------------
		if (method === "POST" && path === "/v1/parse/jobs") {
			handleCreateJob(res, json);
			return;
		}
		const jobMatch = /^\/v1\/parse\/jobs\/([^/]+)$/.exec(path);
		if (jobMatch && (method === "GET" || method === "DELETE")) {
			handleJob(res, method, jobMatch[1]);
			return;
		}

		// -- files ---------------------------------------------------------------
		const contentMatch = /^\/v1\/files\/([^/]+)\/content$/.exec(path);
		if (method === "GET" && contentMatch) {
			handleFileContent(res, contentMatch[1], String(req.headers.host));
			return;
		}
		const fileMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
		if (method === "GET" && fileMatch) {
			const file = files.get(fileMatch[1]);
			if (!file) {
				errorResponse(
					res,
					404,
					"invalid_request_error",
					"file_not_found",
					`File ${fileMatch[1]} not found`,
				);
				return;
			}
			jsonResponse(res, 200, {
				id: file.id,
				object: "file",
				bytes: file.bytes,
				created_at: 1789908394,
				expires_at: null,
				filename: file.filename,
				purpose: file.purpose,
				sha256sum: file.sha256sum,
			});
			return;
		}

		errorResponse(
			res,
			404,
			"invalid_request_error",
			"not_found",
			`No route for ${method} ${path}`,
		);
	}

	function handleCreateUpload(
		res: ServerResponse,
		json: unknown,
		host: string,
	): void {
		const body = (json ?? {}) as Record<string, unknown>;
		if (typeof body.bytes !== "number") {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"invalid_request",
				"Invalid request: bytes: Field required",
				"bytes",
			);
			return;
		}
		if (body.purpose !== undefined && body.purpose !== "parse") {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"invalid_request",
				"Invalid request: purpose: Input should be 'parse' or 'input_image'",
				"purpose",
			);
			return;
		}
		const sha = typeof body.sha256sum === "string" ? body.sha256sum : null;
		if (sha !== null && !SHA256_PATTERN.test(sha)) {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"invalid_request",
				"Invalid request: sha256sum: String should match pattern '^[a-f0-9]{64}$'",
				"sha256sum",
			);
			return;
		}

		const id = nextId("upload_");
		const upload: UploadRecord = {
			id,
			bytes: body.bytes,
			filename: String(body.filename ?? "document"),
			mimeType: String(body.mime_type ?? "application/octet-stream"),
			sha256sum: sha,
			status: "pending",
			received: null,
			fileId: null,
			createdAt: Date.now(),
		};

		// The dedupe hit: bytes are content-addressed and survive a restart, so a
		// known sha completes instantly — with a BRAND NEW file id.
		if (sha && blobs.has(sha)) {
			upload.status = "completed";
			upload.fileId = registerInputFile(upload, blobs.get(sha) as Buffer);
		}
		uploads.set(id, upload);
		jsonResponse(res, 200, uploadResponse(upload, host));
	}

	function registerInputFile(upload: UploadRecord, bytes: Buffer): string {
		const id = nextId("file-");
		files.set(id, {
			id,
			filename: upload.filename,
			purpose: "parse",
			sha256sum: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			artifactPath: null,
		});
		return id;
	}

	function handlePutContent(
		res: ServerResponse,
		uploadId: string,
		raw: Buffer,
	): void {
		const upload = uploads.get(uploadId);
		if (!upload) {
			errorResponse(
				res,
				404,
				"invalid_request_error",
				"upload_not_found",
				`Upload ${uploadId} not found`,
			);
			return;
		}
		if (raw.length !== upload.bytes) {
			errorResponse(
				res,
				413,
				"invalid_request_error",
				"upload_size_mismatch",
				`Upload expects ${upload.bytes} bytes, received ${raw.length}`,
			);
			return;
		}
		// 200 even for the WRONG bytes: the hash is only checked at complete.
		upload.received = raw;
		res.writeHead(200);
		res.end();
	}

	function handleComplete(
		res: ServerResponse,
		uploadId: string,
		json: unknown,
		host: string,
	): void {
		const upload = uploads.get(uploadId);
		if (!upload) {
			errorResponse(
				res,
				404,
				"invalid_request_error",
				"upload_not_found",
				`Upload ${uploadId} not found`,
			);
			return;
		}
		if (!upload.received) {
			errorResponse(
				res,
				409,
				"invalid_request_error",
				"upload_not_ready",
				"Upload bytes not yet received",
			);
			return;
		}
		const claimed =
			(json as { sha256sum?: string } | undefined)?.sha256sum ??
			upload.sha256sum ??
			"";
		const actual = createHash("sha256").update(upload.received).digest("hex");
		if (claimed !== actual) {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"file_hash_mismatch",
				"SHA-256 mismatch",
			);
			return;
		}
		blobs.set(actual, upload.received);
		upload.sha256sum = actual;
		upload.status = "completed";
		upload.fileId = registerInputFile(upload, upload.received);
		jsonResponse(res, 200, uploadResponse(upload, host));
	}

	function handleCreateJob(res: ServerResponse, json: unknown): void {
		const body = (json ?? {}) as Record<string, unknown>;
		const requested = Array.isArray(body.files) ? body.files : [];
		if (requested.length === 0) {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"invalid_request",
				"Invalid request: files: List should have at least 1 item after validation",
				"files",
			);
			return;
		}
		if ("callback" in body && body.callback !== undefined) {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"invalid_request",
				"Webhook callback is not supported by this Local Parse Server",
			);
			return;
		}
		if ("ocr_mode" in body) {
			const mode = body.ocr_mode;
			if (!(MINERU_OCR_MODES as readonly unknown[]).includes(mode)) {
				errorResponse(
					res,
					400,
					"invalid_request_error",
					"invalid_request",
					`Invalid request: ocr_mode: Input should be ${MINERU_OCR_MODES.map(
						(value) => `'${value}'`,
					).join(" or ")}`,
					"ocr_mode",
				);
				return;
			}
		}

		const formats = Array.isArray(body.output_formats)
			? (body.output_formats as string[])
			: [...MINERU_OUTPUT_FORMATS];
		const unsupported = formats.filter((format) => !(format in ARTIFACTS));
		if (unsupported.length > 0) {
			errorResponse(
				res,
				400,
				"invalid_request_error",
				"unsupported_output_format",
				`Unknown output format: ${unsupported[0]}`,
			);
			return;
		}

		const flashOnly = tiers().length === 1 && tiers()[0] === "flash";
		let tier: MineruTierId;
		if ("tier" in body && body.tier !== undefined) {
			if (body.tier === null) {
				// Recorded: a null tier on a flash-only server is the same 503 as
				// omitting it; elsewhere pydantic rejects it outright.
				if (flashOnly) {
					errorResponse(
						res,
						503,
						"engine_error",
						"quality_tier_unavailable",
						"No basic, standard, or advanced tier available in this server",
					);
					return;
				}
				errorResponse(
					res,
					400,
					"invalid_request_error",
					"invalid_request",
					"Invalid request: tier: Input should be 'flash', 'basic', 'standard' or 'advanced'",
					"tier",
				);
				return;
			}
			const value = String(body.tier);
			if (!["flash", "basic", "standard", "advanced"].includes(value)) {
				errorResponse(
					res,
					400,
					"invalid_request_error",
					"invalid_request",
					"Invalid request: tier: Input should be 'flash', 'basic', 'standard' or 'advanced'",
					"tier",
				);
				return;
			}
			if (!tiers().includes(value as MineruTierId)) {
				errorResponse(
					res,
					400,
					"invalid_request_error",
					"invalid_request",
					`Tier '${value}' not available in this server`,
				);
				return;
			}
			tier = value as MineruTierId;
		} else {
			const needsQuality = fixtureNeedsQualityTier();
			if (flashOnly && needsQuality) {
				errorResponse(
					res,
					503,
					"engine_error",
					"quality_tier_unavailable",
					"No basic, standard, or advanced tier available in this server",
				);
				return;
			}
			tier = flashOnly
				? "flash"
				: ((tiers().at(-1) ?? "flash") as MineruTierId);
		}

		const source = (requested[0] as { source?: { file_id?: string } }).source;
		const fileId = source?.file_id ?? "";
		const known = files.get(fileId);

		const job: JobRecord = {
			id: nextId("job_"),
			fileId,
			fileName: known?.filename ?? fileId,
			tier,
			outputFormats: formats,
			createdAt: Date.now(),
			polls: 0,
			canceled: false,
			// A 202 proves nothing: an unknown file id is accepted here and the
			// job fails later with a file-level engine_error.
			fileError: known
				? null
				: {
						type: "engine_error",
						code: "parse_failed",
						message: `File ${fileId} not found`,
						param: null,
					},
			outputFileIds: null,
		};
		jobs.set(job.id, job);
		jsonResponse(res, 202, jobResponse(job, true));
	}

	function handleJob(res: ServerResponse, method: string, jobId: string): void {
		const job = jobs.get(jobId);
		if (!job) {
			errorResponse(
				res,
				404,
				"invalid_request_error",
				"job_not_found",
				`Job ${jobId} not found`,
			);
			return;
		}
		if (method === "GET") {
			job.polls += 1;
			jsonResponse(res, 200, jobResponse(job));
			return;
		}
		const status = jobStatus(job);
		if (["completed", "partial", "failed", "canceled"].includes(status)) {
			errorResponse(
				res,
				409,
				"invalid_request_error",
				"job_already_terminal",
				`Job is ${status}`,
			);
			return;
		}
		job.canceled = true;
		jsonResponse(res, 200, {
			job_id: job.id,
			status: "canceled",
			canceled_at: new Date().toISOString(),
		});
	}

	function handleFileContent(
		res: ServerResponse,
		fileId: string,
		host: string,
	): void {
		const file = files.get(fileId);
		if (!file?.artifactPath) {
			errorResponse(
				res,
				404,
				"invalid_request_error",
				"file_not_found",
				`File ${fileId} not found`,
			);
			return;
		}
		if (options.redirectDownloads) {
			const target =
				options.redirectDownloads === "cross-origin"
					? `http://localhost:${port}/v1/files/${fileId}/content`
					: `http://${host}/v1/files/${fileId}/content`;
			// Setting it once and clearing the flag keeps the redirect from
			// looping forever when the client follows it.
			options = { ...options, redirectDownloads: undefined };
			res.writeHead(302, { location: target });
			res.end();
			return;
		}
		const bytes = readFileSync(file.artifactPath);
		// Always octet-stream, and never a Content-Disposition: the client has to
		// know what it asked for.
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": bytes.length,
		});
		res.end(bytes);
	}

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port =
		address && typeof address === "object" ? address.port : Number(address);

	let restartTimer: NodeJS.Timeout | null = null;
	const restart = () => {
		uploads = new Map();
		files = new Map();
		jobs = new Map();
	};
	if (options.restartAfterMs !== undefined) {
		restartTimer = setTimeout(restart, options.restartAfterMs);
		restartTimer.unref?.();
	}

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		crossOriginBaseUrl: `http://localhost:${port}`,
		port,
		fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
		requests,
		get jobs() {
			return new Map(
				[...jobs.values()].map((job) => [
					job.id,
					{ status: jobStatus(job), tier: job.tier },
				]),
			);
		},
		get blobs() {
			return new Map(
				[...blobs.entries()].map(([sha, bytes]) => [sha, bytes.length]),
			);
		},
		restart,
		setOptions(patch) {
			options = { ...options, ...patch };
		},
		resetLog() {
			requests.length = 0;
			failureCounts.clear();
		},
		close() {
			if (restartTimer) clearTimeout(restartTimer);
			return new Promise<void>((resolve, reject) => {
				server.close((error?: Error) => (error ? reject(error) : resolve()));
			});
		},
	} satisfies FakeMineruServer & { close: () => Promise<void> };
}

/** Reads a recorded probe fixture: `{ http_status, body, … }`. */
export function readMineruErrorFixture(name: string): {
	probe: string;
	http_status?: number;
	body?: unknown;
} {
	const file = name.endsWith(".json") ? name : `${name}.json`;
	return JSON.parse(
		readFileSync(join(MINERU_FIXTURE_ROOT, "errors", file), "utf8"),
	);
}

/** Reads any fixture JSON, e.g. `readMineruFixtureJson("pdf/job.final.json")`. */
export function readMineruFixtureJson<T = unknown>(relativePath: string): T {
	return JSON.parse(
		readFileSync(join(MINERU_FIXTURE_ROOT, relativePath), "utf8"),
	) as T;
}
