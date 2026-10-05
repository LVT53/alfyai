// A project's bundle: its files, and the Documents, Apps and Canvases its
// chats made (Slice 5b · T5). One list for the Files dialog, the project page's
// quiet line and the home cards, so the three can never count differently.
//
// An item is in the bundle one of two ways, and a person never has to tell:
//   - through its chat — it was made in a chat that is in the project. Nothing
//     is written for that: the membership is read off `conversations.project_id`
//     every time, so a chat moved into or out of the project takes its items
//     with it, and nothing goes stale;
//   - through a link — the reader added it from the library, the same
//     `project_knowledge_links` row a file uses. Unlinking removes that row
//     and deletes nothing.
//
// Every row is read through the ownership scope the rest of the family uses
// (`getArtifactOwnershipScope` + the canonical ownership condition), so an
// incognito chat's items, another user's items and a row whose chat is gone
// are not in the bundle by construction. A produced file stays a file
// (ruling 18) and Slides are not listed while none can exist (ruling 69).
import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { selectInBatches } from "$lib/server/db/id-batches";
import { artifacts, conversations, projects } from "$lib/server/db/schema";
import {
	listProjectKnowledge,
	listProjectLinks,
	type ProjectKnowledgeItem,
	sortProjectKnowledgeItems,
} from "$lib/server/services/knowledge";
import {
	buildArtifactCanonicalOwnershipCondition,
	getArtifactOwnershipScope,
} from "$lib/server/services/knowledge/store/core";
import { parseArtifactMetadata, titleForArtifactRow } from "./record";

/** The three kinds a bundle lists beside its files. */
const BUNDLE_KINDS: ReadonlySet<string> = new Set([
	"document",
	"app",
	"canvas",
]);

const bundleColumns = {
	id: artifacts.id,
	name: artifacts.name,
	type: artifacts.type,
	metadataJson: artifacts.metadataJson,
	conversationId: artifacts.conversationId,
	conversationTitle: conversations.title,
	createdAt: artifacts.createdAt,
} as const;

/**
 * The project's bundle, in the one order the project's files already use.
 *
 * `listProjectKnowledge` still answers the model's question — which FILES a
 * turn may read — and this builds the person's list on top of it. A caller that
 * is not the project's owner gets an empty list, as it does there.
 */
export async function listProjectBundle(params: {
	userId: string;
	projectId: string;
}): Promise<ProjectKnowledgeItem[]> {
	const { userId, projectId } = params;
	const [files, links, ownershipScope] = await Promise.all([
		listProjectKnowledge(params),
		listProjectLinks(params),
		getArtifactOwnershipScope(userId),
	]);
	const linkedAtById = new Map(
		links.map((link) => [link.artifactId, link.linkedAt]),
	);
	const ownership = buildArtifactCanonicalOwnershipCondition({
		userId,
		ownershipScope,
	});

	// The chats the project holds, as a subquery: a project can have hundreds,
	// and the membership is the project's own join, not a list to bind.
	const projectChatIds = db
		.select({ id: conversations.id })
		.from(conversations)
		.innerJoin(
			projects,
			and(
				eq(projects.id, conversations.projectId),
				eq(projects.userId, userId),
			),
		)
		.where(
			and(
				eq(conversations.userId, userId),
				eq(conversations.projectId, projectId),
			),
		);

	const [madeInChats, linked] = await Promise.all([
		db
			.select(bundleColumns)
			.from(artifacts)
			.leftJoin(conversations, eq(conversations.id, artifacts.conversationId))
			.where(
				and(
					eq(artifacts.type, "artifact"),
					inArray(artifacts.conversationId, projectChatIds),
					ownership,
				),
			),
		selectInBatches([...linkedAtById.keys()], (batch) =>
			db
				.select(bundleColumns)
				.from(artifacts)
				.leftJoin(conversations, eq(conversations.id, artifacts.conversationId))
				.where(
					and(
						eq(artifacts.type, "artifact"),
						inArray(artifacts.id, batch),
						ownership,
					),
				),
		),
	]);

	const items = new Map<string, ProjectKnowledgeItem>();
	for (const row of [...madeInChats, ...linked]) {
		if (items.has(row.id)) continue;
		const kind = parseArtifactMetadata(row.metadataJson)?.artifactType;
		if (!kind || !BUNDLE_KINDS.has(kind)) continue;
		items.set(row.id, {
			artifactId: row.id,
			name: titleForArtifactRow(row),
			mimeType: null,
			type: "artifact",
			// Not a meaningful number for something edited in place.
			sizeBytes: null,
			// A linked item is dated by its link, like a file; one that is here
			// through its chat has no link, so it is dated by when the chat made it.
			linkedAt:
				linkedAtById.get(row.id) ?? Math.floor(row.createdAt.getTime() / 1000),
			summary: null,
			artifactKind: kind,
			sourceConversationId: row.conversationId,
			sourceConversationTitle: row.conversationTitle,
			linked: linkedAtById.has(row.id),
		});
	}

	return sortProjectKnowledgeItems([...files, ...items.values()]);
}
