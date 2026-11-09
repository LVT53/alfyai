/**
 * Every schema, against every recorded MinerU 4.1 answer.
 *
 * The recorded answers are the authority (`fixtures/mineru-v41/protocol/`,
 * copied byte for byte from the 4.1 spike); the 4.1 docs are not. Two guards keep
 * that honest:
 *
 *  1. Every JSON fixture is dispatched to the schema for its family by what was
 *     asked (method, path) and answered (status), and must parse. A new fixture
 *     that fits no family fails here by name instead of being silently ignored.
 *  2. The last case walks the fixture folder and fails when a file was never
 *     read, so the curated subset cannot grow dead weight.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fastapiErrorSchema,
	isTerminalMineruTaskStatus,
	MINERU_FILE_STATUSES,
	MINERU_TASK_STATUSES,
	mineruCancelTaskResponseSchema,
	mineruCreateTaskResponseSchema,
	mineruErrorResponseSchema,
	mineruFileObjectSchema,
	mineruHealthSchema,
	mineruTaskDetailSchema,
	mineruTierListLenientSchema,
	mineruTierListSchema,
	mineruUploadFileResponseSchema,
	mineruUsageSchema,
} from "./schemas";
import { MINERU_PROTOCOL_FIXTURE_ROOT } from "./testing/fake-server";

/** Every fixture path this file has touched, for the coverage case below. */
const touched = new Set<string>();

function fixturePath(relativePath: string): string {
	const path = join(MINERU_PROTOCOL_FIXTURE_ROOT, relativePath);
	touched.add(path);
	return path;
}

interface Recorded {
	request?: { method: string; path: string };
	response?: {
		status: number;
		headers?: Record<string, string>;
		json?: unknown;
	};
	/** Poll captures: the body sits under `snapshot`. */
	snapshot?: unknown;
	zip_listing?: Array<{ name: string; size: number }>;
}

function readRecorded(relativePath: string): Recorded {
	return JSON.parse(readFileSync(fixturePath(relativePath), "utf8"));
}

