/**
 * An in-process MinerU 4.1.7 server, for tests.
 *
 * It speaks REAL HTTP on an ephemeral loopback port rather than impersonating
 * `fetch`, because the things most likely to be wrong in this client are things
 * a fake `fetch` cannot exercise: a streamed request body with `duplex: "half"`,
 * a streamed response piped to disk, and the `Authorization`-only-on-our-own-
 * origin rule (which needs two origins that both resolve: `127.0.0.1` and
 * `localhost` on the same port).
 *
 * Every behaviour mirrors a capture in `fixtures/mineru-v41/protocol/`, and
 * `fake-server.test.ts` holds it to them. The ones worth knowing about:
 *
 *  - `POST /v1/tasks` takes a JSON manifest and answers 202. A file whose
 *    sha256 the server already holds is `pending` with NO `upload` object (the
 *    hash cache); every other file is `waiting-file` with one.
 *  - The bytes go to `upload.url` by PUT. A wrong length or a wrong hash is a
 *    400 and the file keeps waiting; a repeat PUT is a 200 with the file's
 *    current status.
 *  - A file with bytes is `pending`, then `running`, then `completed`,
 *    `failed` or (after a cancel) `canceled`. A task is `partial` when it holds
 *    a completed file beside a failed one. Each completed file has its own
 *    `result_url`.
 *  - A cancel stops every unfinished file, running ones included, and leaves
 *    finished files finished and downloadable (spike D24).
 *  - `restart()` forgets every task, every file AND the hash cache, so the
 *    same bytes must be uploaded again (spike section 8).
 *  - Anything that is not a `/v1/tasks` route is FastAPI's `{"detail":"Not
 *    Found"}` (or `Method Not Allowed`), not MinerU's `{error}` envelope.
 *
 * Control API (everything a test needs, and nothing that hides a bug):
 *
 * ```ts
 * const server = await createFakeMineruServer({ parseDelayMs: 20 });
 * server.baseUrl;            // "http://127.0.0.1:<port>": feed it to MineruConfig
 * server.crossOriginBaseUrl; // same port, hostname "localhost": a FOREIGN origin
 * server.requests;           // every request, in order: method, path, json, headers
 * server.tasks;              // taskId -> { status, files: [{ fileId, fileName, status }] }
 * server.restart();          // forget all ids and the hash cache
 * server.setOptions({ ... }); // change behaviour mid-test
 * await server.close();
 * ```
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntakeTierHint } from "$lib/shared/file-types";
import {
	MINERU_OCR_MODES,
	MINERU_TIER_IDS,
	type MineruTierId,
} from "../config";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * `<repo>/fixtures/mineru-v1`: the 4.0.4 corpus (three-page PDF and eight other
 * inputs, each with a recorded result ZIP). Six levels up from
 * `services/mineru/testing/`. Its protocol captures are retired; its ZIPs and
 * sample files are still what the result and bundle tests parse.
 */
export const MINERU_FIXTURE_ROOT = join(
	HERE,
	"../../../../../../fixtures/mineru-v1",
);

/**
 * `<repo>/fixtures/mineru-v41/protocol`: the captured MinerU 4.1 answers (create
 * and PUT receipts, task snapshots, cancel receipts, error bodies, three result
 * ZIPs), copied byte for byte from the 4.1 spike. Anchored on this file rather
 * than on `process.cwd()`, because some suites chdir into a scratch directory.
 */
export const MINERU_PROTOCOL_FIXTURE_ROOT = join(
	HERE,
	"../../../../../../fixtures/mineru-v41/protocol",
);

/** Reads a captured 4.1 body: `readMineruProtocolFixture("server/tiers.json")`. */
export function readMineruProtocolFixture<T = unknown>(
	relativePath: string,
): T {
	return JSON.parse(
		readFileSync(join(MINERU_PROTOCOL_FIXTURE_ROOT, relativePath), "utf8"),
	) as T;
}

/**
 * Which result ZIP answers downloads. A plain string rather than a union of
 * file extensions: a union of extensions inside a module is exactly the ad-hoc
 * file-type map `shared/file-types/no-ad-hoc-maps.test.ts` exists to forbid, and
 * this module names FIXTURES, not user files. A wrong name fails loudly on the
 * first download.
 *
 * Looked up in `fixtures/mineru-v41/protocol/zips/<name>.zip` (three 4.1
 * results: the PDF, the Word document and the CSV), then in
 * `fixtures/mineru-v1/<name>/` (the 4.0.4 results for the other inputs, which the
 * result parser reads the same).
 */
export type FakeMineruFixtureInput = string;

const DEFAULT_FIXTURE_INPUT = "pdf";

