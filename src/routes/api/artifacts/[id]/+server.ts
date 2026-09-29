import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	deleteArtifact,
	getArtifact,
	listComments,
	listVersions,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id] — one artifact's detail, its version history and
// its comment threads, all through the one scoped read (ruling 39: 401 comes
// from requireApiUser/hooks.server.ts, never a route-local check).
//
// One shape across the feature (ruling 49): success is
// { ok: true, artifact, versions, comments }, and the 404 body is
// { ok: false, reason: "not_found" } — never a 403, since a 403 confirms
// existence, and this route must answer the same way for a missing id,
// another user's artifact, or an incognito artifact read from outside its
// conversation.
//
// An optional `?conversationId=` names the conversation being served and is
// forwarded as `ArtifactScopeOptions.conversationId` to every read below. That
// widens the ownership scope by exactly one conversation — the caller's own,
// since `getArtifactOwnershipScope` (knowledge/store/core.ts) starts from
// `conversations.userId = caller`, so naming someone else's conversation, or
// a different one of the caller's own, reaches nothing new. Without it, an
// incognito conversation's own artifact 404s even for its owner: incognito
// hides a chat's work from the user's OTHER chats, never from itself.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!artifact) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const [versions, comments] = await Promise.all([
		listVersions({ userId: user.id, artifactId, conversationId }),
		listComments({ userId: user.id, artifactId, conversationId }),
	]);

	return json({ ok: true, artifact, versions, comments });
};

// DELETE /api/artifacts/[id] — remove an item for good. The same scope as the
// read above: `?conversationId=` names the served conversation (the only way
// an incognito chat's own item can be reached, and only by its owner), and a
// foreign id, a missing id and an already-deleted id all answer the one 404
// body — never a 403, which would confirm the row exists. Success is
// `{ ok: true }` (ruling 49). What hangs off the item (versions, comments,
// stored values, links, embedding) goes with it inside `deleteArtifact`.
//
// A delete that names a conversation acts only on what THAT conversation made:
// a fork's panel can open its parent's Document (a normal chat the same user
// can read) but not delete it. That one answers 409 `not_made_here` — only
// ever for an item the caller can already read, since it is decided after the
// scoped read that answers everything else with the plain 404.
export const DELETE: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const result = await deleteArtifact({
		userId: user.id,
		artifactId: event.params.id,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!result.ok) {
		return result.reason === "not_made_here"
			? json({ ok: false, reason: "not_made_here" }, { status: 409 })
			: json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return json({ ok: true });
};
