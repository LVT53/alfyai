/**
 * The MinerU V1 wire shapes, mirrored from RECORDED responses.
 *
 * Authority order: `fixtures/mineru-v1/` beats `docs/plans/mineru4/phase0-local-spike.md`
 * beats every upstream MinerU document. Where the upstream Draft schema and a
 * fixture disagree, the fixture is what is encoded here — see the spelling trap
 * on `status` below, the seven-key `output_files` map whose unrequested members
 * are `null`, and `parse.model_used`, which was `null` on every completed file
 * the spike observed.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. **A 200 is not automatically valid.** Every response body the client reads
 *     goes through one of these schemas before a single field is trusted.
 *  2. **Objects we do not own are `.passthrough()`.** A minor server upgrade
 *     that adds a field must not turn a working parse into a `protocol`
 *     failure; the cost of tolerating an extra key is nothing, and the cost of
 *     rejecting it is a document that will not extract.
 *
 * No I/O lives here.
 */

import { z } from "zod";
import { MINERU_TIER_IDS } from "./config";

/** The server's own pattern for a content hash: lowercase hex, 64 wide. */
export const MINERU_SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const mineruSha256 = z.string().regex(MINERU_SHA256_PATTERN);

// ---------------------------------------------------------------------------
// Error envelopes — there are two, and they are nothing alike
// ---------------------------------------------------------------------------

/**
 * MinerU's hand-written envelope. `type` is one of `invalid_request_error`,
 * `permission_error`, `authentication_error`, `engine_error`, but it is typed
 * as a plain string: the client branches on `code`, never on `type` alone, and
 * a fifth type must not make an error unreadable.
 */
export const mineruErrorDetailSchema = z
	.object({
		type: z.string(),
		code: z.string().nullish(),
		message: z.string(),
		param: z.string().nullish(),
	})
	.passthrough();

export const mineruErrorResponseSchema = z
	.object({ error: mineruErrorDetailSchema })
	.passthrough();

