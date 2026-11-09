/**
 * The MinerU 4.1 wire shapes, mirrored from RECORDED responses.
 *
 * Authority order: `fixtures/mineru-v41/protocol/` (captured from a real 4.1.7
 * server) beats the 4.1 docs. The 4.1 spike found 27 places where the two
 * disagree: the create receipt has no `bytes`, a hash-cache hit is `pending`
 * with no `upload` object at all, a failed task has no top-level `error`, and
 * every parse failure is the single code `parse_failed`.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. **A 200 is not automatically valid.** Every response body the client reads
 *     goes through one of these schemas before a single field is trusted.
 *  2. **Objects we do not own are loose.** A minor server upgrade that adds a
 *     field must not turn a working parse into a `protocol` failure; rejecting
 *     an extra key costs a document that will not extract, tolerating it costs
 *     nothing.
 *  3. **Validate what we read, nothing more.** Timestamps, progress and the
 *     other bookkeeping fields are optional: the client never branches on them,
 *     so a server that drops one must not fail a task. Statuses are the
 *     exception and are strict enums, because the poll loop ends on them and an
 *     unknown one should fail in one poll instead of hanging until the deadline.
 *
 * No I/O lives here.
 */

import { z } from "zod";
import { MINERU_TIER_IDS } from "./config";

// ---------------------------------------------------------------------------
// Error envelopes: there are two, and they are nothing alike
// ---------------------------------------------------------------------------

/**
 * MinerU's own envelope. 4.1 dropped `type`: the client branches on `code` and
 * `param`, never on `message` (pydantic's multi-line dump, with a URL in it).
 */
const mineruErrorDetailSchema = z.looseObject({
	code: z.string().nullish(),
	message: z.string(),
	param: z.string().nullish(),
});

export const mineruErrorResponseSchema = z.looseObject({
	error: mineruErrorDetailSchema,
});

/**
 * FastAPI's own envelope, which still answers for routes MinerU did not write:
 * `{"detail":"Not Found"}` (404) and `{"detail":"Method Not Allowed"}` (405) are
 * a plain string, a request FastAPI itself rejects is a list.
 */
export const fastapiErrorSchema = z.looseObject({
	detail: z.union([
		z.string(),
		z.array(
			z.looseObject({
				loc: z.array(z.union([z.string(), z.number()])).optional(),
				msg: z.string().optional(),
				type: z.string().optional(),
			}),
		),
	]),
});

// ---------------------------------------------------------------------------
// Capability reads
// ---------------------------------------------------------------------------

export const mineruHealthSchema = z.looseObject({
	status: z.string().default("ok"),
	version: z.string(),
	features: z
		.looseObject({
			webhook: z.boolean().default(false),
			/** `default`, `docx`, `html`, `latex`. 4.0's `output_formats` is gone. */
			task_output_formats: z.array(z.string()).default([]),
			sources: z.array(z.string()).default([]),
		})
		.optional(),
});

export const mineruTierSchema = z.looseObject({
	id: z.enum(MINERU_TIER_IDS),
	description: z.string(),
	/** `mineru-4.1.7` for every tier: it names the build, not a model. */
	current_model: z.string().nullish(),
});

export const mineruTierListSchema = z.looseObject({
	object: z.string().optional(),
	data: z.array(mineruTierSchema),
});

/**
 * The shape `MineruClient.getTiers` actually parses.
 *
 * `mineruTierListSchema` pins what the recorded servers return, and the tests
 * hold it to that. The client reads the lenient shape instead and then drops
 * the rows whose `id` this app does not know: a MinerU that grows a fifth tier
 * must not take the admin status card down, and it must not make every
 * extraction fail a capability read before a byte moves.
 */
export const mineruTierListLenientSchema = z.looseObject({
	object: z.string().optional(),
	data: z.array(
		z.looseObject({
			id: z.string(),
			description: z.string().default(""),
			current_model: z.string().nullish(),
		}),
	),
});

export const mineruUsageSchema = z.looseObject({
	object: z.string().optional(),
	access_level: z.enum(["anonymous", "registered"]).optional(),
	limits: z
		.looseObject({
			max_pages_per_file: z.number().nullish(),
			max_file_size_bytes: z.number().nullish(),
			max_files_per_job: z.number().nullish(),
			max_concurrent_jobs: z.number().nullish(),
			max_file_retention_days: z.number().nullish(),
		})
		.optional(),
});

// ---------------------------------------------------------------------------
// Tasks and their files
// ---------------------------------------------------------------------------

/** In the order a task moves through them; the last four are terminal. */
export const MINERU_TASK_STATUSES = [
	"waiting-file",
	"pending",
	"running",
	"completed",
	"partial",
	"failed",
	"canceled",
] as const;
export type MineruTaskStatus = (typeof MINERU_TASK_STATUSES)[number];

/** A file has no `partial`: that is a task that holds a mix. */
export const MINERU_FILE_STATUSES = [
	"waiting-file",
	"pending",
	"running",
	"completed",
	"failed",
	"canceled",
] as const;

/** A poll loop stops here and then reads the file it submitted. */
const MINERU_TERMINAL_TASK_STATUSES = [
	"completed",
	"partial",
	"failed",
	"canceled",
] as const;

