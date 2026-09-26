// An App's edit path (Feature 2 · Artifacts, Slice 2): regeneration, never a
// patch — an App is generated code, not addressable blocks. The generate+
// verify pipeline itself is shared with the `create_artifact` tool's App
// handler (Task A7, `./create.ts`) through `generate-and-verify.ts`: nothing
// about generation or verification forks per caller, only what happens to
// the html afterward (this file updates an existing artifact's body;
// `create.ts` writes a brand-new one).
import type { ModelId } from "$lib/model-types";
import { getArtifact, updateArtifactBody } from "../record";
import type { ArtifactScopeOptions } from "../types";
import type { AppGenerationFailureReason } from "./generate";
import {
	type AppMetadataVerification,
	generateAndVerifyApp,
	maybeRecordAppVerificationComment,
} from "./generate-and-verify";

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
			verification: AppMetadataVerification;
	  }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "version_conflict"; version: number }
	| { ok: false; reason: AppGenerationFailureReason; detail: string };

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

	const outcome = await generateAndVerifyApp({
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
	if (!outcome.ok) {
		return { ok: false, reason: outcome.reason, detail: outcome.detail };
	}
	const { html, glitchRuleIds, verification, findings } = outcome.value;

	const written = await updateArtifactBody({
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		includeIncognito: input.includeIncognito,
		body: html,
		author: "alfy",
		summary: `Alfy regenerated the app: ${input.prompt}`,
		metadataPatch: { glitchRuleIds, verification },
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

	await maybeRecordAppVerificationComment({
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		includeIncognito: input.includeIncognito,
		verification,
		findings,
	});

	return {
		ok: true,
		// updateArtifactBody always appends exactly one version (record.ts);
		// re-deriving from what was already read avoids a second round trip.
		version: current.versionNumber + 1,
		title: current.title,
		verification,
	};
}
