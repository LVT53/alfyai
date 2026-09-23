// Atlas v3 Local Sources: the user's own documents as evidence (ADR 0063,
// Phase C of the v3-only consolidation; ADR 0036 branch 6 as amended).
//
// Which documents: the kickoff message's explicit attachments, the linked
// sources snapshotted onto that message, and (from Phase D) the documents a
// parent job read. NOT the automatic working set: a citable evidence bank holds
// only what the user chose.
//
// Everything goes through the knowledge boundary. Each document must also be
// canonically owned under the STRICT scope of the job's conversation — the
// conversation's own work plus every non-incognito conversation — so a linked
// source whose original chat has since gone incognito is refused here rather
// than quoted into a report in another chat.
//
// Nothing here reads a stored file. Passages are chosen by the same ranking the
// pull-side document tool uses (`selectDocumentPassages`), over chunks the
// knowledge store already holds.

import {
	getArtifactOwnershipScope,
	getArtifactsForUser,
	isArtifactCanonicallyOwned,
	resolvePromptAttachmentArtifacts,
} from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { listMessageArtifactLinks } from "$lib/server/services/linked-context-sources";
import { selectDocumentPassages } from "$lib/server/services/task-state/artifacts";
import {
	ATLAS_V3_LOCAL_CORE_PASSAGES,
	ATLAS_V3_LOCAL_PASSAGE_CHAR_BUDGET,
	ATLAS_V3_LOCAL_SUB_QUESTION_PASSAGES,
} from "./config";
import { ATLAS_V3_LOCAL_PASSAGE_SEPARATOR } from "./evidence-bank";
import type { AtlasV3LocalSource } from "./types";

export interface AtlasV3LocalDocument {
	/** The artifact the user sees: the upload, or the linked library row. */
	displayArtifactId: string;
	/** The text-bearing artifact passages are read from (normalized document). */
	promptArtifactId: string;
	title: string;
	origin: AtlasV3LocalSource["origin"];
	summary: string | null;
}

export interface AtlasV3LocalPassage {
	text: string;
	chunkIndex: number;
	pageStart: number | null;
	pageEnd: number | null;
}

export type AtlasV3LocalUnavailableReason =
	| "not_found"
	| "out_of_scope"
	| "no_text";

export interface AtlasV3LocalUnavailable {
	displayArtifactId: string;
	title: string | null;
	origin: AtlasV3LocalSource["origin"];
	reason: AtlasV3LocalUnavailableReason;
}

export interface AtlasV3LocalSources {
	resolve(input: {
		userId: string;
		conversationId: string;
		kickoffUserMessageId: string | null;
		inheritedDisplayArtifactIds?: string[];
	}): Promise<{
		documents: AtlasV3LocalDocument[];
		unavailable: AtlasV3LocalUnavailable[];
	}>;
	passages(input: {
		userId: string;
		document: AtlasV3LocalDocument;
		goals: string[];
		maxChars: number;
	}): Promise<AtlasV3LocalPassage[]>;
}

type OwnershipScope = Awaited<ReturnType<typeof getArtifactOwnershipScope>>;

function hasText(artifact: Artifact): boolean {
	return Boolean(artifact.contentText?.trim());
}

/**
 * Resolves display ids to documents through `resolvePromptAttachmentArtifacts`
 * — the attachment path chat itself uses — which maps an uploaded source to
 * its normalized text and reports readiness. Used for attachments and for
 * inherited sources, which are both known only by their display id.
 */
