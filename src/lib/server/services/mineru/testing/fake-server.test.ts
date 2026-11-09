/**
 * The fake MinerU 4.1 server, held to the captured answers.
 *
 * A fake that drifts from the real server is worse than no fake: every flow test
 * built on it would pass against a protocol that does not exist. So this file
 * talks to it over plain HTTP, with no client in between, and compares what it
 * says with `fixtures/mineru-v41/protocol/`: the same key sets, the same
 * statuses, and for every recorded request that can be replayed, the same
 * status, `error.code` and `error.param`.
 *
 * It also holds the state machine the spike observed: `waiting-file` ->
 * `pending` -> `running` -> `completed | failed | canceled`, the hash cache, a
 * `partial` task, a cancel that stops running files but keeps finished ones
 * (D24), and a restart that forgets everything (spike section 8).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_FIXTURE_ROOT,
	MINERU_PROTOCOL_FIXTURE_ROOT,
	readMineruProtocolFixture,
} from "./fake-server";

interface Reply {
	status: number;
	headers: Headers;
	json: Record<string, unknown> & {
		error?: { code: string; message: string; param?: string };
		files?: Array<Record<string, unknown>>;
	};
	bytes: Buffer;
}

let server: FakeMineruServer | null = null;

afterEach(async () => {
	await server?.close();
	server = null;
});

async function start(
	options: FakeMineruServerOptions = {},
): Promise<FakeMineruServer> {
	server = await createFakeMineruServer(options);
	return server;
}

async function call(
	path: string,
	init: RequestInit & { key?: string } = {},
): Promise<Reply> {
	if (!server) throw new Error("start() first");
	const headers = new Headers(init.headers);
	if (init.key) headers.set("authorization", `Bearer ${init.key}`);
	const response = await fetch(
		path.startsWith("http") ? path : `${server.baseUrl}${path}`,
		{ ...init, headers },
	);
	const bytes = Buffer.from(await response.arrayBuffer());
	let json = {} as Reply["json"];
	try {
		json = JSON.parse(bytes.toString("utf8"));
	} catch {
		// A ZIP, or nothing.
	}
	return { status: response.status, headers: response.headers, json, bytes };
}

const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

/** A `files[]` entry as the request sends it, plus the bytes a test will PUT. */
function fileFor(
	name: string,
	content: Buffer,
	withHash = true,
): Record<string, unknown> & { content: Buffer } {
	return {
		file_name: name,
		bytes: content.byteLength,
		...(withHash ? { sha256sum: sha256(content) } : {}),
		content,
	};
}

/** `content` is the bytes to PUT and is not sent; the rest is the request. */
function create(
	files: ReadonlyArray<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
) {
	return call("/v1/tasks", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			files: files.map(({ content: _content, ...file }) => file),
			...extra,
		}),
	});
}

function putTo(url: string, content: Buffer, headers: HeadersInit = {}) {
	return call(url, {
		method: "PUT",
		headers: { "content-type": "application/octet-stream", ...headers },
		body: new Uint8Array(content),
	});
}

const getTask = (taskId: string) => call(`/v1/tasks/${taskId}`);
const cancelTask = (taskId: string) =>
	call(`/v1/tasks/${taskId}/cancel`, { method: "POST" });

/** Creates a one-file task and PUTs its bytes; returns the task and file ids. */
async function submit(
	name: string,
	content: Buffer,
	extra: Record<string, unknown> = {},
) {
	const receipt = await create([fileFor(name, content)], extra);
	const file = receipt.json.files?.[0] as {
		file_id: string;
		upload?: { url: string };
	};
	if (file.upload) await putTo(file.upload.url, content);
	return {
		taskId: receipt.json.task_id as string,
		fileId: file.file_id,
		receipt,
	};
}

/** The key structure of a body, ignoring every value. */
function shapeOf(value: unknown): unknown {
	if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, shapeOf(inner)]),
		);
	}
	return typeof value;
}

interface Recorded {
	request: {
		method: string;
		path: string;
		headers?: Record<string, string>;
		json?: unknown;
		raw_body_bytes?: number;
	};
	response: {
		status: number;
		json?: unknown;
		headers?: Record<string, string>;
	};
	snapshot?: unknown;
}

const recorded = (name: string) => readMineruProtocolFixture<Recorded>(name);
const recordedBody = (name: string) =>
	(recorded(name).snapshot ?? recorded(name).response.json) as Record<
		string,
		unknown
	>;

const CSV = Buffer.from("a,b\n1,2\n");
const PDF = Buffer.from("%PDF-1.7 pretend this is a document\n".repeat(20));

describe("capability reads", () => {
	it("answers /v1/health exactly like the recorded 4.1.7 server, without a key", async () => {
		await start({ apiKey: "secret" });
		const health = await call("/v1/health");
		expect(health.status).toBe(200);
		expect(health.json).toEqual(recordedBody("server/health_no_key.json"));
	});

	it("lists the tiers up to its ceiling, with the recorded shape", async () => {
		await start();
		const tiers = await call("/v1/tiers");
		expect(tiers.json).toEqual(recordedBody("server/tiers.json"));

		await server?.close();
		await start({ tiers: ["flash"] });
		const flash = await call("/v1/tiers");
		expect(flash.json).toEqual(
			recordedBody("flows/tier-ceilings/flash/02_tiers.json"),
		);
	});

	it("answers /v1/usage with the recorded shape, 'registered' once a key is set", async () => {
		await start({ apiKey: "secret" });
		const usage = await call("/v1/usage", { key: "secret" });
		expect(shapeOf(usage.json)).toEqual(
			shapeOf(recordedBody("server/usage.json")),
		);
		expect(usage.json.access_level).toBe("registered");
	});

	it("demands the key on everything else, and answers 401 invalid_api_key", async () => {
		await start({ apiKey: "secret" });
		const wrong = recorded("errors/01_auth_wrong_key_create.json");

		for (const reply of [
			await call("/v1/usage"),
			await call("/v1/usage", { key: "nope" }),
			await call("/v1/tasks/job_x"),
			await create([fileFor("x.csv", CSV)]),
		]) {
			expect(reply.status).toBe(wrong.response.status);
			expect(reply.json).toEqual(wrong.response.json);
		}

		// With the key the same calls work, and the PUT is keyed too.
		const receipt = await call("/v1/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [
					{ file_name: "k.csv", bytes: CSV.byteLength, sha256sum: sha256(CSV) },
				],
			}),
			key: "secret",
		});
		expect(receipt.status).toBe(202);
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		const noKey = recorded("errors/115_upload_no_key.json");
		const refused = await putTo(upload, CSV);
		expect(refused.status).toBe(noKey.response.status);
		expect(refused.json).toEqual(noKey.response.json);
		const accepted = await putTo(upload, CSV, {
			authorization: "Bearer secret",
		});
		expect(accepted.status).toBe(200);
	});
});

