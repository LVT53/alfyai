// Regenerate for a deleted Document or App (polish G2-A): make it again from
// the arguments the model itself gave `create_artifact`, which the chat kept on
// the message that made it — under the id the chat's cards already carry, so
// the deleted state clears by itself and nothing else has to be rewritten.
//
// It reuses the tool's own `runCreateArtifactTool` and per-kind handlers, so
// the App comes back through the same generate → verify → write path (ruling
// 52) and inside the same budget (ruling 53): the caller hands in the signal
// (`create_artifact`'s own 120 s ceiling and the request's abort), a handler
// checks it before any write, and the per-turn cap does not apply because this
// is not a turn. One regeneration of one item runs at a time, so a double
// click cannot make it twice.

import { getArtifact } from "$lib/server/services/artifacts";
import { getConversation } from "$lib/server/services/conversations";
import { getStoredCreateArtifactCall } from "$lib/server/services/messages";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import {
	buildCreateArtifactInputSchema,
	runCreateArtifactTool,
} from "./create";

export type RecreateArtifactResult =
	| {
			ok: true;
			/** `false` when the item already exists (made again by an earlier call): nothing was written. */
			created: boolean;
			artifactId: string;
			kind: ArtifactKind;
			title: string;
	  }
	| {
			ok: false;
			/**
			 * `not_found`: not the caller's conversation (one answer for a missing chat
			 * and someone else's). `no_stored_input`: no successful create call of this
			 * chat names the item, or its arguments are no longer acceptable. `in_progress`:
			 * this item is already being made. `failed`: the kind's handler refused or the
			 * call was aborted; `detail` is its own model-safe reason.
			 */
			reason: "not_found" | "no_stored_input" | "in_progress" | "failed";
			detail?: string;
	  };

const regenerating = new Set<string>();

export async function recreateArtifactFromStoredCall(params: {
	userId: string;
	conversationId: string;
	artifactId: string;
	/** The reply language an App is made in (ruling 55): the caller's, since a regeneration is not a turn with one of its own. */
	language: "en" | "hu";
	abortSignal: AbortSignal;
}): Promise<RecreateArtifactResult> {
	const conversation = await getConversation(
		params.userId,
		params.conversationId,
	);
	if (!conversation) return { ok: false, reason: "not_found" };

	const key = `${params.conversationId}:${params.artifactId}`;
	if (regenerating.has(key)) return { ok: false, reason: "in_progress" };
	regenerating.add(key);
	try {
		const existing = await getArtifact({
			userId: params.userId,
			artifactId: params.artifactId,
			conversationId: params.conversationId,
		});
		if (existing) {
			return {
				ok: true,
				created: false,
				artifactId: existing.id,
				kind: existing.kind,
				title: existing.title,
			};
		}

		const stored = await getStoredCreateArtifactCall({
			conversationId: params.conversationId,
			artifactId: params.artifactId,
		});
		const input = stored
			? buildCreateArtifactInputSchema().safeParse(stored.input)
			: null;
		if (!input?.success) return { ok: false, reason: "no_stored_input" };

		const result = await runCreateArtifactTool({
			userId: params.userId,
			conversationId: params.conversationId,
			turnId: `regenerate:${params.artifactId}`,
			artifactType: input.data.artifactType,
			title: input.data.title,
			body: input.data.body,
			language: params.language,
			abortSignal: params.abortSignal,
			artifactId: params.artifactId,
		});
		if (!result.modelPayload.success) {
			return {
				ok: false,
				reason: "failed",
				detail: result.modelPayload.error,
			};
		}
		return {
			ok: true,
			created: true,
			artifactId: result.modelPayload.artifactId,
			kind: result.modelPayload.artifactType,
			title: result.modelPayload.title,
		};
	} finally {
		regenerating.delete(key);
	}
}
