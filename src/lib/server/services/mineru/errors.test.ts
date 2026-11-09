/**
 * The error map, driven by every error the 4.1 spike recorded.
 *
 * Two guards make this more than a list of assertions:
 *
 *  1. Every recorded error under `fixtures/mineru-v41/protocol/` must appear in
 *     `EXPECTED` below, and every row must name a fixture that exists. A fixture
 *     run that adds an unmapped failure mode fails here, by name.
 *  2. Every mapped error must report `known: true`: a NAMED rule matched on the
 *     server's `code` (or on FastAPI's `{detail}` shape), not a status fallback.
 *
 * The rules branch on `code` and `param`, never on `message` (4.1's validation
 * messages are pydantic dumps with a URL in them). The one place a message is
 * read is a file's `parse_failed`, because that single code is all 4.1 sends for
 * a corrupt, a locked, an unsupported and an unreadable document alike.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import {
	isMineruForgottenIdError,
	MINERU_CLIENT_ERROR_CODES,
	MINERU_FORGOTTEN_ID_CODES,
	MineruApiError,
	type MineruErrorDisposition,
	mapMineruError,
	mapMineruTaskFailure,
	mineruApiErrorFromBody,
	mineruErrorToExtractionError,
	parseMineruErrorBody,
	pickMineruTaskFile,
	redactMineruSecrets,
	truncateMineruBody,
} from "./errors";
import { mineruTaskDetailSchema } from "./schemas";
import {
	MINERU_4_0_12_ERRORS,
	MINERU_PROTOCOL_FIXTURE_ROOT,
	readMineruProtocolFixture,
} from "./testing/fake-server";

interface Recorded {
	request?: { method: string; path: string };
	response?: { status: number; json?: unknown };
	snapshot?: unknown;
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

const ERROR_FIXTURES = walk(MINERU_PROTOCOL_FIXTURE_ROOT)
	.map((path) => relative(MINERU_PROTOCOL_FIXTURE_ROOT, path))
	.filter((name) => name.endsWith(".json"))
	.filter(
		(name) =>
			(readMineruProtocolFixture<Recorded>(name).response?.status ?? 0) >= 400,
	)
	.sort();

interface Expectation {
	rule: string;
	taxonomy: ExtractionErrorCode;
	retryable: boolean;
	disposition?: MineruErrorDisposition;
}

const AUTH: Expectation = {
	rule: "401:invalid_api_key",
	taxonomy: "auth_failed",
	retryable: false,
};
const TIER: Expectation = {
	rule: "400:tier-not-available",
	taxonomy: "tier_unavailable",
	retryable: false,
};
const INVALID: Expectation = {
	rule: "400:invalid_request",
	taxonomy: "protocol",
	retryable: false,
};
/** The server answered in another protocol's voice: it is not a 4.1 MinerU (S6, R14). */
const WRONG_PROTOCOL: Expectation = {
	rule: "wrong-protocol",
	taxonomy: "unavailable",
	retryable: true,
};
/** The server forgot the id (a restart): create again and upload again (S6). */
const forgotten = (rule: string): Expectation => ({
	rule,
	taxonomy: "protocol",
	retryable: true,
	disposition: "recover-by-reupload",
});
const TERMINAL: Expectation = {
	rule: "409:task_already_terminal",
	taxonomy: "protocol",
	retryable: false,
	disposition: "swallow",
};

