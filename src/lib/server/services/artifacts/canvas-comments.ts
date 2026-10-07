// `@Alfy` in a comment on a Canvas (Feature 2 · Artifacts, Slice 3, T5): the
// board's branch of the comment hook `comments.ts` dispatches to (ruling 11
// gave the hook to the shared comment layer; a kind with its own behavior adds
// its branch, the way `EDIT_ARTIFACT_HANDLERS` dispatches by kind).
//
// One model call answers a thread with a reply and, when the comment asks for a
// change, board ops in EXACTLY what `edit_artifact` advertises to the model
// (ruling 62): the same op schema (`boardOpsArraySchema`, never a twin), the
// same edit rule and worked example, the same board projection (`read_artifact`'s
// blocks), and the same words for what went wrong. The ops land through the same
// envelope as the tool's (`applyArtifactOps`: one version, author `alfy`, every
// op judged against the board as it is now, except that an op on a block the
// reader changed after the model read it is refused `stale` and the rest lands,
// ruling 67), and the reply goes in the thread — applied, refused, or an answer,
// never silence, and a skipped op is named.
//
// What is a comment's own here: the anchor scopes the request (a comment on a
// block that is gone is refused before any model call), the note is written in
// the comment's language, and a wrong answer gets ONE correction: the tool's own
// refusal text goes back to the model, the way it would in the tool loop, since
// this hook has no loop of its own. Abort and deadline are the Document's: the
// signal is checked before each call and before each write, and a call that was
// made is paid for even when it is abandoned.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	ALFY_EMPTY_REPLY_MARKER,
	ALFY_REFUSED_MARKER,
	type AlfySkippedOp,
	splitSkippedOps,
	withSkippedOps,
} from "$lib/shared/artifact-document/alfy-reply";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { boardOpsArraySchema } from "$lib/shared/artifacts/board-ops";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import {
	emptyCanvasBody,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import { canvasAnchorResolver } from "$lib/shared/artifacts/comments";
import { sendJsonControlMessage } from "../normal-chat-control-model";
import {
	BLOCK_SHAPES_HINT,
	canvasEditFailureMessage,
	canvasEditOutcome,
	canvasOpsRequiredMessage,
	canvasReadBlocks,
} from "../normal-chat-tools/artifact-tools/canvas-model";
import {
	EDIT_ARTIFACT_CANVAS_EXAMPLE,
	editArtifactOpsFieldDescription,
	editArtifactRuleClause,
} from "../normal-chat-tools/artifact-tools/kind-prose";
import { applyArtifactOps, type OpsEnvelopeResult } from "./ops";
import { getArtifact } from "./record";
import type {
	AlfyCommentReplyResult,
	AlfyThreadContext,
	ArtifactComment,
	ArtifactScopeOptions,
} from "./types";
import { listVersions } from "./versions";

/** The first answer and one correction: the model had the tool's refusal text once, as it would in the tool loop. */
const MAX_ATTEMPTS = 2;
/** Room for up to 40 ops of JSON: a whole rearranged board is a long answer. */
const REPLY_MAX_TOKENS = 6000;
/** The reply is a comment, not a document: a runaway note is cut, so it always fits a comment. */
const NOTE_MAX_CHARS = 4000;
/** How much of the board the model is shown: blocks in order until this many characters, then a count of the rest. */
const BOARD_PROMPT_MAX_CHARS = 40_000;
/** The skipped ops a reply names: a reader learns what kind of thing went wrong, not a hundred lines of it. */
const MAX_SKIPPED_NAMED = 5;
const TARGET_NAME_MAX_CHARS = 40;
const VERSION_SUMMARY = "Alfy's comment reply";

/**
 * The answer the model is asked for. `ops` is the edit tool's own array — the
 * one object it advertises and validates with — so what the model is shown and
 * what its answer is read with cannot drift (ruling 62). Optional: a question
 * needs no change.
 */
const alfyCanvasReplySchema = z.object({
	note: z.string(),
	// A model that means "no change" may write `[]` as readily as leave `ops` out; the
	// schema it is shown is still the tool's (the preprocess is not part of it).
	ops: z.preprocess(
		(value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
		boardOpsArraySchema.optional(),
	),
});

/**
 * The schema as a model's JSON-schema mode can compile it: the validator's own
 * (`z.toJSONSchema`), with two things taken out that say nothing. `$schema` is a
 * header for a validator, and `propertyNames: {type: "string"}` — what zod writes
 * for a record — restates that a JSON object's keys are strings; the grammar
 * compiler behind a local model refuses the keyword outright (measured live:
 * "Unimplemented keys: propertyNames"), so a schema that carries it makes every
 * comment fail. Neither removal changes what an answer may contain.
 */
function forTheModel(schema: unknown): Record<string, unknown> {
	const cleaned = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(cleaned);
		if (typeof value !== "object" || value === null) return value;
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			if (key === "$schema") continue;
			if (
				key === "propertyNames" &&
				typeof inner === "object" &&
				inner !== null &&
				JSON.stringify(inner) === '{"type":"string"}'
			) {
				continue;
			}
			out[key] = cleaned(inner);
		}
		return out;
	};
	return cleaned(schema) as Record<string, unknown>;
}