const SERVER_VERSION = "4.1.7";
const UPLOAD_TTL_SECONDS = 3600;
const MAX_FILES_PER_TASK = 100;
const MAX_FILE_NAME_LENGTH = 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * What a 4.1.7 server lists under `features` of `/v1/health`: the output
 * formats it accepts for a task, and its sources. Read from the capture instead
 * of retyped, so there is one record of it, and so this module names no file
 * extension of its own.
 */
let recordedFeatures: {
	task_output_formats: string[];
	sources: string[];
} | null = null;

function serverFeatures(): {
	task_output_formats: string[];
	sources: string[];
} {
	recordedFeatures ??= readMineruProtocolFixture<{
		response: {
			json: { features: { task_output_formats: string[]; sources: string[] } };
		};
	}>("server/health_no_key.json").response.json.features;
	return recordedFeatures;
}

/** What a file ends up as once its bytes are in and the parse has run. */
export type FakeMineruFileOutcome =
	| "completed"
	/** Completed, but the snapshot omits `result_url`: a broken server. */
	| "completed-without-result-url"
	/** `failed` with a `parse_failed` error (see `fileError`). */
	| "file-failed"
	/** `failed` with no `error` object at all: a broken server. */
	| "failed-without-detail"
	/** Never finishes: `running` until a cancel (or the test ends). */
	| "stuck";

export type FakeMineruFailure = {
	/** Matched as a prefix of the request path. */
	path: string;
	method?: string;
	/** 1-based. Omitted: every matching request fails. */
	nth?: number;
} & (
	| {
			/** A capture under `fixtures/mineru-v41/protocol/`, e.g. `errors/49_removed_post_uploads.json`. */
			fixture: string;
	  }
	| { status: number; body: unknown }
);

export interface FakeMineruServerOptions {
	/** The tiers the server offers, which is its ceiling. Default: what production runs. */
	tiers?: readonly MineruTierId[];
	/** Simulated parse time per file, from the moment its bytes arrive. Default 0. */
	parseDelayMs?: number;
	/** No file ever finishes: for cancel and deadline tests. Same as outcome "stuck". */
	neverFinish?: boolean;
	failures?: ReadonlyArray<FakeMineruFailure>;
	/** Forget everything this many ms after the server starts. */
	restartAfterMs?: number;
	/**
	 * Forget everything the instant the FIRST task is created (after its 202 has
	 * gone out). A wall clock cannot say "after the create, before the PUT" on a
	 * loaded machine; an event can. Fires once.
	 */
	restartAfterFirstTask?: boolean;
	/**
	 * Forget everything the instant the FIRST upload has been accepted (after its
	 * 200): the task exists, its bytes are on the server, and then the ids go.
	 * Fires once.
	 */
	restartAfterFirstUpload?: boolean;
	/** Which result ZIP answers downloads. Defaults to the PDF. */
	fixtureInput?: FakeMineruFixtureInput;
	/** When set, everything but `/v1/health` and `/v1/tiers` demands this bearer token. */
	apiKey?: string;
	/** What every file ends as. Default `completed`. */
	outcome?: FakeMineruFileOutcome;
	/** A per-file override of `outcome`, for tasks that hold more than one file. */
	outcomeFor?: (file: {
		fileName: string;
		index: number;
	}) => FakeMineruFileOutcome | undefined;
	/**
	 * The error a failed file reports. Defaults to `parse_failed` / "Parse
	 * failed". 4.1 says the same code for every cause; only the message differs
	 * ("Failed to load document (PDFium: Data format error).").
	 */
	fileError?: { code?: string; message?: string };
	/** Serve a result as a 302 (once) instead of a stream. */
	redirectDownloads?: "same-origin" | "cross-origin";
	/**
	 * Issue `upload.url` and `result_url` on the same origin the request came in
	 * on (the default, and what the real server does), or on `crossOriginBaseUrl`:
	 * a different origin that still reaches this server, so a client that follows
	 * it anyway is caught.
	 */
	urlOrigin?: "request" | "cross-origin";
}

export interface FakeMineruRequest {
	method: string;
	path: string;
	/** Parsed JSON request body, when there was one. */
	json?: unknown;
	/** Byte length of the request body. Never its content. */
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
	readonly tasks: ReadonlyMap<
		string,
		{
			status: string;
			files: ReadonlyArray<{
				fileId: string;
				fileName: string;
				status: string;
			}>;
		}
	>;
	/** sha256 -> byte length: the hash cache. Gone after `restart()`. */
	readonly blobs: ReadonlyMap<string, number>;
	/** Forgets every task, every file and the hash cache. */
	restart(): void;
	/** Change behaviour mid-test. */
	setOptions(patch: FakeMineruServerOptions): void;
	/** Clears the request log and the failure counters. */
	resetLog(): void;
	close(): Promise<void>;
}

