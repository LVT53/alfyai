// The document suite (Feature 2 · Artifacts, Slice 1, Task T13): scores the
// EDIT_ARTIFACT PATCH CONTRACT against a real model, not the prototype's
// canned patches. Each case shows the model a document's addressable blocks
// (the same view `read_artifact` gives it — ids, hashes, text, no markers)
// plus a request, and asks for the exact `edit_artifact` `patches` JSON
// shape. The scorer (`../scoring.ts`) runs the model's own ops through the
// REAL patch engine (`$lib/shared/artifact-document/patch`) against each
// case's fixture and checks the OUTCOME against what that case exists to
// prove — refusing correctly counts as a pass, not a failure (ruling 25).
import {
	type DocumentBlock,
	makeBlock,
} from "$lib/shared/artifact-document/blocks";
import type { PatchResult } from "$lib/shared/artifact-document/patch";
import type { EvalCase } from "../types";

export interface DocumentEvalVerification {
	ok: boolean;
	reasons: string[];
}

export interface DocumentEvalFixture {
	/** What the model is shown in the prompt — the hashes it must address. */
	shownBlocks: DocumentBlock[];
	/** What is ACTUALLY stored when the patch lands. Differs from `shownBlocks`
	 *  only for the "the user changed it after the model's read" case. */
	currentBlocks: DocumentBlock[];
	/** Case-specific pass/fail, given the real engine's outcome for this fixture. */
	verify: (result: PatchResult) => DocumentEvalVerification;
}

function block(id: string, text: string): DocumentBlock {
	return makeBlock(id, "paragraph", text);
}

function renderBlocksForPrompt(blocks: DocumentBlock[]): string {
	return blocks
		.map(
			(b) =>
				`- blockId: ${b.id}\n  hash: ${b.hash}\n  text: ${JSON.stringify(b.markdown)}`,
		)
		.join("\n");
}

const RESPONSE_FORMAT_INSTRUCTIONS = `Respond with ONLY a JSON array of patch ops, nothing else — no prose, no markdown code fence. Each op is one of:
  {"op":"replaceBlock","blockId":"...","baseHash":"...","text":"..."}
  {"op":"replaceRange","blockId":"...","baseHash":"...","find":"...","text":"..."}
  {"op":"toggleTask","blockId":"...","baseHash":"...","checked":true}
"baseHash" MUST be exactly the hash shown for that block above. If the request cannot be done safely (the block you would need is not listed, or the text you would replace is not unique), respond with an empty array [] instead of guessing.`;

function buildPrompt(params: {
	intro: string;
	blocks: DocumentBlock[];
	request: string;
}): string {
	return [
		params.intro,
		"",
		"Document blocks:",
		renderBlocksForPrompt(params.blocks),
		"",
		`User request: ${params.request}`,
		"",
		RESPONSE_FORMAT_INSTRUCTIONS,
	].join("\n");
}

function refusedCodes(result: PatchResult): string[] {
	return result.outcomes
		.filter((o) => o.status === "refused")
		.map((o) => o.code ?? "unknown");
}

// ---------------------------------------------------------------------------
// The six required scenarios (slice-1.md Task T13, Step 3).
// ---------------------------------------------------------------------------

const cleanBlocks = [block("p1", "Book the flight to Vienna.")];
const CLEAN_PATCH: DocumentEvalFixture = {
	shownBlocks: cleanBlocks,
	currentBlocks: cleanBlocks,
	verify(result) {
		if (result.applied === 1 && refusedCodes(result).length === 0) {
			return { ok: true, reasons: ["the one op applied cleanly"] };
		}
		return {
			ok: false,
			reasons: [
				`expected 1 applied op with no refusals, got applied=${result.applied} refused=${refusedCodes(result).join(",")}`,
			],
		};
	},
};

// Not one of the six named scenarios (slice-1.md Task T13, Step 3), but
// explicitly named by Step 1.1's scorer-level requirement: "a patch that
// refuses a non-existent block is good — refusing correctly is a pass, not
// a failure." A well-behaved model should never invent a blockId that was
// not in what it was shown, but the ENGINE'S OWN block_missing refusal is
// what actually protects the document if one ever does.
const missingBlockShown = [block("p1", "Book the flight to Vienna.")];
const REFUSES_MISSING_BLOCK: DocumentEvalFixture = {
	shownBlocks: missingBlockShown,
	currentBlocks: missingBlockShown,
	verify(result) {
		// [trap, found by a real live run] Two well-behaved answers exist here
		// too, same as AMBIGUOUS_FIND: a model that notices there is no
		// "packing list" block and sends [] has behaved exactly as safely as
		// one that invents a blockId the ENGINE then refuses block_missing.
		// The first live run against a real model scored this "bad" for a
		// clean [] answer before this fixed — a fixture bug the run exists to
		// catch, not a model failure (slice-1.md T13: "a weak result changes
		// the design").
		const codes = refusedCodes(result);
		const attemptedNothing = result.outcomes.length === 0;
		if (
			result.applied === 0 &&
			(attemptedNothing || codes.includes("block_missing"))
		) {
			return {
				ok: true,
				reasons: ["correctly avoided inventing a missing block"],
			};
		}
		return {
			ok: false,
			reasons: [
				`expected either an empty patch or a block_missing refusal, got applied=${result.applied} refused=${codes.join(",")}`,
			],
		};
	},
};