const EXPECTED: Record<string, Expectation> = {
	// -- authentication -----------------------------------------------------
	"errors/01_auth_wrong_key_create.json": AUTH,
	"errors/115_upload_no_key.json": AUTH,

	// -- tier: 400 invalid_request with param "tier", whatever the message says
	"errors/08_tier_advanced_above_ceiling.json": TIER,
	"errors/09_tier_bogus.json": TIER,

	// -- request shape: what S5 says the client never sends ------------------
	"errors/14_filename_dotdot_slash.json": INVALID,
	"errors/38_old_client_file_id.json": INVALID,
	"errors/40_old_file_id_field.json": INVALID,
	"errors/44_old_include_model_output_true.json": INVALID,
	"errors/46_old_output_formats_markdown.json": INVALID,
	"errors/76_ocr_mode_null.json": INVALID,
	"errors/83_page_range_null.json": INVALID,
	"errors/90_query_parameter.json": INVALID,
	"errors/91_content_type_text_plain.json": INVALID,
	"errors/78_page_range_garbage.json": {
		rule: "400:page_range_invalid",
		taxonomy: "protocol",
		retryable: false,
	},

	// -- uploads ------------------------------------------------------------
	"errors/107_upload_size_short_by_one.json": {
		rule: "400:upload_size_mismatch",
		taxonomy: "protocol",
		retryable: true,
	},
	"flows/hash-cache/F_same_hash_wrong_bytes_declared_create.json": {
		rule: "400:upload_size_mismatch",
		taxonomy: "protocol",
		retryable: true,
	},
	"errors/113_upload_hash_mismatch_right_size.json": {
		rule: "400:file_hash_mismatch",
		taxonomy: "protocol",
		retryable: true,
	},

	// -- the server does not speak /v1/tasks (4.0.12, or a proxy) -----------
	"errors/49_removed_post_uploads.json": WRONG_PROTOCOL,
	"errors/55_removed_get_parse_job.json": WRONG_PROTOCOL,
	// A 405 is a 4.1 server answering a client bug (4.0.12 only ever answers 404
	// for a route it lacks), so it is not an outage to wait out.
	"errors/59_delete_task_not_allowed.json": {
		rule: "405:method-not-allowed",
		taxonomy: "protocol",
		retryable: false,
	},
	"errors/101_get_task_weird_id_slash.json": WRONG_PROTOCOL,

	// -- forgotten ids and late cancels ---------------------------------------
	"errors/100_get_unknown_task.json": forgotten("404:task_not_found"),
	"errors/102_cancel_unknown_task.json": forgotten("404:task_not_found"),
	"errors/103_put_unknown_task_unknown_file.json":
		forgotten("404:task_not_found"),
	"errors/104_get_unknown_file_meta.json": forgotten("404:file_not_found"),
	"errors/105_get_unknown_file_content.json": forgotten("404:file_not_found"),
	"flows/restart/01_R1_task_after_restart.json":
		forgotten("404:task_not_found"),
	"flows/restart/02_R1_file_meta_after_restart.json":
		forgotten("404:file_not_found"),
	"flows/restart/03_R1_result_url_after_restart.json":
		forgotten("404:file_not_found"),
	"flows/restart/05_R2_put_after_restart.json": forgotten("404:task_not_found"),
	"flows/restart/06_R2_cancel_after_restart.json":
		forgotten("404:task_not_found"),
	"flows/tier-ceilings/basic/09_put_known_task_unknown_file.json": forgotten(
		"404:upload_not_found",
	),
	"errors/121_cancel_finished_task.json": TERMINAL,
	"errors/128_upload_after_cancel.json": TERMINAL,
	"flows/partial-and-file-terminal/08_cancel_partial_task.json": TERMINAL,
};

function errorFor(name: string): MineruApiError {
	const recorded = readMineruProtocolFixture<Required<Recorded>>(name);
	return mineruApiErrorFromBody({
		status: recorded.response.status,
		bodyText: JSON.stringify(recorded.response.json),
		path: recorded.request.path,
	});
}

describe("mapMineruError: every recorded error", () => {
	it("has an expectation for every error fixture on disk, and no stale rows", () => {
		const missing = ERROR_FIXTURES.filter((name) => !(name in EXPECTED));
		expect(missing, `error fixtures with no taxonomy row: ${missing}`).toEqual(
			[],
		);
		const stale = Object.keys(EXPECTED).filter(
			(name) => !ERROR_FIXTURES.includes(name),
		);
		expect(stale, `expectations naming no error fixture: ${stale}`).toEqual([]);
	});

	it.each(ERROR_FIXTURES)("maps %s", (name) => {
		const expectation = EXPECTED[name];
		expect(expectation, `no expectation for ${name}`).toBeTruthy();
		const mapping = mapMineruError(errorFor(name));

		expect(
			mapping.known,
			`${name} matched no named rule, only a status fallback`,
		).toBe(true);
		expect(mapping.rule).toBe(expectation.rule);
		expect(mapping.taxonomy).toBe(expectation.taxonomy);
		expect(mapping.retryable).toBe(expectation.retryable);
		expect(mapping.disposition).toBe(expectation.disposition ?? "fail");
		// A forgotten id is recovered by re-creating, so it is not a poisoned
		// handle; only a settled task poisons one (see `mapMineruTaskFailure`).
		expect(mapping.handleUnknown).toBe(false);
	});
});

