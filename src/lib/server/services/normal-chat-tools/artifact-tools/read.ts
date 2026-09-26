// read_artifact: see a Document, App, Canvas, Slides or File item's current
// content, addressed by the id from create_artifact, a prior read, or the
// artifact catalogue. See docs/plans/claude-at-home-2/slice-5.md §The three
// tools and decisions.md ruling 43.
import { z } from "zod";
import {
	getArtifact,
	listArtifactCatalogueEntries,
} from "$lib/server/services/artifacts";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { MAX_INLINE_TEXT_CHARS } from "../files";
import { truncateText } from "../shared";
import type { CreatableArtifactKind } from "./create";

export const readArtifactInputSchema = z.object({
	artifactId: z.string().min(1),
	/** `blocks` returns the addressable ids and hashes; `full` returns the whole body. */
	detail: z.enum(["blocks", "full"]).optional(),
});

export type ReadArtifactToolInput = z.infer<typeof readArtifactInputSchema>;

export type ReadArtifactModelPayload =
	| {
			success: true;
			artifactId: string;
			artifactType: ArtifactKind;
			title: string;
			/** Documents: [{blockId, kind, label, hash, text}] (slice 1's readDocumentForAlfy shape).
			 *  Canvas: [{id, kind, label, x, y, parentId}].
			 *  Slides: [{slideId, layout, fields: [{fieldId, hash, text}]}]. */
			blocks?: Array<Record<string, unknown>>;
			body?: string;
			/**
			 * Set when `body` was clipped or `blocks` was cut short at
			 * MAX_INLINE_TEXT_CHARS (files.ts's own inline-text budget, reused
			 * here rather than a second invented cap). `body` and `blocks` are
			 * bounded independently, so at most one of `omittedChars`/
			 * `omittedBlocks` is ever present alongside it.
			 */
			truncated?: boolean;
			/** Characters left out of `body` past the cap. */
			omittedChars?: number;
			/** Blocks left out of `blocks` past the cap, in original order. */
			omittedBlocks?: number;
	  }
	| {
			success: false;
			error: string;
			candidates?: Array<{ artifactId: string; title: string }>;
	  };

export interface ReadArtifactHandlerParams {
	userId: string;
	conversationId: string;
	artifactId: string;
	title: string;
	detail: "blocks" | "full";
	/**
	 * Fires on the tool's own timeout (10s, TOOL_TIMEOUTS_MS.read_artifact) or
	 * the turn's own stop/disconnect. A read has nothing to write, but a
	 * handler MUST still check it before doing further work and pass it to
	 * any model call it makes, so that call is cancelled too rather than left
	 * running unattended after the model was told the read failed.
	 */
	abortSignal: AbortSignal;
}

export interface ReadArtifactHandlerResult {
	blocks?: Array<Record<string, unknown>>;
	body?: string;
}

/**
 * A registered handler returns the per-kind `blocks` shape that lets the
 * model address a later edit_artifact patch/op (block ids and hashes for
 * Documents, node ids for Canvas, slide/field ids for Slides). It never
 * needs to re-check ownership: the artifact was already resolved through the
 * scoped `getArtifact` before this runs.
 */
export type ReadArtifactHandler = (
	params: ReadArtifactHandlerParams,
) => Promise<ReadArtifactHandlerResult>;

/**
 * The per-kind dispatch seam for the four creatable kinds (rulings 43/44).
 * Empty in Slice 5a — File needs no entry here at all: Slice 0's generic
 * artifact record already carries everything read_artifact says about one
 * (see the `kind === "file"` branch below), so it is answered without a
 * registered handler. Slice 1/2/3/4 each append ONE entry here, and only
 * here — no type slice edits `normal-chat-tools/index.ts` or `shared.ts`.
 */
export const READ_ARTIFACT_HANDLERS: Partial<
	Record<CreatableArtifactKind, ReadArtifactHandler>
> = {};

/**
 * A produced file's content can be long (it is meant for read_generated_file,
 * not this tool); read_artifact on a File answers with its type and a SHORT
 * summary, not the full text — asking to read a File's whole content is
 * still read_generated_file's job.
 */
const FILE_SUMMARY_MAX_CHARS = 280;

export interface ReadArtifactRunResult {
	modelPayload: ReadArtifactModelPayload;
	outputSummary: string;
	metadata: Record<string, string | number | boolean | null>;
}

/**
 * Bounds `body`/`blocks` at MAX_INLINE_TEXT_CHARS BEFORE either ever reaches
 * the model — applied to whatever a caller returns, whether that is the
 * generic-record fallback below or a registered per-kind handler. A "full"
 * read had no size bound at all before this (compactModelPayload only strips
 * EMPTY keys, it never truncates), which was dead code with no creatable
 * kind registered yet but becomes live the moment a type slice's reader
 * ships. Not applied to the File short-summary path: FILE_SUMMARY_MAX_CHARS
 * (280) can never exceed this cap, so there is nothing for it to do there.
 */
