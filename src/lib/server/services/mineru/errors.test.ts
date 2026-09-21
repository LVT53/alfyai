/**
 * The error map, driven by every probe the spike recorded.
 *
 * Two guards make this more than a list of assertions:
 *
 *  1. Every file under `fixtures/mineru-v1/errors/` must appear in
 *     `EXPECTED` below. A future fixture run that adds a probe fails here, by
 *     name, instead of silently shipping an unmapped failure mode.
 *  2. Every mapped error must report `known: true` — i.e. a rule matched on the
 *     server's `code`, not a status-shaped fallback.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import {
	isMineruForgottenIdError,
	MINERU_CLIENT_ERROR_CODES,
	MineruApiError,
	type MineruErrorDisposition,
	mapMineruError,
	mapMineruJobFailure,
	mineruApiErrorFromBody,
	mineruErrorToExtractionError,
	parseMineruErrorBody,
	redactMineruSecrets,
	truncateMineruBody,
} from "./errors";
import { mineruJobSchema } from "./schemas";
import { MINERU_FIXTURE_ROOT } from "./testing/fake-server";

const ERROR_DIR = join(MINERU_FIXTURE_ROOT, "errors");

interface Expectation {
	taxonomy: ExtractionErrorCode;
	retryable: boolean;
	disposition?: MineruErrorDisposition;
	handleUnknown?: boolean;
}

/** `null` = the probe is not an error at all (a 200 or a 202). */
const EXPECTED: Record<string, Expectation | null> = {
	// -- not errors ---------------------------------------------------------
	auth_health_unauthenticated: null,
	auth_valid_key_files: null,
	cancel_running_job: null,
	cancel_running_job_after: null,
	flash_csv_tier_omitted: null,
	flash_explicit_flash: null,
	inline_source_ok: null,
	job_unknown_file_id: null,
	keyed_job_create: null,
	keyed_usage: null,
	list_files: null,
	list_jobs: null,
	page_range_on_csv: null,
	page_range_on_png: null,
	page_range_out_of_bounds: null,
	page_range_reverse_rN: null,
	tier_basic: null,
	tier_flash: null,
	upload_cancel_pending: null,
	upload_wronghash_create: null,
	upload_wronghash_put: null,

	// -- authentication -----------------------------------------------------
	auth_invalid_key: { taxonomy: "auth_failed", retryable: false },
	auth_missing_key: { taxonomy: "auth_failed", retryable: false },
	auth_upload_no_key: { taxonomy: "auth_failed", retryable: false },

	// -- tier ---------------------------------------------------------------
	tier_standard: { taxonomy: "tier_unavailable", retryable: false },
	tier_advanced: { taxonomy: "tier_unavailable", retryable: false },
	flash_basic_tier_requested: {
		taxonomy: "tier_unavailable",
		retryable: false,
	},
	flash_pdf_tier_omitted: { taxonomy: "tier_unavailable", retryable: false },
	flash_pdf_tier_null: { taxonomy: "tier_unavailable", retryable: false },
	flash_image_tier_omitted: { taxonomy: "tier_unavailable", retryable: false },
	tier_invalid_tier: { taxonomy: "protocol", retryable: false },

	// -- output formats and sources ----------------------------------------
	output_format_docx: { taxonomy: "protocol", retryable: false },
	output_format_html: { taxonomy: "protocol", retryable: false },
	output_format_latex: { taxonomy: "protocol", retryable: false },
	output_format_json: { taxonomy: "protocol", retryable: false },
	output_format_images: { taxonomy: "protocol", retryable: false },
	output_format_content_list_v2: { taxonomy: "protocol", retryable: false },
	keyed_output_docx: { taxonomy: "protocol", retryable: false },
	keyed_output_html: { taxonomy: "protocol", retryable: false },
	keyed_output_latex: { taxonomy: "protocol", retryable: false },
	keyed_source_download: { taxonomy: "protocol", retryable: false },
	source_file_content_download: { taxonomy: "protocol", retryable: false },
	inline_source_too_big: { taxonomy: "protocol", retryable: false },
	url_source_http: { taxonomy: "protocol", retryable: false },
	source_type_local: { taxonomy: "protocol", retryable: false },

	// -- request shape ------------------------------------------------------
	files_empty: { taxonomy: "protocol", retryable: false },
	ocr_mode_invalid: { taxonomy: "protocol", retryable: false },
	ocr_mode_null: { taxonomy: "protocol", retryable: false },
	callback_unsupported: { taxonomy: "protocol", retryable: false },
	keyed_callback: { taxonomy: "protocol", retryable: false },
	page_range_malformed: { taxonomy: "protocol", retryable: false },
	list_bad_limit: { taxonomy: "protocol", retryable: false },
	upload_bad_purpose: { taxonomy: "protocol", retryable: false },
	upload_bad_sha_format: { taxonomy: "protocol", retryable: false },
	upload_missing_fields: { taxonomy: "protocol", retryable: false },
	model_unknown: { taxonomy: "protocol", retryable: false },

	// -- uploads ------------------------------------------------------------
	upload_wronghash_complete: { taxonomy: "protocol", retryable: true },
	upload_complete_without_bytes: { taxonomy: "protocol", retryable: true },
	upload_bytes_mismatch_complete: { taxonomy: "protocol", retryable: true },
	upload_bytes_mismatch_put: { taxonomy: "protocol", retryable: true },
	upload_cancel_twice: {
		taxonomy: "protocol",
		retryable: false,
		disposition: "swallow",
	},

	// -- forgotten ids and cancels ------------------------------------------
	cancel_finished_job: {
		taxonomy: "protocol",
		retryable: false,
		disposition: "swallow",
	},
	cancel_unknown_job: {
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
	},
	job_unknown_id: {
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
	},
	file_unknown_id: {
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
	},
	file_unknown_id_content: {
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
	},
	upload_unknown_id: {
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
	},
};