describe("S6: the server forgot it", () => {
	it("names the four codes that mean 'create the task again and upload again'", () => {
		expect([...MINERU_FORGOTTEN_ID_CODES]).toEqual([
			"task_not_found",
			"file_not_found",
			"upload_not_found",
			"upload_expired",
		]);
	});

	it("treats 404 task_not_found, file_not_found, upload_not_found as a forgotten id", () => {
		for (const name of [
			"errors/100_get_unknown_task.json",
			"errors/105_get_unknown_file_content.json",
			"flows/tier-ceilings/basic/09_put_known_task_unknown_file.json",
		]) {
			const error = errorFor(name);
			expect(isMineruForgottenIdError(error), name).toBe(true);
			expect(mapMineruError(error).disposition, name).toBe(
				"recover-by-reupload",
			);
		}
	});

	it("treats 410 upload_expired as a forgotten id too (documented, not reproducible in a spike)", () => {
		const error = mineruApiErrorFromBody({
			status: 410,
			bodyText: JSON.stringify({
				error: { code: "upload_expired", message: "Upload link expired" },
			}),
			path: "/v1/tasks/job_x/uploads/file-x",
		});
		expect(isMineruForgottenIdError(error)).toBe(true);
		const mapping = mapMineruError(error);
		expect(mapping.rule).toBe("410:upload_expired");
		expect(mapping.disposition).toBe("recover-by-reupload");
		expect(mapping.retryable).toBe(true);
	});

	it("does NOT treat a plain FastAPI 404 as a forgotten id: that is another protocol", () => {
		const error = errorFor("errors/49_removed_post_uploads.json");
		expect(error.fastapi).toBe(true);
		expect(error.code).toBe("");
		expect(isMineruForgottenIdError(error)).toBe(false);

		const mapping = mapMineruError(error);
		// Retryable with the outage budget, so a job caught in the cutover window
		// succeeds once the URL points at 4.1; never a permanent verdict on the
		// document, and never the re-upload path (there is nothing to re-upload to).
		expect(mapping.taxonomy).toBe("unavailable");
		expect(mapping.retryable).toBe(true);
		expect(mapping.disposition).toBe("fail");
	});

	it("reads the same wrong-protocol answer on POST /v1/tasks, on a poll and on a PUT", () => {
		for (const path of [
			"/v1/tasks",
			"/v1/tasks/job_x",
			"/v1/tasks/job_x/uploads/file-x",
			"/v1/tasks/job_x/cancel",
		]) {
			const mapping = mapMineruError(
				mineruApiErrorFromBody({
					status: 404,
					bodyText: JSON.stringify({ detail: "Not Found" }),
					path,
				}),
			);
			expect(mapping.rule, path).toBe("wrong-protocol");
		}
	});

	it("does NOT read a FastAPI 405 as another protocol: it is a client bug, and must not ride the outage budget", () => {
		// An empty task id makes /v1/tasks/ , which a 4.1 server answers 405; the
		// old server only ever says 404 for a route it lacks.
		for (const path of ["/v1/tasks/", "/v1/tasks"]) {
			const error = mineruApiErrorFromBody({
				status: 405,
				bodyText: JSON.stringify({ detail: "Method Not Allowed" }),
				path,
			});
			const mapping = mapMineruError(error);
			expect(error.wrongProtocol, path).toBeNull();
			expect(mapping.rule, path).toBe("405:method-not-allowed");
			expect(mapping.known, path).toBe(true);
			expect(mapping.taxonomy, path).toBe("protocol");
			expect(mapping.retryable, path).toBe(false);
		}
	});

	it("does not retry a 4xx FastAPI body that is not a routing error", () => {
		const mapping = mapMineruError(
			mineruApiErrorFromBody({
				status: 422,
				bodyText: JSON.stringify({
					detail: [
						{
							loc: ["body", "files", 0],
							msg: "field required",
							type: "missing",
						},
					],
				}),
			}),
		);
		expect(mapping.known).toBe(false);
		expect(mapping.rule).toBe("fallback:422");
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(false);
	});
});

const OLD_SERVER = MINERU_4_0_12_ERRORS;

function oldServerError(
	status: number,
	body: unknown,
	path: string,
): MineruApiError {
	return mineruApiErrorFromBody({
		status,
		bodyText: JSON.stringify(body),
		path,
	});
}

