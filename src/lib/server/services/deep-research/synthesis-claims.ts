import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
	deepResearchClaimEvidenceLinks,
	deepResearchEvidenceNotes,
	deepResearchSynthesisClaims,
} from "$lib/server/db/schema";
import type {
	DeepResearchClaimEvidenceLink,
	DeepResearchClaimEvidenceRelation,
	DeepResearchClaimType,
	DeepResearchEvidenceNote,
	DeepResearchSynthesisClaim,
	DeepResearchSynthesisClaimStatus,
} from "$lib/types";
import type { SynthesisFinding, SynthesisNotes } from "./synthesis";

type DeepResearchSynthesisClaimRow =
	typeof deepResearchSynthesisClaims.$inferSelect;
type DeepResearchClaimEvidenceLinkRow =
	typeof deepResearchClaimEvidenceLinks.$inferSelect;
type DeepResearchEvidenceNoteRow =
	typeof deepResearchEvidenceNotes.$inferSelect;

const MAX_SYNTHESIS_CLAIMS_PER_PASS = 80;
const MAX_EVIDENCE_LINKS_PER_CLAIM = 12;
const SQLITE_SAFE_SELECT_CHUNK_SIZE = 400;
const SQLITE_SAFE_CLAIM_INSERT_CHUNK_SIZE = 40;
const SQLITE_SAFE_LINK_INSERT_CHUNK_SIZE = 80;

export type SaveDeepResearchClaimEvidenceLinkInput = {
	evidenceNoteId: string;
	relation: DeepResearchClaimEvidenceRelation;
	rationale?: string | null;
	material?: boolean;
};

export type SaveDeepResearchSynthesisClaimInput = {
	id?: string;
	statement: string;
	planQuestion?: string | null;
	reportSection?: string | null;
	claimType?: DeepResearchClaimType | null;
	central?: boolean;
	status?: DeepResearchSynthesisClaimStatus;
	statusReason?: string | null;
	competingClaimGroupId?: string | null;
	evidenceLinks: SaveDeepResearchClaimEvidenceLinkInput[];
};

export type SaveDeepResearchSynthesisClaimsInput = {
	userId: string;
	jobId: string;
	conversationId: string;
	passCheckpointId?: string | null;
	synthesisPass?: string | null;
	claims: SaveDeepResearchSynthesisClaimInput[];
	now?: Date;
};

export type ListDeepResearchSynthesisClaimsInput = {
	userId: string;
	jobId: string;
};

export type SaveDeepResearchSynthesisClaimsFromNotesInput = {
	userId: string;
	jobId: string;
	conversationId: string;
	passCheckpointId?: string | null;
	synthesisPass: string;
	synthesisNotes: SynthesisNotes;
	evidenceNotes: DeepResearchEvidenceNote[];
	now?: Date;
};

type NormalizedSynthesisClaim = Omit<
	SaveDeepResearchSynthesisClaimInput,
	"statement" | "id" | "evidenceLinks"
> & {
	id: string;
	statement: string;
	planQuestion: string | null;
	reportSection: string | null;
	claimType: DeepResearchClaimType | null;
	status: DeepResearchSynthesisClaimStatus;
	statusReason: string | null;
	competingClaimGroupId: string | null;
	evidenceLinks: SaveDeepResearchClaimEvidenceLinkInput[];
};