/** The body of a recorded answer. */
function bodyOf(relativePath: string): Record<string, unknown> {
	const recorded = readRecorded(relativePath);
	return (recorded.snapshot ?? recorded.response?.json) as Record<
		string,
		unknown
	>;
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

const ALL_FILES = walk(MINERU_PROTOCOL_FIXTURE_ROOT)
	.map((path) => relative(MINERU_PROTOCOL_FIXTURE_ROOT, path))
	.sort();
const JSON_FILES = ALL_FILES.filter((name) => name.endsWith(".json"));
const ZIP_FILES = ALL_FILES.filter((name) => name.endsWith(".zip"));

type Family =
	| "health"
	| "tiers"
	| "usage"
	| "create-receipt"
	| "put-receipt"
	| "task-snapshot"
	| "cancel-receipt"
	| "file-object"
	| "download"
	| "error";

/** What a recorded answer is, from what was asked and what came back. */
function familyOf(relativePath: string): Family {
	const recorded = readRecorded(relativePath);
	if (recorded.snapshot !== undefined) return "task-snapshot";
	const { request, response } = recorded;
	if (!request || !response) {
		throw new Error(
			`${relativePath} is neither a snapshot nor request+response`,
		);
	}
	if (response.status >= 400) return "error";
	const { method, path } = request;
	if (method === "GET" && path === "/v1/health") return "health";
	if (method === "GET" && path === "/v1/tiers") return "tiers";
	if (method === "GET" && path === "/v1/usage") return "usage";
	if (method === "POST" && path === "/v1/tasks") return "create-receipt";
	if (method === "PUT" && /^\/v1\/tasks\/[^/]+\/uploads\/[^/]+$/.test(path)) {
		return "put-receipt";
	}
	if (method === "GET" && /^\/v1\/tasks\/[^/]+$/.test(path)) {
		return "task-snapshot";
	}
	if (method === "POST" && /^\/v1\/tasks\/[^/]+\/cancel$/.test(path)) {
		return "cancel-receipt";
	}
	if (method === "GET" && /^\/v1\/files\/[^/]+\/content$/.test(path)) {
		return "download";
	}
	if (method === "GET" && /^\/v1\/files\/[^/]+$/.test(path)) {
		return "file-object";
	}
	throw new Error(`${relativePath}: no family for ${method} ${path}`);
}

describe("mineru schemas: every recorded body parses with the schema for its family", () => {
	it("finds the curated tree", () => {
		expect(JSON_FILES.length).toBeGreaterThan(60);
		expect(ZIP_FILES).toEqual([
			"zips/v41-csv.zip",
			"zips/v41-docx.zip",
			"zips/v41-pdf.zip",
		]);
	});

	it.each(JSON_FILES)("%s", (name) => {
		const body = bodyOf(name);
		switch (familyOf(name)) {
			case "health":
				return void mineruHealthSchema.parse(body);
			case "tiers":
				return void mineruTierListSchema.parse(body);
			case "usage":
				return void mineruUsageSchema.parse(body);
			case "create-receipt":
				return void mineruCreateTaskResponseSchema.parse(body);
			case "put-receipt":
				return void mineruUploadFileResponseSchema.parse(body);
			case "task-snapshot":
				return void mineruTaskDetailSchema.parse(body);
			case "cancel-receipt":
				return void mineruCancelTaskResponseSchema.parse(body);
			case "file-object":
				return void mineruFileObjectSchema.parse(body);
			case "download": {
				// A result is a ZIP with the images/ directory entry in it (D2, D3).
				const recorded = readRecorded(name);
				expect(recorded.response?.headers?.["content-type"]).toBe(
					"application/zip",
				);
				expect(recorded.response?.headers?.["content-disposition"]).toMatch(
					/^attachment; filename(\*=utf-8'')?/,
				);
				const entries = (recorded.zip_listing ?? []).map((entry) => entry.name);
				expect(entries).toEqual(
					expect.arrayContaining([
						"markdown.md",
						"structured_content.json",
						"images/",
					]),
				);
				return;
			}
			case "error": {
				const parsed = mineruErrorResponseSchema.safeParse(body);
				if (parsed.success) {
					// 4.1 never sends `type`: the envelope is code, message and param only.
					expect(Object.keys(parsed.data.error)).not.toContain("type");
					expect(parsed.data.error.code).toBeTruthy();
					return;
				}
				expect(fastapiErrorSchema.parse(body)).toBeTruthy();
			}
		}
	});

	it.each(ZIP_FILES)("%s is a ZIP", (name) => {
		const bytes = readFileSync(fixturePath(name));
		expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
	});
});

describe("mineru schemas: capability reads", () => {
	it("reads task_output_formats and sources from /v1/health", () => {
		const health = mineruHealthSchema.parse(
			bodyOf("server/health_no_key.json"),
		);
		expect(health.version).toBe("4.1.7");
		expect(health.features?.webhook).toBe(false);
		expect(health.features?.task_output_formats).toEqual([
			"default",
			"docx",
			"html",
			"latex",
		]);
		expect(health.features?.sources).toEqual(["upload", "url"]);
	});

	it("defaults the feature lists to empty rather than failing", () => {
		const health = mineruHealthSchema.parse({
			version: "4.1.9",
			features: { webhook: true },
		});
		expect(health.features?.task_output_formats).toEqual([]);
		expect(health.features?.sources).toEqual([]);
		// The 4.0 key is gone: nothing reads `output_formats` any more.
		expect(Object.keys(health.features ?? {})).not.toContain("output_formats");
	});

	it("reads the ceiling-limited tier lists, current_model being one name for all", () => {
		const standard = mineruTierListSchema.parse(bodyOf("server/tiers.json"));
		expect(standard.data.map((tier) => tier.id)).toEqual([
			"flash",
			"basic",
			"standard",
		]);
		expect(new Set(standard.data.map((tier) => tier.current_model))).toEqual(
			new Set(["mineru-4.1.7"]),
		);
		const flash = mineruTierListSchema.parse(
			bodyOf("flows/tier-ceilings/flash/02_tiers.json"),
		);
		expect(flash.data.map((tier) => tier.id)).toEqual(["flash"]);
	});

	it("keeps an unknown tier id in the lenient shape and rejects it in the strict one", () => {
		const body = {
			object: "list",
			data: [
				{ id: "flash", description: "Fast." },
				{ id: "quantum", description: "From a future server." },
			],
		};
		expect(
			mineruTierListLenientSchema.parse(body).data.map((tier) => tier.id),
		).toEqual(["flash", "quantum"]);
		expect(mineruTierListSchema.safeParse(body).success).toBe(false);
	});

	it("reads /v1/usage, where the real limits live", () => {
		const usage = mineruUsageSchema.parse(bodyOf("server/usage.json"));
		expect(usage.access_level).toBe("registered");
		expect(usage.limits?.max_files_per_job).toBe(100);
		expect(usage.limits?.max_concurrent_jobs).toBe(2);
		expect(usage.limits?.max_pages_per_file).toBeNull();
		expect(usage.limits?.max_file_size_bytes).toBeNull();
	});
});

describe("mineru schemas: create receipts", () => {
	it("a new hash waits for its bytes: waiting-file, with an upload link to PUT to", () => {
		const receipt = mineruCreateTaskResponseSchema.parse(
			bodyOf("samples/docx-default/01_create.json"),
		);
		expect(receipt.status).toBe("waiting-file");
		const file = receipt.files[0];
		expect(file?.status).toBe("waiting-file");
		expect(file?.file_name).toBe("report.docx");
		expect(file?.upload?.url).toBe(
			`http://127.0.0.1:8012/v1/tasks/${receipt.task_id}/uploads/${file?.file_id}`,
		);
		expect(file?.upload?.headers).toEqual({
			"Content-Type": "application/octet-stream",
		});
		expect(file?.upload?.expires_at).toBe(1793883192);
	});

	it("a cache hit is pending with no upload object at all, and carries new ids", () => {
		const first = mineruCreateTaskResponseSchema.parse(
			bodyOf("flows/hash-cache/A_first_upload_create.json"),
		);
		const hit = mineruCreateTaskResponseSchema.parse(
			bodyOf("flows/hash-cache/B_same_hash_same_name_create.json"),
		);
		expect(hit.status).toBe("pending");
		expect(hit.files[0]?.status).toBe("pending");
		expect(hit.files[0]?.upload).toBeUndefined();
		expect(hit.task_id).not.toBe(first.task_id);
		expect(hit.files[0]?.file_id).not.toBe(first.files[0]?.file_id);
	});

	it("a two-file task has one upload link per file", () => {
		const receipt = mineruCreateTaskResponseSchema.parse(
			bodyOf("flows/partial-and-file-terminal/01_create.json"),
		);
		expect(receipt.files.map((file) => file.file_name)).toEqual([
			"good.pdf",
			"bad.pdf",
		]);
		expect(receipt.files.every((file) => file.upload?.url)).toBe(true);
	});

	it("a Hungarian name round-trips untouched", () => {
		const receipt = mineruCreateTaskResponseSchema.parse(
			bodyOf("samples/pdf-hu-accented-name/01_create.json"),
		);
		expect(receipt.files[0]?.file_name).toBe(
			"Árvíztűrő tükörfúrógép jelentés.pdf",
		);
	});
});

describe("mineru schemas: task snapshots", () => {
	it("tells terminal statuses from the ones that keep polling", () => {
		expect([...MINERU_TASK_STATUSES]).toEqual([
			"waiting-file",
			"pending",
			"running",
			"completed",
			"partial",
			"failed",
			"canceled",
		]);
		expect([...MINERU_FILE_STATUSES]).toEqual([
			"waiting-file",
			"pending",
			"running",
			"completed",
			"failed",
			"canceled",
		]);
		const terminal = MINERU_TASK_STATUSES.filter(isTerminalMineruTaskStatus);
		expect(terminal).toEqual(["completed", "partial", "failed", "canceled"]);
	});

	it("a completed file names its effective tier and where to download the result", () => {
		const task = mineruTaskDetailSchema.parse(
			bodyOf("samples/docx-default/03_poll_02_completed.json"),
		);
		expect(task.status).toBe("completed");
		expect(task.finished_at).toBe("2026-11-05T11:53:12Z");
		expect(task.progress).toEqual({ completed: 1, failed: 0, total: 1 });
		const file = task.files[0];
		expect(file?.status).toBe("completed");
		// The size of the SOURCE; the result's size is the download's Content-Length.
		expect(file?.bytes).toBe(50722);
		// A native document reports flash whatever was asked (D27).
		expect(file?.parse).toEqual({
			tier: "flash",
			duration_ms: 309,
			parser_version: "4.1.7",
		});
		expect(file?.result_url).toBe(
			`http://127.0.0.1:8012/v1/files/${file?.file_id}/content`,
		);
	});

	it("a failed task has no top-level error: the reason is on the file, as parse_failed", () => {
		const task = mineruTaskDetailSchema.parse(
			bodyOf("samples/pdf-corrupt-truncated/03_poll_02_failed.json"),
		);
		expect(task.status).toBe("failed");
		expect(task.error).toBeUndefined();
		expect(task.files[0]?.error).toEqual({
			code: "parse_failed",
			message: "Failed to load document (PDFium: Data format error).",
		});
		expect(task.files[0]?.result_url).toBeUndefined();
	});

	it("a waiting file inside a running task still carries its upload link", () => {
		const task = mineruTaskDetailSchema.parse(
			bodyOf("flows/partial-and-file-terminal/03_poll_after_bad.json"),
		);
		expect(task.status).toBe("running");
		expect(task.files.map((file) => file.status)).toEqual([
			"waiting-file",
			"running",
		]);
		expect(task.files[0]?.upload?.url).toContain("/uploads/");
	});

	it("a partial task is terminal: one file completed, one failed", () => {
		const task = mineruTaskDetailSchema.parse(
			bodyOf("flows/partial-and-file-terminal/snapshot_02_partial.json"),
		);
		expect(task.status).toBe("partial");
		expect(isTerminalMineruTaskStatus(task.status)).toBe(true);
		expect(task.progress).toEqual({ completed: 1, failed: 1, total: 2 });
		expect(task.files.map((file) => file.status)).toEqual([
			"completed",
			"failed",
		]);
		expect(task.files[0]?.result_url).toBeTruthy();
		expect(task.files[1]?.error?.code).toBe("parse_failed");
	});

	it("a queued task is pending and has not started: no started_at, no parse, no result", () => {
		const task = mineruTaskDetailSchema.parse(
			bodyOf(
				"samples/bigdoc-20-pages/p20-concurrent-2/03_poll_01_pending.json",
			),
		);
		expect(task.status).toBe("pending");
		expect(isTerminalMineruTaskStatus(task.status)).toBe(false);
		expect(task.started_at).toBeUndefined();
		expect(task.files[0]?.status).toBe("pending");
		expect(task.files[0]?.parse).toBeUndefined();
		expect(task.files[0]?.result_url).toBeUndefined();
	});

	it("keeps per-file results while the task itself is still running", () => {
		const task = mineruTaskDetailSchema.parse(
			bodyOf("samples/mixed-batch-pdf-docx-csv/03_poll_02_running.json"),
		);
		expect(task.status).toBe("running");
		expect(
			task.files.map((file) => [file.file_name, file.status, file.parse?.tier]),
		).toEqual([
			["paper-en.pdf", "running", undefined],
			["report.docx", "completed", "flash"],
			["table.csv", "completed", "flash"],
		]);
	});
});

describe("mineru schemas: PUT, cancel and file receipts", () => {
	it("a PUT answers with the file's identity and its current status", () => {
		const receipt = mineruUploadFileResponseSchema.parse(
			bodyOf("samples/docx-default/02_put_0.json"),
		);
		expect(receipt).toEqual({
			task_id: "job_e25a30af18058622cc7715c7",
			file_id: "file-57ecb6bbc422eb333d3d3fc5",
			status: "pending",
		});
	});

	it("a cancel mid-way leaves the finished file completed and downloadable", () => {
		const receipt = mineruCancelTaskResponseSchema.parse(
			bodyOf("flows/cancel-midway/cancel_receipt.json"),
		);
		expect(receipt.status).toBe("canceled");
		expect(receipt.files).toHaveLength(10);
		expect(receipt.files[0]?.status).toBe("completed");
		expect(receipt.files[0]?.result_url).toBeTruthy();
		expect(receipt.files[0]?.parse?.tier).toBe("standard");
		expect(
			receipt.files.slice(1).every((file) => file.status === "canceled"),
		).toBe(true);
		// …and the snapshot after the cancel says the same (nothing changes later).
		const later = mineruTaskDetailSchema.parse(
			bodyOf("flows/cancel-midway/snapshot_3s_after_cancel.json"),
		);
		expect(later.status).toBe("canceled");
		expect(later.progress?.completed).toBe(1);
	});

	it("a cancel while everything was waiting or running cancels every file", () => {
		const receipt = mineruCancelTaskResponseSchema.parse(
			bodyOf("flows/cancel-running/10_cancel_running.json"),
		);
		expect(receipt.files.every((file) => file.status === "canceled")).toBe(
			true,
		);
		const after = mineruTaskDetailSchema.parse(
			bodyOf("flows/cancel-running/11_get_after_cancel.json"),
		);
		expect(after.status).toBe("canceled");
	});

	it("the file object says id and file_name, not file_id and filename", () => {
		const file = mineruFileObjectSchema.parse(
			bodyOf("flows/files-endpoints/13_file_meta.json"),
		);
		expect(file.id).toBe("file-5f19f9ed9efd0ec303433dfd");
		expect(file.file_name).toBe("files-probe.zip");
		expect(file.purpose).toBe("parse_output");
		expect(file.bytes).toBe(78586);
	});
});

describe("mineru schemas: error bodies", () => {
	it("reads {error:{code,message,param}} without a type", () => {
		const parsed = mineruErrorResponseSchema.parse(
			bodyOf("errors/08_tier_advanced_above_ceiling.json"),
		);
		expect(parsed.error).toEqual({
			code: "invalid_request",
			message: "Tier 'advanced' is not available",
			param: "tier",
		});
	});

	it("reads FastAPI's {detail} as a string (404/405) and as a list (422)", () => {
		const route = fastapiErrorSchema.parse(
			bodyOf("errors/49_removed_post_uploads.json"),
		);
		expect(route.detail).toBe("Not Found");
		const method = fastapiErrorSchema.parse(
			bodyOf("errors/59_delete_task_not_allowed.json"),
		);
		expect(method.detail).toBe("Method Not Allowed");
		const validation = fastapiErrorSchema.parse({
			detail: [
				{ loc: ["body", "tier"], msg: "field required", type: "missing" },
			],
		});
		expect(Array.isArray(validation.detail)).toBe(true);
	});

	it("does not mistake one envelope for the other", () => {
		expect(
			mineruErrorResponseSchema.safeParse({ detail: "Not Found" }).success,
		).toBe(false);
		expect(
			fastapiErrorSchema.safeParse({ error: { code: "x", message: "y" } })
				.success,
		).toBe(false);
	});
});

describe("mineru schemas: tolerance", () => {
	it("survives a server that adds a field we have never seen, at every level", () => {
		const recorded = bodyOf(
			"samples/docx-default/03_poll_02_completed.json",
		) as {
			files: Array<Record<string, unknown>>;
		};
		const task = mineruTaskDetailSchema.parse({
			...recorded,
			carbon_grams: 7,
			files: [
				{
					...recorded.files[0],
					vibes: "excellent",
					parse: { ...(recorded.files[0]?.parse as object), gpu: "none" },
				},
			],
		});
		expect((task as unknown as { carbon_grams: number }).carbon_grams).toBe(7);
		expect((task.files[0] as unknown as { vibes: string }).vibes).toBe(
			"excellent",
		);
		expect((task.files[0]?.parse as unknown as { gpu: string }).gpu).toBe(
			"none",
		);
	});

	it("reads a parse object that names no tier instead of failing every poll", () => {
		// Only `tier` was required of `parse`, and nothing needs it to be there:
		// the extractor reads it with a fallback to the tier it asked for.
		const recorded = bodyOf(
			"samples/docx-default/03_poll_02_completed.json",
		) as {
			files: Array<Record<string, unknown>>;
		};
		const task = mineruTaskDetailSchema.parse({
			...recorded,
			files: [{ ...recorded.files[0], parse: { duration_ms: 5 } }],
		});
		expect(task.files[0]?.parse?.tier).toBeUndefined();
		expect(task.files[0]?.parse?.duration_ms).toBe(5);
		const canceled = mineruCancelTaskResponseSchema.parse({
			task_id: "job_x",
			status: "canceled",
			files: [
				{
					file_id: "file-x",
					file_name: "x.pdf",
					status: "completed",
					parse: {},
					result_url: "http://127.0.0.1:8012/v1/files/file-x/content",
				},
			],
		});
		expect(canceled.files[0]?.parse?.tier).toBeUndefined();
	});

	it("refuses an upload link with an empty url: it would resolve to the base URL itself", () => {
		const recorded = bodyOf("samples/docx-default/01_create.json") as {
			files: Array<{ upload: Record<string, unknown> }>;
		};
		const receipt = (url: unknown) => ({
			...recorded,
			files: [
				{
					...recorded.files[0],
					upload: { ...recorded.files[0]?.upload, url },
				},
			],
		});
		expect(mineruCreateTaskResponseSchema.safeParse(receipt("")).success).toBe(
			false,
		);
		expect(
			mineruCreateTaskResponseSchema.safeParse(receipt("http://x/y")).success,
		).toBe(true);
	});

	it("reads upload headers that are null or absent as no headers, instead of failing the receipt", () => {
		// A receipt that fails to parse after a 202 leaves a task nobody can find
		// again, and the retried create makes a second one.
		const recorded = bodyOf("samples/docx-default/01_create.json") as {
			files: Array<{ upload: Record<string, unknown> }>;
		};
		const upload = recorded.files[0]?.upload ?? {};
		const withHeaders = (headers: unknown) =>
			mineruCreateTaskResponseSchema.parse({
				...recorded,
				files: [{ ...recorded.files[0], upload: { ...upload, headers } }],
			});
		expect(withHeaders(null).files[0]?.upload?.headers).toEqual({});
		expect(withHeaders(undefined).files[0]?.upload?.headers).toEqual({});
		expect(withHeaders({ "X-A": "b" }).files[0]?.upload?.headers).toEqual({
			"X-A": "b",
		});
	});

	it("refuses a status it does not know rather than polling it forever", () => {
		const recorded = bodyOf("samples/docx-default/03_poll_01_running.json");
		expect(
			mineruTaskDetailSchema.safeParse({ ...recorded, status: "queued" })
				.success,
		).toBe(false);
	});

	it("rejects a 200 whose shape is wrong: a 200 is not automatically valid", () => {
		expect(mineruTaskDetailSchema.safeParse({ task_id: "job_1" }).success).toBe(
			false,
		);
		expect(
			mineruCreateTaskResponseSchema.safeParse({
				task_id: "job_1",
				status: "pending",
			}).success,
		).toBe(false);
		expect(
			mineruUploadFileResponseSchema.safeParse({ task_id: "job_1" }).success,
		).toBe(false);
		expect(mineruHealthSchema.safeParse({ status: "ok" }).success).toBe(false);
		// The 4.0 shapes are not 4.1: `job_id` is `task_id` now.
		expect(
			mineruTaskDetailSchema.safeParse({
				job_id: "job_1",
				status: "completed",
				created_at: "2026-11-05T11:53:12Z",
				files: [],
			}).success,
		).toBe(false);
	});
});

describe("mineru fixtures: coverage", () => {
	it("leaves no fixture unread", () => {
		const unread = ALL_FILES.filter(
			(name) => !touched.has(join(MINERU_PROTOCOL_FIXTURE_ROOT, name)),
		);
		expect(unread).toEqual([]);
	});
});