const ALFY_CANVAS_REPLY_JSON_SCHEMA = {
	name: "alfy_canvas_comment_reply",
	schema: forTheModel(z.toJSONSchema(alfyCanvasReplySchema)),
	// The ops array has optional fields on purpose (a frame's size, a node's parent):
	// strict mode would demand every one of them in every op.
	strict: false,
} as const;

function readBoard(stored: string | null): CanvasBody {
	if (!stored?.trim()) return emptyCanvasBody();
	try {
		return normalizeCanvasBody(JSON.parse(stored)).body;
	} catch {
		return emptyCanvasBody();
	}
}

function clip(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

// ── What the model is told ──────────────────────────────────────────────

type Block = Record<string, unknown>;

/** Blocks in order until the cap, and how many were left out: the same bound `read_artifact` puts on what reaches a model. */
function boundBlocks(
	blocks: readonly Block[],
	maxChars: number,
): { shown: Block[]; omitted: number } {
	const shown: Block[] = [];
	let size = 0;
	for (const block of blocks) {
		size += JSON.stringify(block).length + 1;
		if (size > maxChars) break;
		shown.push(block);
	}
	return { shown, omitted: blocks.length - shown.length };
}

function describeAnchor(anchor: Anchor, blocks: readonly Block[]): string {
	if (anchor.kind === "point") {
		return `This comment was left on a spot of the board (x ${anchor.x}, y ${anchor.y}), not on any block.`;
	}
	const block =
		anchor.kind === "node"
			? blocks.find((candidate) => candidate.id === anchor.nodeId)
			: undefined;
	return block
		? `This comment is attached to this block: ${JSON.stringify(block)}`
		: "This comment is attached to a part of the board.";
}

/** A message as the model reads the thread: who said it, without the fixed markers a card localizes. */
function plainBody(comment: ArtifactComment): string {
	const { text } = splitSkippedOps(comment.body);
	if (comment.author === "alfy" && text === ALFY_REFUSED_MARKER) {
		return "(no change was made to the board)";
	}
	if (comment.author === "alfy" && text === ALFY_EMPTY_REPLY_MARKER) {
		return "(done)";
	}
	return text;
}

function describeThread(thread: ArtifactComment): string {
	return [thread, ...thread.replies]
		.map((comment) => `[${comment.author}] ${plainBody(comment)}`)
		.join("\n");
}

function buildSystemPrompt(params: {
	anchor: Anchor;
	blocks: readonly Block[];
	thread: ArtifactComment;
}): string {
	const { shown, omitted } = boundBlocks(params.blocks, BOARD_PROMPT_MAX_CHARS);
	return [
		"You are Alfy, replying inside a comment thread on a Canvas board you share with the reader.",
		describeAnchor(params.anchor, params.blocks),
		"",
		"The thread so far, oldest first; answer the last [user] message:",
		describeThread(params.thread),
		"",
		"The board, as read_artifact shows it: every block and arrow, each with the id an op must name; x and y are in the block's own space (relative to its frame when it has a parentId):",
		JSON.stringify(shown),
		...(omitted > 0 ? [`${omitted} more blocks are not shown.`] : []),
		"",
		"If the comment asks for a change to the board, describe it as ops: the same ops edit_artifact takes.",
		editArtifactOpsFieldDescription(["canvas"]) ?? "",
		editArtifactRuleClause(["canvas"], "en"),
		`Example ops: ${JSON.stringify(EDIT_ARTIFACT_CANVAS_EXAMPLE.ops)}`,
		BLOCK_SHAPES_HINT,
		"Change only what the comment asks for. If the comment is a question, an observation, or needs no change, leave ops out.",
		'Always write a short "note": your answer if it was a question, or one short line about what you changed. Write it in the same language as the comment.',
		'Respond with JSON only, in the shape {"note": string, "ops": [...]}.',
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

/** What the model is told when its answer could not be read: the tool's own refusal, naming the valid ops. */
function unreadableFeedback(error: z.ZodError | null): string {
	const detail = error
		? error.issues
				.slice(0, 3)
				.map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`)
				.join("; ")
		: "the answer was not JSON";
	return `Your answer was not applied. ${canvasEditFailureMessage({
		ok: false,
		status: 400,
		reason: "invalid_diff",
		detail: `${detail}. ${canvasOpsRequiredMessage(false)}`,
	})}`;
}

/** What the model is told when every op was refused: the tool's own text, and each refusal's own detail. */
function refusedFeedback(
	error: string,
	refused: readonly { opIndex: number; target?: string; detail: string }[],
): string {
	return [
		`Your answer was not applied. ${error}`,
		...refused.map(
			(item) =>
				`- op ${item.opIndex}${item.target ? ` (${item.target})` : ""}: ${item.detail}`,
		),
	].join("\n");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ── The hook ────────────────────────────────────────────────────────────

export async function runCanvasAlfyReply(
	params: {
		userId: string;
		artifactId: string;
		abortSignal: AbortSignal;
		context: AlfyThreadContext;
	} & ArtifactScopeOptions,
): Promise<
	| { ok: true; value: AlfyCommentReplyResult }
	| { ok: false; reason: "not_found" | "aborted" }
> {
	const scope = {
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
	};
	const { context, abortSignal } = params;
	const aborted = { ok: false, reason: "aborted" } as const;
	if (abortSignal.aborted) return aborted;

	async function answer(
		outcome: AlfyCommentReplyResult["outcome"],
		counts: { applied: number; refused: number; version: number },
		body: string,
	): Promise<{ ok: true; value: AlfyCommentReplyResult }> {
		return {
			ok: true,
			value: { outcome, ...counts, reply: await context.reply(body) },
		};
	}

	/** One model call, paid for whatever happens to it next: recorded before anything can abandon it. */
	async function ask(
		message: string,
		systemPrompt: string,
		conversationId: string | null,
	): Promise<string | null> {
		const result = await sendJsonControlMessage(message, undefined, {
			systemPrompt,
			thinkingMode: "off",
			maxTokens: REPLY_MAX_TOKENS,
			jsonSchema: ALFY_CANVAS_REPLY_JSON_SCHEMA,
			signal: abortSignal,
		}).catch(() => null);
		if (!result) return null;
		const { recordControlModelUsage } = await import("../analytics");
		await recordControlModelUsage({
			userId: params.userId,
			conversationId,
			feature: "artifact_comment_alfy",
			modelId: result.modelId,
			modelDisplayName: result.modelDisplayName,
			promptTokens: result.usage?.promptTokens,
			completionTokens: result.usage?.completionTokens,
			totalTokens: result.usage?.totalTokens,
			cachedInputTokens: result.usage?.cachedInputTokens,
			cacheHitTokens: result.usage?.cacheHitTokens,
			cacheMissTokens: result.usage?.cacheMissTokens,
		});
		return result.text;
	}

	/**
	 * The ops as ONE Alfy version against the board's newest version; a save that
	 * lands in between is refused by the write and tried once more. `readBody` is
	 * the board as the model was shown it: an op on a block the reader changed
	 * since is refused `stale` and the rest lands (ruling 67). The body, not the
	 * version it came from: the reader's saves within ten minutes are written into
	 * their newest version, so the version the model read can hold newer words.
	 */
	async function apply(
		ops: unknown[],
		readBody: string,
	): Promise<OpsEnvelopeResult | null> {
		let outcome: OpsEnvelopeResult | null = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			// The signal is checked right before the write: once it fires the caller was told it failed.
			if (abortSignal.aborted) return null;
			const [newest] = await listVersions({ ...scope, limit: 1 });
			if (!newest) return { ok: false, status: 404, reason: "not_found" };
			outcome = await applyArtifactOps({
				...scope,
				readBody,
				payload: {
					baseVersionId: newest.id,
					diff: { id: randomUUID(), summary: VERSION_SUMMARY, ops },
				},
			});
			if (outcome.ok || outcome.reason !== "version_conflict") return outcome;
		}
		return outcome;
	}

	let feedback: string | null = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		if (abortSignal.aborted) return aborted;

		// Each attempt reads the board afresh: what a correction is about is the board now.
		const artifact = await getArtifact(scope);
		if (!artifact) return { ok: false, reason: "not_found" };
		const board = readBoard(artifact.body);
		const anchor = context.anchor;
		const counts = { applied: 0, refused: 0, version: artifact.versionNumber };
		// A comment on a block that is gone has nothing to change: refused before any model call.
		if (
			!anchor ||
			canvasAnchorResolver.resolve(anchor, board.nodes).state === "orphaned"
		) {
			return answer("refused", counts, ALFY_REFUSED_MARKER);
		}

		const blocks = canvasReadBlocks(board);
		const text = await ask(
			feedback ? `${context.target.body}\n\n${feedback}` : context.target.body,
			buildSystemPrompt({ anchor, blocks, thread: context.thread }),
			artifact.conversationId,
		);
		if (abortSignal.aborted) return aborted;
		if (text === null) return answer("refused", counts, ALFY_REFUSED_MARKER);

		const parsed = alfyCanvasReplySchema.safeParse(parseJson(text));
		if (!parsed.success) {
			feedback = unreadableFeedback(
				parseJson(text) === null ? null : parsed.error,
			);
			continue;
		}
		const note = clip(parsed.data.note.trim(), NOTE_MAX_CHARS);
		const ops = parsed.data.ops ?? [];
		if (ops.length === 0) {
			return answer("answered", counts, note || ALFY_EMPTY_REPLY_MARKER);
		}

		const landed = await apply(ops, artifact.body ?? "");
		if (landed === null) return aborted;
		if (!landed.ok) {
			if (landed.reason === "not_found")
				return { ok: false, reason: "not_found" };
			feedback = `Your answer was not applied. ${canvasEditFailureMessage(landed)}`;
			continue;
		}
		const judged = canvasEditOutcome(landed);
		if (!judged.ok) {
			feedback = refusedFeedback(judged.error, judged.refused);
			continue;
		}
		// Only a highlight applied: it changes nothing on the board, so it is an answer, not a change.
		if (!landed.changed) {
			return answer(
				"answered",
				{ applied: 0, refused: judged.refused.length, version: landed.version },
				note || ALFY_EMPTY_REPLY_MARKER,
			);
		}
		// A note cannot change kind in place, so making one a list is a remove and an add.
		// When the block this thread is on was replaced by exactly one new block, the thread
		// follows it: the comment stays where it was left instead of being orphaned by the
		// very change it asked for. With more than one new block which took its place is a guess.
		const refusedAt = new Set(judged.refused.map((item) => item.opIndex));
		const accepted = ops.filter((_, index) => !refusedAt.has(index));
		const added = accepted.filter((op) => op.op === "add_node");
		if (
			anchor.kind === "node" &&
			added.length === 1 &&
			accepted.some((op) => op.op === "remove_node" && op.id === anchor.nodeId)
		) {
			await context.reanchor({ kind: "node", nodeId: added[0].node.id });
		}
		// A skipped op is named by its block's own words when the block is on the board, else by the id it addressed.
		const words = new Map(
			blocks
				.filter(
					(block) => typeof block.id === "string" && block.kind !== "edge",
				)
				.map((block) => [String(block.id), String(block.label ?? "")]),
		);
		const skipped: AlfySkippedOp[] = judged.refused
			.slice(0, MAX_SKIPPED_NAMED)
			.map((item) => ({
				target: clip(
					item.target === undefined
						? ""
						: words.get(item.target) || item.target,
					TARGET_NAME_MAX_CHARS,
				),
				reason: item.reason,
			}));
		return answer(
			"applied",
			{
				applied: judged.applied,
				refused: judged.refused.length,
				version: landed.version,
			},
			withSkippedOps(note || ALFY_EMPTY_REPLY_MARKER, skipped),
		);
	}

	// Two answers, neither one the board could take: it is as it was, and the reply says so.
	return answer(
		"refused",
		{
			applied: 0,
			refused: 0,
			version: (await getArtifact(scope))?.versionNumber ?? 0,
		},
		ALFY_REFUSED_MARKER,
	);
}