export async function saveDeepResearchSynthesisClaims(
	input: SaveDeepResearchSynthesisClaimsInput,
): Promise<DeepResearchSynthesisClaim[]> {
	const normalizedClaims: NormalizedSynthesisClaim[] = input.claims
		.map((claim) => ({
			...claim,
			id: normalizeOptionalText(claim.id) ?? randomUUID(),
			statement: normalizeText(claim.statement),
			planQuestion: normalizeOptionalText(claim.planQuestion),
			reportSection: normalizeOptionalText(claim.reportSection),
			claimType: normalizeClaimType(claim.claimType),
			status: claim.status ?? "needs-repair",
			statusReason: normalizeOptionalText(claim.statusReason),
			competingClaimGroupId: normalizeOptionalText(claim.competingClaimGroupId),
			evidenceLinks: normalizeEvidenceLinks(claim.evidenceLinks),
		}))
		.filter((claim) => claim.statement.length > 0);
	if (normalizedClaims.length === 0) return [];

	const { db } = await import("$lib/server/db");
	const noteIds = [
		...new Set(
			normalizedClaims.flatMap((claim) =>
				claim.evidenceLinks.map((link) => link.evidenceNoteId),
			),
		),
	];
	const evidenceRows: DeepResearchEvidenceNoteRow[] = [];
	for (const noteIdChunk of chunkArray(
		noteIds,
		SQLITE_SAFE_SELECT_CHUNK_SIZE,
	)) {
		const rows = await db
			.select()
			.from(deepResearchEvidenceNotes)
			.where(
				and(
					eq(deepResearchEvidenceNotes.userId, input.userId),
					eq(deepResearchEvidenceNotes.jobId, input.jobId),
					inArray(deepResearchEvidenceNotes.id, noteIdChunk),
				),
			);
		evidenceRows.push(...rows);
	}
	const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
	const claimsToInsert = expandMaterialContradictions(
		normalizedClaims,
		evidenceById,
	);
	const now = input.now ?? new Date();
	const claimRows = claimsToInsert.map((claim) => {
		const assessment = assessClaimSupport({
			statement: claim.statement,
			requestedStatus: claim.status,
			evidenceLinks: claim.evidenceLinks,
			evidenceById,
		});
		return {
			id: claim.id,
			jobId: input.jobId,
			conversationId: input.conversationId,
			userId: input.userId,
			passCheckpointId: input.passCheckpointId ?? null,
			synthesisPass: normalizeOptionalText(input.synthesisPass),
			planQuestion: claim.planQuestion,
			reportSection: claim.reportSection,
			statement: claim.statement,
			claimType: claim.claimType,
			central: claim.central ?? false,
			status: assessment.status,
			statusReason: assessment.statusReason ?? claim.statusReason,
			competingClaimGroupId: claim.competingClaimGroupId,
			createdAt: now,
			updatedAt: now,
		};
	});
	const insertedClaims: DeepResearchSynthesisClaimRow[] = [];
	for (const claimChunk of chunkArray(
		claimRows,
		SQLITE_SAFE_CLAIM_INSERT_CHUNK_SIZE,
	)) {
		const rows = await db
			.insert(deepResearchSynthesisClaims)
			.values(claimChunk)
			.returning();
		insertedClaims.push(...rows);
	}
	const linkRows = claimsToInsert.flatMap((claim) =>
		claim.evidenceLinks
			.filter((link) => evidenceById.has(link.evidenceNoteId))
			.map((link) => ({
				id: randomUUID(),
				claimId: claim.id,
				evidenceNoteId: link.evidenceNoteId,
				jobId: input.jobId,
				conversationId: input.conversationId,
				userId: input.userId,
				relation: link.relation,
				rationale: link.rationale,
				material: link.material,
				createdAt: now,
			})),
	);
	const insertedLinks: DeepResearchClaimEvidenceLinkRow[] = [];
	for (const linkChunk of chunkArray(
		linkRows,
		SQLITE_SAFE_LINK_INSERT_CHUNK_SIZE,
	)) {
		const rows = await db
			.insert(deepResearchClaimEvidenceLinks)
			.values(linkChunk)
			.returning();
		insertedLinks.push(...rows);
	}

	return mapSynthesisClaims(insertedClaims, groupLinksByClaimId(insertedLinks));
}

function expandMaterialContradictions(
	claims: NormalizedSynthesisClaim[],
	evidenceById: Map<string, DeepResearchEvidenceNoteRow>,
): NormalizedSynthesisClaim[] {
	const expanded: NormalizedSynthesisClaim[] = [];
	for (const claim of claims) {
		const materialContradictions = claim.evidenceLinks.filter(
			(link) => link.relation === "contradiction" && link.material,
		);
		if (materialContradictions.length === 0) {
			expanded.push(claim);
			continue;
		}

		const competingClaimGroupId = claim.competingClaimGroupId ?? randomUUID();
		expanded.push({
			...claim,
			status: "needs-repair",
			statusReason:
				claim.statusReason ??
				"Material contradictory evidence requires competing Synthesis Claims.",
			competingClaimGroupId,
		});
		for (const link of materialContradictions) {
			const evidence = evidenceById.get(link.evidenceNoteId);
			const competingStatement = evidence
				? normalizeText(evidence.findingText)
				: "";
			if (
				!competingStatement ||
				competingStatement.toLowerCase() === claim.statement.toLowerCase()
			) {
				continue;
			}
			expanded.push({
				...claim,
				id: randomUUID(),
				statement: competingStatement,
				status: "needs-repair",
				statusReason:
					"Material contradictory evidence competes with another Synthesis Claim.",
				competingClaimGroupId,
				evidenceLinks: [
					{
						evidenceNoteId: link.evidenceNoteId,
						relation: "support",
						rationale: link.rationale,
						material: true,
					},
				],
			});
		}
	}
	return expanded;
}

