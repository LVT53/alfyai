// An App's edit path (Feature 2 · Artifacts, Slice 2): regeneration, never a
// patch — an App is generated code, not addressable blocks. One
// implementation shared by the panel's route and the `create_artifact`
// tool's App branch (once Slice 5a lands): nothing about the pipeline forks
// per caller.
import type { ModelId } from "$lib/model-types";
import { createComment } from "../comments";
import { getArtifact, updateArtifactBody } from "../record";
import type { ArtifactScopeOptions } from "../types";
import type { AppGenerationFailureReason } from "./generate";
import { generateApp } from "./generate";
import type { AppVerificationVerdict } from "./verify";
import { verifyApp } from "./verify";

export interface RegenerateAppInput {
	userId: string;
	artifactId: string;
	prompt: string;
	language: "en" | "hu";
	/** Slice 1's optimistic guard — the version the caller last saw. */
	expectVersion?: number;
	modelId?: ModelId;
	abortSignal?: AbortSignal;
}

export type RegenerateAppResult =
	| {
			ok: true;
			version: number;
			title: string;
			verification: {
				checked: boolean;
				verdict: AppVerificationVerdict;
				reason: string | null;
			};
	  }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "version_conflict"; version: number }
	| { ok: false; reason: AppGenerationFailureReason; detail: string };

/**
 * The persisted summary an App's metadata carries (Task A6's read side).
 * Deliberately small: findings live in the Alfy comment, not duplicated
 * here, and `repairedHtml`/`usage` are spent the moment this function
 * returns.
 */
interface AppMetadataVerification {
	checked: boolean;
	verdict: AppVerificationVerdict;
	reason: string | null;
}

/**
 * Comments anchor to a block, a canvas node or a point (`Anchor`) — none of
 * which describes "a note about the whole app". `{ kind: "node", nodeId:
 * "app" }` is a deliberate, documented sentinel: AppBody.svelte never reads
 * or renders the anchor field for an App's comment (it finds the root
 * `author: "alfy"` comment directly), so the shape only has to be valid
 * enough for `createComment` to accept a root comment, never meaningful on
 * its own.
 */
const APP_COMMENT_ANCHOR = { kind: "node" as const, nodeId: "app" };

function summarizeFindingsForComment(
	findings: Array<{ claim: string; problem: string }>,
): string {
	return findings
		.map((finding) => `${finding.claim}: ${finding.problem}`)
		.join("\n\n");
}

/**
 * Runs the App contract's generation + verification pipeline against an
 * EXISTING artifact and, on success, writes the result as a new version.
 * Nothing is written until both calls have finished — "verified before the
 * card appears" (spec §2.10) applies to a regeneration exactly as it does to
 * the first draft.
 */
export async function regenerateApp(
	input: RegenerateAppInput & ArtifactScopeOptions,
): Promise<RegenerateAppResult> {
	const current = await getArtifact({
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		includeIncognito: input.includeIncognito,
	});
	if (!current || current.kind !== "app") {
		return { ok: false, reason: "not_found" };
	}
	if (
		input.expectVersion !== undefined &&
		input.expectVersion !== current.versionNumber
	) {
		return {
			ok: false,
			reason: "version_conflict",
			version: current.versionNumber,
		};
	}

	const generation = await generateApp({
		userId: input.userId,
		conversationId: current.conversationId,
		prompt: input.prompt,
		language: input.language,
		// The title stays what it already was — regeneration has no field for
		// the user to rename it through; only the app's own <title>/<h1> could
		// change it, and this call keeps the existing one deliberately.
		title: current.title,
		modelId: input.modelId,
		abortSignal: input.abortSignal,
	});
	if (!generation.ok) {
		return { ok: false, reason: generation.reason, detail: generation.detail };
	}

	const verification = await verifyApp({
		userId: input.userId,
		conversationId: current.conversationId,
		html: generation.html,
		prompt: input.prompt,
		language: input.language,
		abortSignal: input.abortSignal,
	});

	const finalHtml =
		verification.verdict === "repaired" && verification.repairedHtml
			? verification.repairedHtml
			: generation.html;
	const glitchRuleIds = generation.checks
		.filter((check) => check.severity === "glitch" && !check.passed)
		.map((check) => check.rule);
	const metadataVerification: AppMetadataVerification = {
		checked: verification.checked,
		verdict: verification.verdict,
		reason: verification.reason,
	};

	const written = await updateArtifactBody({
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		includeIncognito: input.includeIncognito,
		body: finalHtml,
		author: "alfy",
		summary: `Alfy regenerated the app: ${input.prompt}`,
		metadataPatch: { glitchRuleIds, verification: metadataVerification },
	});
	if (!written.ok) {
		// The artifact vanished, or a concurrent write already moved the
		// version past what we read at the top of this call — either way, the
		// caller's own version guard is the honest reason to report.
		return {
			ok: false,
			reason: "version_conflict",
			version: current.versionNumber,
		};
	}

	// One comment per verification pass (Contracts), never one per finding.
	if (
		(verification.verdict === "uncertain" ||
			verification.verdict === "repaired") &&
		verification.findings.length > 0
	) {
		await createComment({
			userId: input.userId,
			artifactId: input.artifactId,
			conversationId: input.conversationId,
			includeIncognito: input.includeIncognito,
			anchor: APP_COMMENT_ANCHOR,
			author: "alfy",
			body: summarizeFindingsForComment(verification.findings),
		});
	}

	return {
		ok: true,
		// updateArtifactBody always appends exactly one version (record.ts);
		// re-deriving from what was already read avoids a second round trip.
		version: current.versionNumber + 1,
		title: current.title,
		verification: metadataVerification,
	};
}