describe("R14: the old server answered, in its own voice", () => {
	it("reads a 4.1 manifest refused by 4.0.12 (400 with error.type) as another protocol, not as our bug", () => {
		// Sent in the seconds between the deploy and the URL flip, this used to land
		// on 400:invalid_request: permanent, so every extraction started in that
		// window failed for good.
		const error = oldServerError(400, OLD_SERVER.invalidManifest, "/v1/tasks");
		expect(error.wrongProtocol).toBe("error.type invalid_request_error");
		const mapping = mapMineruError(error);
		expect(mapping.rule).toBe("wrong-protocol");
		expect(mapping.known).toBe(true);
		expect(mapping.taxonomy).toBe("unavailable");
		expect(mapping.retryable).toBe(true);
		expect(mapping.disposition).toBe("fail");
		expect(isMineruForgottenIdError(error)).toBe(false);
		// And the pydantic dump (the value we sent, a URL) stays out of the message.
		expect(error.message).not.toContain("pydantic");
		expect(error.message).not.toContain("report");
	});

	it("reads 4.0.12's 404 task_not_found WITH a type as another protocol, never as a forgotten id", () => {
		// The same code, no type, from a 4.1 server IS a forgotten id (see below).
		const error = oldServerError(
			404,
			OLD_SERVER.taskNotFound,
			"/v1/tasks/job_x",
		);
		expect(error.code).toBe("task_not_found");
		expect(isMineruForgottenIdError(error)).toBe(false);
		const mapping = mapMineruError(error);
		expect(mapping.rule).toBe("wrong-protocol");
		expect(mapping.disposition).toBe("fail");
		expect(mapping.taxonomy).toBe("unavailable");
		expect(mapping.retryable).toBe(true);
	});

	it("reads 4.0.12's 404 file_not_found on a result URL the same way", () => {
		const error = oldServerError(
			404,
			OLD_SERVER.fileNotFound,
			"/v1/files/file-x/content",
		);
		expect(isMineruForgottenIdError(error)).toBe(false);
		expect(mapMineruError(error).rule).toBe("wrong-protocol");
		expect(mapMineruError(error).disposition).toBe("fail");
	});

	it("reads any error body that carries error.type that way, whatever its status or code", () => {
		for (const [status, body] of [
			[401, OLD_SERVER.badKey],
			[500, OLD_SERVER.engine],
			[400, OLD_SERVER.invalidManifest],
			[404, OLD_SERVER.taskNotFound],
		] as const) {
			for (const path of [
				"/v1/tasks",
				"/v1/tasks/job_x",
				"/v1/tasks/job_x/cancel",
				"/v1/files/file-x/content",
			]) {
				const mapping = mapMineruError(oldServerError(status, body, path));
				expect(mapping.rule, `${status} ${path}`).toBe("wrong-protocol");
				expect(mapping.retryable, `${status} ${path}`).toBe(true);
			}
		}
	});

	it("finds the type before it strictly parses the body, so an odd old body cannot hide it", () => {
		for (const body of [
			{ error: { type: "api_error" } },
			{ error: { type: "invalid_request_error", code: 7, message: null } },
			{
				error: {
					type: "authentication_error",
					code: "invalid_api_key",
					message: "x",
					param: null,
					extra: [],
				},
			},
		]) {
			const error = oldServerError(400, body, "/v1/tasks");
			expect(error.wrongProtocol, JSON.stringify(body)).toMatch(
				/^error\.type /,
			);
			expect(mapMineruError(error).rule, JSON.stringify(body)).toBe(
				"wrong-protocol",
			);
		}
		// `param: null` is how 4.0 says "none"; it is not a schema failure.
		const parsed = parseMineruErrorBody(
			JSON.stringify(OLD_SERVER.invalidManifest),
		);
		expect(parsed.detail?.code).toBe("invalid_request");
		expect(parsed.detail?.param).toBeNull();
	});

	it("leaves 4.1's own answers alone: the same codes WITHOUT a type are still what they were", () => {
		const forgotten = mineruApiErrorFromBody({
			status: 404,
			bodyText: JSON.stringify({
				error: { code: "task_not_found", message: "Task job_x not found" },
			}),
			path: "/v1/tasks/job_x",
		});
		expect(forgotten.wrongProtocol).toBeNull();
		expect(isMineruForgottenIdError(forgotten)).toBe(true);
		expect(mapMineruError(forgotten).rule).toBe("404:task_not_found");

		const invalid = mineruApiErrorFromBody({
			status: 400,
			bodyText: JSON.stringify({
				error: {
					code: "invalid_request",
					message: "x",
					param: "files.0.file_name",
				},
			}),
			path: "/v1/tasks",
		});
		expect(mapMineruError(invalid).rule).toBe("400:invalid_request");
		expect(mapMineruError(invalid).retryable).toBe(false);
	});

	it("carries the cause into the ledger error and keeps the user out of it", () => {
		const error = mineruErrorToExtractionError(
			oldServerError(400, OLD_SERVER.invalidManifest, "/v1/tasks"),
			{ context: "MinerU task creation failed" },
		);
		expect(error.code).toBe("unavailable");
		expect(error.retryable).toBe(true);
		expect(error.handleUnknown).toBe(false);
		expect(error.details?.mineruRule).toBe("wrong-protocol");
		expect(error.details?.wrongProtocol).toBe(
			"error.type invalid_request_error",
		);
		expect(error.message).toBe("The document service could not be reached.");
	});
});