export async function listDeepResearchSynthesisClaims(
	input: ListDeepResearchSynthesisClaimsInput,
): Promise<DeepResearchSynthesisClaim[]> {
	const { db } = await import("$lib/server/db");
	const claims = await db
		.select()
		.from(deepResearchSynthesisClaims)
		.where(
			and(
				eq(deepResearchSynthesisClaims.userId, input.userId),
				eq(deepResearchSynthesisClaims.jobId, input.jobId),
			),
		)
		.orderBy(
			asc(deepResearchSynthesisClaims.createdAt),
			asc(deepResearchSynthesisClaims.id),
		);
	if (claims.length === 0) return [];

	const links: DeepResearchClaimEvidenceLinkRow[] = [];
	for (const claimIdChunk of chunkArray(
		claims.map((claim) => claim.id),
		SQLITE_SAFE_SELECT_CHUNK_SIZE,
	)) {
		const rows = await db
			.select()
			.from(deepResearchClaimEvidenceLinks)
			.where(
				and(
					eq(deepResearchClaimEvidenceLinks.userId, input.userId),
					eq(deepResearchClaimEvidenceLinks.jobId, input.jobId),
					inArray(deepResearchClaimEvidenceLinks.claimId, claimIdChunk),
				),
			)
			.orderBy(
				asc(deepResearchClaimEvidenceLinks.claimId),
				asc(deepResearchClaimEvidenceLinks.createdAt),
				asc(deepResearchClaimEvidenceLinks.id),
			);
		links.push(...rows);
	}
	return mapSynthesisClaims(claims, groupLinksByClaimId(links));
}

export async function saveDeepResearchSynthesisClaimsFromNotes(
	input: SaveDeepResearchSynthesisClaimsFromNotesInput,
): Promise<DeepResearchSynthesisClaim[]> {
	const existing = await listDeepResearchSynthesisClaims({
		userId: input.userId,
		jobId: input.jobId,
	});
	const existingForPass = existing.filter(
		(claim) => claim.synthesisPass === input.synthesisPass,
	);
	if (existingForPass.length > 0) return existingForPass;

	const claims: SaveDeepResearchSynthesisClaimInput[] = [
		...input.synthesisNotes.supportedFindings.map((finding) =>
			claimInputFromSupportedFinding(finding, input.evidenceNotes),
		),
		...input.synthesisNotes.conflicts.flatMap((finding) =>
			claimInputsFromConflictFinding(finding, input.evidenceNotes),
		),
	]
		.filter((claim): claim is SaveDeepResearchSynthesisClaimInput =>
			Boolean(claim),
		)
		.slice(0, MAX_SYNTHESIS_CLAIMS_PER_PASS);
	if (claims.length === 0) return [];

	return saveDeepResearchSynthesisClaims({
		userId: input.userId,
		jobId: input.jobId,
		conversationId: input.conversationId,
		passCheckpointId: input.passCheckpointId,
		synthesisPass: input.synthesisPass,
		claims,
		now: input.now,
	});
}

export async function updateDeepResearchSynthesisClaimStatus(input: {
	userId: string;
	claimId: string;
	status: DeepResearchSynthesisClaimStatus;
	statusReason?: string | null;
	now?: Date;
}): Promise<DeepResearchSynthesisClaim | null> {
	const { db } = await import("$lib/server/db");
	const now = input.now ?? new Date();
	const [updated] = await db
		.update(deepResearchSynthesisClaims)
		.set({
			status: input.status,
			statusReason: normalizeOptionalText(input.statusReason),
			updatedAt: now,
		})
		.where(
			and(
				eq(deepResearchSynthesisClaims.userId, input.userId),
				eq(deepResearchSynthesisClaims.id, input.claimId),
			),
		)
		.returning();
	if (!updated) return null;
	const links = await db
		.select()
		.from(deepResearchClaimEvidenceLinks)
		.where(eq(deepResearchClaimEvidenceLinks.claimId, updated.id))
		.orderBy(asc(deepResearchClaimEvidenceLinks.createdAt));
	return mapSynthesisClaims([updated], groupLinksByClaimId(links))[0] ?? null;
}

function assessClaimSupport(input: {
	statement: string;
	requestedStatus: DeepResearchSynthesisClaimStatus;
	evidenceLinks: SaveDeepResearchClaimEvidenceLinkInput[];
	evidenceById: Map<string, DeepResearchEvidenceNoteRow>;
}): { status: DeepResearchSynthesisClaimStatus; statusReason?: string | null } {
	if (!["accepted", "limited"].includes(input.requestedStatus)) {
		return { status: input.requestedStatus };
	}

	const supportingNotes = input.evidenceLinks
		.filter((link) => link.relation === "support")
		.map((link) => input.evidenceById.get(link.evidenceNoteId))
		.filter((note): note is DeepResearchEvidenceNoteRow => Boolean(note));
	if (supportingNotes.length === 0) {
		return {
			status: "rejected",
			statusReason:
				"Accepted Synthesis Claims require at least one supporting Evidence Note.",
		};
	}

	return { status: input.requestedStatus };
}

