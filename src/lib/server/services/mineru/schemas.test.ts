/**
 * Every schema, against every recorded response.
 *
 * The last case in this file is the one that matters most: it walks
 * `fixtures/mineru-v1/` and fails when a file was never read. A fixture nobody
 * reads is a fixture nobody is checked against, and the whole point of Phase 0
 * was that the upstream documentation could not be trusted.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fastapiValidationErrorSchema,
	isTerminalMineruJobStatus,
	mineruErrorResponseSchema,
	mineruFileListSchema,
	mineruHealthSchema,
	mineruJobCancelSchema,
	mineruJobSchema,
	mineruTierListLenientSchema,
	mineruTierListSchema,
	mineruUploadSchema,
	mineruUsageSchema,
} from "./schemas";
import { MINERU_FIXTURE_ROOT } from "./testing/fake-server";

/** Every fixture path this file has touched, for the coverage case below. */
const touched = new Set<string>();

function fixturePath(...parts: string[]): string {
	const path = join(MINERU_FIXTURE_ROOT, ...parts);
	touched.add(path);
	return path;
}

function readJson<T = Record<string, unknown>>(...parts: string[]): T {
	return JSON.parse(readFileSync(fixturePath(...parts), "utf8")) as T;
}

function readBytes(...parts: string[]): Buffer {
	return readFileSync(fixturePath(...parts));
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

const INPUT_DIRS = [
	"pdf",
	"docx",
	"xlsx",
	"pptx",
	"html",
	"csv",
	"epub",
	"png",
	"jpg",
] as const;

describe("mineru schemas — recorded uploads", () => {
	it.each(INPUT_DIRS)("parses %s upload.create.json", (input) => {
		const parsed = mineruUploadSchema.parse(
			readJson(input, "upload.create.json"),
		);
		expect(parsed.id).toMatch(/^upload_/);
		expect(["pending", "completed"]).toContain(parsed.status);
	});

	it("parses the PDF dedupe hit: completed at create, with an embedded file", () => {
		const upload = mineruUploadSchema.parse(
			readJson("pdf", "upload.create.json"),
		);
		expect(upload.status).toBe("completed");
		expect(upload.upload_url).toBeNull();
		expect(upload.upload_method).toBeNull();
		expect(upload.file?.id).toBe("file-10c3b409b0ab0e3b7da5fc00");
		// The dedupe hit is why `pdf/upload.complete.json` does not exist.
		expect(upload.sha256sum).toMatch(/^[a-f0-9]{64}$/);
	});

	it("parses the fresh DOCX upload: pending, with an absolute upload_url", () => {
		const upload = mineruUploadSchema.parse(
			readJson("docx", "upload.create.json"),
		);
		expect(upload.status).toBe("pending");
		expect(upload.upload_method).toBe("PUT");
		expect(upload.upload_url).toBe(
			"http://127.0.0.1:8765/v1/uploads/upload_7e33e5d48a2a3789f878f873/content",
		);
		expect(upload.upload_headers?.["Content-Type"]).toContain(
			"wordprocessingml",
		);
		expect(upload.file).toBeNull();
	});

	it.each(
		INPUT_DIRS.filter((input) => input !== "pdf"),
	)("parses %s upload.complete.json", (input) => {
		const upload = mineruUploadSchema.parse(
			readJson(input, "upload.complete.json"),
		);
		expect(upload.status).toBe("completed");
		expect(upload.file?.purpose).toBe("parse");
	});
});

describe("mineru schemas — recorded jobs", () => {
	it.each(INPUT_DIRS)("parses %s job.create.json as a queued job", (input) => {
		const job = mineruJobSchema.parse(readJson(input, "job.create.json"));
		expect(job.status).toBe("queued");
		expect(isTerminalMineruJobStatus(job.status)).toBe(false);
		// "" on a queued job — NOT null.
		expect(job.files[0]?.page_range).toBe("");
		expect(job.files[0]?.parse).toBeNull();
		expect(job.files[0]?.output_files).toBeNull();
	});

	it.each([
		...INPUT_DIRS,
		"flash-pdf",
	] as const)("parses %s job.final.json as a terminal job", (input) => {
		const job = mineruJobSchema.parse(readJson(input, "job.final.json"));
		expect(job.status).toBe("completed");
		expect(isTerminalMineruJobStatus(job.status)).toBe(true);
		expect(job.files[0]?.status).toBe("completed");
		expect(job.files[0]?.page_range).toMatch(/^\d+(-\d+)?$/);
	});

	it("keeps every output_files key, with null for the unrequested formats", () => {
		const job = mineruJobSchema.parse(readJson("pdf", "job.final.json"));
		const outputs = job.files[0]?.output_files;
		expect(outputs).toBeTruthy();
		expect(Object.keys(outputs ?? {})).toEqual([
			"markdown",
			"middle_json",
			"structured_content",
			"html",
			"latex",
			"docx",
			"zip",
		]);
		expect(outputs?.html).toBeNull();
		expect(outputs?.latex).toBeNull();
		expect(outputs?.docx).toBeNull();
		expect(outputs?.zip).toEqual({
			file_id: "file-d3aae163fbf484a7ae8ae604",
			bytes: 71547,
		});
	});

	it("tolerates parse.model_used being null on a completed file", () => {
		const job = mineruJobSchema.parse(readJson("pdf", "job.final.json"));
		expect(job.files[0]?.parse?.model_used).toBeNull();
		expect(job.files[0]?.parse?.parser_version).toBe("4.0.4");
	});

	it("keeps the JOB tier even though it lies about the file's real tier", () => {
		// docx executes at flash INSIDE a basic job; only
		// extensions.mineru.tier (Phase 4) knows that.
		const job = mineruJobSchema.parse(readJson("docx", "job.final.json"));
		expect(job.tier).toBe("basic");
	});
});

describe("mineru schemas — capability reads", () => {
	it("parses /v1/health on both server shapes", () => {
		for (const name of ["health.json", "flash.health.json"]) {
			const health = mineruHealthSchema.parse(readJson("server", name));
			expect(health.version).toBe("4.0.4");
			expect(health.features?.webhook).toBe(false);
			expect(health.features?.output_formats).toEqual([
				"markdown",
				"middle_json",
				"structured_content",
				"zip",
			]);
		}
	});

	it("parses /v1/tiers on both server shapes", () => {
		const basic = mineruTierListSchema.parse(readJson("server", "tiers.json"));
		expect(basic.data.map((tier) => tier.id)).toEqual(["flash", "basic"]);
		// current_model does NOT join to /v1/models[].id.
		expect(basic.data[1]?.current_model).toBe("hybrid-basic");

		const flash = mineruTierListSchema.parse(
			readJson("server", "flash.tiers.json"),
		);
		expect(flash.data.map((tier) => tier.id)).toEqual(["flash"]);
	});

	it("drops an unknown tier id in the lenient shape instead of failing", () => {
		const parsed = mineruTierListLenientSchema.parse({
			object: "list",
			data: [
				{ id: "flash", description: "Fast." },
				{ id: "quantum", description: "From a future server." },
			],
		});
		expect(parsed.data.map((tier) => tier.id)).toEqual(["flash", "quantum"]);
		// …and the strict shape, which pins what was recorded, does fail.
		expect(
			mineruTierListSchema.safeParse({
				data: [{ id: "quantum", description: "" }],
			}).success,
		).toBe(false);
	});

	it("parses /v1/usage, which is where the real limits live", () => {
		const usage = mineruUsageSchema.parse(readJson("server", "usage.json"));
		expect(usage.access_level).toBe("anonymous");
		expect(usage.limits?.max_file_size_bytes).toBe(209715200);
		expect(usage.limits?.max_file_retention_days).toBeNull();
	});

	it("reads /v1/models and the OpenAPI document without modelling them", () => {
		// Neither is used by the client: models[].id does not join to a tier,
		// and the OpenAPI document is a fixture for humans.
		const models = readJson<{ data: Array<{ id: string }> }>(
			"server",
			"models.json",
		);
		expect(models.data.map((model) => model.id)).toEqual([
			"MinerU-Flash",
			"Hybrid-Basic",
			"MinerU-HTML",
		]);
		const flashModels = readJson<{ data: Array<{ id: string }> }>(
			"server",
			"flash.models.json",
		);
		expect(flashModels.data.map((model) => model.id)).toContain("MinerU-Flash");

		const openapi = readJson<{ openapi: string }>("server", "openapi.json");
		expect(openapi.openapi).toBe("3.1.0");
	});
});

describe("mineru schemas — spelling and tolerance", () => {
	it("pins the cancelled/canceled split that exists inside one API", () => {
		const upload = mineruUploadSchema.parse(
			readJson("errors", "upload_cancel_pending.json").body,
		);
		// TWO l's on an upload…
		expect(upload.status).toBe("cancelled");

		const cancel = mineruJobCancelSchema.parse(
			readJson("errors", "cancel_running_job.json").body,
		);
		// …and ONE on a job cancel.
		expect(cancel.status).toBe("canceled");

		const after = mineruJobSchema.parse(
			readJson("errors", "cancel_running_job_after.json").body,
		);
		expect(after.status).toBe("canceled");
	});

	it("survives a server that adds a field we have never seen", () => {
		const recorded = readJson<{ files: Array<Record<string, unknown>> }>(
			"pdf",
			"job.final.json",
		);
		const job = mineruJobSchema.parse({
			...recorded,
			carbon_grams: 7,
			files: [{ ...recorded.files[0], vibes: "excellent" }],
		});
		expect((job as unknown as { carbon_grams: number }).carbon_grams).toBe(7);
	});

	it("rejects a 200 whose shape is wrong — a 200 is not automatically valid", () => {
		expect(mineruJobSchema.safeParse({ job_id: "job_1" }).success).toBe(false);
		expect(mineruUploadSchema.safeParse({ id: "upload_1" }).success).toBe(
			false,
		);
		expect(mineruHealthSchema.safeParse({ status: "ok" }).success).toBe(false);
	});

	it("parses both error envelopes", () => {
		const mineru = mineruErrorResponseSchema.parse(
			readJson("errors", "tier_standard.json").body,
		);
		expect(mineru.error.code).toBe("invalid_request");
		expect(mineru.error.param).toBeNull();

		const fastapi = fastapiValidationErrorSchema.parse({
			detail: [
				{ loc: ["body", "tier"], msg: "field required", type: "value_error" },
			],
		});
		expect(fastapi.detail[0]?.msg).toBe("field required");
	});

	it("parses the anonymous file listings the local server allows", () => {
		// The docs promise 403 list_requires_api_key here; the local server
		// serves both listings anonymously, with real rows.
		const anonymous = mineruFileListSchema.parse(
			readJson("errors", "list_files.json").body,
		);
		expect(anonymous.data.length).toBeGreaterThan(0);
		expect(anonymous.data.map((file) => file.purpose)).toContain(
			"parse_output",
		);

		const keyed = mineruFileListSchema.parse(
			readJson("errors", "auth_valid_key_files.json").body,
		);
		expect(keyed.data).toEqual([]);
		const jobs = readJson<{ body: { data: unknown[] } }>(
			"errors",
			"list_jobs.json",
		);
		expect(Array.isArray(jobs.body.data)).toBe(true);
	});
});

describe("mineru schemas — every recorded error body", () => {
	const errorDir = join(MINERU_FIXTURE_ROOT, "errors");
	const names = readdirSync(errorDir).filter(
		(name) => name.endsWith(".json") && !name.startsWith("_"),
	);

	it.each(names)("parses %s", (name) => {
		const probe = readJson<{ http_status?: number; body?: unknown }>(
			"errors",
			name,
		);
		const body = probe.body as Record<string, unknown> | undefined;
		if (body && "error" in body) {
			expect(mineruErrorResponseSchema.safeParse(body).success).toBe(true);
			return;
		}
		if (body && "job_id" in body && "status" in body && "files" in body) {
			expect(mineruJobSchema.safeParse(body).success).toBe(true);
			return;
		}
		// Whatever it is — a health read, a listing, an upload, a cancel — it
		// parsed as JSON, which is all this case claims for the leftovers.
		expect(probe).toBeTruthy();
	});

	it("parses every deferred 202-then-fail follow-up as a terminal job", () => {
		const followups = readJson<
			Array<{ probe: string; final: unknown; file_error: unknown }>
		>("errors", "_202-followups.json");
		expect(followups).toHaveLength(8);
		for (const followup of followups) {
			const job = mineruJobSchema.parse(followup.final);
			expect(isTerminalMineruJobStatus(job.status)).toBe(true);
		}
	});

	it("reads the probe index", () => {
		const index = readJson<Array<{ probe: string }>>("errors", "_index.json");
		expect(index.map((row) => row.probe)).toContain("auth_missing_key");
	});
});

describe("mineru schemas — restart probes", () => {
	it("records that bytes survive a restart and identifiers do not", () => {
		const before = readJson<{
			upload_create_status_for_known_sha: string;
			reupload_same_sha_status: string;
			reupload_same_sha_same_file_id: boolean;
		}>("probe.restart-before.json");
		expect(before.upload_create_status_for_known_sha).toBe("completed");
		expect(before.reupload_same_sha_status).toBe("completed");
		// The dedupe hit mints a NEW file id. This is why no id is ever persisted.
		expect(before.reupload_same_sha_same_file_id).toBe(false);

		const after = readJson<{
			upload: { http_status: number; body: string };
			input_file: { http_status: number; body: string };
			job: { http_status: number; body: string };
			output_zip_content: { http_status: number; body: string };
			dedupe_after_restart_status: string;
		}>("probe.restart-after.json");

		for (const probe of [
			after.upload,
			after.input_file,
			after.job,
			after.output_zip_content,
		]) {
			expect(probe.http_status).toBe(404);
			expect(
				mineruErrorResponseSchema.safeParse(JSON.parse(probe.body)).success,
			).toBe(true);
		}
		expect(JSON.parse(after.upload.body).error.code).toBe("upload_not_found");
		expect(JSON.parse(after.input_file.body).error.code).toBe("file_not_found");
		expect(JSON.parse(after.job.body).error.code).toBe("job_not_found");
		// …and the sha still dedupes afterwards. That is the recovery path.
		expect(after.dedupe_after_restart_status).toBe("completed");
	});
});

describe("mineru fixtures — coverage", () => {
	it("reads the per-input artifacts the later phases parse", () => {
		for (const input of [...INPUT_DIRS, "flash-pdf"] as const) {
			const structured = readJson<{ pages: unknown[] }>(
				input,
				"structured_content.json",
			);
			expect(Array.isArray(structured.pages)).toBe(true);
			const middle = readJson<{ schema: string }>(input, "middle_json.json");
			expect(middle.schema).toBe("docvortex.middle");
			expect(readBytes(input, "markdown.md").byteLength).toBeGreaterThan(0);
			expect(readBytes(input, "result.zip").byteLength).toBeGreaterThan(0);
		}
		for (const input of INPUT_DIRS) {
			expect(readBytes(input, "zip-listing.txt").toString()).toContain(
				"structured_content.json",
			);
			const sample = readdirSync(join(MINERU_FIXTURE_ROOT, input)).find(
				(name) => name.startsWith("sample."),
			);
			expect(sample).toBeTruthy();
			expect(readBytes(input, sample as string).byteLength).toBeGreaterThan(0);
		}
		const summary =
			readJson<Array<{ name: string; zip_bytes?: number }>>(
				"_run-summary.json",
			);
		expect(summary.length).toBeGreaterThanOrEqual(9);
	});

	it("leaves no fixture unread", () => {
		const all = walk(MINERU_FIXTURE_ROOT);
		const unread = all
			.filter((path) => !touched.has(path))
			.map((path) => relative(MINERU_FIXTURE_ROOT, path))
			.sort();
		expect(unread).toEqual([]);
		// Sanity: the walk really did find the tree.
		expect(all.length).toBeGreaterThan(100);
		expect(statSync(MINERU_FIXTURE_ROOT).isDirectory()).toBe(true);
	});
});