describe("tiers and 5xx", () => {
	it("reads param 'tier' as a missing tier, not as a protocol bug, whatever the message", () => {
		for (const message of [
			"Tier 'advanced' is not available",
			"Invalid request: 1 validation error for CreateTaskRequest\ntier\n  Input should be 'flash'",
			"something nobody has ever seen",
		]) {
			const mapping = mapMineruError(
				mineruApiErrorFromBody({
					status: 400,
					bodyText: JSON.stringify({
						error: { code: "invalid_request", message, param: "tier" },
					}),
				}),
			);
			expect(mapping.taxonomy, message).toBe("tier_unavailable");
			expect(mapping.retryable, message).toBe(false);
		}
		// Any other param is our request being wrong.
		const other = mapMineruError(
			mineruApiErrorFromBody({
				status: 400,
				bodyText: JSON.stringify({
					error: { code: "invalid_request", message: "x", param: "ocr_mode" },
				}),
			}),
		);
		expect(other.taxonomy).toBe("protocol");
	});

	it("retries a 503 server_shutting_down and any other 503", () => {
		const shutting = mapMineruError(
			mineruApiErrorFromBody({
				status: 503,
				bodyText: JSON.stringify({
					error: { code: "server_shutting_down", message: "Shutting down" },
				}),
				retryAfterMs: 2000,
			}),
		);
		expect(shutting.rule).toBe("503:server_shutting_down");
		expect(shutting.taxonomy).toBe("unavailable");
		expect(shutting.retryable).toBe(true);
		expect(shutting.retryAfterMs).toBe(2000);

		// 4.0 answered 503 quality_tier_unavailable for a missing tier; 4.1 answers
		// 400 (above). A 503 is an outage in every case now.
		const unknown = mapMineruError(
			mineruApiErrorFromBody({
				status: 503,
				bodyText: JSON.stringify({
					error: { code: "quality_tier_unavailable", message: "x" },
				}),
			}),
		);
		expect(unknown.known).toBe(false);
		expect(unknown.taxonomy).toBe("unavailable");
		expect(unknown.retryable).toBe(true);
	});

	it("maps the two responses the spike never triggered", () => {
		const rateLimited = mapMineruError(
			mineruApiErrorFromBody({
				status: 429,
				bodyText: JSON.stringify({
					error: { code: "rate_limit_exceeded", message: "Too many requests" },
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
					error: { code: "file_too_large", message: "File too large" },
				}),
			}),
		);
		expect(tooLarge.taxonomy).toBe("too_large");
		expect(tooLarge.retryable).toBe(false);
	});

	it("falls back on the status for a body it cannot place", () => {
		const bad = mapMineruError(
			mineruApiErrorFromBody({ status: 502, bodyText: "<html>bad gateway" }),
		);
		expect(bad.known).toBe(false);
		expect(bad.taxonomy).toBe("unavailable");
		expect(bad.retryable).toBe(true);
		const odd = mapMineruError(
			mineruApiErrorFromBody({
				status: 400,
				bodyText: JSON.stringify({
					error: { code: "brand_new", message: "?" },
				}),
			}),
		);
		expect(odd.known).toBe(false);
		expect(odd.taxonomy).toBe("protocol");
		expect(odd.retryable).toBe(false);
	});
});

function task(name: string) {
	const recorded = readMineruProtocolFixture<Recorded>(name);
	return mineruTaskDetailSchema.parse(
		recorded.snapshot ?? recorded.response?.json,
	);
}

