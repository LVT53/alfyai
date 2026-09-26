// The pure scoring module (unit-tested in CI, no model, no browser).
// `scoreArtifactEvalAttempt` is the generic, honest placeholder Slice 0
// shipped: it catches the one universal failure every suite shares (an empty
// or whitespace-only answer) and otherwise says plainly that no
// suite-specific rule exists yet, rather than fabricating a verdict a real
// suite has not earned.
//
// `SUITE_SCORERS` below is the per-suite dispatch seam (decisions.md ruling
// 44): each type slice registers its OWN scorer here as it lands —
// `document` (Slice 1), `app`/`verification` (Slice 2), `canvas` (Slice 3),
// `slides` (Slice 4) — and `getSuiteScorer` is what `run.ts` calls, so the
// runner never has to know which suites exist. Empty in Slice 5a: every
// suite falls back to the generic scorer above until its own lands.
import { buildIndex } from "$lib/shared/artifact-document/blocks";
import {
	applyPatchSet,
	type PatchOp,
	type PatchOpKind,
} from "$lib/shared/artifact-document/patch";
import { scoreAppEval } from "./suites/apps";
import { DOCUMENT_FIXTURES } from "./suites/document";
import { scoreVerificationEval } from "./suites/verification";
import type {
	EvalAttempt,
	EvalCase,
	EvalScoreResult,
	SuiteScorer,
} from "./types";

export function scoreArtifactEvalAttempt(
	evalCase: EvalCase,
	attempt: EvalAttempt,
): EvalScoreResult {
	if (attempt.response.trim().length === 0) {
		return {
			verdict: "bad",
			reasons: [`case ${evalCase.id}: the response was empty`],
		};
	}

	// No suite-specific scorer exists yet — say so rather than fabricating a
	// verdict a real suite has not earned.
	return {
		verdict: "acceptable",
		reasons: [
			`case ${evalCase.id}: no suite-specific scorer is registered for "${evalCase.suite}" yet`,
		],
	};
}

const DOCUMENT_PATCH_OP_KINDS: readonly PatchOpKind[] = [
	"replaceBlock",
	"insertText",
	"replaceRange",
	"toggleTask",
	"addTableRow",
];

function isDocumentPatchOpKind(value: unknown): value is PatchOpKind {
	return (
		typeof value === "string" &&
		(DOCUMENT_PATCH_OP_KINDS as readonly string[]).includes(value)
	);
}

/**
 * Lenient on purpose: a real model's answer may wrap the JSON array in a
 * markdown code fence or add a stray sentence around it, and "an answer with
 * no parseable ops is bad, not a throw" (slice-1.md T13 Step 1) means this
 * function must never throw — an unparseable or malformed answer is exactly
 * one more way a case can score "bad". Deliberately SEPARATE from
 * `edit_artifact`'s own strict Zod schema (`normal-chat-tools/artifact-tools
 * /edit.ts`): that one guards a real write and rejects anything off-shape,
 * this one is scoring MODEL OUTPUT QUALITY and needs to tell "malformed" and
 * "well-formed but wrong" apart rather than collapsing both into one error.
 */
export function parseDocumentPatchOpsFromModelResponse(
	response: string,
): PatchOp[] | null {
	const match = response.match(/\[[\s\S]*\]/);
	if (!match) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(match[0]);
	} catch {
		return null;
	}
	if (!Array.isArray(raw)) return null;
	if (raw.length === 0) return [];

	const ops: PatchOp[] = [];
	for (const [index, entry] of raw.entries()) {
		if (!entry || typeof entry !== "object") return null;
		const record = entry as Record<string, unknown>;
		if (!isDocumentPatchOpKind(record.op)) return null;
		if (typeof record.blockId !== "string" || record.blockId.length === 0) {
			return null;
		}
		if (typeof record.baseHash !== "string" || record.baseHash.length === 0) {
			return null;
		}
		ops.push({
			opId: `eval-${index}`,
			kind: record.op,
			blockId: record.blockId,
			baseHash: record.baseHash,
			blockLabel: record.blockId,
			text: typeof record.text === "string" ? record.text : undefined,
			find: typeof record.find === "string" ? record.find : undefined,
			at: record.at === "start" || record.at === "end" ? record.at : undefined,
			checked: typeof record.checked === "boolean" ? record.checked : undefined,
		});
	}
	return ops;
}

/**
 * The document suite's scorer (Feature 2 · Artifacts, Slice 1, Task T13):
 * runs the model's own patch ops through the REAL engine
 * (`applyPatchSet`) against the case's fixture, then asks the fixture's own
 * `verify` what that outcome means — refusing correctly is a pass, not a
 * failure (ruling 25), so this never treats `applied === 0` as automatically
 * bad.
 */
export const documentScorer: SuiteScorer = (evalCase, attempt) => {
	const fixture = DOCUMENT_FIXTURES[evalCase.id];
	if (!fixture) {
		return {
			verdict: "bad",
			reasons: [`no fixture is registered for case "${evalCase.id}"`],
		};
	}

	const ops = parseDocumentPatchOpsFromModelResponse(attempt.response);
	if (ops === null) {
		return {
			verdict: "bad",
			reasons: ["could not parse the response as a JSON array of patch ops"],
		};
	}
	if (ops.length === 0) {
		// An empty array is a valid, sometimes CORRECT answer (the prompt tells
		// the model to send [] rather than guess) — score it through the same
		// fixture-specific verifier as any other outcome, not a blanket "bad".
		const result = applyPatchSet({
			blocks: fixture.currentBlocks,
			patch: { patchId: "eval", label: evalCase.id, ops: [] },
			snapshot: buildIndex(fixture.shownBlocks),
		});
		const verified = fixture.verify(result);
		return {
			verdict: verified.ok ? "good" : "bad",
			reasons: verified.reasons,
		};
	}

	const result = applyPatchSet({
		blocks: fixture.currentBlocks,
		patch: { patchId: "eval", label: evalCase.id, ops },
		snapshot: buildIndex(fixture.shownBlocks),
	});
	const verified = fixture.verify(result);
	return { verdict: verified.ok ? "good" : "bad", reasons: verified.reasons };
};

/**
 * The per-suite scorer registry. Each type slice appends ONE entry, keyed by
 * its suite name, and only here; `run.ts` never imports a type slice's
 * scorer directly.
 */
export const SUITE_SCORERS: Partial<Record<string, SuiteScorer>> = {
	document: documentScorer,
	app: scoreAppEval,
	verification: scoreVerificationEval,
};

/** What `run.ts` calls for every case: a suite's own scorer when one is
 * registered, else the generic placeholder above. Never throws for an
 * unregistered suite — that is exactly the "not measured yet" state the
 * placeholder is honest about. */
export function getSuiteScorer(suite: string): SuiteScorer {
	return SUITE_SCORERS[suite] ?? scoreArtifactEvalAttempt;
}