/** FastAPI's own 422 envelope — a different shape entirely. */
export const fastapiValidationErrorSchema = z
	.object({
		detail: z.array(
			z
				.object({
					loc: z.array(z.union([z.string(), z.number()])).optional(),
					msg: z.string().optional(),
					type: z.string().optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Capability reads
// ---------------------------------------------------------------------------

export const mineruHealthSchema = z
	.object({
		status: z.string().default("ok"),
		version: z.string(),
		features: z
			.object({
				webhook: z.boolean().default(false),
				output_formats: z.array(z.string()).default([]),
				sources: z.array(z.string()).default([]),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export const mineruTierSchema = z
	.object({
		id: z.enum(MINERU_TIER_IDS),
		description: z.string(),
		/** DO NOT join this to /v1/models[].id — "hybrid-basic" vs "Hybrid-Basic". */
		current_model: z.string().nullish(),
	})
	.passthrough();

export const mineruTierListSchema = z
	.object({
		object: z.string().optional(),
		data: z.array(mineruTierSchema),
	})
	.passthrough();

/**
 * The shape `MineruClient.getTiers` actually parses.
 *
 * `mineruTierListSchema` pins what the recorded servers return, and the tests
 * hold it to that. The client reads the lenient shape instead and then drops
 * the rows whose `id` this app does not know: a MinerU that grows a fifth tier
 * must not take the admin status card down, and it must not make every
 * extraction fail a capability read before a byte moves.
 */
export const mineruTierListLenientSchema = z
	.object({
		object: z.string().optional(),
		data: z.array(
			z
				.object({
					id: z.string(),
					description: z.string().default(""),
					current_model: z.string().nullish(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export const mineruUsageSchema = z
	.object({
		object: z.string().optional(),
		access_level: z.enum(["anonymous", "registered"]).optional(),
		limits: z
			.object({
				max_pages_per_file: z.number().nullish(),
				max_file_size_bytes: z.number().nullish(),
				max_files_per_job: z.number().nullish(),
				max_concurrent_jobs: z.number().nullish(),
				max_file_retention_days: z.number().nullish(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Files and uploads
// ---------------------------------------------------------------------------

export const mineruFileObjectSchema = z
	.object({
		id: z.string(),
		object: z.literal("file").optional(),
		bytes: z.number(),
		created_at: z.number(),
		expires_at: z.number().nullish(),
		filename: z.string(),
		purpose: z.enum(["parse", "parse_output", "input_image"]),
		sha256sum: z.string().nullish(),
	})
	.passthrough();

/** `GET /v1/files`. The client never calls it; the fixtures record it. */
export const mineruFileListSchema = z
	.object({
		object: z.string().optional(),
		data: z.array(mineruFileObjectSchema),
		first_id: z.string().nullish(),
		last_id: z.string().nullish(),
		has_more: z.boolean().optional(),
	})
	.passthrough();

export const mineruUploadSchema = z
	.object({
		id: z.string(),
		object: z.literal("upload").optional(),
		bytes: z.number(),
		created_at: z.number(),
		expires_at: z.number(),
		filename: z.string(),
		purpose: z.string().optional(),
		mime_type: z.string(),
		sha256sum: z.string().nullish(),
		/** NOTE the double-l spelling: the server says "cancelled" here. */
		status: z.enum(["pending", "completed", "cancelled", "expired"]),
		upload_url: z.string().nullish(),
		upload_method: z.literal("PUT").nullish(),
		upload_headers: z.record(z.string(), z.string()).nullish(),
		file: mineruFileObjectSchema.nullish(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Parse jobs
// ---------------------------------------------------------------------------

export const mineruOutputFileRefSchema = z
	.object({
		file_id: z.string(),
		bytes: z.number(),
	})
	.passthrough();

/**
 * Every key is present on a terminal job; the unrequested formats are `null`.
 * Iterating `Object.entries` without a null check crashed the spike's own
 * harness, which is why each member is `.nullish()` rather than optional.
 */
export const mineruOutputFilesSchema = z
	.object({
		markdown: mineruOutputFileRefSchema.nullish(),
		middle_json: mineruOutputFileRefSchema.nullish(),
		structured_content: mineruOutputFileRefSchema.nullish(),
		html: mineruOutputFileRefSchema.nullish(),
		latex: mineruOutputFileRefSchema.nullish(),
		docx: mineruOutputFileRefSchema.nullish(),
		zip: mineruOutputFileRefSchema.nullish(),
	})
	.passthrough();

export const mineruJobFileResultSchema = z
	.object({
		file_id: z.string().nullish(),
		name: z.string(),
		/** "" on a queued job — NOT null. Normalises to "1-3" when terminal. */
		page_range: z.string(),
		status: z.enum(["queued", "running", "completed", "failed"]),
		parse: z
			.object({
				/** null on every observed completed file. Do not trust it. */
				model_used: z.string().nullish(),
				duration_ms: z.number().nullish(),
				parser_version: z.string().nullish(),
			})
			.passthrough()
			.nullish(),
		output_files: mineruOutputFilesSchema.nullish(),
		error: mineruErrorDetailSchema.nullish(),
	})
	.passthrough();

export const mineruJobSchema = z
	.object({
		job_id: z.string(),
		status: z.enum([
			"queued",
			"running",
			"completed",
			"partial",
			"failed",
			"canceled",
		]),
		created_at: z.string(),
		started_at: z.string().nullish(),
		finished_at: z.string().nullish(),
		/** The JOB tier. Lies about what parsed the file — read extensions.mineru.tier. */
		tier: z.enum(MINERU_TIER_IDS),
		output_formats: z.array(z.string()),
		access_level: z.enum(["anonymous", "registered"]),
		progress: z
			.object({
				completed: z.number().default(0),
				failed: z.number().default(0),
				total: z.number().default(0),
			})
			.passthrough()
			.nullish(),
		files: z.array(mineruJobFileResultSchema),
		links: z
			.object({ self: z.string().optional(), cancel: z.string().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();

export const mineruJobCancelSchema = z
	.object({
		job_id: z.string(),
		/** ONE l here — `mineruUploadSchema.status` spells it with two. */
		status: z.literal("canceled").default("canceled"),
		canceled_at: z.string(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Inferred types — the vocabulary every other slice imports
// ---------------------------------------------------------------------------

export type MineruErrorDetail = z.infer<typeof mineruErrorDetailSchema>;
export type MineruErrorResponse = z.infer<typeof mineruErrorResponseSchema>;
export type FastapiValidationError = z.infer<
	typeof fastapiValidationErrorSchema
>;
export type MineruHealth = z.infer<typeof mineruHealthSchema>;
export type MineruTier = z.infer<typeof mineruTierSchema>;
export type MineruTierList = z.infer<typeof mineruTierListSchema>;
export type MineruUsage = z.infer<typeof mineruUsageSchema>;
export type MineruFileObject = z.infer<typeof mineruFileObjectSchema>;
export type MineruFileList = z.infer<typeof mineruFileListSchema>;
export type MineruUpload = z.infer<typeof mineruUploadSchema>;
export type MineruOutputFileRef = z.infer<typeof mineruOutputFileRefSchema>;
export type MineruOutputFiles = z.infer<typeof mineruOutputFilesSchema>;
export type MineruJobFileResult = z.infer<typeof mineruJobFileResultSchema>;
export type MineruJob = z.infer<typeof mineruJobSchema>;
export type MineruJobCancel = z.infer<typeof mineruJobCancelSchema>;

/** Terminal job statuses. A poll loop stops here and then reads `files[0]`. */
export const MINERU_TERMINAL_JOB_STATUSES = [
	"completed",
	"partial",
	"failed",
	"canceled",
] as const;
export type MineruTerminalJobStatus =
	(typeof MINERU_TERMINAL_JOB_STATUSES)[number];

export function isTerminalMineruJobStatus(
	status: MineruJob["status"],
): status is MineruTerminalJobStatus {
	return (MINERU_TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}