describe("S8: every parse failure is parse_failed, and only the message differs", () => {
	it.each([
		[
			"a damaged PDF",
			"samples/pdf-corrupt-truncated/03_poll_02_failed.json",
			"file:parse_failed:unreadable-document",
			"document_unreadable",
		],
		[
			"a password-protected PDF",
			"samples/edge-inputs/encrypted-pdf/03_poll_02_failed.json",
			"file:parse_failed:protected",
			"document_unreadable",
		],
		[
			"a file type MinerU cannot read",
			"samples/txt-unsupported/03_poll_01_failed.json",
			"file:parse_failed:unsupported-type",
			"unsupported_type",
		],
		[
			"an XLSX that is not a ZIP",
			"samples/edge-inputs/csv-bytes-named-xlsx/03_poll_02_failed.json",
			"file:parse_failed:invalid-package",
			"document_unreadable",
		],
	] as const)("%s", (_label, fixture, rule, taxonomy) => {
		const snapshot = task(fixture);
		expect(snapshot.status).toBe("failed");
		expect(snapshot.files[0]?.error?.code).toBe("parse_failed");

		const mapping = mapMineruTaskFailure(snapshot);
		expect(mapping?.rule).toBe(rule);
		expect(mapping?.taxonomy).toBe(taxonomy);
		// The same bytes fail the same way however often we ask.
		expect(mapping?.retryable).toBe(false);
		expect(mapping?.known).toBe(true);
		// The remote task is settled: resuming its id cannot change its mind.
		expect(mapping?.handleUnknown).toBe(true);
		// `reason` is a static operator line. The upstream message (a file name,
		// a PDFium sentence) is never copied into anything a user could see.
		expect(mapping?.reason).not.toBe(snapshot.files[0]?.error?.message);
	});

	it("keeps a PDFium 'not found' sentence out of the dropped-id branch", () => {
		// "Page not found or content error" contains "not found"; it is an
		// unreadable document, not a server that lost an id.
		const mapping = mapMineruTaskFailure(
			failedFile({
				code: "parse_failed",
				message:
					"Failed to load document (PDFium: Page not found or content error).",
			}),
		);
		expect(mapping?.rule).toBe("file:parse_failed:unreadable-document");
		expect(mapping?.taxonomy).toBe("document_unreadable");
	});

	it("reads any other parse_failed as a generic, retryable engine failure", () => {
		const mapping = mapMineruTaskFailure(
			failedFile({
				code: "parse_failed",
				message: "All connection attempts failed",
			}),
		);
		expect(mapping?.rule).toBe("file:parse_failed");
		expect(mapping?.taxonomy).toBe("job_failed");
		expect(mapping?.retryable).toBe(true);
		expect(mapping?.handleUnknown).toBe(true);
	});

	it("still reads an empty result as final, should 4.1 ever say so", () => {
		for (const error of [
			{ code: "parse_empty", message: "Parse completed but returned no pages" },
			{
				code: "parse_failed",
				message: "Parse completed but returned no pages",
			},
		]) {
			const mapping = mapMineruTaskFailure(failedFile(error));
			expect(mapping?.taxonomy, error.code).toBe("empty_result");
			expect(mapping?.retryable, error.code).toBe(false);
		}
	});

	it("reads an unmapped file-level code as a retryable failure and says so", () => {
		const mapping = mapMineruTaskFailure(
			failedFile({ code: "brand_new_code", message: "?" }),
		);
		expect(mapping?.known).toBe(false);
		expect(mapping?.rule).toBe("task:file-error-unmapped");
		expect(mapping?.taxonomy).toBe("job_failed");
		expect(mapping?.retryable).toBe(true);
	});
});

/** A terminal one-file task whose only file failed with this error. */
function failedFile(error: { code: string; message: string }) {
	return mineruTaskDetailSchema.parse({
		task_id: "job_x",
		status: "failed",
		files: [{ file_id: "file-x", file_name: "x.pdf", status: "failed", error }],
	});
}