export function isTerminalMineruTaskStatus(status: MineruTaskStatus): boolean {
	return (MINERU_TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Where to PUT a file's bytes: absolute URL, headers to send verbatim, and the
 * Unix second the link stops working (creation plus an hour). Present only
 * while the file waits for bytes; a hash-cache hit never gets one.
 */
export const mineruUploadLinkSchema = z.looseObject({
	url: z.string(),
	headers: z.record(z.string(), z.string()).default({}),
	expires_at: z.number().nullish(),
});

/**
 * What parsed a file. `tier` is the EFFECTIVE tier per file, so a native
 * document says `flash` whatever was asked (and equals `extensions.mineru.tier`
 * inside the result).
 */
const mineruFileParseInfoSchema = z.looseObject({
	tier: z.string(),
	duration_ms: z.number().nullish(),
	parser_version: z.string().nullish(),
});

const mineruCreatedTaskFileSchema = z.looseObject({
	file_id: z.string().min(1),
	file_name: z.string(),
	status: z.enum(MINERU_FILE_STATUSES),
	upload: mineruUploadLinkSchema.nullish(),
});

/** `POST /v1/tasks`, 202. No timestamps and no `bytes`: the first GET has them. */
export const mineruCreateTaskResponseSchema = z.looseObject({
	task_id: z.string().min(1),
	status: z.enum(MINERU_TASK_STATUSES),
	files: z.array(mineruCreatedTaskFileSchema),
});

const mineruTaskFileSchema = z.looseObject({
	file_id: z.string().min(1),
	file_name: z.string(),
	status: z.enum(MINERU_FILE_STATUSES),
	/** The size of the SOURCE. The result's size is its download's Content-Length. */
	bytes: z.number().nullish(),
	upload: mineruUploadLinkSchema.nullish(),
	parse: mineruFileParseInfoSchema.nullish(),
	/** Where the result ZIP is; present once the file is `completed`. */
	result_url: z.string().nullish(),
	/** Every cause arrives as `parse_failed`; only the message differs. */
	error: mineruErrorDetailSchema.nullish(),
});

/** `GET /v1/tasks/{id}`. */
export const mineruTaskDetailSchema = z.looseObject({
	task_id: z.string().min(1),
	status: z.enum(MINERU_TASK_STATUSES),
	created_at: z.string().nullish(),
	started_at: z.string().nullish(),
	finished_at: z.string().nullish(),
	output_formats: z.array(z.string()).default([]),
	progress: z
		.looseObject({
			completed: z.number().default(0),
			failed: z.number().default(0),
			total: z.number().default(0),
		})
		.nullish(),
	files: z.array(mineruTaskFileSchema),
	/** Never seen on a real task (a failed one reports on its files); tolerated. */
	error: mineruErrorDetailSchema.nullish(),
});

/** `PUT {upload.url}`, 200. A repeat PUT answers the same, with the current status. */
export const mineruUploadFileResponseSchema = z.looseObject({
	task_id: z.string().min(1),
	file_id: z.string().min(1),
	status: z.enum(MINERU_FILE_STATUSES),
});

/** `POST /v1/tasks/{id}/cancel`, 200: the settled state of every file. */
export const mineruCancelTaskResponseSchema = z.looseObject({
	task_id: z.string().min(1),
	status: z.literal("canceled"),
	finished_at: z.string().nullish(),
	files: z
		.array(
			z.looseObject({
				file_id: z.string().min(1),
				file_name: z.string(),
				status: z.enum(["completed", "failed", "canceled"]),
				parse: mineruFileParseInfoSchema.nullish(),
				result_url: z.string().nullish(),
				error: mineruErrorDetailSchema.nullish(),
			}),
		)
		.default([]),
});

/**
 * `GET /v1/files/{id}`. Note `id` and `file_name`, not `file_id` and
 * `filename`. The client never calls it; it is here so the fixtures that record
 * it are held to a schema too.
 */
export const mineruFileObjectSchema = z.looseObject({
	id: z.string(),
	object: z.literal("file").optional(),
	bytes: z.number(),
	created_at: z.number(),
	expires_at: z.number().nullish(),
	file_name: z.string(),
	purpose: z.enum(["parse", "parse_output"]),
	sha256sum: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Inferred types: the vocabulary every other slice imports
// ---------------------------------------------------------------------------

export type MineruErrorDetail = z.infer<typeof mineruErrorDetailSchema>;
export type MineruHealth = z.infer<typeof mineruHealthSchema>;
export type MineruTier = z.infer<typeof mineruTierSchema>;
export type MineruUsage = z.infer<typeof mineruUsageSchema>;
export type MineruUploadLink = z.infer<typeof mineruUploadLinkSchema>;
export type MineruCreateTaskResponse = z.infer<
	typeof mineruCreateTaskResponseSchema
>;
export type MineruTaskFile = z.infer<typeof mineruTaskFileSchema>;
export type MineruTaskDetail = z.infer<typeof mineruTaskDetailSchema>;
export type MineruUploadFileResponse = z.infer<
	typeof mineruUploadFileResponseSchema
>;
export type MineruCancelTaskResponse = z.infer<
	typeof mineruCancelTaskResponseSchema
>;
