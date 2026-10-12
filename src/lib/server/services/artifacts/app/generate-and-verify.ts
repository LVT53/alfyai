// The shared generate+verify pipeline for the App kind (Feature 2 ·
// Artifacts, Slice 2): one generation call (generate.ts, thinking off), then
// one verification pass (verify.ts) that may repair once and re-verify the
// repair (ruling 52). Used by BOTH `regenerateApp` (an existing artifact's
// new version) and the `create_artifact` tool's App handler (a brand-new
// artifact, Task A7) — nothing about generation or verification forks per
// caller; only what happens to the html AFTERWARD (createArtifact vs
// updateArtifactBody) does, which is why this module writes nothing itself.
import type { ModelId } from "$lib/model-types";
import { createComment } from "../comments";
import type { ArtifactScopeOptions } from "../types";
import { appViolations, glitchRuleIdsOf } from "./audit";
import type { AppContractRuleId } from "./contract";
import type { AppGenerationFailureReason } from "./generate";
import { generateApp } from "./generate";
import type { AppVerificationFinding, AppVerificationVerdict } from "./verify";
import { verifyApp } from "./verify";

/**
 * The persisted summary an App's metadata carries (Task A6's read side).
 * Deliberately small: findings live in the Alfy comment, not duplicated
 * here, and `repairedHtml`/`usage` are spent the moment this pipeline
 * returns.
 */
export interface AppMetadataVerification {
	checked: boolean;
	verdict: AppVerificationVerdict;
	reason: string | null;
}

export interface GenerateAndVerifyAppResult {
	/** The verified html — the repair, when one was accepted, else the original. */
	html: string;
	title: string;
	glitchRuleIds: AppContractRuleId[];
	verification: AppMetadataVerification;
	findings: AppVerificationFinding[];
}

export type GenerateAndVerifyAppOutcome =
	| { ok: true; value: GenerateAndVerifyAppResult }
	| { ok: false; reason: AppGenerationFailureReason; detail: string };

export interface GenerateAndVerifyAppParams {
	userId: string;
	conversationId: string | null;
	/** The brief: what to build. Generation's whole prompt (spec §2.11 — no chat history, nothing else from the session). */
	prompt: string;
	language: "en" | "hu";
	/** When the caller already knows it (a regeneration keeps the old title unless the app's own `<title>`/`<h1>` changes it). */
	title?: string | null;
	/** A change to an App that exists: the app as it is now, with `prompt` as the change (see `AppGenerationRequest.currentHtml`). */
	currentHtml?: string;
	modelId?: ModelId;
	abortSignal?: AbortSignal;
}

/**
 * Runs generation then verification and decides the final html — never
 * writes anything (no `createArtifact`, no `updateArtifactBody`, no
 * comment): the caller decides how and where to persist. "Verified before
 * the card appears" (spec §2.10) holds for both callers because neither one
 * persists before this returns `ok: true`.
 */
export async function generateAndVerifyApp(
	params: GenerateAndVerifyAppParams,
): Promise<GenerateAndVerifyAppOutcome> {
	const generation = await generateApp({
		userId: params.userId,
		conversationId: params.conversationId,
		prompt: params.prompt,
		language: params.language,
		title: params.title,
		currentHtml: params.currentHtml,
		modelId: params.modelId,
		abortSignal: params.abortSignal,
	});
	if (!generation.ok) {
		return { ok: false, reason: generation.reason, detail: generation.detail };
	}

	const verification = await verifyApp({
		userId: params.userId,
		conversationId: params.conversationId,
		html: generation.html,
		prompt: params.prompt,
		language: params.language,
		abortSignal: params.abortSignal,
	});

	// Ruling 58: `generateApp` audited the document it generated (a violation is
	// retried once, then refused), but a repair is a SECOND document the model wrote
	// after that audit, and it is the one that becomes the App's body. It is audited
	// the same way. A repair that sends the document away or opens a WebRTC channel
	// is refused like any other refused repair (`verifyApp`'s own shape for one: the
	// findings stay for Alfy's note, the verdict is "uncertain", and the original,
	// audited document ships).
	const repair =
		verification.verdict === "repaired" ? verification.repairedHtml : null;
	const repairRuns = repair !== null && appViolations(repair).length === 0;
	const finalHtml = repairRuns ? repair : generation.html;
	const verdict =
		repair !== null && !repairRuns ? "uncertain" : verification.verdict;
	const glitchRuleIds = glitchRuleIdsOf(generation.checks);

	return {
		ok: true,
		value: {
			html: finalHtml,
			title: generation.title,
			glitchRuleIds,
			verification: {
				checked: verification.checked,
				verdict,
				reason: verification.reason,
			},
			findings: verification.findings,
		},
	};
}

/**
 * Comments anchor to a block, a canvas node or a point (`Anchor`) — none of
 * which describes "a note about the whole app". `{ kind: "node", nodeId:
 * "app" }` is a deliberate, documented sentinel: `AppBody.svelte` never reads
 * or renders the anchor field for an App's comment (it finds the root
 * `author: "alfy"` comment directly), so the shape only has to be valid
 * enough for `createComment` to accept a root comment, never meaningful on
 * its own.
 */
export const APP_COMMENT_ANCHOR = { kind: "node" as const, nodeId: "app" };

function summarizeFindingsForComment(
	findings: Array<{ claim: string; problem: string }>,
): string {
	return findings
		.map((finding) => `${finding.claim}: ${finding.problem}`)
		.join("\n\n");
}

/**
 * Writes Alfy's one comment for a verification pass (Contracts table) — never
 * one per finding — when the verdict is `uncertain` or `repaired` and there
 * is something to quote. A no-op otherwise (`clean`/`unavailable`, or no
 * findings), so every caller can call this unconditionally after persisting.
 */
export async function maybeRecordAppVerificationComment(
	params: {
		userId: string;
		artifactId: string;
		verification: AppMetadataVerification;
		findings: AppVerificationFinding[];
	} & ArtifactScopeOptions,
): Promise<void> {
	if (
		(params.verification.verdict !== "uncertain" &&
			params.verification.verdict !== "repaired") ||
		params.findings.length === 0
	) {
		return;
	}
	await createComment({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		anchor: APP_COMMENT_ANCHOR,
		author: "alfy",
		body: summarizeFindingsForComment(params.findings),
	});
}