type FileState =
	| "waiting-file"
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "canceled";

interface FileRecord {
	id: string;
	index: number;
	name: string;
	/** The size the request declared: the SOURCE, not the result. */
	bytes: number;
	sha256: string | null;
	/** When its bytes arrived (a PUT, or a hash-cache hit). null while waiting. */
	readyAt: number | null;
	/** How many task polls have seen this file with bytes in. */
	observed: number;
	/** Frozen by a cancel: what the file was when the cancel settled it. */
	settled: FileState | null;
}

interface TaskRecord {
	id: string;
	createdAt: number;
	finishedAt: number | null;
	canceled: boolean;
	/** The tier the request asked for, if it asked. */
	tier: MineruTierId | null;
	outputFormats: string[];
	files: FileRecord[];
}

interface Invalid {
	status: number;
	code: string;
	message: string;
	param?: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: Invalid };

interface ParsedFile {
	name: string;
	bytes: number;
	sha256: string | null;
}

interface ParsedCreate {
	files: ParsedFile[];
	tier: MineruTierId | null;
	outputFormats: string[];
}

interface RouteContext {
	req: IncomingMessage;
	res: ServerResponse;
	raw: Buffer;
	url: URL;
	params: string[];
}

interface Route {
	method: string;
	pattern: RegExp;
	/** Answers without a key even on a keyed server. */
	public?: boolean;
	handle(context: RouteContext): void;
}

const TERMINAL_FILE_STATES: readonly FileState[] = [
	"completed",
	"failed",
	"canceled",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
	param: string | undefined,
	message: string,
	code = "invalid_request",
	status = 400,
): { ok: false; error: Invalid } {
	return { ok: false, error: { status, code, message, param } };
}

/** 4.1's file-name rule (spike D18): a basename, no control characters. */
function fileNameProblem(value: unknown): string | null {
	if (typeof value !== "string") return "file_name must be a string";
	if (value === "" || value === "." || value === "..") {
		return "file_name must be a name";
	}
	if (value.length > MAX_FILE_NAME_LENGTH) return "file_name is too long";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f)
			return "file_name has a control character";
	}
	if (/[/\\:]/.test(value)) {
		return "File name must be a basename without '/', '\\', or ':'";
	}
	return null;
}

/** `all`, `3`, `r2`, `1-5`: a reversed range or page 0 is not one (spike D19). */
function pageRangeProblem(value: unknown): boolean {
	if (typeof value !== "string") return true;
	if (value === "all") return false;
	const single = /^r?(\d+)$/.exec(value);
	if (single) return Number(single[1]) < 1;
	const range = /^(\d+)-(\d+)$/.exec(value);
	if (range) return Number(range[1]) < 1 || Number(range[1]) > Number(range[2]);
	return true;
}

