import type { ToolEvidenceCandidate } from "$lib/types";
import { getHistoryMemoryContext } from "./history";
import { getPersonaMemoryContext } from "./persona";
import {
	getProjectContext,
	type ProjectContextResult,
	type ProjectContextSelectedSiblingDetail,
	type ProjectContextSiblingSummary,
} from "./project";
import { buildMemoryReadSanitizer } from "./sanitize";
import type {
	GetMemoryContextParams,
	MemoryContextResult,
	ProjectMemoryContextResult,
} from "./types";

const PROJECT_REPORT_QUERY_RE =
	/\b(report|pdf|docx?|document|export|download|file|summari[sz]e|write[- ]?up)\b|(?:jelentés|jelentes|riport|dokumentum|fájl|fajl|letöltés|letoltes|összefoglal(?:ó|o)?|foglalj\s+össze|foglalj\s+ossze|írd\s+meg|ird\s+meg|készíts|keszits)/iu;
const PROJECT_FOLDER_QUERY_RE =
	/\b(project folder|folder|project|workspace|content from|content of|memory)\b|(?:projektmappa|projekt[\p{L}]*|mappa|munkaterület|munkaterulet|memória|memoria|korábbi\s+beszélgetések|korabbi\s+beszelgetesek|kapcsolódó\s+beszélgetések|kapcsolodo\s+beszelgetesek)/iu;

export function resolveProjectMemoryContextMode(params: {
	query?: string | null;
	siblingConversationId?: string | null;
}): ProjectContextResult["mode"] {
	const query = params.query?.trim() ?? "";
	if (params.siblingConversationId?.trim()) return "detail";
	return PROJECT_REPORT_QUERY_RE.test(query) &&
		PROJECT_FOLDER_QUERY_RE.test(query)
		? "report"
		: "summary";
}

type MemoryReadSanitizer = ReturnType<typeof buildMemoryReadSanitizer>;

function sanitizeEvidenceCandidate(
	candidate: ToolEvidenceCandidate,
	sanitize: MemoryReadSanitizer,
): ToolEvidenceCandidate {
	return {
		...candidate,
		title: sanitize(candidate.title),
		...(candidate.snippet ? { snippet: sanitize(candidate.snippet) } : {}),
	};
}

function sanitizeSiblingSummary(
	sibling: ProjectContextSiblingSummary,
	sanitize: MemoryReadSanitizer,
): ProjectContextSiblingSummary {
	return {
		...sibling,
		title: sanitize(sibling.title),
		objective: sibling.objective === null ? null : sanitize(sibling.objective),
		summary: sibling.summary === null ? null : sanitize(sibling.summary),
	};
}

function sanitizeSelectedSibling(
	sibling: ProjectContextSelectedSiblingDetail,
	sanitize: MemoryReadSanitizer,
): ProjectContextSelectedSiblingDetail {
	return {
		...sibling,
		title: sanitize(sibling.title),
		objective: sibling.objective === null ? null : sanitize(sibling.objective),
		summary: sibling.summary === null ? null : sanitize(sibling.summary),
		messages: sibling.messages.map((message) => ({
			...message,
			content: sanitize(message.content),
			...(message.attachments
				? {
						attachments: message.attachments.map((attachment) => ({
							name: attachment.name,
							content: sanitize(attachment.content),
						})),
					}
				: {}),
		})),
	};
}

/**
 * Uniform sanitisation for project context: project content reaches the model
 * through this read path, so scrub identity references from every model-facing
 * text field before returning.
 */
function sanitizeProjectResult(
	result: ProjectMemoryContextResult,
	sanitize: MemoryReadSanitizer,
): ProjectMemoryContextResult {
	return {
		...result,
		project: result.project
			? { ...result.project, name: sanitize(result.project.name) }
			: null,
		siblings: result.siblings.map((sibling) =>
			sanitizeSiblingSummary(sibling, sanitize),
		),
		...(result.selectedSibling
			? {
					selectedSibling: sanitizeSelectedSibling(
						result.selectedSibling,
						sanitize,
					),
				}
			: {}),
		...(result.reportSiblings
			? {
					reportSiblings: result.reportSiblings.map((sibling) =>
						sanitizeSelectedSibling(sibling, sanitize),
					),
				}
			: {}),
		evidenceCandidates: result.evidenceCandidates.map((candidate) =>
			sanitizeEvidenceCandidate(candidate, sanitize),
		),
	};
}

async function getProjectMemoryContext(
	params: GetMemoryContextParams,
): Promise<ProjectMemoryContextResult> {
	const projectMode = resolveProjectMemoryContextMode({
		query: params.query,
		siblingConversationId: params.siblingConversationId,
	});
	const result = await getProjectContext({
		userId: params.userId,
		conversationId: params.conversationId,
		mode: projectMode,
		query: params.query ?? null,
		maxSiblings: params.maxSiblings,
		siblingConversationId: params.siblingConversationId?.trim() || null,
		maxMessages: params.maxMessages,
		includeEvidenceCandidates: params.includeEvidenceCandidates,
		includeAttachments: params.includeAttachments,
	});

	const projectResult: ProjectMemoryContextResult = {
		...result,
		mode: "project",
		projectMode: result.mode,
	};
	const sanitize = buildMemoryReadSanitizer({
		userId: params.userId,
		userDisplayName: params.userDisplayName,
	});
	return sanitizeProjectResult(projectResult, sanitize);
}

/**
 * The single memory-read seam. Both the memory_context tool (all three modes)
 * and — via retrievePersonaMemory — the baseline profile injection route their
 * reads through this module, which owns persona + history + project retrieval,
 * projection-policy screening (inside history) and uniform sanitisation.
 */
export async function getMemoryForTurn(
	params: GetMemoryContextParams,
): Promise<MemoryContextResult> {
	const mode = params.mode?.trim() || "persona";
	if (mode === "project") {
		return getProjectMemoryContext(params);
	}
	if (mode === "persona") {
		return getPersonaMemoryContext(params);
	}
	if (mode === "history") {
		return getHistoryMemoryContext(params);
	}
	throw new Error(`Unsupported memory_context mode: ${mode}`);
}