interface Probe {
	probe: string;
	http_status?: number;
	body?: unknown;
}

function readProbe(name: string): Probe {
	return JSON.parse(readFileSync(join(ERROR_DIR, name), "utf8")) as Probe;
}

const probeNames = readdirSync(ERROR_DIR)
	.filter((name) => name.endsWith(".json") && !name.startsWith("_"))
	.filter((name) => !name.endsWith(".final.json"))
	.map((name) => name.replace(/\.json$/, ""));

describe("mapMineruError — every recorded probe", () => {
	it("has an expectation for every probe fixture on disk", () => {
		const missing = probeNames.filter((name) => !(name in EXPECTED));
		expect(
			missing,
			`probe fixtures with no taxonomy row: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it.each(probeNames)("maps %s", (name) => {
		const probe = readProbe(`${name}.json`);
		const expectation = EXPECTED[name];
		const status = probe.http_status ?? 200;

		if (expectation === null) {
			expect(status).toBeLessThan(400);
			return;
		}
		expect(expectation, `no expectation for ${name}`).toBeTruthy();

		const error = mineruApiErrorFromBody({
			status,
			bodyText: JSON.stringify(probe.body),
			path: "/v1/probe",
		});
		const mapping = mapMineruError(error);

		expect(
			mapping.known,
			`${name} (code "${error.code}") matched no rule — add one to MINERU_ERROR_RULES`,
		).toBe(true);
		expect(mapping.taxonomy, name).toBe(expectation.taxonomy);
		expect(mapping.retryable, name).toBe(expectation.retryable);
		expect(mapping.disposition, name).toBe(expectation.disposition ?? "fail");
		expect(mapping.handleUnknown, name).toBe(
			expectation.handleUnknown ?? false,
		);
	});

	it("routes the three forgotten-id codes to the re-upload recovery", () => {
		for (const name of [
			"job_unknown_id",
			"file_unknown_id",
			"upload_unknown_id",
		]) {
			const probe = readProbe(`${name}.json`);
			const error = mineruApiErrorFromBody({
				status: probe.http_status ?? 404,
				bodyText: JSON.stringify(probe.body),
			});
			expect(isMineruForgottenIdError(error)).toBe(true);
			expect(mapMineruError(error).disposition).toBe("recover-by-reupload");
		}
	});

	it("reads feature_requires_api_key as final, not as 'add a key and retry'", () => {
		const anonymous = mapMineruError(
			mineruApiErrorFromBody({
				status: 403,
				bodyText: JSON.stringify(readProbe("output_format_docx.json").body),
			}),
		);
		const keyed = mapMineruError(
			mineruApiErrorFromBody({
				status: 400,
				bodyText: JSON.stringify(readProbe("keyed_output_docx.json").body),
			}),
		);
		// Same input, two codes, one verdict: do not retry.
		expect(anonymous.retryable).toBe(false);
		expect(keyed.retryable).toBe(false);
		expect(anonymous.taxonomy).toBe("protocol");
		expect(keyed.taxonomy).toBe("protocol");
	});
});

describe("mapMineruError — deferred, file-level failures", () => {
	const followups = JSON.parse(
		readFileSync(join(ERROR_DIR, "_202-followups.json"), "utf8"),
	) as Array<{ probe: string; final: unknown }>;

	function finalFor(probe: string) {
		const row = followups.find((entry) => entry.probe === probe);
		expect(row, `no 202-followup recorded for ${probe}`).toBeTruthy();
		return mineruJobSchema.parse(row?.final);
	}

	it("treats an unknown file_id as a poisonous handle, and retries", () => {
		const mapping = mapMineruJobFailure(finalFor("job_unknown_file_id"));
		expect(mapping?.taxonomy).toBe("protocol");
		expect(mapping?.retryable).toBe(true);
		// The ledger must clear the stored handle and submit fresh.
		expect(mapping?.handleUnknown).toBe(true);
	});

	it.each([
		"page_range_on_csv",
		"page_range_on_png",
		"page_range_out_of_bounds",
	])("maps the deferred page_range failure in %s", (probe) => {
		const mapping = mapMineruJobFailure(finalFor(probe));
		expect(mapping?.taxonomy).toBe("protocol");
		expect(mapping?.retryable).toBe(false);
		expect(mapping?.known).toBe(true);
	});

	it.each([
		"tier_flash",
		"tier_basic",
		"page_range_reverse_rN",
		"inline_source_ok",
	])("reports no failure for the successful follow-up %s", (probe) => {
		// These jobs requested markdown only, so the zip is legitimately absent.
		expect(
			mapMineruJobFailure(finalFor(probe), { requiredOutput: "markdown" }),
		).toBeNull();
	});

	it("fails a completed job whose requested output is missing", () => {
		const mapping = mapMineruJobFailure(finalFor("tier_basic"));
		expect(mapping?.taxonomy).toBe("protocol");
		expect(mapping?.retryable).toBe(true);
		expect(mapping?.rule).toBe("job:missing-output");
	});

	it("fails a job canceled by someone else, and not one we canceled", () => {
		const canceled = mineruJobSchema.parse(
			(
				JSON.parse(
					readFileSync(
						join(ERROR_DIR, "cancel_running_job_after.json"),
						"utf8",
					),
				) as { body: unknown }
			).body,
		);
		expect(mapMineruJobFailure(canceled)?.taxonomy).toBe("job_failed");
		expect(mapMineruJobFailure(canceled, { canceledByUs: true })).toBeNull();
	});

	it("fails a partial job — UNVERIFIED upstream, so it is never a success", () => {
		const job = mineruJobSchema.parse({
			...(JSON.parse(
				readFileSync(
					join(MINERU_FIXTURE_ROOT, "pdf", "job.final.json"),
					"utf8",
				),
			) as Record<string, unknown>),
			status: "partial",
		});
		const mapping = mapMineruJobFailure(job);
		expect(mapping?.taxonomy).toBe("job_failed");
		expect(mapping?.retryable).toBe(true);
	});

	// Ruling 3. Live, MinerU 4.0.4 answered AVIF and SVG with a file-level
	// `parse_failed` reading "Unsupported file type: <name>". Read as an
	// ordinary `job_failed` it burned three attempts plus backoff and then
	// offered a Retry that could never succeed — the most expensive possible
	// way to tell someone their file cannot be read.
	it.each([
		["Unsupported file type: cover.avif", "cover.avif"],
		["Unsupported file type: diagram.svg", "diagram.svg"],
		["unsupported input format: chart.heic", "chart.heic"],
	])("reads %s as a permanent refusal, not a retryable failure", (message) => {
		const job = mineruJobSchema.parse({
			...(JSON.parse(
				readFileSync(
					join(MINERU_FIXTURE_ROOT, "pdf", "job.final.json"),
					"utf8",
				),
			) as Record<string, unknown>),
			status: "failed",
			files: [
				{
					file_id: "file-000000000001",
					name: "cover.avif",
					page_range: "",
					status: "failed",
					parse: null,
					output_files: null,
					error: {
						type: "engine_error",
						code: "parse_failed",
						message,
						param: null,
					},
				},
			],
		});

		const mapping = mapMineruJobFailure(job);
		expect(mapping?.taxonomy).toBe("unsupported_type");
		expect(mapping?.retryable).toBe(false);
		expect(mapping?.known).toBe(true);
		expect(mapping?.rule).toBe("file:parse_failed:unsupported-type");
	});

	it("still reads an ordinary parse failure as retryable", () => {
		const job = mineruJobSchema.parse({
			...(JSON.parse(
				readFileSync(
					join(MINERU_FIXTURE_ROOT, "pdf", "job.final.json"),
					"utf8",
				),
			) as Record<string, unknown>),
			status: "failed",
			files: [
				{
					file_id: "file-000000000001",
					name: "scan.pdf",
					page_range: "",
					status: "failed",
					parse: null,
					output_files: null,
					error: {
						type: "engine_error",
						code: "parse_failed",
						message: "Engine crashed while rendering page 3",
						param: null,
					},
				},
			],
		});

		expect(mapMineruJobFailure(job)).toMatchObject({
			taxonomy: "job_failed",
			retryable: true,
		});
	});

	it("accepts the recorded PDF job, which is the success case", () => {
		const job = mineruJobSchema.parse(
			JSON.parse(
				readFileSync(
					join(MINERU_FIXTURE_ROOT, "pdf", "job.final.json"),
					"utf8",
				),
			),
		);
		expect(mapMineruJobFailure(job)).toBeNull();
	});
});

describe("mapMineruError — transport and unverified responses", () => {
	it("maps a fetch failure to unavailable, retryable", () => {
		const mapping = mapMineruError(
			Object.assign(new TypeError("fetch failed"), {
				cause: { code: "ECONNREFUSED" },
			}),
		);
		expect(mapping.taxonomy).toBe("unavailable");
		expect(mapping.retryable).toBe(true);
	});

	it("tells a user cancel apart from our own timeout", () => {
		const aborted = mapMineruError(
			new DOMException("aborted", "AbortError") as unknown as Error,
		);
		expect(aborted.taxonomy).toBe("canceled");
		expect(aborted.retryable).toBe(false);

		const timedOut = mapMineruError(
			new DOMException("timed out", "TimeoutError") as unknown as Error,
		);
		expect(timedOut.taxonomy).toBe("timeout");
		expect(timedOut.retryable).toBe(true);
	});

	it("never retries an untrusted upload_url", () => {
		const mapping = mapMineruError(
			new MineruApiError({
				code: MINERU_CLIENT_ERROR_CODES.untrustedUploadUrl,
				message: "refused",
			}),
		);
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(false);
	});

	it.each([
		[MINERU_CLIENT_ERROR_CODES.invalidJson, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.schemaMismatch, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.byteCountMismatch, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.missingZipOutput, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.jobDeadline, "timeout", true],
		[MINERU_CLIENT_ERROR_CODES.tierNotAvailable, "tier_unavailable", false],
	])("maps the client-side code %s", (code, taxonomy, retryable) => {
		const mapping = mapMineruError(new MineruApiError({ code, message: "x" }));
		expect(mapping.known).toBe(true);
		expect(mapping.taxonomy).toBe(taxonomy);
		expect(mapping.retryable).toBe(retryable);
	});

	it("maps the two responses the spike never triggered", () => {
		const rateLimited = mapMineruError(
			mineruApiErrorFromBody({
				status: 429,
				bodyText: JSON.stringify({
					error: {
						type: "invalid_request_error",
						code: "rate_limit_exceeded",
						message: "Too many requests",
						param: null,
					},
				}),
				retryAfterMs: 5000,
			}),
		);
		expect(rateLimited.taxonomy).toBe("rate_limited");
		expect(rateLimited.retryable).toBe(true);
		expect(rateLimited.retryAfterMs).toBe(5000);

		const tooLarge = mapMineruError(
			mineruApiErrorFromBody({
				status: 413,
				bodyText: JSON.stringify({
					error: {
						type: "invalid_request_error",
						code: "file_too_large",
						message: "File exceeds max_file_size_bytes",
						param: null,
					},
				}),
			}),
		);
		expect(tooLarge.taxonomy).toBe("too_large");
		expect(tooLarge.retryable).toBe(false);
	});

	it("maps FastAPI's 422 envelope and an unclassified 5xx", () => {
		const validation = mineruApiErrorFromBody({
			status: 422,
			bodyText: JSON.stringify({
				detail: [
					{ loc: ["body", "files", 0], msg: "field required", type: "missing" },
				],
			}),
		});
		expect(validation.fastapiValidation).toBe(true);
		expect(validation.param).toBe("body.files.0");
		const mapped = mapMineruError(validation);
		expect(mapped.taxonomy).toBe("protocol");
		expect(mapped.retryable).toBe(false);

		const serverError = mapMineruError(
			mineruApiErrorFromBody({ status: 502, bodyText: "<html>bad gateway" }),
		);
		expect(serverError.taxonomy).toBe("unavailable");
		expect(serverError.retryable).toBe(true);
	});
});

describe("error bodies never leak", () => {
	it("truncates an upstream body to 300 characters", () => {
		const excerpt = truncateMineruBody("x".repeat(5000));
		expect(excerpt.length).toBe(301);
		expect(excerpt.endsWith("…")).toBe(true);
	});

	it("collapses whitespace so a body cannot smuggle a fake log line", () => {
		expect(truncateMineruBody("a\n\n  b\tc")).toBe("a b c");
	});

	it("redacts the API key from anything about to be logged", () => {
		const text = "Authorization: Bearer sk-test-123 was rejected";
		expect(redactMineruSecrets(text, "sk-test-123")).toBe(
			"Authorization: Bearer [redacted] was rejected",
		);
		expect(redactMineruSecrets(text, "")).toBe(text);
	});

	it("keeps an opaque body as an excerpt rather than losing the message", () => {
		const parsed = parseMineruErrorBody("<html>504 Gateway Timeout</html>");
		expect(parsed.detail).toBeNull();
		expect(parsed.excerpt).toContain("504 Gateway Timeout");
	});
});

describe("mineruErrorToExtractionError", () => {
	it("carries the taxonomy, the retry verdict and MinerU-free diagnostics", () => {
		const probe = readProbe("auth_missing_key.json");
		const error = mineruErrorToExtractionError(
			mineruApiErrorFromBody({
				status: probe.http_status ?? 401,
				bodyText: JSON.stringify(probe.body),
				path: "/v1/uploads",
			}),
			{ context: "MinerU upload failed" },
		);
		expect(error.code).toBe("auth_failed");
		expect(error.retryable).toBe(false);
		// The MESSAGE is the code's, not the backend's: `error_message` is read
		// by the send gate and by the Knowledge row, and "MinerU upload failed:
		// …" is an operator's line. The raw text is kept beside it.
		expect(error.message).toBe(
			"The document service rejected our credentials. Ask an administrator to check the API key.",
		);
		expect(error.details?.rawMessage).toContain("MinerU upload failed");
		expect(error.details?.mineruCode).toBe("invalid_api_key");
		expect(error.details?.httpStatus).toBe(401);
		expect(error.details?.path).toBe("/v1/uploads");
	});

	it("tells the user to convert a file the backend refuses outright", () => {
		const error = mineruErrorToExtractionError(
			new MineruApiError({
				code: "parse_failed",
				message: "Unsupported file type: cover.avif",
				status: null,
			}),
		);
		expect(error.code).toBe("unsupported_type");
		expect(error.retryable).toBe(false);
		expect(error.message).toContain("Convert it to PDF");
		expect(error.details?.rawMessage).toContain("cover.avif");
	});

	it("passes handleUnknown through for a server that dropped our file id", () => {
		const followups = JSON.parse(
			readFileSync(join(ERROR_DIR, "_202-followups.json"), "utf8"),
		) as Array<{
			probe: string;
			file_error: { code: string; message: string };
		}>;
		const row = followups.find(
			(entry) => entry.probe === "job_unknown_file_id",
		);
		const error = mineruErrorToExtractionError(
			new MineruApiError({
				code: row?.file_error.code ?? "",
				message: row?.file_error.message ?? "",
				type: "engine_error",
			}),
		);
		expect(error.handleUnknown).toBe(true);
		expect(error.retryable).toBe(true);
	});
});