describe("mapMineruTaskFailure: reading a settled task", () => {
	it("accepts a completed file that says where its result is", () => {
		const snapshot = task("samples/docx-default/03_poll_02_completed.json");
		expect(mapMineruTaskFailure(snapshot)).toBeNull();
		expect(pickMineruTaskFile(snapshot)?.result_url).toContain("/content");
	});

	it("reads the file it submitted, so a partial task still hands over the good one", () => {
		const partial = task(
			"flows/partial-and-file-terminal/snapshot_02_partial.json",
		);
		const [good, bad] = partial.files;
		// The task is `partial`, but the file we asked about is what matters.
		expect(mapMineruTaskFailure(partial, { fileId: good?.file_id })).toBeNull();
		const failure = mapMineruTaskFailure(partial, { fileId: bad?.file_id });
		expect(failure?.rule).toBe("file:parse_failed:unreadable-document");
		// With no file named it reads the first, the only one a one-file task has.
		expect(mapMineruTaskFailure(partial)).toBeNull();
		expect(pickMineruTaskFile(partial, bad?.file_id)?.file_name).toBe(
			"bad.pdf",
		);
		expect(pickMineruTaskFile(partial, "file-nope")).toBeNull();
	});

	it("keeps a result downloadable after a cancel that came too late for it", () => {
		const midway = task("flows/cancel-midway/snapshot_3s_after_cancel.json");
		expect(midway.status).toBe("canceled");
		expect(mapMineruTaskFailure(midway)).toBeNull();
		// The files the cancel did stop are failures to whoever reads them.
		const stopped = mapMineruTaskFailure(midway, {
			fileId: midway.files[1]?.file_id,
		});
		expect(stopped?.rule).toBe("task:canceled-by-someone-else");
	});

	it("is not a failure when we are the ones who canceled", () => {
		const canceled = task("flows/cancel-running/11_get_after_cancel.json");
		expect(canceled.status).toBe("canceled");
		expect(mapMineruTaskFailure(canceled, { canceledByUs: true })).toBeNull();

		const elsewhere = mapMineruTaskFailure(canceled);
		expect(elsewhere?.rule).toBe("task:canceled-by-someone-else");
		expect(elsewhere?.taxonomy).toBe("job_failed");
		expect(elsewhere?.retryable).toBe(true);
		expect(elsewhere?.handleUnknown).toBe(true);
	});

	it("fails a completed file that has no result_url", () => {
		const snapshot = mineruTaskDetailSchema.parse({
			task_id: "job_x",
			status: "completed",
			files: [{ file_id: "file-x", file_name: "x.pdf", status: "completed" }],
		});
		const mapping = mapMineruTaskFailure(snapshot);
		expect(mapping?.rule).toBe("task:missing-result-url");
		expect(mapping?.taxonomy).toBe("protocol");
		expect(mapping?.retryable).toBe(true);
	});

	it("fails a failed file that says nothing about why", () => {
		const snapshot = mineruTaskDetailSchema.parse({
			task_id: "job_x",
			status: "failed",
			files: [{ file_id: "file-x", file_name: "x.pdf", status: "failed" }],
		});
		const mapping = mapMineruTaskFailure(snapshot);
		expect(mapping?.rule).toBe("task:failed-without-detail");
		expect(mapping?.taxonomy).toBe("job_failed");
		expect(mapping?.retryable).toBe(true);
	});

	it("fails a settled task whose file is still moving, and one with no file at all", () => {
		const moving = mineruTaskDetailSchema.parse({
			task_id: "job_x",
			status: "failed",
			files: [{ file_id: "file-x", file_name: "x.pdf", status: "running" }],
		});
		expect(mapMineruTaskFailure(moving)?.rule).toBe("task:file-not-completed");
		const empty = mineruTaskDetailSchema.parse({
			task_id: "job_x",
			status: "failed",
			files: [],
		});
		expect(mapMineruTaskFailure(empty)?.rule).toBe("task:no-file");
	});

	it("poisons the stored handle on every failure it returns, whatever the verdict", () => {
		const failures = [
			mapMineruTaskFailure(
				task("samples/pdf-corrupt-truncated/03_poll_02_failed.json"),
			),
			mapMineruTaskFailure(
				task("flows/cancel-running/11_get_after_cancel.json"),
			),
			mapMineruTaskFailure(
				failedFile({ code: "brand_new_code", message: "?" }),
			),
			mapMineruTaskFailure(
				mineruTaskDetailSchema.parse({
					task_id: "job_x",
					status: "failed",
					files: [],
				}),
			),
		];
		for (const failure of failures) {
			expect(failure).not.toBeNull();
			expect(failure?.handleUnknown).toBe(true);
		}
	});
});

