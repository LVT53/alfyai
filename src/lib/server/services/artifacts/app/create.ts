// The App's create_artifact path (Feature 2 · Artifacts, Slice 2, Task A7):
// turns the model's brief into a brand-new App artifact. The thin adapter
// registered as `CREATE_ARTIFACT_HANDLERS.app`
// (`normal-chat-tools/artifact-tools/create.ts`) calls this and nothing
// else — the substantive generate→verify→persist logic lives here, mirroring
// how the panel's regenerate ROUTE is a thin adapter over `regenerate.ts`.
//
// The tool's `body` field is the model's BRIEF (what to build), never literal
// HTML the model wrote itself: the App contract forbids the CHAT model from
// producing the actual markup (spec §2.9/§2.11 — thinking off, a dedicated
// system prompt, no tools), so this handler treats `body` purely as the
// generation prompt and discards nothing the model "wrote" as HTML, because
// there is no such HTML to discard — `generateAndVerifyApp` is the only
// thing that ever produces it.
import type { ModelId } from "$lib/model-types";
import { createArtifact } from "../record";
import type { AppGenerationFailureReason } from "./generate";
import {
	type AppMetadataVerification,
	generateAndVerifyApp,
	maybeRecordAppVerificationComment,
} from "./generate-and-verify";

export interface CreateAppInput {
	userId: string;
	/** create_artifact is always called from within a turn, so this is never null (unlike the App's own conversationId, which CAN be null for a project-linked App — that only happens through the panel's regenerate path, never through this tool). */
	conversationId: string;
	/** The model's brief — what to build, not literal HTML (see the file header). */
	prompt: string;
	/** The model's own title (create_artifact's `title` field is required) — wins over anything `generateApp` would derive from the html. */
	title: string;
	/**
	 * The turn's own resolved reply language (ruling 55) — `CreateArtifactHandlerParams.language`,
	 * carried here unchanged. NOT re-detected from `prompt`: `detectLanguage`
	 * read an English brief full of Hungarian-looking letter pairs as
	 * Hungarian, which is exactly the per-message heuristic Wave 0 retired
	 * from the chat path for the same reason.
	 */
	language: "en" | "hu";
	modelId?: ModelId;
	abortSignal?: AbortSignal;
}

export type CreateAppResult =
	| {
			ok: true;
			artifactId: string;
			title: string;
			verification: AppMetadataVerification;
	  }
	| { ok: false; reason: AppGenerationFailureReason; detail: string }
	| { ok: false; reason: "aborted"; detail: string }
	| { ok: false; reason: "not_saved"; detail: string };

/**
 * Runs generation + verification, then writes the result as a brand-new App
 * artifact — nothing is written until verification has finished ("verified
 * before the card appears", spec §2.10) and nothing is written if the
 * envelope's abort signal has already fired by the time generation and
 * verification are done (ruling 53): the model was already told the call
 * failed once the timeout/stop fires, so a write past that point would be an
 * orphan the user never asked for, and a duplicate when the model retries.
 */
export async function createAppFromBrief(
	input: CreateAppInput,
): Promise<CreateAppResult> {
	if (input.abortSignal?.aborted) {
		return { ok: false, reason: "aborted", detail: "the call was aborted" };
	}

	const outcome = await generateAndVerifyApp({
		userId: input.userId,
		conversationId: input.conversationId,
		prompt: input.prompt,
		language: input.language,
		title: input.title,
		modelId: input.modelId,
		abortSignal: input.abortSignal,
	});
	if (!outcome.ok) {
		return { ok: false, reason: outcome.reason, detail: outcome.detail };
	}

	if (input.abortSignal?.aborted) {
		// Generation and verification both finished, but the envelope already
		// gave up on this call — never write a version the model was told
		// failed (ruling 53).
		return { ok: false, reason: "aborted", detail: "the call was aborted" };
	}

	const { html, title, glitchRuleIds, verification, findings } = outcome.value;

	const created = await createArtifact({
		userId: input.userId,
		conversationId: input.conversationId,
		kind: "app",
		title,
		body: html,
		author: "alfy",
		versionSummary: `Alfy made the app: ${input.prompt}`,
		metadata: { glitchRuleIds, verification },
	});
	if (!created.ok) {
		return {
			ok: false,
			reason: "not_saved",
			detail: `could not save the app (${created.reason})`,
		};
	}

	// One comment per verification pass (Contracts), never one per finding —
	// only after the artifact exists, since a comment needs a real artifactId.
	await maybeRecordAppVerificationComment({
		userId: input.userId,
		artifactId: created.artifact.id,
		conversationId: input.conversationId,
		verification,
		findings,
	});

	return {
		ok: true,
		artifactId: created.artifact.id,
		title,
		verification,
	};
}