function claimInputFromSupportedFinding(
	finding: SynthesisFinding,
	evidenceNotes: DeepResearchEvidenceNote[],
): SaveDeepResearchSynthesisClaimInput | null {
	const supportingNotes = matchingEvidenceNotesForFinding(
		finding,
		evidenceNotes,
	);
	if (supportingNotes.length === 0) return null;
	return {
		statement: finding.statement,
		planQuestion: firstNonNull(
			supportingNotes.map((note) => note.supportedKeyQuestion),
		),
		reportSection: firstNonNull(
			supportingNotes.map((note) => note.comparisonAxis),
		),
		claimType: finding.claimType ?? null,
		central: finding.central ?? true,
		status: "accepted",
		evidenceLinks: supportingNotes
			.slice(0, MAX_EVIDENCE_LINKS_PER_CLAIM)
			.map((note) => ({
				evidenceNoteId: note.id,
				relation: "support",
			})),
	};
}

function claimInputsFromConflictFinding(
	finding: SynthesisFinding,
	evidenceNotes: DeepResearchEvidenceNote[],
): SaveDeepResearchSynthesisClaimInput[] {
	const matchingNotes = matchingEvidenceNotesForFinding(finding, evidenceNotes);
	if (matchingNotes.length < 2) return [];
	const [baseNote, contradictionNote] = matchingNotes;
	return [
		{
			statement: baseNote.findingText,
			planQuestion: baseNote.supportedKeyQuestion,
			reportSection: baseNote.comparisonAxis,
			status: "needs-repair",
			claimType: finding.claimType ?? null,
			central: finding.central ?? true,
			evidenceLinks: [
				{
					evidenceNoteId: baseNote.id,
					relation: "support",
				},
				{
					evidenceNoteId: contradictionNote.id,
					relation: "contradiction",
					material: true,
				},
			],
		},
	];
}

function matchingEvidenceNotesForFinding(
	finding: SynthesisFinding,
	evidenceNotes: DeepResearchEvidenceNote[],
): DeepResearchEvidenceNote[] {
	const sourceIds = new Set(
		finding.sourceRefs.flatMap((sourceRef) => [
			sourceRef.discoveredSourceId,
			sourceRef.reviewedSourceId,
		]),
	);
	const findingStatement = normalizeText(finding.statement).toLowerCase();
	const sourceMatchedNotes = evidenceNotes.filter((note) => {
		if (normalizeText(note.findingText).toLowerCase() === findingStatement) {
			return true;
		}
		if (note.sourceId && sourceIds.has(note.sourceId)) return true;
		const sourceSupportIds = sourceIdsFromSupport(note.sourceSupport);
		return sourceSupportIds.some((sourceId) => sourceIds.has(sourceId));
	});
	const exactMatches = sourceMatchedNotes.filter(
		(note) =>
			normalizeText(note.findingText).toLowerCase() === findingStatement,
	);
	if (exactMatches.length > 0) return exactMatches;
	const textMatches = sourceMatchedNotes.filter((note) =>
		evidenceNoteSupportsClaim(finding.statement, note),
	);
	return textMatches.length > 0 ? textMatches : sourceMatchedNotes;
}

function sourceIdsFromSupport(
	sourceSupport: Record<string, unknown>,
): string[] {
	const values = [
		sourceSupport.sourceId,
		sourceSupport.reviewedSourceId,
		...(Array.isArray(sourceSupport.sourceIds) ? sourceSupport.sourceIds : []),
	];
	return values.filter((value): value is string => typeof value === "string");
}

function firstNonNull(values: Array<string | null | undefined>): string | null {
	return values.find((value) => value && value.trim().length > 0) ?? null;
}

function evidenceNoteSupportsClaim(
	statement: string,
	note: Pick<
		DeepResearchEvidenceNote,
		| "findingText"
		| "supportedKeyQuestion"
		| "comparedEntity"
		| "comparisonAxis"
		| "sourceSupport"
	>,
): boolean {
	const claimTerms = importantTerms(statement);
	const noteTerms = importantTerms(
		[
			note.findingText,
			note.supportedKeyQuestion,
			note.comparedEntity,
			note.comparisonAxis,
			typeof note.sourceSupport.excerpt === "string"
				? note.sourceSupport.excerpt
				: null,
		]
			.filter(Boolean)
			.join(" "),
	);
	if (hasGeographyMismatch(claimTerms, noteTerms)) return false;
	const overlap = [...claimTerms].filter((term) => noteTerms.has(term));
	return overlap.length >= Math.min(3, claimTerms.size);
}