describe("mapMineruError: transport and client-side codes", () => {
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

	it.each([
		[MINERU_CLIENT_ERROR_CODES.untrustedUploadUrl, "protocol", false],
		[MINERU_CLIENT_ERROR_CODES.untrustedResultUrl, "protocol", false],
		[MINERU_CLIENT_ERROR_CODES.untrustedRedirect, "protocol", false],
		[MINERU_CLIENT_ERROR_CODES.invalidJson, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.schemaMismatch, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.byteCountMismatch, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.downloadTooLarge, "protocol", true],
		[MINERU_CLIENT_ERROR_CODES.jobDeadline, "timeout", true],
		[MINERU_CLIENT_ERROR_CODES.tierNotAvailable, "tier_unavailable", false],
	])("maps the client-side code %s", (code, taxonomy, retryable) => {
		const mapping = mapMineruError(new MineruApiError({ code, message: "x" }));
		expect(mapping.known).toBe(true);
		expect(mapping.taxonomy).toBe(taxonomy);
		expect(mapping.retryable).toBe(retryable);
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
		expect(parsed.fastapi).toBe(false);
		expect(parsed.excerpt).toContain("504 Gateway Timeout");
	});

	it("never copies a pydantic validation dump (a URL, the value we sent) into the error message", () => {
		// D12: `message` is pydantic's multi-line dump, and it echoes the input,
		// here a file name. The code and the param say what was wrong.
		const error = errorFor("errors/14_filename_dotdot_slash.json");
		expect(error.code).toBe("invalid_request");
		expect(error.param).toBe("files.0.file_name");
		expect(error.message).toContain("invalid_request");
		expect(error.message).toContain("files.0.file_name");
		expect(error.message).not.toContain("pydantic");
		expect(error.message).not.toContain("x.pdf");
		// The (truncated, scrubbed) body is still there for an operator.
		expect(error.bodyExcerpt).toContain("x.pdf");
		expect(error.bodyExcerpt?.length).toBeLessThanOrEqual(301);
	});

	it("keeps a short, stable message for any other code", () => {
		const error = errorFor("errors/100_get_unknown_task.json");
		expect(error.message).toBe(
			"MinerU /v1/tasks/job_000000000000000000000000 failed with 404: Task job_000000000000000000000000 not found",
		);
	});

	it("reads FastAPI's string detail and the first entry of a list", () => {
		const route = parseMineruErrorBody(JSON.stringify({ detail: "Not Found" }));
		expect(route.fastapi).toBe(true);
		expect(route.detail).toEqual({
			code: null,
			message: "Not Found",
			param: null,
		});
		const list = parseMineruErrorBody(
			JSON.stringify({
				detail: [{ loc: ["body", "files", 0], msg: "field required" }],
			}),
		);
		expect(list.fastapi).toBe(true);
		expect(list.detail?.param).toBe("body.files.0");
		expect(list.detail?.message).toBe("field required");
	});
});

describe("mineruErrorToExtractionError", () => {
	it("carries the taxonomy, the retry verdict and MinerU-free diagnostics", () => {
		const error = mineruErrorToExtractionError(
			errorFor("errors/01_auth_wrong_key_create.json"),
			{ context: "MinerU task creation failed" },
		);
		expect(error.code).toBe("auth_failed");
		expect(error.retryable).toBe(false);
		// The MESSAGE is the code's, not the backend's: `error_message` is read by
		// the send gate and by the Knowledge row.
		expect(error.message).toBe(
			"The document service rejected our credentials. Ask an administrator to check the API key.",
		);
		expect(error.details?.rawMessage).toContain("MinerU task creation failed");
		expect(error.details?.mineruCode).toBe("invalid_api_key");
		expect(error.details?.mineruRule).toBe("401:invalid_api_key");
		expect(error.details?.httpStatus).toBe(401);
		expect(error.details?.path).toBe("/v1/tasks");
	});

	it("records which parameter a rejected request tripped on", () => {
		const error = mineruErrorToExtractionError(
			errorFor("errors/14_filename_dotdot_slash.json"),
		);
		expect(error.code).toBe("protocol");
		expect(error.details?.mineruParam).toBe("files.0.file_name");
	});

	it("reports a server that speaks another protocol as unavailable, so it is retried", () => {
		const error = mineruErrorToExtractionError(
			errorFor("errors/49_removed_post_uploads.json"),
		);
		expect(error.code).toBe("unavailable");
		expect(error.retryable).toBe(true);
		expect(error.details?.mineruRule).toBe("wrong-protocol");
		// The cause rides in the diagnostics.
		expect(error.details?.wrongProtocol).toBe("a FastAPI 404 {detail}");
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

	it("tells the user to re-export a file the reader cannot open", () => {
		const error = mineruErrorToExtractionError(
			new MineruApiError({
				code: "parse_failed",
				message: "Failed to load document (PDFium: Data format error).",
				status: null,
			}),
		);
		expect(error.code).toBe("document_unreadable");
		expect(error.retryable).toBe(false);
		// The upstream sentence is true and useless; the code owns the advice.
		expect(error.message).toContain("damaged or password-protected");
		expect(error.message).not.toContain("PDFium");
		expect(error.details?.rawMessage).toContain("PDFium");
		expect(error.details?.mineruRule).toBe(
			"file:parse_failed:unreadable-document",
		);
	});
});