describe("creating a task", () => {
	it("a new hash waits for bytes, with the recorded receipt shape", async () => {
		await start();
		const receipt = await create([fileFor("report.docx", CSV)]);
		expect(receipt.status).toBe(202);
		expect(shapeOf(receipt.json)).toEqual(
			shapeOf(recordedBody("samples/docx-default/01_create.json")),
		);

		const task = receipt.json as unknown as {
			task_id: string;
			status: string;
			files: Array<{
				file_id: string;
				file_name: string;
				status: string;
				upload: { url: string; headers: object; expires_at: number };
			}>;
		};
		expect(task.task_id).toMatch(/^job_[0-9a-f]{24}$/);
		expect(task.status).toBe("waiting-file");
		const file = task.files[0];
		expect(file?.file_id).toMatch(/^file-[0-9a-f]{24}$/);
		expect(file?.file_name).toBe("report.docx");
		expect(file?.status).toBe("waiting-file");
		expect(file?.upload.url).toBe(
			`${server?.baseUrl}/v1/tasks/${task.task_id}/uploads/${file?.file_id}`,
		);
		expect(file?.upload.headers).toEqual({
			"Content-Type": "application/octet-stream",
		});
		// Exactly an hour from now (spike section 4), to the second.
		expect(file?.upload.expires_at).toBeGreaterThan(
			Math.floor(Date.now() / 1000) + 3590,
		);
		expect(file?.upload.expires_at).toBeLessThanOrEqual(
			Math.floor(Date.now() / 1000) + 3600,
		);
	});

	it("keeps a non-ASCII name byte for byte", async () => {
		await start();
		const name = "Árvíztűrő tükörfúrógép jelentés.pdf";
		const receipt = await create([fileFor(name, PDF)]);
		expect(receipt.json.files?.[0]?.file_name).toBe(name);
	});

	it("answers the same bytes with a cache hit: pending, no upload object, new ids", async () => {
		await start();
		const first = await submit("cache-a.pdf", PDF);
		expect(first.receipt.json.status).toBe("waiting-file");

		const hit = await create([fileFor("cache-a.pdf", PDF)]);
		expect(hit.status).toBe(202);
		expect(shapeOf(hit.json)).toEqual(
			shapeOf(
				recordedBody("flows/hash-cache/B_same_hash_same_name_create.json"),
			),
		);
		expect(hit.json.status).toBe("pending");
		expect(hit.json.files?.[0]?.status).toBe("pending");
		expect(hit.json.files?.[0]).not.toHaveProperty("upload");
		expect(hit.json.task_id).not.toBe(first.taskId);
		expect(hit.json.files?.[0]?.file_id).not.toBe(first.fileId);

		// The key is the hash only: another name hits too (spike section 8, task C).
		const renamed = await create([fileFor("other-name.pdf", PDF)]);
		expect(renamed.json.files?.[0]?.status).toBe("pending");
		// A cache hit needs no PUT and still finishes.
		const done = await getTask(hit.json.task_id as string);
		expect(done.json.status).toBe("completed");
	});

	it("needs an upload when no hash is sent, even for bytes it has", async () => {
		await start();
		await submit("same.pdf", PDF);
		const again = await create([fileFor("same.pdf", PDF, false)]);
		expect(again.json.status).toBe("waiting-file");
		expect(again.json.files?.[0]).toHaveProperty("upload");
	});

	it("refuses a declared size that contradicts a cached hash: 400 at create", async () => {
		await start();
		await submit("cache-a.pdf", PDF);
		const wrong = recorded(
			"flows/hash-cache/F_same_hash_wrong_bytes_declared_create.json",
		);
		const reply = await create([
			{ ...fileFor("cache-a.pdf", PDF), bytes: PDF.byteLength + 1 },
		]);
		expect(reply.status).toBe(wrong.response.status);
		expect(reply.json).toEqual(wrong.response.json);
	});

	it("turns away the same requests the recorded server did, with the same code and param", async () => {
		await start();
		const replayable = [
			"errors/08_tier_advanced_above_ceiling.json",
			"errors/09_tier_bogus.json",
			"errors/14_filename_dotdot_slash.json",
			// The S5 list: each of these is a 400, which is why the client never sends them.
			"errors/38_old_client_file_id.json",
			"errors/40_old_file_id_field.json",
			"errors/44_old_include_model_output_true.json",
			"errors/46_old_output_formats_markdown.json",
			"errors/76_ocr_mode_null.json",
			"errors/83_page_range_null.json",
			"errors/78_page_range_garbage.json",
			"errors/90_query_parameter.json",
			"errors/91_content_type_text_plain.json",
		];
		for (const name of replayable) {
			const { request, response } = recorded(name);
			const reply = await call(request.path, {
				method: request.method,
				headers: { "content-type": request.headers?.["Content-Type"] ?? "" },
				body:
					request.json !== undefined
						? JSON.stringify(request.json)
						: Buffer.alloc(request.raw_body_bytes ?? 0, 97),
			});
			const want = (response.json as { error: Record<string, unknown> }).error;
			expect(reply.status, name).toBe(response.status);
			expect(reply.json.error?.code, name).toBe(want.code);
			expect(reply.json.error?.param, name).toBe(want.param);
		}
	});

	it.each([
		[
			"a path in the name",
			{ file_name: "a/b.pdf", bytes: 1 },
			"files.0.file_name",
		],
		[
			"a colon in the name",
			{ file_name: "a:b.pdf", bytes: 1 },
			"files.0.file_name",
		],
		["an empty name", { file_name: "", bytes: 1 }, "files.0.file_name"],
		[
			"a newline in the name",
			{ file_name: "a\nb.pdf", bytes: 1 },
			"files.0.file_name",
		],
		[
			"a 1025-character name",
			{ file_name: "a".repeat(1025), bytes: 1 },
			"files.0.file_name",
		],
		["zero bytes", { file_name: "a.pdf", bytes: 0 }, "files.0.bytes"],
		["a fractional size", { file_name: "a.pdf", bytes: 1.5 }, "files.0.bytes"],
		["no size at all", { file_name: "a.pdf" }, "files.0"],
		[
			"an upper-case hash",
			{ file_name: "a.pdf", bytes: 1, sha256sum: "A".repeat(64) },
			"files.0.sha256sum",
		],
		[
			"a field of the 4.0 protocol",
			{ file_name: "a.pdf", bytes: 1, upload_method: "PUT" },
			"files.0.upload_method",
		],
	])("rejects %s", async (_label, file, param) => {
		await start();
		const reply = await create([file]);
		expect(reply.status).toBe(400);
		expect(reply.json.error?.code).toBe("invalid_request");
		expect(reply.json.error?.param).toBe(param);
	});

	it("accepts the names and values the recorded server accepted", async () => {
		await start();
		for (const file of [
			{ file_name: "a".repeat(1024), bytes: 1 },
			{ file_name: ".report.csv", bytes: 1 },
			{ file_name: "my report final.pdf", bytes: 1 },
			{ file_name: "x.pdf", bytes: 1, sha256sum: null },
		]) {
			expect(
				(await create([file])).status,
				JSON.stringify(file).slice(0, 60),
			).toBe(202);
		}
		// tier: null is accepted (D19), and so is a repeated output format.
		expect(
			(await create([{ file_name: "x.pdf", bytes: 1 }], { tier: null })).status,
		).toBe(202);
		expect(
			(
				await create([{ file_name: "x.pdf", bytes: 1 }], {
					output_formats: ["default", "default"],
				})
			).status,
		).toBe(202);
	});

	it("bounds the number of files at 1 to 100", async () => {
		await start();
		expect((await create([])).json.error?.param).toBe("files");
		const many = Array.from({ length: 101 }, (_, i) => ({
			file_name: `f${i}.csv`,
			bytes: 1,
		}));
		expect((await create(many)).json.error?.param).toBe("files");
		expect((await create(many.slice(0, 100))).status).toBe(202);
	});

	it("rejects a bad body the way FastAPI does not: with its own {error} envelope", async () => {
		await start();
		const notJson = await call("/v1/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{nope",
		});
		expect(notJson.status).toBe(400);
		expect(notJson.json.error?.code).toBe("invalid_request");
		const array = await call("/v1/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "[]",
		});
		expect(array.status).toBe(400);
	});

	it("honours the tier ceiling, and fills in the best tier when none is sent", async () => {
		await start({ tiers: ["flash", "basic"] });
		const refused = await create([{ file_name: "x.pdf", bytes: 1 }], {
			tier: "standard",
		});
		expect(refused.status).toBe(400);
		expect(refused.json.error).toMatchObject({
			code: "invalid_request",
			param: "tier",
			message: "Tier 'standard' is not available",
		});

		const omitted = await submit("x.pdf", PDF);
		const done = await getTask(omitted.taskId);
		// Omitted, on a basic server, parses with Basic (D14).
		expect((done.json.files?.[0]?.parse as { tier: string }).tier).toBe(
			"basic",
		);
	});
});

