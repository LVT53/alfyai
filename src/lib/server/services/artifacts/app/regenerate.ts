// An App's edit path (Feature 2 · Artifacts, Slice 2): regeneration, never a
// patch — an App is generated code, not addressable blocks. The generate+
// verify pipeline itself is shared with the `create_artifact` tool's App
// handler (Task A7, `./create.ts`) through `generate-and-verify.ts`: nothing
// about generation or verification forks per caller, only what happens to
// the html afterward (this file updates an existing artifact's body;
// `create.ts` writes a brand-new one).
import type { ModelId } from "$lib/model-types";
import { regeneratedAppSummary } from "$lib/shared/artifacts/version-summaries";
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
			/** The version row this call wrote: the chat tool puts it on its call's record (ruling 76). */
			versionId: string;
			title: string;
			verification: AppMetadataVerification;
	  }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "version_conflict"; version: number }
	| { ok: false; reason: AppGenerationFailureReason; detail: string }
	| { ok: false; reason: "aborted"; detail: string };

/**
 * Runs the App contract's generation + verification pipeline against an
 * EXISTING artifact and, on success, writes the result as a new version.
 * Nothing is written until both calls have finished — "verified before the
 * card appears" (spec §2.10) applies to a regeneration exactly as it does to
 * the first draft.
 *
 * Abort-aware exactly like `createAppFromBrief` (ruling 53): checked before
 * generation starts AND again after generation/verification finish, before
 * `updateArtifactBody`. Generation and verification can together take tens of
 * seconds (Task A7's own arithmetic — up to ~113s with a repair), and a
 * caller whose own request was cancelled in that window (the panel's fetch
 * aborted, the tab closed) must not have a version written after the fact:
 * the caller already moved on, and a write past that point is an orphan
 * nobody asked for, or a duplicate if the user simply retried.
 */
export async function regenerateApp(
	input: RegenerateAppInput & ArtifactScopeOptions,
): Promise<RegenerateAppResult> {
	if (input.abortSignal?.aborted) {
		return { ok: false, reason: "aborted", detail: "the call was aborted" };
	}

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
		// The change is made to the app that exists (F2, ruling 77): the generator
		// is handed it, and the prompt is only what to change. Without it a
		// request like "make the background dark" came back as another app.
		currentHtml: current.body ?? undefined,
		modelId: input.modelId,
		abortSignal: input.abortSignal,
	});
	if (!outcome.ok) {
		return { ok: false, reason: outcome.reason, detail: outcome.detail };
	}

	if (input.abortSignal?.aborted) {
		// Generation and verification both finished, but the caller already
		// gave up on this call — never write a version past that point
		// (ruling 53, the same rule createAppFromBrief applies).
		return { ok: false, reason: "aborted", detail: "the call was aborted" };
	}

	const { html, glitchRuleIds, verification, findings } = outcome.value;

	const written = await updateArtifactBody({
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		includeIncognito: input.includeIncognito,
		body: html,
		author: "alfy",
		summary: regeneratedAppSummary(input.prompt),
		metadataPatch: { glitchRuleIds, verification },
		// Written on top of the version this call read and generated from: a write
		// that landed meanwhile (the panel's own rebuild, a restore, a second call
		// of the same turn) is refused rather than silently stacked under this one.
		expectVersion: current.versionNumber,
	});
	if (!written.ok) {
		// The artifact vanished, or a concurrent write already moved the
		// version past what we read at the top of this call — either way, the
		// caller's own version guard is the honest reason to report, with the
		// version that is current now.
		const now = await getArtifact({
			userId: input.userId,
			artifactId: input.artifactId,
			conversationId: input.conversationId,
			includeIncognito: input.includeIncognito,
		});
		return {
			ok: false,
			reason: "version_conflict",
			version: now?.versionNumber ?? current.versionNumber,
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
		// updateArtifactBody appends exactly one version (record.ts) and says which.
		version: written.versionNumber,
		versionId: written.versionId,
		title: current.title,
		verification,
	};
}
