/**
 * The one mechanism every kind's id-addressed changes run through (ruling 14):
 * parse the `{ baseVersionId, diff }` envelope, read the diff with the schema
 * the kind's vocabulary hands in, judge each op against the document as the ops
 * before it left it, apply the accepted ones in order, and answer per op —
 * applied or refused, with a reason.
 *
 * It knows nothing about boards or decks: no route, no database handle, no
 * kind union. A kind plugs in by supplying an `OpsVocabulary` — Canvas's is
 * `board-ops.ts`, Slides' will be `deck-ops.ts` — and the mechanism stays as it
 * is. What it does own is the contract every vocabulary must keep, so no
 * vocabulary has to be trusted with it: every op is accounted for, refusals come
 * back in batch order, and a diff that cannot be read names the valid ops.
 */
import type { z } from "zod";

/**
 * One op a vocabulary refused: its place in the batch, its name, the id it
 * addressed, why, and a short English hint for the model — what IS valid
 * (the ids on the board, the kinds it may add, the fields the kind has), so a
 * wrong guess is corrected in one step (ruling 62). The reader's own words come
 * from `reason`, through the kind's message keys.
 */
export interface OpRefusal<TReason extends string = string> {
	index: number;
	op: string;
	/** The id the op addressed (or the one it named that does not exist). */
	id?: string;
	reason: TReason;
	detail: string;
}

/** A diff: what the model or the panel sends, whatever the kind. */
export interface OpsDiff<TOp> {
	id: string;
	/** One line: the version's summary and the change pill's label. */
	summary: string;
	ops: TOp[];
}

export interface OpsVocabulary<
	TDoc,
	TOp extends { op: string },
	TReason extends string,
> {
	/** Every op name the vocabulary has, named in a refusal so a wrong guess is corrected in one step. */
	opNames: readonly string[];
	/** The schema the model is shown and the server parses with: one schema, never a twin. */
	diffSchema: z.ZodType<OpsDiff<TOp>>;
	/**
	 * Which of the ops apply to `doc`, in order, and why each of the others does
	 * not. Sees the whole batch, and judges every op against what the accepted
	 * ops before it leave behind (so "an id an earlier op removed" is unknown).
	 */
	validate(
		ops: readonly TOp[],
		doc: TDoc,
	): { accepted: TOp[]; refused: OpRefusal<TReason>[] };
	/** One accepted op. Pure: the caller assigns the result. */
	apply(doc: TDoc, op: TOp): TDoc;
}

/** Enough of an issue list for a model to fix its call, and no more. */
const MAX_ISSUES_SHOWN = 5;

function formatPath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "diff";
	let out = "";
	for (const part of path) {
		if (typeof part === "number") out += `[${part}]`;
		else out += out === "" ? String(part) : `.${String(part)}`;
	}
	return out;
}

/** A diff's zod issues, put where a model can act on them, ending with the ops it could have used. */
function describeDiffIssues(
	error: z.ZodError,
	opNames: readonly string[],
): string {
	const shown = error.issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => {
		const where = formatPath(issue.path);
		// An unknown discriminator says nothing but "Invalid input": say what it is.
		if (issue.code === "invalid_union" && "discriminator" in issue) {
			return `${where}: not a known ${String(issue.discriminator)}`;
		}
		return `${where}: ${issue.message}`;
	});
	const more = error.issues.length - shown.length;
	return `${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}. Valid ops: ${opNames.join(", ")}.`;
}

/** The envelope's shell: a base version and a diff, both present. The diff's own shape is the vocabulary's. */
export function parseOpsEnvelope(
	payload: unknown,
):
	| { ok: true; baseVersionId: string; diff: unknown }
	| { ok: false; detail: string } {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return {
			ok: false,
			detail:
				"Send an object: { baseVersionId: string, diff: { id, summary, ops } }.",
		};
	}
	const { baseVersionId, diff } = payload as Record<string, unknown>;
	if (typeof baseVersionId !== "string" || baseVersionId.length === 0) {
		return {
			ok: false,
			detail:
				"baseVersionId must be the id of the version the diff was made against.",
		};
	}
	if (typeof diff !== "object" || diff === null || Array.isArray(diff)) {
		return {
			ok: false,
			detail: "diff must be an object: { id, summary, ops }.",
		};
	}
	return { ok: true, baseVersionId, diff };
}

export type OpsRun<TDoc, TOp extends { op: string }, TReason extends string> =
	| { ok: false; reason: "invalid_diff"; detail: string }
	| {
			ok: true;
			doc: TDoc;
			diffId: string;
			summary: string;
			/** The ops that applied, in the order they were applied. */
			accepted: TOp[];
			applied: number;
			refused: OpRefusal<TReason>[];
	  };

/**
 * A vocabulary that loses an op, names one twice or names one that is not in
 * the batch has a bug that would show up as a silent no-op, so it is refused
 * here, once, rather than left to each vocabulary's own tests.
 */
function checkAccountedFor(
	total: number,
	acceptedCount: number,
	refused: readonly OpRefusal[],
): void {
	const seen = new Set<number>();
	for (const refusal of refused) {
		if (
			!Number.isInteger(refusal.index) ||
			refusal.index < 0 ||
			refusal.index >= total ||
			seen.has(refusal.index)
		) {
			throw new Error(
				`ops vocabulary refused op ${refusal.index} of ${total}: an index outside the batch, or one named twice`,
			);
		}
		seen.add(refusal.index);
	}
	if (acceptedCount + refused.length !== total) {
		throw new Error(
			`ops vocabulary must account for every op: ${acceptedCount} accepted + ${refused.length} refused of ${total}`,
		);
	}
}

/**
 * Reads `rawDiff` with the vocabulary's schema, judges it against `doc`, and
 * applies what was accepted, in order. A diff the schema cannot read is
 * `invalid_diff` and nothing is applied; otherwise the result carries the new
 * document and, per refused op, why. `doc` is never mutated.
 */
export function runOps<
	TDoc,
	TOp extends { op: string },
	TReason extends string,
>(
	vocabulary: OpsVocabulary<TDoc, TOp, TReason>,
	doc: TDoc,
	rawDiff: unknown,
): OpsRun<TDoc, TOp, TReason> {
	const parsed = vocabulary.diffSchema.safeParse(rawDiff);
	if (!parsed.success) {
		return {
			ok: false,
			reason: "invalid_diff",
			detail: describeDiffIssues(parsed.error, vocabulary.opNames),
		};
	}
	const { id, summary, ops } = parsed.data;
	const { accepted, refused } = vocabulary.validate(ops, doc);
	checkAccountedFor(ops.length, accepted.length, refused);
	let next = doc;
	for (const op of accepted) next = vocabulary.apply(next, op);
	return {
		ok: true,
		doc: next,
		diffId: id,
		summary,
		accepted,
		applied: accepted.length,
		refused: [...refused].sort((a, b) => a.index - b.index),
	};
}