describe("uploading, polling and the result", () => {
	it("moves a file through waiting-file, pending, running and completed", async () => {
		// Driven by the number of polls, not by a clock: two polls see the file in
		// progress, the third sees it done, however loaded the machine is.
		await start({ inProgressPolls: 2, fixtureInput: "v41-csv" });
		const receipt = await create([fileFor("document.csv", CSV)]);
		const taskId = receipt.json.task_id as string;
		const file = receipt.json.files?.[0] as {
			file_id: string;
			upload: { url: string };
		};

		expect((await getTask(taskId)).json.files?.[0]?.status).toBe(
			"waiting-file",
		);

		const put = await putTo(file.upload.url, CSV);
		expect(put.status).toBe(200);
		expect(put.json).toEqual({
			task_id: taskId,
			file_id: file.file_id,
			status: "pending",
		});
		expect(shapeOf(put.json)).toEqual(
			shapeOf(recordedBody("samples/docx-default/02_put_0.json")),
		);

		const seen: string[] = [];
		for (let poll = 0; poll < 3; poll += 1) {
			seen.push((await getTask(taskId)).json.status as string);
		}
		expect(seen).toEqual(["pending", "running", "completed"]);
		// And it stays done.
		expect((await getTask(taskId)).json.status).toBe("completed");
	});

	it("keeps a file in progress for exactly inProgressPolls polls: pending first, then running", async () => {
		for (const [polls, expected] of [
			[0, ["completed"]],
			[1, ["pending", "completed"]],
			[3, ["pending", "running", "running", "completed"]],
		] as const) {
			await start({ inProgressPolls: polls });
			const { taskId } = await submit("document.pdf", PDF);
			const seen: string[] = [];
			for (let poll = 0; poll <= polls; poll += 1) {
				seen.push((await getTask(taskId)).json.status as string);
			}
			expect(seen, `inProgressPolls ${polls}`).toEqual([...expected]);
			await server?.close();
			server = null;
		}
	});

	it("counts polls per file: a file that has no bytes yet does not use them up", async () => {
		await start({ inProgressPolls: 1 });
		const receipt = await create([fileFor("document.pdf", PDF)]);
		const taskId = receipt.json.task_id as string;
		for (let poll = 0; poll < 3; poll += 1) {
			expect((await getTask(taskId)).json.status).toBe("waiting-file");
		}
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		await putTo(upload, PDF);
		expect((await getTask(taskId)).json.status).toBe("pending");
		expect((await getTask(taskId)).json.status).toBe("completed");
	});

	it("reports a running file with the recorded snapshot shape", async () => {
		await start({ neverFinish: true });
		const { taskId } = await submit("report.docx", CSV);
		const first = await getTask(taskId);
		expect(first.json.status).toBe("pending");
		const running = await getTask(taskId);
		expect(running.json.status).toBe("running");
		expect(running.json).not.toHaveProperty("finished_at");
		expect(running.json.output_formats).toEqual(["default"]);
		expect(shapeOf(running.json)).toEqual(
			shapeOf(recordedBody("samples/docx-default/03_poll_01_running.json")),
		);
	});

	it("reports a queued task like the recorded pending snapshot: no started_at until a file runs", async () => {
		await start({ neverFinish: true });
		const { taskId } = await submit("report.docx", CSV);
		const queued = await getTask(taskId);
		expect(queued.json.status).toBe("pending");
		expect(queued.json).not.toHaveProperty("started_at");
		expect(shapeOf(queued.json)).toEqual(
			shapeOf(
				recordedBody(
					"samples/bigdoc-20-pages/p20-concurrent-2/03_poll_01_pending.json",
				),
			),
		);
		const running = await getTask(taskId);
		expect(running.json.status).toBe("running");
		expect(running.json).toHaveProperty("started_at");
	});

	it("a task that never started has no started_at: nothing uploaded yet, or canceled while waiting", async () => {
		await start();
		const receipt = await create([fileFor("document.pdf", PDF)]);
		const taskId = receipt.json.task_id as string;
		const waiting = await getTask(taskId);
		expect(waiting.json.status).toBe("waiting-file");
		expect(waiting.json).not.toHaveProperty("started_at");

		await cancelTask(taskId);
		const canceled = await getTask(taskId);
		expect(canceled.json.status).toBe("canceled");
		expect(canceled.json).not.toHaveProperty("started_at");
		expect(canceled.json).toHaveProperty("finished_at");
	});

	it("a task canceled while its file was running keeps the started_at it earned", async () => {
		await start({ neverFinish: true });
		const { taskId } = await submit("document.pdf", PDF);
		await getTask(taskId);
		expect((await getTask(taskId)).json.status).toBe("running");
		await cancelTask(taskId);
		const canceled = await getTask(taskId);
		expect(canceled.json.status).toBe("canceled");
		expect(canceled.json).toHaveProperty("started_at");
	});

	it("reports a completed file with the recorded snapshot shape", async () => {
		await start();
		const done = await submit("report.docx", CSV);
		const completed = await getTask(done.taskId);
		expect(completed.json.status).toBe("completed");
		expect(shapeOf(completed.json)).toEqual(
			shapeOf(recordedBody("samples/docx-default/03_poll_02_completed.json")),
		);
		const file = completed.json.files?.[0] as {
			bytes: number;
			parse: { tier: string; parser_version: string };
			result_url: string;
		};
		expect(file.bytes).toBe(CSV.byteLength);
		expect(file.parse.parser_version).toBe("4.1.7");
		expect(completed.json.progress).toEqual({
			completed: 1,
			failed: 0,
			total: 1,
		});
	});

	it("reports the effective tier per file: a native document is flash whatever was asked", async () => {
		await start();
		const native = await submit("document.docx", CSV, { tier: "standard" });
		const nativeDone = await getTask(native.taskId);
		expect((nativeDone.json.files?.[0]?.parse as { tier: string }).tier).toBe(
			"flash",
		);
		const visual = await submit("document.pdf", PDF, { tier: "standard" });
		const visualDone = await getTask(visual.taskId);
		expect((visualDone.json.files?.[0]?.parse as { tier: string }).tier).toBe(
			"standard",
		);
	});

	it("serves the result as a ZIP with the recorded download headers", async () => {
		await start({ fixtureInput: "v41-docx" });
		const { taskId } = await submit("document.docx", CSV);
		const done = await getTask(taskId);
		const url = (done.json.files?.[0] as { result_url: string }).result_url;
		expect(url).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/v1\/files\/file-[0-9a-f]{24}\/content$/,
		);

		const download = await call(url);
		expect(download.status).toBe(200);
		const want = recorded(
			"samples/docx-default/04_result_download_0.json",
		).response;
		expect(download.headers.get("content-type")).toBe("application/zip");
		expect(download.headers.get("content-disposition")).toBe(
			'attachment; filename="document.zip"',
		);
		expect(download.headers.get("accept-ranges")).toBe(
			want.headers?.["accept-ranges"],
		);
		expect(download.headers.get("etag")).toBeTruthy();
		expect(download.headers.get("last-modified")).toBeTruthy();
		expect(Number(download.headers.get("content-length"))).toBe(
			download.bytes.byteLength,
		);
		const zip = readFileSync(
			join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-docx.zip"),
		);
		expect(download.bytes.equals(zip)).toBe(true);
	});

	it("keeps the existing input names on the 4.0.4 results, and serves the three 4.1 captures as v41-*", async () => {
		const results: Array<[string | undefined, string]> = [
			// The names the older tests use: the 4.0.4 corpus, which the result parser
			// reads the same. The default is the three-page PDF.
			[undefined, join(MINERU_FIXTURE_ROOT, "pdf", "result.zip")],
			["pdf", join(MINERU_FIXTURE_ROOT, "pdf", "result.zip")],
			["docx", join(MINERU_FIXTURE_ROOT, "docx", "result.zip")],
			["csv", join(MINERU_FIXTURE_ROOT, "csv", "result.zip")],
			// The 4.1 captures, under names of their own.
			["v41-pdf", join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-pdf.zip")],
			["v41-docx", join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-docx.zip")],
			["v41-csv", join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-csv.zip")],
		];
		for (const [input, path] of results) {
			await start(input === undefined ? {} : { fixtureInput: input });
			const { taskId } = await submit("document.pdf", PDF);
			const done = await getTask(taskId);
			const download = await call(
				(done.json.files?.[0] as { result_url: string }).result_url,
			);
			expect(download.bytes.equals(readFileSync(path)), String(input)).toBe(
				true,
			);
			await server?.close();
			server = null;
		}
	});

	it("serves, by default, the document the older tests assert on: three pages, with the running heads in it", async () => {
		// scripts/backfill-extractions.test.ts and the extractor test expect
		// pageCount 3 and that the running heads ("INDIA Confidential", "JULIET
		// Document Footer") are stripped. Against a document without them those
		// not.toContain checks would pass vacuously.
		await start();
		const { taskId } = await submit("document.pdf", PDF);
		const done = await getTask(taskId);
		const download = await call(
			(done.json.files?.[0] as { result_url: string }).result_url,
		);
		const zip = await JSZip.loadAsync(download.bytes);
		const structured = await zip
			.file("structured_content.json")
			?.async("string");
		expect(structured).toContain("INDIA Confidential");
		expect(structured).toContain("JULIET Document Footer");
		expect(JSON.parse(structured ?? "{}").pages).toHaveLength(3);
	});

	it("names a non-ASCII result with filename*=, as the recorded server did", async () => {
		await start({ fixtureInput: "pdf" });
		const { taskId } = await submit("Árvíztűrő jelentés.pdf", PDF);
		const done = await getTask(taskId);
		const download = await call(
			(done.json.files?.[0] as { result_url: string }).result_url,
		);
		expect(download.headers.get("content-disposition")).toBe(
			"attachment; filename*=utf-8''%C3%81rv%C3%ADzt%C5%B1r%C5%91%20jelent%C3%A9s.zip",
		);
	});

	it("falls back to the 4.0.4 result corpus for an input it has no 4.1 ZIP for", async () => {
		await start({ fixtureInput: "xlsx" });
		const { taskId } = await submit("document.xlsx", CSV);
		const done = await getTask(taskId);
		const download = await call(
			(done.json.files?.[0] as { result_url: string }).result_url,
		);
		expect(download.status).toBe(200);
		expect(download.bytes.subarray(0, 2).toString()).toBe("PK");
	});

	it("a PUT of the wrong length is a 400 and leaves the file waiting for a corrected one", async () => {
		await start();
		const receipt = await create([fileFor("document.pdf", PDF)]);
		const taskId = receipt.json.task_id as string;
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		const wrong = recorded("errors/107_upload_size_short_by_one.json");

		const short = await putTo(upload, PDF.subarray(0, PDF.byteLength - 1));
		expect(short.status).toBe(wrong.response.status);
		expect(short.json).toEqual(wrong.response.json);
		const empty = await putTo(upload, Buffer.alloc(0));
		expect(empty.status).toBe(400);

		const after = await getTask(taskId);
		expect(after.json.status).toBe("waiting-file");
		expect(after.json.files?.[0]).toHaveProperty("upload");

		const good = await putTo(upload, PDF);
		expect(good.status).toBe(200);
		expect(good.json.status).toBe("pending");
	});

	it("a PUT whose bytes do not hash to the declared sha256 is a 400, and the file keeps waiting", async () => {
		await start();
		const receipt = await create([fileFor("document.pdf", PDF)]);
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		const wrong = recorded("errors/113_upload_hash_mismatch_right_size.json");

		const swapped = Buffer.from(PDF);
		swapped[0] = 0x58;
		const reply = await putTo(upload, swapped);
		expect(reply.status).toBe(wrong.response.status);
		expect(reply.json).toEqual(wrong.response.json);
		expect((await getTask(receipt.json.task_id as string)).json.status).toBe(
			"waiting-file",
		);
	});

	it("answers a repeat PUT 200 with the file's current status", async () => {
		await start();
		const { taskId, fileId, receipt } = await submit("document.pdf", PDF);
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		const again = await putTo(upload, PDF);
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ task_id: taskId, file_id: fileId });
		await getTask(taskId);
		const later = await putTo(upload, PDF);
		expect(later.status).toBe(200);
		expect(later.json.status).toBe("completed");
	});

	it("tells a PUT to an unknown task or file apart", async () => {
		await start();
		const { receipt } = await submit("document.pdf", PDF);
		const taskId = receipt.json.task_id as string;
		const noTask = await putTo(
			`/v1/tasks/job_${"0".repeat(24)}/uploads/file-${"0".repeat(24)}`,
			PDF,
		);
		expect(noTask.status).toBe(404);
		expect(noTask.json.error?.code).toBe("task_not_found");
		const noFile = await putTo(
			`/v1/tasks/${taskId}/uploads/file-${"0".repeat(24)}`,
			PDF,
		);
		const want = recorded(
			"flows/tier-ceilings/basic/09_put_known_task_unknown_file.json",
		);
		expect(noFile.status).toBe(want.response.status);
		expect(noFile.json).toEqual(want.response.json);
	});

	it("answers an unknown task id, and an unknown result, with the recorded 404s", async () => {
		await start();
		const task = await getTask("job_000000000000000000000000");
		expect(task.status).toBe(404);
		expect(task.json).toEqual(
			recorded("errors/100_get_unknown_task.json").response.json,
		);
		const file = await call("/v1/files/file-000000000000000000000000/content");
		expect(file.status).toBe(404);
		expect(file.json).toEqual(
			recorded("errors/105_get_unknown_file_content.json").response.json,
		);
	});

	it("reports a file that failed with the recorded error shape, and no top-level error", async () => {
		await start({
			outcome: "file-failed",
			fileError: {
				message: "Failed to load document (PDFium: Data format error).",
			},
		});
		const { taskId } = await submit("document.pdf", PDF);
		const failed = await getTask(taskId);
		expect(failed.json.status).toBe("failed");
		expect(failed.json).not.toHaveProperty("error");
		expect(shapeOf(failed.json)).toEqual(
			shapeOf(
				recordedBody("samples/pdf-corrupt-truncated/03_poll_02_failed.json"),
			),
		);
		expect(failed.json.files?.[0]?.error).toEqual({
			code: "parse_failed",
			message: "Failed to load document (PDFium: Data format error).",
		});
		expect(failed.json.progress).toEqual({ completed: 0, failed: 1, total: 1 });
	});

	it("can also misbehave on purpose: no result_url, or a failure that says nothing", async () => {
		await start({ outcome: "completed-without-result-url" });
		const a = await submit("document.pdf", PDF);
		const done = await getTask(a.taskId);
		expect(done.json.status).toBe("completed");
		expect(done.json.files?.[0]).not.toHaveProperty("result_url");

		await server?.close();
		await start({ outcome: "failed-without-detail" });
		const b = await submit("document.pdf", PDF);
		const failed = await getTask(b.taskId);
		expect(failed.json.status).toBe("failed");
		expect(failed.json.files?.[0]).not.toHaveProperty("error");
	});
});