function boundReadOutput(result: {
	blocks?: Array<Record<string, unknown>>;
	body?: string;
}): {
	blocks?: Array<Record<string, unknown>>;
	body?: string;
	truncated?: boolean;
	omittedChars?: number;
	omittedBlocks?: number;
} {
	let truncated: boolean | undefined;
	let omittedChars: number | undefined;
	let omittedBlocks: number | undefined;

	let body = result.body;
	if (body !== undefined && body.length > MAX_INLINE_TEXT_CHARS) {
		omittedChars = body.length - MAX_INLINE_TEXT_CHARS;
		body = truncateText(body, MAX_INLINE_TEXT_CHARS);
		truncated = true;
	}

	let blocks = result.blocks;
	if (blocks !== undefined) {
		let usedChars = 0;
		const kept: Array<Record<string, unknown>> = [];
		for (const block of blocks) {
			usedChars += JSON.stringify(block).length;
			if (usedChars > MAX_INLINE_TEXT_CHARS) break;
			kept.push(block);
		}
		if (kept.length < blocks.length) {
			omittedBlocks = blocks.length - kept.length;
			truncated = true;
		}
		blocks = kept;
	}

	return { body, blocks, truncated, omittedChars, omittedBlocks };
}

async function buildNotFoundResult(params: {
	userId: string;
	conversationId: string;
}): Promise<ReadArtifactRunResult> {
	const entries = await listArtifactCatalogueEntries(params).catch(() => []);
	const error =
		"No item with that id exists in this conversation. Use one of the candidates below, the artifact catalogue, or read_generated_file for a produced file.";
	return {
		modelPayload: {
			success: false,
			error,
			candidates: entries.map((entry) => ({
				artifactId: entry.artifactId,
				title: entry.title,
			})),
		},
		outputSummary: "Not found",
		metadata: { ok: false, found: false },
	};
}

/**
 * The tool's whole domain logic, independent of the AI SDK execution
 * envelope so it can be unit-tested directly.
 */
export async function runReadArtifactTool(params: {
	userId: string;
	conversationId: string;
	artifactId: string;
	detail?: "blocks" | "full";
	abortSignal: AbortSignal;
}): Promise<ReadArtifactRunResult> {
	const detail = params.detail ?? "full";
	const record = await getArtifact({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
	});
	// getArtifact/readScopedArtifactRow is scoped to "any conversation this
	// user can currently reach" (deliberately wide for its other caller,
	// GET /api/artifacts/[id], which opens any of the user's own artifacts by
	// id) — NOT to this one conversation. The catalogue that hands the model
	// ids is scoped to exactly this conversation
	// (listArtifactsForConversation's `eq(artifacts.conversationId, …)`), so
	// without this check the model could read another of the user's own,
	// non-incognito conversations' artifacts just by naming its id — an id it
	// was never given. Treat that exactly like the id does not exist.
	if (!record || record.conversationId !== params.conversationId) {
		return buildNotFoundResult(params);
	}

	if (record.kind === "file") {
		const summary = truncateText(record.body ?? "", FILE_SUMMARY_MAX_CHARS);
		return {
			modelPayload: {
				success: true,
				artifactId: record.id,
				artifactType: "file",
				title: record.title,
				body: summary || undefined,
			},
			outputSummary: `Read File "${record.title}"`,
			metadata: {
				ok: true,
				found: true,
				artifactId: record.id,
				artifactKind: "file",
			},
		};
	}

	const handler = READ_ARTIFACT_HANDLERS[record.kind];
	if (!handler) {
		// No per-kind reader yet: answer with what the generic record already
		// knows (kind, title, the whole stored body) rather than refusing
		// outright. What is actually missing is the per-kind `blocks` shape an
		// edit needs to address — not the ability to see the thing at all.
		const bounded = boundReadOutput({ body: record.body ?? undefined });
		return {
			modelPayload: {
				success: true,
				artifactId: record.id,
				artifactType: record.kind,
				title: record.title,
				body: bounded.body,
				truncated: bounded.truncated,
				omittedChars: bounded.omittedChars,
			},
			outputSummary: `Read ${record.kind} "${record.title}"`,
			metadata: {
				ok: true,
				found: true,
				artifactId: record.id,
				artifactKind: record.kind,
			},
		};
	}

	const result = await handler({
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: record.id,
		title: record.title,
		detail,
		abortSignal: params.abortSignal,
	});
	const bounded = boundReadOutput({ blocks: result.blocks, body: result.body });
	return {
		modelPayload: {
			success: true,
			artifactId: record.id,
			artifactType: record.kind,
			title: record.title,
			blocks: bounded.blocks,
			body: bounded.body,
			truncated: bounded.truncated,
			omittedChars: bounded.omittedChars,
			omittedBlocks: bounded.omittedBlocks,
		},
		outputSummary: `Read ${record.kind} "${record.title}"`,
		metadata: {
			ok: true,
			found: true,
			artifactId: record.id,
			artifactKind: record.kind,
		},
	};
}