const staleShown = [block("p1", "Book the flight to Vienna.")];
// Same blockId, different content — the CURRENT hash differs from what the
// model was shown, exactly the "someone else edited it since" scenario.
const staleCurrent = [
	block("p1", "Book the flight to Vienna (already booked!)."),
];
const STALE_BLOCK: DocumentEvalFixture = {
	shownBlocks: staleShown,
	currentBlocks: staleCurrent,
	verify(result) {
		const codes = refusedCodes(result);
		if (result.applied === 0 && codes.includes("block_changed")) {
			return { ok: true, reasons: ["correctly refused block_changed"] };
		}
		return {
			ok: false,
			reasons: [
				`expected a block_changed refusal with nothing applied, got applied=${result.applied} refused=${codes.join(",")}`,
			],
		};
	},
};

const ambiguousBlocks = [
	block("p1", "Please book the hotel and then book the hotel shuttle."),
];
const AMBIGUOUS_FIND: DocumentEvalFixture = {
	shownBlocks: ambiguousBlocks,
	currentBlocks: ambiguousBlocks,
	verify(result) {
		// Two well-behaved answers exist, and both count as a pass: the prompt
		// itself tells the model to send [] rather than guess, so a model that
		// proactively sends no ops (nothing to apply OR refuse) is exactly as
		// correct as one that attempts a replaceRange the ENGINE then refuses
		// with find_ambiguous. Only an op that actually APPLIED against this
		// ambiguous text is the failure this case exists to catch.
		const codes = refusedCodes(result);
		const attemptedNothing = result.outcomes.length === 0;
		if (
			result.applied === 0 &&
			(attemptedNothing || codes.includes("find_ambiguous"))
		) {
			return {
				ok: true,
				reasons: ["correctly avoided guessing an ambiguous find"],
			};
		}
		return {
			ok: false,
			reasons: [
				`expected either an empty patch or a find_ambiguous refusal (the model must not guess which occurrence), got applied=${result.applied} refused=${codes.join(",")}`,
			],
		};
	},
};

const scopeBlocks = [
	block("p1", "Day one: museum in the morning."),
	block("p2", "Day two: hiking in the afternoon."),
];
const STAYS_IN_SCOPE: DocumentEvalFixture = {
	shownBlocks: scopeBlocks,
	currentBlocks: scopeBlocks,
	verify(result) {
		const p2Touched = result.outcomes.some(
			(o) => o.blockId === "p2" && o.status === "applied",
		);
		const p1Applied = result.outcomes.some(
			(o) => o.blockId === "p1" && o.status === "applied",
		);
		if (p1Applied && !p2Touched) {
			return { ok: true, reasons: ["only the requested block changed"] };
		}
		return {
			ok: false,
			reasons: [
				p2Touched
					? "the patch touched day two, which the request never mentioned"
					: "the requested block (day one) never applied",
			],
		};
	},
};

const multiOpBlocks = [
	block("p1", "Book the flight."),
	block("p2", "Book the hotel."),
	block("p3", "Pack the bags."),
];
const MULTI_OP_MIX: DocumentEvalFixture = {
	shownBlocks: multiOpBlocks,
	currentBlocks: multiOpBlocks,
	verify(result) {
		if (result.applied >= 2) {
			return {
				ok: true,
				reasons: [`applied ${result.applied} of 3 requested ops`],
			};
		}
		return {
			ok: false,
			reasons: [
				`expected at least 2 of the 3 requested edits to apply, got ${result.applied}`,
			],
		};
	},
};

const hungarianBlocks = [block("p1", "Foglald le a szállodát.")];
const HUNGARIAN_REQUEST: DocumentEvalFixture = {
	shownBlocks: hungarianBlocks,
	currentBlocks: hungarianBlocks,
	verify(result) {
		if (result.applied === 1 && refusedCodes(result).length === 0) {
			return { ok: true, reasons: ["applied the Hungarian request cleanly"] };
		}
		return {
			ok: false,
			reasons: [
				`expected the Hungarian request to apply cleanly, got applied=${result.applied} refused=${refusedCodes(result).join(",")}`,
			],
		};
	},
};

