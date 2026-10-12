import type {
	ChatMessage,
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";
import { isShippedArtifactKind, type ShippedArtifactKind } from "./kinds";

// What the messages a chat holds say about the artifacts their own tool calls
// made or edited. Pure, so the server (`conversation-detail/read-model.ts`, on
// the messages it has persisted) and the chat page (on the messages it holds
// live, including the turn that is still running and has no persisted row yet)
// read them one way.

interface ArtifactCall {
	name: "create_artifact" | "edit_artifact";
	artifactId: string;
	input: Record<string, unknown>;
}

/**
 * What a `create_artifact` / `edit_artifact` call made or changed, when it did:
 * the one reading of "this call is about that item", for a stored thinking
 * segment and a live tool-call entry alike (the turn's own finished calls, from
 * which the Sources panel's "Made in this chat" group is built). A refused or
 * failed call, a call that named no item and every other tool are `null`.
 */
export function artifactCallOf(
	call: Pick<ToolCallEntry, "name" | "status" | "input" | "metadata">,
): ArtifactCall | null {
	if (call.name !== "create_artifact" && call.name !== "edit_artifact")
		return null;
	if (call.status === "failed" || call.metadata?.ok === false) return null;
	const artifactId = call.metadata?.artifactId;
	if (typeof artifactId !== "string" || artifactId.length === 0) return null;
	return { name: call.name, artifactId, input: call.input ?? {} };
}

/**
 * The successful `create_artifact` / `edit_artifact` calls in a list of
 * thinking segments: the one record of which artifact a chat card is about
 * and (for a create) of the model's own arguments. A refused call, a call
 * that named no artifact and every other tool are left out.
 */
export function artifactCallsFromSegments(
	segments: readonly ThinkingSegment[] | undefined,
): ArtifactCall[] {
	const calls: ArtifactCall[] = [];
	for (const segment of segments ?? []) {
		if (segment.type !== "tool_call") continue;
		const call = artifactCallOf(segment);
		if (call) calls.push(call);
	}
	return calls;
}

/**
 * The ids of the artifacts these messages' own tool calls made or edited,
 * each once, in the order first seen — read off the messages the caller
 * already holds, so it costs no query. Whether they still exist is the
 * artifact service's to say (`listMissingArtifactIds`): that is how a chat
 * card learns its item was deleted.
 */
export function artifactCallIdsFromMessages(
	messageList: ReadonlyArray<Pick<ChatMessage, "thinkingSegments">>,
): string[] {
	const ids = new Set<string>();
	for (const message of messageList) {
		for (const call of artifactCallsFromSegments(message.thinkingSegments)) {
			ids.add(call.artifactId);
		}
	}
	return [...ids];
}

/**
 * Which message made which version of which artifact, read off the messages the
 * caller already holds: the successful create/edit calls whose record names the
 * version they wrote (`metadata.versionId`). It is what lets History's "From the
 * chat" scroll to the message behind an Alfy moment, and say nothing for a
 * version no loaded message made (another chat's, an older record). Artifact id
 * to version id to message id.
 */
export function artifactVersionMessagesFromMessages(
	messageList: ReadonlyArray<Pick<ChatMessage, "id" | "thinkingSegments">>,
): Map<string, Map<string, string>> {
	const map = new Map<string, Map<string, string>>();
	for (const message of messageList) {
		for (const segment of message.thinkingSegments ?? []) {
			if (segment.type !== "tool_call") continue;
			const call = artifactCallOf(segment);
			const versionId = segment.metadata?.versionId;
			if (!call || typeof versionId !== "string" || versionId === "") continue;
			let versions = map.get(call.artifactId);
			if (!versions) {
				versions = new Map();
				map.set(call.artifactId, versions);
			}
			versions.set(versionId, message.id);
		}
	}
	return map;
}

/**
 * The ids of the artifacts these messages can make again — read off the
 * messages the caller already holds, so it costs no query: the ones a
 * successful `create_artifact` call made (Regenerate makes them again from the
 * model's own arguments; an edit never counts, it holds a summary, not the
 * item) and the Document a message was kept as (pressing "Open as document"
 * again makes it from the message). Each once, in the order first seen. It is
 * what lets the delete confirm promise "you can regenerate it from the chat"
 * only for an item the chat really can make again.
 */
export function regenerableArtifactIdsFromMessages(
	messageList: ReadonlyArray<
		Pick<ChatMessage, "thinkingSegments" | "documentArtifactId">
	>,
): string[] {
	const ids = new Set<string>();
	for (const message of messageList) {
		for (const call of artifactCallsFromSegments(message.thinkingSegments)) {
			if (call.name === "create_artifact") ids.add(call.artifactId);
		}
		if (message.documentArtifactId) ids.add(message.documentArtifactId);
	}
	return [...ids];
}

/**
 * The kind and the title the chat's own successful `create_artifact` call gave an
 * item, read off the messages the caller already holds: what a row that stands for
 * the item before it exists again can say (Regenerate, FB-5 F29: the panel's list
 * shows the item being made while its card's button shows the work). `null` for an
 * item no create call of these messages made (an edit never counts: it holds a
 * summary, not the item), or one whose arguments name no title or no kind that
 * ships.
 */
export function createdArtifactOf(
	messageList: ReadonlyArray<Pick<ChatMessage, "thinkingSegments">>,
	artifactId: string,
): { kind: ShippedArtifactKind; title: string } | null {
	for (const message of messageList) {
		for (const call of artifactCallsFromSegments(message.thinkingSegments)) {
			if (call.name !== "create_artifact" || call.artifactId !== artifactId) {
				continue;
			}
			const { artifactType, title } = call.input;
			if (
				isShippedArtifactKind(artifactType) &&
				typeof title === "string" &&
				title.trim() !== ""
			) {
				return { kind: artifactType, title: title.trim() };
			}
		}
	}
	return null;
}

/**
 * The artifact rows with the ones in `ids` marked `regenerable` — the one place
 * a row gets that mark, whichever messages, jobs or live turn said so. Returns
 * the very array it was given when nothing changes, so a caller re-deriving it
 * hands its own dependents no new references.
 */
export function markRegenerable<T extends { id: string; regenerable?: true }>(
	rows: T[],
	ids: ReadonlySet<string>,
): T[] {
	if (!rows.some((row) => ids.has(row.id) && row.regenerable !== true)) {
		return rows;
	}
	return rows.map((row) =>
		ids.has(row.id) && row.regenerable !== true
			? { ...row, regenerable: true as const }
			: row,
	);
}