export async function createFakeMineruServer(
	initialOptions: FakeMineruServerOptions = {},
): Promise<FakeMineruServer> {
	let options: FakeMineruServerOptions = { ...initialOptions };
	const requests: FakeMineruRequest[] = [];
	/** The hash cache: content-addressed, and forgotten by a restart. */
	let blobs = new Map<string, Buffer>();
	let tasks = new Map<string, TaskRecord>();
	let filesById = new Map<string, { task: TaskRecord; file: FileRecord }>();
	let createdCount = 0;

	const restart = () => {
		blobs = new Map();
		tasks = new Map();
		filesById = new Map();
	};
	let restartAfterFirstTaskArmed = options.restartAfterFirstTask === true;
	let restartAfterFirstUploadArmed = options.restartAfterFirstUpload === true;
	const failureCounts = new Map<number, number>();
	let sequence = 0;

	/** `job_` / `file-` plus 24 hex digits: the recorded shape, deterministic. */
	const nextId = (prefix: string) => {
		sequence += 1;
		return `${prefix}${sequence.toString(16).padStart(24, "0")}`;
	};

	// -- configuration ------------------------------------------------------

	function tiers(): readonly MineruTierId[] {
		return options.tiers ?? ["flash", "basic", "standard"];
	}

	/** What the server picks when a request names no tier (spike D14). */
	function bestTier(): MineruTierId {
		const order: readonly MineruTierId[] = [
			"standard",
			"basic",
			"flash",
			"advanced",
		];
		return order.find((tier) => tiers().includes(tier)) ?? "flash";
	}

	function outcomeOf(file: FileRecord): FakeMineruFileOutcome {
		if (options.neverFinish) return "stuck";
		return (
			options.outcomeFor?.({ fileName: file.name, index: file.index }) ??
			options.outcome ??
			"completed"
		);
	}

	function resultZipPath(): string {
		const name = options.fixtureInput ?? DEFAULT_FIXTURE_INPUT;
		const own = join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", `${name}.zip`);
		return existsSync(own)
			? own
			: join(MINERU_FIXTURE_ROOT, name, "result.zip");
	}

	// -- state --------------------------------------------------------------

	function stateOf(file: FileRecord): FileState {
		if (file.settled) return file.settled;
		if (file.readyAt === null) return "waiting-file";
		// The first poll that sees a file with bytes sees it queued; later ones see
		// it working. That is the order the recorded server showed.
		const inProgress: FileState = file.observed <= 1 ? "pending" : "running";
		const outcome = outcomeOf(file);
		if (outcome === "stuck") return inProgress;
		if (Date.now() - file.readyAt < (options.parseDelayMs ?? 0)) {
			return inProgress;
		}
		return outcome === "file-failed" || outcome === "failed-without-detail"
			? "failed"
			: "completed";
	}

	function taskState(task: TaskRecord): string {
		if (task.canceled) return "canceled";
		const states = task.files.map(stateOf);
		if (states.includes("running")) return "running";
		if (states.includes("waiting-file")) return "waiting-file";
		if (states.includes("pending")) return "pending";
		const failed = states.filter((state) => state === "failed").length;
		if (failed === 0) return "completed";
		return failed === states.length ? "failed" : "partial";
	}

	function isTerminalTask(status: string): boolean {
		return ["completed", "partial", "failed", "canceled"].includes(status);
	}

	function effectiveTier(task: TaskRecord, file: FileRecord): MineruTierId {
		// A native document is flash whatever was asked (spike D27).
		if (getIntakeTierHint(file.name, null) === "flash") return "flash";
		return task.tier ?? bestTier();
	}

	// -- bodies -------------------------------------------------------------

	function origin(req: IncomingMessage): string {
		return options.urlOrigin === "cross-origin"
			? `http://localhost:${port}`
			: `http://${req.headers.host}`;
	}

	function isoSeconds(ms: number): string {
		return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	function uploadLink(task: TaskRecord, file: FileRecord, base: string) {
		return {
			url: `${base}/v1/tasks/${task.id}/uploads/${file.id}`,
			headers: { "Content-Type": "application/octet-stream" },
			expires_at: Math.floor(task.createdAt / 1000) + UPLOAD_TTL_SECONDS,
		};
	}

	/** What a file adds to a snapshot once it has finished one way or the other. */
	function finishedFields(
		task: TaskRecord,
		file: FileRecord,
		state: FileState,
		base: string,
	): Record<string, unknown> {
		const outcome = outcomeOf(file);
		if (state === "completed") {
			return {
				parse: {
					tier: effectiveTier(task, file),
					duration_ms: 12,
					parser_version: SERVER_VERSION,
				},
				...(outcome === "completed-without-result-url"
					? {}
					: { result_url: `${base}/v1/files/${file.id}/content` }),
			};
		}
		if (state === "failed" && outcome !== "failed-without-detail") {
			return {
				error: {
					code: options.fileError?.code ?? "parse_failed",
					message: options.fileError?.message ?? "Parse failed",
				},
			};
		}
		return {};
	}

	function createReceipt(task: TaskRecord, base: string) {
		const states = task.files.map((file) =>
			file.readyAt === null ? "waiting-file" : "pending",
		);
		return {
			task_id: task.id,
			status: states.includes("waiting-file") ? "waiting-file" : "pending",
			files: task.files.map((file, index) => ({
				file_id: file.id,
				file_name: file.name,
				status: states[index],
				...(file.readyAt === null
					? { upload: uploadLink(task, file, base) }
					: {}),
			})),
		};
	}

	function snapshot(task: TaskRecord, base: string) {
		const status = taskState(task);
		const states = task.files.map(stateOf);
		if (isTerminalTask(status) && task.finishedAt === null) {
			task.finishedAt = Date.now();
		}
		return {
			task_id: task.id,
			status,
			created_at: isoSeconds(task.createdAt),
			started_at: isoSeconds(task.createdAt),
			...(isTerminalTask(status) && task.finishedAt !== null
				? { finished_at: isoSeconds(task.finishedAt) }
				: {}),
			output_formats: task.outputFormats,
			progress: {
				completed: states.filter((state) => state === "completed").length,
				failed: states.filter((state) => state === "failed").length,
				total: states.length,
			},
			files: task.files.map((file, index) => {
				const state = states[index] as FileState;
				return {
					file_id: file.id,
					file_name: file.name,
					status: state,
					bytes: file.bytes,
					...(state === "waiting-file"
						? { upload: uploadLink(task, file, base) }
						: {}),
					...finishedFields(task, file, state, base),
				};
			}),
		};
	}

	function cancelReceipt(task: TaskRecord, base: string) {
		return {
			task_id: task.id,
			status: "canceled",
			finished_at: isoSeconds(task.finishedAt ?? Date.now()),
			files: task.files.map((file) => {
				const state = stateOf(file);
				return {
					file_id: file.id,
					file_name: file.name,
					status: state,
					...finishedFields(task, file, state, base),
				};
			}),
		};
	}

	// -- responses ----------------------------------------------------------

	function jsonResponse(
		res: ServerResponse,
		status: number,
		body: unknown,
		headers: Record<string, string> = {},
	): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(payload),
			...headers,
		});
		res.end(payload);
	}

	/** MinerU's envelope. 4.1 has no `type`, and omits `param` when there is none. */
	function errorResponse(res: ServerResponse, error: Invalid): void {
		jsonResponse(res, error.status, {
			error: {
				code: error.code,
				message: error.message,
				...(error.param ? { param: error.param } : {}),
			},
		});
	}

	function plainError(
		res: ServerResponse,
		status: number,
		code: string,
		message: string,
	): void {
		errorResponse(res, { status, code, message });
	}

	/** FastAPI's own answer for a route it does not have. */
	function fastapiError(
		res: ServerResponse,
		status: number,
		detail: string,
		headers: Record<string, string> = {},
	): void {
		jsonResponse(res, status, { detail }, headers);
	}

	function scriptedFailure(
		res: ServerResponse,
		method: string,
		path: string,
	): boolean {
		// Every entry that matches counts the request, so "nth: 2" means this
		// entry's second matching request even when an earlier entry answered the
		// first; the first entry that is due then answers.
		let due: FakeMineruFailure | null = null;
		for (const [index, scripted] of (options.failures ?? []).entries()) {
			if (scripted.method && scripted.method !== method) continue;
			if (!path.startsWith(scripted.path)) continue;
			const seen = (failureCounts.get(index) ?? 0) + 1;
			failureCounts.set(index, seen);
			if (
				due === null &&
				(scripted.nth === undefined || scripted.nth === seen)
			) {
				due = scripted;
			}
		}
		if (due === null) return false;
		if ("fixture" in due) {
			const recorded = readMineruProtocolFixture<{
				response: { status: number; json: unknown };
			}>(due.fixture);
			jsonResponse(res, recorded.response.status, recorded.response.json);
		} else {
			jsonResponse(res, due.status, due.body);
		}
		return true;
	}

	function authorized(req: IncomingMessage): boolean {
		if (!options.apiKey) return true;
		return req.headers.authorization === `Bearer ${options.apiKey}`;
	}

	// -- validation ---------------------------------------------------------

	function checkFile(entry: unknown, index: number): Checked<ParsedFile> {
		const at = `files.${index}`;
		if (!isRecord(entry)) return failure(at, "Each file must be an object");
		const nameProblem = fileNameProblem(entry.file_name);
		if (nameProblem) return failure(`${at}.file_name`, nameProblem);
		// A missing or null size is an error on the entry; a bad one, on the field.
		if (entry.bytes === undefined || entry.bytes === null) {
			return failure(at, "bytes is required for an uploaded file");
		}
		if (
			typeof entry.bytes !== "number" ||
			!Number.isInteger(entry.bytes) ||
			entry.bytes < 1
		) {
			return failure(`${at}.bytes`, "bytes must be a positive integer");
		}
		const sha = entry.sha256sum ?? null;
		if (
			sha !== null &&
			(typeof sha !== "string" || !SHA256_PATTERN.test(sha))
		) {
			return failure(
				`${at}.sha256sum`,
				"sha256sum must be 64 lowercase hex digits",
			);
		}
		if ("page_range" in entry && pageRangeProblem(entry.page_range)) {
			return failure(
				`${at}.page_range`,
				"Invalid page range",
				"page_range_invalid",
			);
		}
		for (const key of Object.keys(entry)) {
			if (!["file_name", "bytes", "sha256sum", "page_range"].includes(key)) {
				return failure(
					`${at}.${key}`,
					`Extra inputs are not permitted: ${key}`,
				);
			}
		}
		return {
			ok: true,
			value: {
				name: entry.file_name as string,
				bytes: entry.bytes,
				sha256: sha as string | null,
			},
		};
	}

	/**
	 * The create body, held to what the spike observed. Anything the 4.0 protocol
	 * sent (`filename`, `file_id`, `client_file_id`, `include_model_output`,
	 * `callback`, ...) is an extra input and a 400, and so are the nulls the 4.0
	 * client used to tolerate: `ocr_mode: null`, `page_range: null`.
	 */
	function validateCreate(body: unknown): Checked<ParsedCreate> {
		if (!isRecord(body))
			return failure(undefined, "The body must be a JSON object");

		const entries = body.files;
		if (
			!Array.isArray(entries) ||
			entries.length < 1 ||
			entries.length > MAX_FILES_PER_TASK
		) {
			return failure(
				"files",
				`files must hold 1 to ${MAX_FILES_PER_TASK} entries`,
			);
		}
		const files: ParsedFile[] = [];
		for (const [index, entry] of entries.entries()) {
			const checked = checkFile(entry, index);
			if (!checked.ok) return checked;
			files.push(checked.value);
		}

		let tier: MineruTierId | null = null;
		if ("tier" in body && body.tier !== null) {
			const asked = body.tier;
			if (
				typeof asked !== "string" ||
				!(MINERU_TIER_IDS as readonly string[]).includes(asked)
			) {
				return failure(
					"tier",
					"Input should be 'flash', 'basic', 'standard' or 'advanced'",
				);
			}
			if (!tiers().includes(asked as MineruTierId)) {
				return failure("tier", `Tier '${asked}' is not available`);
			}
			tier = asked as MineruTierId;
		}

		if (
			"ocr_mode" in body &&
			!(MINERU_OCR_MODES as readonly unknown[]).includes(body.ocr_mode)
		) {
			return failure("ocr_mode", "ocr_mode is not one of the accepted modes");
		}

		if ("page_range" in body) {
			if (body.page_range === null) {
				return failure("page_range", "page_range must be a string");
			}
			if (pageRangeProblem(body.page_range)) {
				return failure(
					"page_range",
					`Invalid page range '${String(body.page_range)}'`,
					"page_range_invalid",
				);
			}
		}

		let outputFormats = ["default"];
		if ("output_formats" in body) {
			const asked = body.output_formats;
			if (!Array.isArray(asked) || asked.length === 0) {
				return failure(
					"output_formats",
					"output_formats must be a non-empty list",
				);
			}
			for (const [index, format] of asked.entries()) {
				if (
					!(serverFeatures().task_output_formats as unknown[]).includes(format)
				) {
					return failure(
						`output_formats.${index}`,
						"Input should be one of the output formats the server lists",
					);
				}
			}
			outputFormats = asked as string[];
		}

		for (const key of Object.keys(body)) {
			if (
				!["files", "tier", "ocr_mode", "page_range", "output_formats"].includes(
					key,
				)
			) {
				return failure(key, `Extra inputs are not permitted: ${key}`);
			}
		}
		return { ok: true, value: { files, tier, outputFormats } };
	}

	// -- handlers -----------------------------------------------------------

	function handleHealth({ res }: RouteContext) {
		jsonResponse(res, 200, {
			status: "ok",
			version: SERVER_VERSION,
			features: {
				webhook: false,
				task_output_formats: [...serverFeatures().task_output_formats],
				sources: [...serverFeatures().sources],
			},
		});
	}

	const TIER_DESCRIPTIONS: Record<MineruTierId, string> = {
		flash: "Fast local text extraction.",
		basic: "Basic parsing with local lightweight models.",
		standard: "Standard parsing for most documents.",
		advanced: "Advanced parsing for the hardest documents.",
	};

	function handleTiers({ res }: RouteContext) {
		jsonResponse(res, 200, {
			object: "list",
			data: tiers().map((id) => ({
				id,
				description: TIER_DESCRIPTIONS[id],
				current_model: `mineru-${SERVER_VERSION}`,
			})),
		});
	}

	function handleUsage({ res }: RouteContext) {
		jsonResponse(res, 200, {
			object: "usage",
			access_level: options.apiKey ? "registered" : "anonymous",
			billing_period: { start: isoSeconds(Date.now()), end: null },
			current: {
				pages_processed: 0,
				files_processed: 0,
				jobs_created: createdCount,
			},
			limits: {
				max_pages_per_file: null,
				max_file_size_bytes: null,
				max_files_per_job: MAX_FILES_PER_TASK,
				max_concurrent_jobs: 2,
				max_file_retention_days: 1,
			},
		});
	}

	function handleCreate({ req, res, raw, url }: RouteContext) {
		if (url.search) {
			return plainError(
				res,
				400,
				"invalid_request",
				"POST parameters must be supplied in the JSON body, not the URL",
			);
		}
		if (
			!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))
		) {
			return plainError(res, 415, "invalid_request", "Use application/json");
		}
		let body: unknown;
		try {
			body = JSON.parse(raw.toString("utf8"));
		} catch (error) {
			return plainError(res, 400, "invalid_request", String(error));
		}
		const checked = validateCreate(body);
		if (!checked.ok) return errorResponse(res, checked.error);

		// A declared size that contradicts the bytes the cache holds for that hash.
		for (const file of checked.value.files) {
			const cached = file.sha256 ? blobs.get(file.sha256) : undefined;
			if (cached && cached.byteLength !== file.bytes) {
				return plainError(
					res,
					400,
					"upload_size_mismatch",
					"Declared size does not match cached bytes",
				);
			}
		}

		const now = Date.now();
		const task: TaskRecord = {
			id: nextId("job_"),
			createdAt: now,
			finishedAt: null,
			canceled: false,
			tier: checked.value.tier,
			outputFormats: checked.value.outputFormats,
			files: checked.value.files.map((file, index) => ({
				id: nextId("file-"),
				index,
				name: file.name,
				bytes: file.bytes,
				sha256: file.sha256,
				// A hash the server holds needs no upload: the file is queued at once.
				readyAt: file.sha256 && blobs.has(file.sha256) ? now : null,
				observed: 0,
				settled: null,
			})),
		};
		tasks.set(task.id, task);
		createdCount += 1;
		for (const file of task.files) filesById.set(file.id, { task, file });

		jsonResponse(res, 202, createReceipt(task, origin(req)));
		// The restart, as an EVENT rather than a wall clock. The 202 is on the wire
		// first, so the caller holds a task the server has already forgotten.
		if (restartAfterFirstTaskArmed) {
			restartAfterFirstTaskArmed = false;
			restart();
		}
	}

	function handleGetTask({ req, res, params }: RouteContext) {
		const task = tasks.get(params[0] as string);
		if (!task) {
			return plainError(
				res,
				404,
				"task_not_found",
				`Task ${params[0]} not found`,
			);
		}
		for (const file of task.files) {
			if (file.readyAt !== null) file.observed += 1;
		}
		jsonResponse(res, 200, snapshot(task, origin(req)));
	}

	function handlePutFile({ req, res, raw, params }: RouteContext) {
		const [taskId, fileId] = params as [string, string];
		const task = tasks.get(taskId);
		if (!task) {
			return plainError(res, 404, "task_not_found", `Task ${taskId} not found`);
		}
		const file = task.files.find((candidate) => candidate.id === fileId);
		if (!file) {
			return plainError(res, 404, "upload_not_found", "Unknown file_id");
		}
		if (task.canceled) {
			return plainError(res, 409, "task_already_terminal", "Task was canceled");
		}
		// Idempotent: bytes already in, whatever the file has become since.
		if (file.readyAt !== null) {
			return jsonResponse(res, 200, {
				task_id: task.id,
				file_id: file.id,
				status: stateOf(file),
			});
		}

		const announced = req.headers["content-length"];
		if (
			(announced !== undefined && Number(announced) !== file.bytes) ||
			raw.byteLength !== file.bytes
		) {
			return plainError(
				res,
				400,
				"upload_size_mismatch",
				"Content-Length does not match declared file size",
			);
		}
		const actual = createHash("sha256").update(raw).digest("hex");
		if (file.sha256 && actual !== file.sha256) {
			return plainError(res, 400, "file_hash_mismatch", "SHA-256 mismatch");
		}

		blobs.set(actual, raw);
		file.readyAt = Date.now();
		jsonResponse(res, 200, {
			task_id: task.id,
			file_id: file.id,
			status: "pending",
		});
		if (restartAfterFirstUploadArmed) {
			restartAfterFirstUploadArmed = false;
			restart();
		}
	}

	function handleCancel({ req, res, params }: RouteContext) {
		const task = tasks.get(params[0] as string);
		if (!task) {
			return plainError(
				res,
				404,
				"task_not_found",
				`Task ${params[0]} not found`,
			);
		}
		const status = taskState(task);
		if (isTerminalTask(status)) {
			return plainError(res, 409, "task_already_terminal", `Task is ${status}`);
		}
		// Every unfinished file stops, running ones included; finished files stay
		// finished, and their results stay downloadable (spike D24).
		for (const file of task.files) {
			const state = stateOf(file);
			file.settled = TERMINAL_FILE_STATES.includes(state) ? state : "canceled";
		}
		task.canceled = true;
		task.finishedAt = Date.now();
		jsonResponse(res, 200, cancelReceipt(task, origin(req)));
	}

	function handleFileMeta({ res, params }: RouteContext) {
		const found = filesById.get(params[0] as string);
		if (!found || stateOf(found.file) !== "completed") {
			return plainError(
				res,
				404,
				"file_not_found",
				`File ${params[0]} not found`,
			);
		}
		const zip = readFileSync(resultZipPath());
		const created = Math.floor(found.task.createdAt / 1000);
		jsonResponse(res, 200, {
			id: found.file.id,
			object: "file",
			bytes: zip.byteLength,
			created_at: created,
			expires_at: created + 86400,
			file_name: resultName(found.file),
			purpose: "parse_output",
			sha256sum: createHash("sha256").update(zip).digest("hex"),
		});
	}

	function resultName(file: FileRecord): string {
		return `${file.name.replace(/\.[^.]*$/, "")}.zip`;
	}

	function handleResult({ req, res, params }: RouteContext) {
		const fileId = params[0] as string;
		const found = filesById.get(fileId);
		if (!found || stateOf(found.file) !== "completed") {
			return plainError(res, 404, "file_not_found", `File ${fileId} not found`);
		}
		if (options.redirectDownloads) {
			const base =
				options.redirectDownloads === "cross-origin"
					? `http://localhost:${port}`
					: `http://${req.headers.host}`;
			// Once, or a client that follows it would be sent round forever.
			options = { ...options, redirectDownloads: undefined };
			res.writeHead(302, { location: `${base}/v1/files/${fileId}/content` });
			res.end();
			return;
		}
		const zip = readFileSync(resultZipPath());
		const name = resultName(found.file);
		res.writeHead(200, {
			"content-type": "application/zip",
			// A name that is not plain ASCII travels as `filename*=` (spike D2).
			"content-disposition": /^[\x20-\x7e]*$/.test(name)
				? `attachment; filename="${name}"`
				: `attachment; filename*=utf-8''${encodeURIComponent(name)}`,
			"accept-ranges": "bytes",
			"content-length": zip.byteLength,
			etag: `"${createHash("md5").update(zip).digest("hex")}"`,
			"last-modified": new Date(found.task.createdAt).toUTCString(),
		});
		res.end(zip);
	}

	// -- routing ------------------------------------------------------------

	const routes: Route[] = [
		{
			method: "GET",
			pattern: /^\/v1\/health$/,
			public: true,
			handle: handleHealth,
		},
		{
			method: "GET",
			pattern: /^\/v1\/tiers$/,
			public: true,
			handle: handleTiers,
		},
		{ method: "GET", pattern: /^\/v1\/usage$/, handle: handleUsage },
		{ method: "POST", pattern: /^\/v1\/tasks$/, handle: handleCreate },
		{ method: "GET", pattern: /^\/v1\/tasks\/([^/]+)$/, handle: handleGetTask },
		{
			method: "PUT",
			pattern: /^\/v1\/tasks\/([^/]+)\/uploads\/([^/]+)$/,
			handle: handlePutFile,
		},
		{
			method: "POST",
			pattern: /^\/v1\/tasks\/([^/]+)\/cancel$/,
			handle: handleCancel,
		},
		{
			method: "GET",
			pattern: /^\/v1\/files\/([^/]+)$/,
			handle: handleFileMeta,
		},
		{
			method: "GET",
			pattern: /^\/v1\/files\/([^/]+)\/content$/,
			handle: handleResult,
		},
	];

	async function readBody(req: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	}

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const method = req.method ?? "GET";
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const path = url.pathname;
		const raw = await readBody(req);

		let json: unknown;
		if (raw.length > 0 && /json/.test(String(req.headers["content-type"]))) {
			try {
				json = JSON.parse(raw.toString("utf8"));
			} catch {
				json = undefined;
			}
		}
		requests.push({
			method,
			path: url.search ? `${path}${url.search}` : path,
			json,
			bodyBytes: raw.length,
			headers: Object.fromEntries(
				Object.entries(req.headers).map(([key, value]) => [
					key,
					String(value ?? ""),
				]),
			),
		});

		const matching = routes.filter((route) => route.pattern.test(path));
		if (matching.length === 0) return fastapiError(res, 404, "Not Found");
		const route = matching.find((candidate) => candidate.method === method);
		if (!route) {
			return fastapiError(res, 405, "Method Not Allowed", {
				allow: matching.map((candidate) => candidate.method).join(", "),
			});
		}
		if (!route.public && !authorized(req)) {
			return plainError(
				res,
				401,
				"invalid_api_key",
				"Invalid or missing API key",
			);
		}
		if (scriptedFailure(res, method, path)) return;

		const params = (route.pattern.exec(path) ?? []).slice(1);
		route.handle({ req, res, raw, url, params });
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			if (!res.headersSent) {
				plainError(res, 500, "internal_error", String(error));
			} else {
				res.end();
			}
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port =
		address && typeof address === "object" ? address.port : Number(address);

	let restartTimer: NodeJS.Timeout | null = null;
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
		get tasks() {
			return new Map(
				[...tasks.values()].map((task) => [
					task.id,
					{
						status: taskState(task),
						files: task.files.map((file) => ({
							fileId: file.id,
							fileName: file.name,
							status: stateOf(file),
						})),
					},
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
	} satisfies FakeMineruServer;
}