async function resolveThroughAttachments(input: {
	userId: string;
	displayArtifactIds: string[];
	origin: AtlasV3LocalSource["origin"];
	ownershipScope: OwnershipScope;
}): Promise<{
	documents: AtlasV3LocalDocument[];
	unavailable: AtlasV3LocalUnavailable[];
}> {
	const documents: AtlasV3LocalDocument[] = [];
	const unavailable: AtlasV3LocalUnavailable[] = [];
	if (input.displayArtifactIds.length === 0) return { documents, unavailable };
	const resolved = await resolvePromptAttachmentArtifacts(
		input.userId,
		input.displayArtifactIds,
	);
	for (const item of resolved.items) {
		const display = item.displayArtifact;
		if (!display) {
			unavailable.push({
				displayArtifactId: item.requestedArtifactId,
				title: null,
				origin: input.origin,
				reason: "not_found",
			});
			continue;
		}
		const prompt = item.promptArtifact;
		const owned = (artifact: Artifact) =>
			isArtifactCanonicallyOwned({
				userId: input.userId,
				ownershipScope: input.ownershipScope,
				artifact,
			});
		if (!owned(display) || (prompt && !owned(prompt))) {
			unavailable.push({
				displayArtifactId: display.id,
				title: display.name,
				origin: input.origin,
				reason: "out_of_scope",
			});
			continue;
		}
		if (!prompt || !item.promptReady || !hasText(prompt)) {
			unavailable.push({
				displayArtifactId: display.id,
				title: display.name,
				origin: input.origin,
				reason: "no_text",
			});
			continue;
		}
		documents.push({
			displayArtifactId: display.id,
			promptArtifactId: prompt.id,
			title: display.name,
			origin: input.origin,
			summary: prompt.summary ?? display.summary ?? null,
		});
	}
	return { documents, unavailable };
}

/** Linked sources carry both ids on their snapshot link. */
async function resolveLinkedSources(input: {
	userId: string;
	links: Array<{ displayArtifactId: string; promptArtifactId: string | null }>;
	ownershipScope: OwnershipScope;
}): Promise<{
	documents: AtlasV3LocalDocument[];
	unavailable: AtlasV3LocalUnavailable[];
}> {
	const documents: AtlasV3LocalDocument[] = [];
	const unavailable: AtlasV3LocalUnavailable[] = [];
	if (input.links.length === 0) return { documents, unavailable };
	const ids = [
		...new Set(
			input.links.flatMap((link) =>
				[link.displayArtifactId, link.promptArtifactId].filter(
					(id): id is string => Boolean(id),
				),
			),
		),
	];
	const artifacts = await getArtifactsForUser(input.userId, ids);
	const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
	for (const link of input.links) {
		const display = byId.get(link.displayArtifactId);
		if (!display) {
			unavailable.push({
				displayArtifactId: link.displayArtifactId,
				title: null,
				origin: "linked",
				reason: "not_found",
			});
			continue;
		}
		// A link with no prompt artifact points at a document that is its own
		// text (a generated output, a note).
		const prompt = link.promptArtifactId
			? (byId.get(link.promptArtifactId) ?? null)
			: display;
		const owned = (artifact: Artifact) =>
			isArtifactCanonicallyOwned({
				userId: input.userId,
				ownershipScope: input.ownershipScope,
				artifact,
			});
		if (!owned(display) || (prompt && !owned(prompt))) {
			unavailable.push({
				displayArtifactId: display.id,
				title: display.name,
				origin: "linked",
				reason: "out_of_scope",
			});
			continue;
		}
		if (!prompt || !hasText(prompt)) {
			unavailable.push({
				displayArtifactId: display.id,
				title: display.name,
				origin: "linked",
				reason: "no_text",
			});
			continue;
		}
		documents.push({
			displayArtifactId: display.id,
			promptArtifactId: prompt.id,
			title: display.name,
			origin: "linked",
			summary: prompt.summary ?? display.summary ?? null,
		});
	}
	return { documents, unavailable };
}

export async function resolveAtlasV3LocalSources(input: {
	userId: string;
	conversationId: string;
	kickoffUserMessageId: string | null;
	inheritedDisplayArtifactIds?: string[];
}): Promise<{
	documents: AtlasV3LocalDocument[];
	unavailable: AtlasV3LocalUnavailable[];
}> {
	const links = input.kickoffUserMessageId
		? await listMessageArtifactLinks({
				userId: input.userId,
				conversationId: input.conversationId,
				messageId: input.kickoffUserMessageId,
			})
		: { attachmentArtifactIds: [], linkedSources: [] };
	const inherited = input.inheritedDisplayArtifactIds ?? [];
	if (
		links.attachmentArtifactIds.length === 0 &&
		links.linkedSources.length === 0 &&
		inherited.length === 0
	) {
		return { documents: [], unavailable: [] };
	}
	// The STRICT scope: this conversation's own artifacts even if it is
	// incognito, and no other incognito conversation's.
	const ownershipScope = await getArtifactOwnershipScope(input.userId, {
		conversationId: input.conversationId,
	});
	const parts = [
		await resolveThroughAttachments({
			userId: input.userId,
			displayArtifactIds: links.attachmentArtifactIds,
			origin: "attachment",
			ownershipScope,
		}),
		await resolveLinkedSources({
			userId: input.userId,
			links: links.linkedSources,
			ownershipScope,
		}),
		await resolveThroughAttachments({
			userId: input.userId,
			displayArtifactIds: inherited,
			origin: "inherited",
			ownershipScope,
		}),
	];
	// One document reached two ways (attached AND linked, or linked and
	// inherited) is one source; the first, most explicit origin wins.
	const documents: AtlasV3LocalDocument[] = [];
	const seen = new Set<string>();
	for (const document of parts.flatMap((part) => part.documents)) {
		if (seen.has(document.displayArtifactId)) continue;
		if (seen.has(document.promptArtifactId)) continue;
		seen.add(document.displayArtifactId);
		seen.add(document.promptArtifactId);
		documents.push(document);
	}
	const unavailable = parts
		.flatMap((part) => part.unavailable)
		.filter((entry) => !seen.has(entry.displayArtifactId));
	return { documents, unavailable };
}