export const DOCUMENT_FIXTURES: Record<string, DocumentEvalFixture> = {
	"document-clean-patch": CLEAN_PATCH,
	"document-refuses-missing-block": REFUSES_MISSING_BLOCK,
	"document-stale-block-refused": STALE_BLOCK,
	"document-ambiguous-find-refused": AMBIGUOUS_FIND,
	"document-stays-in-scope": STAYS_IN_SCOPE,
	"document-multi-op-mix": MULTI_OP_MIX,
	"document-hungarian-request": HUNGARIAN_REQUEST,
	// Known-bad: a fixture the harness expects to FAIL, so the suite's gate can
	// be seen to work (ruling 25). The committed "response" for this id
	// (fixtures/document/responses/document-known-bad-ignores-json-format.json)
	// is a hand-written BAD answer — plain prose describing what the model
	// "did" instead of the required JSON ops array — which the scorer's own
	// parser (`parseDocumentPatchOpsFromModelResponse`) must reject as
	// unparseable, exactly the "an answer with no parseable ops is bad, not a
	// throw" case (slice-1.md T13 Step 1.1). `verify` below is never actually
	// reached for this case (the parse failure short-circuits first) — kept
	// only so this fixture satisfies the same shape as every other one.
	"document-known-bad-ignores-json-format": {
		shownBlocks: ambiguousBlocks,
		currentBlocks: ambiguousBlocks,
		verify() {
			return {
				ok: false,
				reasons: ["unreachable: the parse failure should score this bad first"],
			};
		},
	},
};

export const DOCUMENT_EVAL_CASES: EvalCase[] = [
	{
		id: "document-clean-patch",
		suite: "document",
		description: "A single unambiguous edit on one block applies cleanly.",
		prompt: buildPrompt({
			intro: "You are editing a shared trip-planning document.",
			blocks: CLEAN_PATCH.shownBlocks,
			request: "Change the flight destination to Budapest instead of Vienna.",
		}),
	},
	{
		id: "document-refuses-missing-block",
		suite: "document",
		description:
			"Step 1.1's scorer-level case: addressing a blockId that does not exist must refuse block_missing, not throw or silently no-op — refusing correctly is a pass.",
		prompt: buildPrompt({
			intro: "You are editing a shared trip-planning document.",
			blocks: REFUSES_MISSING_BLOCK.shownBlocks,
			request:
				'Change the "packing list" block to add sunscreen. (There is no packing list block below — if you cannot find it, do not invent a blockId.)',
		}),
	},
	{
		id: "document-stale-block-refused",
		suite: "document",
		description:
			"The block was changed by someone else after this view was taken — the model must refuse, not overwrite blind.",
		prompt: buildPrompt({
			intro:
				"You are editing a shared trip-planning document. IMPORTANT: the blocks below are what you last read — the document may have changed since.",
			blocks: STALE_BLOCK.shownBlocks,
			request: "Change the flight destination to Budapest instead of Vienna.",
		}),
	},
	{
		id: "document-ambiguous-find-refused",
		suite: "document",
		description:
			'A replaceRange whose "find" text occurs twice in the block — must refuse rather than guess which one.',
		prompt: buildPrompt({
			intro: "You are editing a shared trip-planning document.",
			blocks: AMBIGUOUS_FIND.shownBlocks,
			request: 'Change "book the hotel" to "confirm the hotel".',
		}),
	},
	{
		id: "document-stays-in-scope",
		suite: "document",
		description:
			"A request naming one day's plan must not touch the other day's block.",
		prompt: buildPrompt({
			intro: "You are editing a shared trip-planning document with two days.",
			blocks: STAYS_IN_SCOPE.shownBlocks,
			request:
				"Change day one's plan to an afternoon museum visit instead of the morning.",
		}),
	},
	{
		id: "document-multi-op-mix",
		suite: "document",
		description: "A request naming three separate small edits in one turn.",
		prompt: buildPrompt({
			intro: "You are editing a shared trip-planning document.",
			blocks: MULTI_OP_MIX.shownBlocks,
			request:
				"Change the flight to a train, change the hotel to an apartment, and change the bags line to mention passports too.",
		}),
	},
	{
		id: "document-hungarian-request",
		suite: "document",
		description:
			"The owner's language is not always English, and neither is the model's answer — a Hungarian request against a Hungarian document.",
		prompt: buildPrompt({
			intro: "Egy közösen szerkesztett úti terv dokumentumot szerkesztesz.",
			blocks: HUNGARIAN_REQUEST.shownBlocks,
			request: "Változtasd a szálloda lefoglalását a szálloda megerősítésére.",
		}),
	},
	{
		id: "document-known-bad-ignores-json-format",
		suite: "document",
		description:
			"Known-bad (ruling 25): a committed response that answers in prose instead of the required JSON ops array — the gate this suite exists to prove works.",
		knownBad: true,
		prompt: buildPrompt({
			intro: "You are editing a shared trip-planning document.",
			blocks: AMBIGUOUS_FIND.shownBlocks,
			request: 'Change "book the hotel" to "confirm the hotel".',
		}),
	},
];