function hasGeographyMismatch(
	claimTerms: Set<string>,
	noteTerms: Set<string>,
): boolean {
	const claimUs = claimTerms.has("us") || claimTerms.has("unitedstates");
	const noteUs = noteTerms.has("us") || noteTerms.has("unitedstates");
	const claimEu = claimTerms.has("eu") || claimTerms.has("europeanunion");
	const noteEu = noteTerms.has("eu") || noteTerms.has("europeanunion");
	return (claimUs && noteEu && !noteUs) || (claimEu && noteUs && !noteEu);
}

function importantTerms(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.replace(/\bunited states\b/g, "unitedstates")
			.replace(/\beuropean union\b/g, "europeanunion")
			.split(/[^a-z0-9]+/)
			.map((term) => term.trim())
			.filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
	);
}

function normalizeEvidenceLinks(
	links: SaveDeepResearchClaimEvidenceLinkInput[],
): SaveDeepResearchClaimEvidenceLinkInput[] {
	return links
		.map((link) => ({
			evidenceNoteId: normalizeText(link.evidenceNoteId),
			relation: link.relation,
			rationale: normalizeOptionalText(link.rationale),
			material: link.material ?? false,
		}))
		.filter(
			(link) =>
				link.evidenceNoteId.length > 0 &&
				["support", "qualification", "contradiction"].includes(link.relation),
		);
}

function mapSynthesisClaims(
	rows: DeepResearchSynthesisClaimRow[],
	linksByClaimId: Map<string, DeepResearchClaimEvidenceLinkRow[]>,
): DeepResearchSynthesisClaim[] {
	return rows.map((row) => ({
		id: row.id,
		jobId: row.jobId,
		conversationId: row.conversationId,
		userId: row.userId,
		passCheckpointId: row.passCheckpointId,
		synthesisPass: row.synthesisPass,
		planQuestion: row.planQuestion,
		reportSection: row.reportSection,
		statement: row.statement,
		claimType: normalizeClaimType(row.claimType),
		central: row.central,
		status: row.status as DeepResearchSynthesisClaimStatus,
		statusReason: row.statusReason,
		competingClaimGroupId: row.competingClaimGroupId,
		evidenceLinks: (linksByClaimId.get(row.id) ?? []).map(mapEvidenceLinkRow),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	}));
}

function mapEvidenceLinkRow(
	row: DeepResearchClaimEvidenceLinkRow,
): DeepResearchClaimEvidenceLink {
	return {
		id: row.id,
		claimId: row.claimId,
		evidenceNoteId: row.evidenceNoteId,
		jobId: row.jobId,
		conversationId: row.conversationId,
		userId: row.userId,
		relation: row.relation as DeepResearchClaimEvidenceRelation,
		rationale: row.rationale,
		material: row.material,
		createdAt: row.createdAt.toISOString(),
	};
}

function groupLinksByClaimId(
	rows: DeepResearchClaimEvidenceLinkRow[],
): Map<string, DeepResearchClaimEvidenceLinkRow[]> {
	const grouped = new Map<string, DeepResearchClaimEvidenceLinkRow[]>();
	for (const row of rows) {
		grouped.set(row.claimId, [...(grouped.get(row.claimId) ?? []), row]);
	}
	return grouped;
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function normalizeOptionalText(
	value: string | null | undefined,
): string | null {
	const normalized = value?.replace(/\s+/g, " ").trim();
	return normalized ? normalized : null;
}

function normalizeClaimType(
	value: string | null | undefined,
): DeepResearchClaimType | null {
	const normalized = normalizeOptionalText(value);
	if (!normalized) return null;
	return CLAIM_TYPES.has(normalized as DeepResearchClaimType)
		? (normalized as DeepResearchClaimType)
		: null;
}

const CLAIM_TYPES = new Set<DeepResearchClaimType>([
	"official_specification",
	"price_availability",
	"reliability_experience",
	"high_stakes",
	"general",
]);

const STOP_WORDS = new Set([
	"the",
	"and",
	"or",
	"of",
	"to",
	"in",
	"for",
	"with",
	"a",
	"an",
	"by",
	"on",
	"at",
	"as",
	"from",
	"that",
	"this",
	"already",
	"every",
	"major",
	"still",
]);