/**
 * Passages of one document for the job's questions: up to three for the core
 * question and two per sub-question, deduped by chunk, in document order,
 * joined length (with separators) within `maxChars`.
 *
 * When no passage matches any question — a lexical miss, often a document in
 * another language than the request — the document's opening is read instead.
 * The user chose this document for this question; reading nothing of it would
 * turn their choice into a silent no-op.
 */
export async function selectAtlasV3LocalPassages(input: {
	userId: string;
	document: AtlasV3LocalDocument;
	goals: string[];
	maxChars: number;
}): Promise<AtlasV3LocalPassage[]> {
	const [artifact] = await getArtifactsForUser(input.userId, [
		input.document.promptArtifactId,
	]);
	if (!artifact) return [];
	const byChunk = new Map<number, AtlasV3LocalPassage>();
	const goals = input.goals
		.map((goal) => goal.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	for (const [index, goal] of goals.entries()) {
		const selected = await selectDocumentPassages({
			userId: input.userId,
			artifact,
			query: goal,
			limit:
				index === 0
					? ATLAS_V3_LOCAL_CORE_PASSAGES
					: ATLAS_V3_LOCAL_SUB_QUESTION_PASSAGES,
			charBudget: ATLAS_V3_LOCAL_PASSAGE_CHAR_BUDGET,
		});
		for (const passage of selected.passages) {
			if (byChunk.has(passage.chunkIndex)) continue;
			byChunk.set(passage.chunkIndex, {
				text: passage.text,
				chunkIndex: passage.chunkIndex,
				pageStart: passage.pageStart,
				pageEnd: passage.pageEnd,
			});
		}
	}
	let chosen = [...byChunk.values()].sort(
		(left, right) => left.chunkIndex - right.chunkIndex,
	);
	if (chosen.length === 0 && artifact.contentText?.trim()) {
		chosen = [
			{
				text: artifact.contentText.trim(),
				chunkIndex: 0,
				pageStart: null,
				pageEnd: null,
			},
		];
	}
	return fitAtlasV3LocalPassages(chosen, input.maxChars);
}

/**
 * Keeps passages, in order, while the joined text stays within `maxChars`; the
 * passage that crosses the limit is cut to fit and nothing after it is kept.
 */
export function fitAtlasV3LocalPassages(
	passages: readonly AtlasV3LocalPassage[],
	maxChars: number,
): AtlasV3LocalPassage[] {
	const fitted: AtlasV3LocalPassage[] = [];
	let used = 0;
	for (const passage of passages) {
		const separator =
			fitted.length > 0 ? ATLAS_V3_LOCAL_PASSAGE_SEPARATOR.length : 0;
		const room = maxChars - used - separator;
		if (room <= 0) break;
		const text = passage.text.trim();
		if (!text) continue;
		if (text.length <= room) {
			fitted.push({ ...passage, text });
			used += separator + text.length;
			continue;
		}
		fitted.push({ ...passage, text: text.slice(0, room) });
		break;
	}
	return fitted;
}

/** The production binding; tests pass a fake with the same shape. */
export function createAtlasV3LocalSources(): AtlasV3LocalSources {
	return {
		resolve: resolveAtlasV3LocalSources,
		passages: selectAtlasV3LocalPassages,
	};
}