describe("cancel", () => {
	it("cancels a task that is waiting for bytes: every file canceled, and a PUT after it is a 409", async () => {
		await start();
		const receipt = await create([fileFor("document.pdf", PDF)]);
		const taskId = receipt.json.task_id as string;
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;

		const cancel = await cancelTask(taskId);
		expect(cancel.status).toBe(200);
		expect(cancel.json.status).toBe("canceled");
		expect(cancel.json.files?.map((file) => file.status)).toEqual(["canceled"]);
		expect(cancel.json.finished_at).toMatch(
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
		);

		const later = recorded("errors/128_upload_after_cancel.json");
		const put = await putTo(upload, PDF);
		expect(put.status).toBe(later.response.status);
		expect(put.json).toEqual(later.response.json);
		expect((await getTask(taskId)).json.status).toBe("canceled");
	});

	it("cancels files that are RUNNING too, and nothing changes afterwards (D24)", async () => {
		await start({ neverFinish: true });
		const { taskId } = await submit("document.pdf", PDF);
		await getTask(taskId);
		expect((await getTask(taskId)).json.status).toBe("running");

		const cancel = await cancelTask(taskId);
		expect(cancel.json.files?.map((file) => file.status)).toEqual(["canceled"]);
		expect(shapeOf(cancel.json)).toEqual(
			shapeOf({
				...recordedBody("flows/cancel-running/10_cancel_running.json"),
				files: [{ file_id: "", file_name: "", status: "" }],
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const after = await getTask(taskId);
		expect(after.json.status).toBe("canceled");
		expect(after.json.files?.[0]?.status).toBe("canceled");
		expect(after.json.finished_at).toBeTruthy();
	});

	it("keeps a file that had already finished, and its result stays downloadable (D24)", async () => {
		await start({
			// The first file finishes; the other two never do.
			outcomeFor: ({ index }) => (index === 0 ? "completed" : "stuck"),
			fixtureInput: "csv",
		});
		const names = ["m0.csv", "m1.csv", "m2.csv"];
		const files = names.map((name, i) =>
			fileFor(name, Buffer.from(`${i},${name}\n`)),
		);
		const receipt = await create(files);
		const taskId = receipt.json.task_id as string;
		const uploads = (receipt.json.files ?? []).map(
			(file) => (file as { upload: { url: string } }).upload.url,
		);
		for (const [i, upload] of uploads.entries()) {
			await putTo(upload, files[i]?.content as Buffer);
		}
		await getTask(taskId);
		const running = await getTask(taskId);
		expect(running.json.status).toBe("running");
		expect(running.json.files?.map((file) => file.status)).toEqual([
			"completed",
			"running",
			"running",
		]);

		const cancel = await cancelTask(taskId);
		expect(cancel.json.files?.map((file) => file.status)).toEqual([
			"completed",
			"canceled",
			"canceled",
		]);
		const kept = cancel.json.files?.[0] as {
			result_url: string;
			parse: object;
		};
		expect(kept.parse).toBeTruthy();
		const download = await call(kept.result_url);
		expect(download.status).toBe(200);

		const after = await getTask(taskId);
		expect(after.json.status).toBe("canceled");
		expect(after.json.progress).toEqual({ completed: 1, failed: 0, total: 3 });
		expect(after.json.files?.map((file) => file.status)).toEqual([
			"completed",
			"canceled",
			"canceled",
		]);
	});

	it("refuses to cancel a task that is already over: 409 task_already_terminal", async () => {
		await start();
		const { taskId } = await submit("document.pdf", PDF);
		const done = await getTask(taskId);
		expect(done.json.status).toBe("completed");

		const finished = recorded("errors/121_cancel_finished_task.json");
		const late = await cancelTask(taskId);
		expect(late.status).toBe(finished.response.status);
		expect(late.json).toEqual(finished.response.json);

		await cancelTask(taskId);
		const fresh = await create([fileFor("other.csv", CSV)]);
		const id = fresh.json.task_id as string;
		expect((await cancelTask(id)).status).toBe(200);
		const twice = await cancelTask(id);
		expect(twice.status).toBe(409);
		expect(twice.json.error).toEqual({
			code: "task_already_terminal",
			message: "Task is canceled",
		});
	});

	it("answers 404 task_not_found for a task it does not know", async () => {
		await start();
		const unknown = await cancelTask("job_000000000000000000000000");
		expect(unknown.status).toBe(404);
		expect(unknown.json).toEqual(
			recorded("errors/102_cancel_unknown_task.json").response.json,
		);
	});
});

describe("partial tasks", () => {
	it("a task holding one completed and one failed file is `partial`, and terminal", async () => {
		await start({
			outcomeFor: ({ fileName }) =>
				fileName === "bad.pdf" ? "file-failed" : "completed",
			fileError: {
				message: "Failed to load document (PDFium: Data format error).",
			},
		});
		const good = fileFor("good.pdf", PDF);
		const bad = fileFor("bad.pdf", Buffer.from("%PDF-1.7 broken"));
		const receipt = await create([good, bad]);
		expect(shapeOf(receipt.json)).toEqual(
			shapeOf(recordedBody("flows/partial-and-file-terminal/01_create.json")),
		);
		const taskId = receipt.json.task_id as string;
		const uploads = (receipt.json.files ?? []).map(
			(file) => (file as { upload: { url: string } }).upload.url,
		);

		// One file uploaded, the other still waiting: the task waits.
		await putTo(uploads[1] as string, bad.content);
		const waiting = await getTask(taskId);
		expect(waiting.json.files?.map((file) => file.status)).toEqual([
			"waiting-file",
			"failed",
		]);
		expect(waiting.json.status).toBe("waiting-file");

		await putTo(uploads[0] as string, good.content);
		const partial = await getTask(taskId);
		expect(partial.json.status).toBe("partial");
		expect(partial.json.progress).toEqual({
			completed: 1,
			failed: 1,
			total: 2,
		});
		expect(partial.json.files?.map((file) => file.status)).toEqual([
			"completed",
			"failed",
		]);
		expect(shapeOf(partial.json)).toEqual(
			shapeOf(
				recordedBody(
					"flows/partial-and-file-terminal/snapshot_02_partial.json",
				),
			),
		);

		const recordedCancel = recorded(
			"flows/partial-and-file-terminal/08_cancel_partial_task.json",
		);
		const cancel = await cancelTask(taskId);
		expect(cancel.status).toBe(recordedCancel.response.status);
		expect(cancel.json.error).toEqual({
			code: "task_already_terminal",
			message: "Task is partial",
		});
	});
});

describe("restart", () => {
	it("forgets every task, every file and the hash cache, as the recorded restart did", async () => {
		await start();
		const done = await submit("cache-a.pdf", PDF);
		const waiting = await create([fileFor("never-uploaded.csv", CSV)]);
		expect(server?.blobs.size).toBe(1);
		expect(server?.tasks.size).toBe(2);

		server?.restart();
		expect(server?.blobs.size).toBe(0);
		expect(server?.tasks.size).toBe(0);

		const task = await getTask(done.taskId);
		const wantRestart = recorded(
			"flows/restart/01_R1_task_after_restart.json",
		).response;
		expect(task.status).toBe(wantRestart.status);
		expect(task.json).toEqual({
			error: {
				code: (wantRestart.json as { error: { code: string } }).error.code,
				message: `Task ${done.taskId} not found`,
			},
		});
		// Its result is gone with it, and so is a PUT to an upload link handed out before.
		const result = await call(`/v1/files/${done.fileId}/content`);
		expect(result.status).toBe(404);
		expect(result.json.error?.code).toBe("file_not_found");
		const upload = (waiting.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		const put = await putTo(upload, CSV);
		expect(put.status).toBe(404);
		expect(put.json.error?.code).toBe("task_not_found");
		const cancel = await cancelTask(waiting.json.task_id as string);
		expect(cancel.status).toBe(404);
		expect(cancel.json.error?.code).toBe("task_not_found");

		// The hash cache went too: the same bytes must be uploaded again.
		const again = await create([fileFor("cache-a.pdf", PDF)]);
		expect(again.json.status).toBe("waiting-file");
		expect(again.json.files?.[0]).toHaveProperty("upload");
	});

	it("restarts at the moment a test asks for: after the first task, or after the first upload", async () => {
		await start({ restartAfterFirstTask: true });
		const receipt = await create([fileFor("document.pdf", PDF)]);
		expect(receipt.status).toBe(202);
		// The 202 went out, then the server forgot it.
		const upload = (receipt.json.files?.[0] as { upload: { url: string } })
			.upload.url;
		expect((await putTo(upload, PDF)).json.error?.code).toBe("task_not_found");
		// Armed once: the retry is not forgotten.
		const second = await submit("document.pdf", PDF);
		expect((await getTask(second.taskId)).json.status).toBe("completed");

		await server?.close();
		await start({ restartAfterFirstUpload: true });
		const first = await submit("document.pdf", PDF);
		expect((await getTask(first.taskId)).status).toBe(404);
		const retry = await submit("document.pdf", PDF);
		expect((await getTask(retry.taskId)).json.status).toBe("completed");
	});

	it("restarts on a timer", async () => {
		await start({ restartAfterMs: 20 });
		const { taskId } = await submit("document.pdf", PDF);
		// Whenever it fires, the end state is the same: wait for the server to say so.
		await vi.waitFor(() => expect(server?.tasks.size).toBe(0));
		expect((await getTask(taskId)).status).toBe(404);
	});
});

describe("restarts can be armed in the middle of a test", () => {
	// The three restart options used to be read once, when the server was built;
	// setOptions merged them and nothing happened, so a restart-recovery test
	// that armed one after setting up passed without ever restarting.

	it("restartAfterFirstTask, armed by setOptions: the next created task is the last the server remembers", async () => {
		await start();
		const earlier = await submit("a.pdf", PDF);
		expect((await getTask(earlier.taskId)).status).toBe(200);

		server?.setOptions({ restartAfterFirstTask: true });
		const receipt = await create([
			fileFor("b.pdf", Buffer.from("other bytes")),
		]);
		// The 202 went out, and then everything was forgotten, the earlier task too.
		expect(receipt.status).toBe(202);
		expect(server?.tasks.size).toBe(0);
		expect((await getTask(receipt.json.task_id as string)).status).toBe(404);
		expect((await getTask(earlier.taskId)).status).toBe(404);

		// It fired once; the retry is remembered.
		const retry = await submit("b.pdf", PDF);
		expect((await getTask(retry.taskId)).json.status).toBe("completed");
	});

	it("restartAfterFirstUpload, armed by setOptions: the first PUT after it is the last the server remembers", async () => {
		await start();
		const earlier = await submit("a.pdf", PDF);
		expect((await getTask(earlier.taskId)).status).toBe(200);

		server?.setOptions({ restartAfterFirstUpload: true });
		const sent = await submit("b.pdf", Buffer.from("other bytes"));
		expect(server?.tasks.size).toBe(0);
		expect(server?.blobs.size).toBe(0);
		expect((await getTask(sent.taskId)).status).toBe(404);

		const retry = await submit("b.pdf", Buffer.from("other bytes"));
		expect((await getTask(retry.taskId)).json.status).toBe("completed");
	});

	it("restartAfterMs, armed by setOptions, starts a timer; a later patch re-arms it, and undefined clears it", async () => {
		await start();
		const { taskId } = await submit("a.pdf", PDF);
		server?.setOptions({ restartAfterMs: 20 });
		await vi.waitFor(() => expect(server?.tasks.size).toBe(0));
		expect((await getTask(taskId)).status).toBe(404);

		// Armed again, then cleared before it could fire: nothing is forgotten.
		const kept = await submit("a.pdf", PDF);
		server?.setOptions({ restartAfterMs: 40 });
		server?.setOptions({ restartAfterMs: undefined });
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect((await getTask(kept.taskId)).status).toBe(200);

		// Re-armed with a new delay replaces the old timer rather than adding one.
		server?.setOptions({ restartAfterMs: 20 });
		server?.setOptions({ restartAfterMs: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect((await getTask(kept.taskId)).status).toBe(200);
	});

	it("an event restart can be disarmed with false before it fires, and armed again after it has", async () => {
		await start({ restartAfterFirstTask: true });
		server?.setOptions({ restartAfterFirstTask: false });
		const kept = await submit("a.pdf", PDF);
		expect((await getTask(kept.taskId)).status).toBe(200);

		server?.setOptions({ restartAfterFirstUpload: true });
		server?.setOptions({ restartAfterFirstUpload: false });
		const alsoKept = await submit("b.pdf", Buffer.from("other bytes"));
		expect((await getTask(alsoKept.taskId)).status).toBe(200);

		// Fire one, then arm it again: it fires again.
		server?.setOptions({ restartAfterFirstTask: true });
		await create([fileFor("c.pdf", Buffer.from("third"))]);
		expect(server?.tasks.size).toBe(0);
		server?.setOptions({ restartAfterFirstTask: true });
		await create([fileFor("d.pdf", Buffer.from("fourth"))]);
		expect(server?.tasks.size).toBe(0);
	});

	it("a patch that does not mention a restart option leaves an armed one armed", async () => {
		await start({ restartAfterFirstTask: true });
		server?.setOptions({ inProgressPolls: 1 });
		await create([fileFor("a.pdf", PDF)]);
		expect(server?.tasks.size).toBe(0);
	});
});

describe("what is not a /v1/tasks route", () => {
	it("answers the 4.0 routes with FastAPI's own {detail}, so a client can tell", async () => {
		await start();
		const removed = await call("/v1/uploads", { method: "POST" });
		expect(removed.status).toBe(404);
		expect(removed.json).toEqual({ detail: "Not Found" });
		expect(removed.json).toEqual(
			recorded("errors/49_removed_post_uploads.json").response.json,
		);
		expect((await call("/v1/parse/jobs/job_x")).json).toEqual({
			detail: "Not Found",
		});
	});

	it("answers a known route with the wrong method 405, with Allow", async () => {
		await start();
		const wrong = await call("/v1/tasks/job_x", { method: "DELETE" });
		expect(wrong.status).toBe(405);
		expect(wrong.json).toEqual({ detail: "Method Not Allowed" });
		expect(wrong.headers.get("allow")).toBe("GET");
		expect((await call("/v1/tasks")).headers.get("allow")).toBe("POST");
	});
});

describe("options are checked where they are set", () => {
	// A bad option used to throw inside a request handler: the server answered
	// 500 internal_error, which the client reads as an outage and retries, and
	// the test read as "the client retried" instead of "I mistyped a name".

	it("refuses, at construction, a scripted failure whose capture does not exist", async () => {
		await expect(
			createFakeMineruServer({
				failures: [{ path: "/v1/tasks", fixture: "errors/no-such-probe.json" }],
			}),
		).rejects.toThrow(/failures\[0\].*errors\/no-such-probe\.json/);
	});

	it("refuses a capture that has no JSON body to replay, and a file that is not JSON at all", async () => {
		// A download capture records headers and a ZIP listing, not a body.
		await expect(
			createFakeMineruServer({
				failures: [
					{
						path: "/v1/tasks",
						fixture: "samples/docx-default/04_result_download_0.json",
					},
				],
			}),
		).rejects.toThrow(/failures\[0\].*no JSON body/);
		await expect(
			createFakeMineruServer({
				failures: [{ path: "/v1/tasks", fixture: "zips/v41-csv.zip" }],
			}),
		).rejects.toThrow(/failures\[0\]/);
	});

	it("refuses, at construction, a fixtureInput that names no result ZIP, and says where it looked", async () => {
		await expect(
			createFakeMineruServer({ fixtureInput: "no-such-input" }),
		).rejects.toThrow(/fixtureInput "no-such-input".*zips.*no-such-input/s);
	});

	it("refuses the same things from setOptions, and keeps the options it had", async () => {
		await start({ fixtureInput: "v41-csv" });
		expect(() => server?.setOptions({ fixtureInput: "no-such-input" })).toThrow(
			/fixtureInput "no-such-input"/,
		);
		expect(() =>
			server?.setOptions({
				failures: [{ path: "/v1/tasks", fixture: "errors/no-such-probe.json" }],
			}),
		).toThrow(/failures\[0\]/);
		// Refused means refused: the earlier options still stand and the server works.
		const { taskId } = await submit("document.csv", CSV);
		const done = await getTask(taskId);
		expect(done.json.status).toBe("completed");
		const download = await call(
			(done.json.files?.[0] as { result_url: string }).result_url,
		);
		expect(
			download.bytes.equals(
				readFileSync(join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-csv.zip")),
			),
		).toBe(true);
	});

	it("refuses numbers and names that cannot mean anything", async () => {
		await start();
		for (const patch of [
			{ tiers: [] },
			{ tiers: ["gold"] as never },
			{ parseDelayMs: -1 },
			{ inProgressPolls: 1.5 },
			{ inProgressPolls: -1 },
			{ restartAfterMs: Number.NaN },
			{ outcome: "exploded" as never },
			{ redirectDownloads: "sideways" as never },
			{ urlOrigin: "elsewhere" as never },
			{ failures: [{ path: "/v1/tasks", status: 99, body: {} }] },
		]) {
			expect(() => server?.setOptions(patch), JSON.stringify(patch)).toThrow(
				/fake MinerU server/,
			);
		}
	});
});

describe("test controls", () => {
	it("replays a recorded error, or a made-up one, on the request that matches", async () => {
		await start({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					nth: 1,
					fixture: "errors/49_removed_post_uploads.json",
				},
				{
					path: "/v1/tasks",
					method: "POST",
					nth: 2,
					status: 503,
					body: {
						error: { code: "server_shutting_down", message: "Shutting down" },
					},
				},
			],
		});
		const first = await create([fileFor("a.csv", CSV)]);
		expect(first.status).toBe(404);
		expect(first.json).toEqual({ detail: "Not Found" });
		const second = await create([fileFor("a.csv", CSV)]);
		expect(second.status).toBe(503);
		expect(second.json.error?.code).toBe("server_shutting_down");
		expect((await create([fileFor("a.csv", CSV)])).status).toBe(202);
	});

	it("can issue its URLs on a foreign origin, to test that a client will not follow them", async () => {
		await start({ urlOrigin: "cross-origin" });
		const receipt = await create([fileFor("a.csv", CSV)]);
		const url = (receipt.json.files?.[0] as { upload: { url: string } }).upload
			.url;
		expect(url.startsWith(server?.crossOriginBaseUrl as string)).toBe(true);
		expect(url.startsWith(server?.baseUrl as string)).toBe(false);
		// The same server answers there, which is what makes the test meaningful.
		const put = await putTo(url, CSV);
		expect(put.status).toBe(200);
	});

	it("can redirect a download once, same origin or not", async () => {
		await start({ redirectDownloads: "same-origin" });
		const { taskId } = await submit("document.pdf", PDF);
		const done = await getTask(taskId);
		const url = (done.json.files?.[0] as { result_url: string }).result_url;
		const first = await fetch(url, { redirect: "manual" });
		expect(first.status).toBe(302);
		expect(first.headers.get("location")).toBe(url);
		expect((await fetch(url)).status).toBe(200);

		server?.setOptions({ redirectDownloads: "cross-origin" });
		const cross = await fetch(url, { redirect: "manual" });
		expect(cross.headers.get("location")).toContain("localhost");
	});

	it("logs every request, and resetLog forgets them", async () => {
		await start();
		await submit("document.pdf", PDF);
		expect(server?.requests[0]).toMatchObject({
			method: "POST",
			path: "/v1/tasks",
		});
		expect(
			server?.requests.find((request) => request.method === "PUT")?.bodyBytes,
		).toBe(PDF.byteLength);
		expect(server?.requests[0]?.json).toMatchObject({
			files: [{ file_name: "document.pdf" }],
		});
		server?.resetLog();
		expect(server?.requests).toEqual([]);
	});
});
