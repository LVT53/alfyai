import type {
	DeepResearchEvidenceNote,
	DeepResearchJob,
	DeepResearchSource,
	DeepResearchSynthesisClaim,
	DeepResearchTask,
	DeepResearchTaskOutput,
} from "$lib/types";
import type {
	CitationAuditClaimReviewResult,
	CitationAuditSource,
	DeepResearchCitationAuditVerdict,
	DeepResearchCitationAuditVerdictStatus,
	DeepResearchClaimGraphReviewer,
	DeepResearchReportDraft,
} from "./citation-audit";
import {
	booleanValue,
	numberValue,
	objectArrayValue,
	parseModelJsonObject,
	parseModelJsonValue,
	stringArrayValue,
	stringValue,
} from "./llm-json";
import { tryRunAndRecordDeepResearchModel } from "./model-runner";
import type {
	ReportIntent,
	ResearchLanguage,
	ResearchPlan,
	ResearchPlanIncludedSource,
} from "./planning";
import type { ResearchReportDraft } from "./report-writer";
import {
	type WriteResearchReportInput,
	writeResearchReport,
} from "./report-writer";
import { classifyDeepResearchClaimType } from "./source-quality";
import type {
	PersistedReviewedResearchSourceNotes,
	ReviewSourceResult,
	SourceReviewCandidate,
} from "./source-review";
import type {
	CompletedResearchTaskOutput,
	ResearchSourceReference,
	SynthesisFinding,
	SynthesisNotes,
} from "./synthesis";
import { buildSynthesisNotes } from "./synthesis";

const MAX_SOURCE_REVIEW_FINDINGS = 12;
const MAX_SOURCE_REVIEW_CLAIMS = 16;
const CLAIM_GRAPH_CITATION_AUDIT_BATCH_SIZE = 20;

export type LlmStepContext = {
	jobId: string;
	conversationId: string;
	userId: string;
	now?: Date;
};

export async function draftResearchPlanWithLlm(input: {
	context: LlmStepContext;
	role: "plan_generation" | "plan_revision";
	userRequest: string;
	selectedDepth: ResearchPlan["depth"];
	researchLanguage: ResearchLanguage;
	selectedBudget: ResearchPlan["researchBudget"];
	contextDisclosure: string | null;
	previousPlan?: ResearchPlan | null;
	editInstruction?: string | null;
	reportIntent?: ReportIntent;
	includedSources?: ResearchPlanIncludedSource[];
}): Promise<ResearchPlan | null> {
	const result = await tryRunAndRecordDeepResearchModel({
		role: input.role,
		jobId: input.context.jobId,
		conversationId: input.context.conversationId,
		userId: input.context.userId,
		stage: input.role,
		operation: input.role,
		occurredAt: input.context.now,
		temperature: 0.15,
		maxTokens: 2200,
		messages: [
			{
				role: "system",
				content:
					"Draft a Deep Research plan as strict JSON. Preserve exact user entities, model names, provider names, comparison terms, requested years, and requested language. Make keyQuestions concrete checks the researcher can execute, not generic research-method questions. Tailor them to reportIntent: comparisons need exact variants/editions, specs, price/availability, practical differences, requested-year changes, and source conflicts; recommendations need decision criteria, options, tradeoffs, disqualifiers, and final-choice conditions; market scans need boundaries, players, trends, data quality, and implications; product scans need versions, capabilities, pricing, limits, independent validation, and fit; limitation-focused reports need risks, failure modes, evidence strength, mitigations, and unresolved uncertainty; investigations need timeline, actors, established facts, causal explanations, disputes, and gaps. Add domain-specific checks when relevant: law needs jurisdiction, current authority, enforceability, and open disputes; procurement needs stakeholder criteria, security/compliance, implementation burden, and vendor risk; software/technical needs versions, architecture, compatibility, performance, security, and operational failure modes; health needs current clinical guidance, population/applicability, benefit/harm evidence, contraindications, and regulator warnings; finance needs instrument/product scope, current market data, assumptions, risk metrics, fees/taxes, and regulatory constraints; academic literature needs search corpus, inclusion/exclusion criteria, study quality, consensus, contradictions, and recency. Return only JSON.",
			},
			{
				role: "user",
				content: JSON.stringify({
					userRequest: input.userRequest,
					selectedDepth: input.selectedDepth,
					researchLanguage: input.researchLanguage,
					selectedBudget: input.selectedBudget,
					contextDisclosure: input.contextDisclosure,
					previousPlan: input.previousPlan ?? null,
					editInstruction: input.editInstruction ?? null,
					reportIntent: input.reportIntent ?? null,
					requiredShape: {
						goal: "string",
						reportIntent:
							"comparison|recommendation|investigation|market_scan|product_scan|limitation_focused",
						comparedEntities:
							"string[] when reportIntent is comparison and entities are explicit",
						comparisonAxes:
							"string[] central axes when reportIntent is comparison and axes are explicit",
						keyQuestions: ["string"],
						reportShape: ["string"],
						constraints: ["string"],
						deliverables: ["string"],
						includePublicWeb: true,
					},
				}),
			},
		],
	});
	const parsed = result ? parseModelJsonObject(result.content) : null;
	if (!parsed) return null;

	const goal = stringValue(parsed.goal) ?? input.userRequest;
	const keyQuestions = stringArrayValue(parsed.keyQuestions).slice(0, 8);
	const reportIntent =
		input.reportIntent ?? reportIntentValue(stringValue(parsed.reportIntent));
	if (keyQuestions.length === 0) return null;
	return {
		goal,
		depth: input.selectedDepth,
		researchLanguage: input.researchLanguage,
		reportIntent: reportIntent ?? "investigation",
		comparedEntities: stringArrayValue(parsed.comparedEntities).slice(0, 6),
		comparisonAxes: stringArrayValue(parsed.comparisonAxes).slice(0, 8),
		researchBudget: input.selectedBudget,
		keyQuestions,
		sourceScope: {
			includePublicWeb: booleanValue(parsed.includePublicWeb) ?? true,
			planningContextDisclosure: input.contextDisclosure,
			includedSources: input.includedSources,
		},
		reportShape: stringArrayValue(parsed.reportShape).slice(0, 8),
		constraints: stringArrayValue(parsed.constraints).slice(0, 12),
		deliverables: stringArrayValue(parsed.deliverables).slice(0, 8),
	};
}

export async function reviewSourceWithLlm(input: {
	context: LlmStepContext;
	source: SourceReviewCandidate;
	keyQuestions: string[];
}): Promise<ReviewSourceResult | null> {
	const result = await tryRunAndRecordDeepResearchModel({
		role: "source_review",
		jobId: input.context.jobId,
		conversationId: input.context.conversationId,
		userId: input.context.userId,
		stage: "source_review",
		operation: "source_review",
		occurredAt: input.context.now,
		temperature: 0,
		maxTokens: 1800,
		messages: [
			{
				role: "system",
				content:
					"Review one research source for relevance and evidence quality. For product/model comparisons, treat the original vendor or manufacturer's technical specifications, manuals, geometry pages, and official support pages as baseline truth for official specs; use third-party contradictions as qualifications unless they are also direct official/primary evidence. Reject browser checks, captcha, blocked pages, noise, and unrelated high-authority pages. Return only JSON.",
			},
			{
				role: "user",
				content: JSON.stringify({
					keyQuestions: input.keyQuestions,
					source: {
						title: input.source.title,
						url: input.source.canonicalUrl,
						snippet: input.source.snippet,
						intendedComparedEntity: input.source.intendedComparedEntity ?? null,
						intendedComparisonAxis: input.source.intendedComparisonAxis ?? null,
						sourceText: limitText(input.source.sourceText ?? "", 12000),
					},
					requiredShape: {
						summary: "string",
						keyFindings: ["string"],
						extractedText: "string|null",
						relevanceScore: "0-100",
						supportedKeyQuestions: ["string"],
						comparedEntity:
							"string|null actual compared entity supported by this source",
						comparisonAxis:
							"string|null actual comparison axis supported by this source",
						extractedClaims: ["string"],
						rejectedReason: "string|null",
					},
				}),
			},
		],
	});
	const parsed = result ? parseModelJsonObject(result.content) : null;
	if (!parsed) return null;
	return {
		summary:
			stringValue(parsed.summary) ?? input.source.snippet ?? input.source.title,
		keyFindings: stringArrayValue(parsed.keyFindings).slice(
			0,
			MAX_SOURCE_REVIEW_FINDINGS,
		),
		extractedText: stringValue(parsed.extractedText),
		relevanceScore: numberValue(parsed.relevanceScore) ?? undefined,
		supportedKeyQuestions: stringArrayValue(parsed.supportedKeyQuestions),
		comparedEntity: stringValue(parsed.comparedEntity),
		comparisonAxis: stringValue(parsed.comparisonAxis),
		extractedClaims: stringArrayValue(parsed.extractedClaims).slice(
			0,
			MAX_SOURCE_REVIEW_CLAIMS,
		),
		rejectedReason: stringValue(parsed.rejectedReason),
	};
}

export async function executeResearchTaskWithLlm(input: {
	context: LlmStepContext & { taskId: string };
	job: DeepResearchJob;
	approvedPlan: ResearchPlan;
	task: DeepResearchTask;
	reviewedSources: DeepResearchSource[];
}): Promise<DeepResearchTaskOutput | null> {
	const result = await tryRunAndRecordDeepResearchModel({
		role: "research_task",
		jobId: input.context.jobId,
		conversationId: input.context.conversationId,
		userId: input.context.userId,
		taskId: input.context.taskId,
		stage: "research_tasks",
		operation: "research_task",
		occurredAt: input.context.now,
		temperature: 0.1,
		maxTokens: 1800,
		messages: [
			{
				role: "system",
				content:
					"Complete the assigned Deep Research task using only reviewed sources. Return concise JSON with supported findings and source IDs.",
			},
			{
				role: "user",
				content: JSON.stringify({
					researchLanguage: input.approvedPlan.researchLanguage ?? "en",
					planGoal: input.approvedPlan.goal,
					task: {
						assignment: input.task.assignment,
						keyQuestion: input.task.keyQuestion,
						coverageGapId: input.task.coverageGapId,
					},
					reviewedSources: input.reviewedSources.map(sourceForPrompt),
					requiredShape: {
						summary: "string",
						findings: ["string"],
						sourceIds: ["source id strings used by findings"],
					},
				}),
			},
		],
	});
	const parsed = result ? parseModelJsonObject(result.content) : null;
	if (!parsed) return null;
	const allowedSourceIds = new Set(
		input.reviewedSources.map((source) => source.id),
	);
	const sourceIds = stringArrayValue(parsed.sourceIds).filter((sourceId) =>
		allowedSourceIds.has(sourceId),
	);
	return {
		summary:
			stringValue(parsed.summary) ??
			input.task.keyQuestion ??
			input.task.assignment,
		findings: stringArrayValue(parsed.findings).slice(0, 10),
		sourceIds,
	};
}

export async function buildSynthesisNotesWithLlm(input: {
	context: LlmStepContext;
	reviewedSources: PersistedReviewedResearchSourceNotes[];
	completedTasks: CompletedResearchTaskOutput[];
}): Promise<SynthesisNotes> {
	const fallback = await buildSynthesisNotes({
		jobId: input.context.jobId,
		reviewedSources: input.reviewedSources,
		completedTasks: input.completedTasks,
	});
	const sourceRefsById = new Map(
		input.reviewedSources.map((source) => [
			source.id,
			{
				reviewedSourceId: source.id,
				discoveredSourceId: source.discoveredSourceId,
				canonicalUrl: source.canonicalUrl,
				title: source.title,
			} satisfies ResearchSourceReference,
		]),
	);
	const result = await tryRunAndRecordDeepResearchModel({
		role: "synthesis",
		jobId: input.context.jobId,
		conversationId: input.context.conversationId,
		userId: input.context.userId,
		stage: "synthesis",
		operation: "synthesis",
		occurredAt: input.context.now,
		temperature: 0.1,
		maxTokens: 2200,
		messages: [
			{
				role: "system",
				content:
					"Synthesize reviewed Deep Research evidence. Keep only claims supported by reviewed source IDs. Return only JSON.",
			},
			{
				role: "user",
				content: JSON.stringify({
					reviewedSources: input.reviewedSources.map((source) => ({
						id: source.id,
						title: source.title,
						keyFindings: source.keyFindings,
						extractedClaims: source.extractedClaims,
						supportedKeyQuestions: source.supportedKeyQuestions,
					})),
					completedTasks: input.completedTasks,
					requiredShape: {
						supportedFindings: [{ statement: "string", sourceIds: ["id"] }],
						conflicts: [{ statement: "string", sourceIds: ["id"] }],
						assumptions: [{ statement: "string", sourceIds: ["id"] }],
						reportLimitations: [{ statement: "string", sourceIds: ["id"] }],
					},
				}),
			},
		],
	});
	const parsed = result ? parseModelJsonObject(result.content) : null;
	if (!parsed) return fallback;
	const supportedFindings = mapLlmFindings(
		parsed.supportedFindings,
		"supported",
		sourceRefsById,
	);
	if (supportedFindings.length === 0) return fallback;
	const conflicts = mapLlmFindings(
		parsed.conflicts,
		"conflict",
		sourceRefsById,
	);
	const assumptions = mapLlmFindings(
		parsed.assumptions,
		"assumption",
		sourceRefsById,
	);
	const reportLimitations = mapLlmFindings(
		parsed.reportLimitations,
		"report_limitation",
		sourceRefsById,
	);
	return {
		jobId: input.context.jobId,
		findings: [
			...supportedFindings,
			...conflicts,
			...assumptions,
			...reportLimitations,
		],
		supportedFindings,
		conflicts,
		assumptions,
		reportLimitations,
	};
}

export async function buildCitationClaimReviewerWithLlm(input: {
	context: LlmStepContext;
	report: DeepResearchReportDraft;
	citedSources: CitationAuditSource[];
}): Promise<
	((claimId: string) => CitationAuditClaimReviewResult | null) | null
> {
	const result = await tryRunAndRecordDeepResearchModel({
		role: "citation_audit",
		jobId: input.context.jobId,
		conversationId: input.context.conversationId,
		userId: input.context.userId,
		stage: "citation_audit",
		operation: "citation_audit",
		occurredAt: input.context.now,
		temperature: 0,
		maxTokens: 2600,
		messages: [
			{
				role: "system",
				content:
					"Audit report claims against reviewed and cited source evidence. Support, repair, or remove each claim. Return only JSON.",
			},
			{
				role: "user",
				content: JSON.stringify({
					report: input.report,
					citedSources: input.citedSources.map((source) => ({
						id: source.id,
						title: source.title,
						url: source.url,
						reviewedNote: source.reviewedNote,
						citationNote: source.citationNote,
						extractedClaims: source.extractedClaims,
						snippet: source.snippet,
						sourceText: limitText(source.sourceText ?? "", 8000),
					})),
					requiredShape: {
						claims: [
							{
								claimId: "string",
								status: "supported|repaired|unsupported",
								reason: "string",
								text: "repaired text when repaired",
								citationSourceIds: ["reviewed cited source id"],
							},
						],
					},
				}),
			},
		],
	});
	const parsed = result ? parseModelJsonObject(result.content) : null;
	if (!parsed) return null;
	const reviews = new Map<string, CitationAuditClaimReviewResult>();
	for (const item of objectArrayValue(parsed.claims)) {
		const claimId = stringValue(item.claimId);
		const status = stringValue(item.status);
		if (
			!claimId ||
			!["supported", "repaired", "unsupported"].includes(status ?? "")
		) {
			continue;
		}
		reviews.set(claimId, {
			status: status as CitationAuditClaimReviewResult["status"],
			reason:
				stringValue(item.reason) ?? "Citation audit model reviewed this claim.",
			text: stringValue(item.text) ?? undefined,
			citationSourceIds: stringArrayValue(item.citationSourceIds),
		});
	}
	return (claimId) => reviews.get(claimId) ?? null;
}

export async function buildClaimGraphCitationReviewerWithLlm(input: {
	context: LlmStepContext;
	claims: DeepResearchSynthesisClaim[];
	evidenceNotes: DeepResearchEvidenceNote[];
	concurrency?: number;
}): Promise<DeepResearchClaimGraphReviewer | null> {
	const evidenceById = new Map(
		input.evidenceNotes.map((evidenceNote) => [evidenceNote.id, evidenceNote]),
	);
	const eligibleClaims = input.claims
		.map((claim) => ({
			claim,
			linkedEvidence: claim.evidenceLinks.flatMap((link) => {
				const evidence = evidenceById.get(link.evidenceNoteId);
				return evidence ? [{ link, evidence }] : [];
			}),
		}))
		.filter(({ claim, linkedEvidence }) => {
			if (
				claim.central &&
				claim.status !== "accepted" &&
				claim.status !== "limited"
			) {
				return false;
			}
			if (
				claim.evidenceLinks.some(
					(link) => !evidenceById.has(link.evidenceNoteId),
				)
			) {
				return false;
			}
			if (
				linkedEvidence.some(
					(item) =>
						item.link.relation === "contradiction" && item.link.material,
				)
			) {
				return false;
			}
			return linkedEvidence.some((item) => item.link.relation === "support");
		});
	if (eligibleClaims.length === 0) return null;

	const batches = chunkArray(
		eligibleClaims,
		CLAIM_GRAPH_CITATION_AUDIT_BATCH_SIZE,
	);
	const batchResults = await mapWithConcurrency(
		batches,
		normalizePositiveInteger(input.concurrency, 1),
		async (batch) => {
			const result = await tryRunAndRecordDeepResearchModel({
				role: "citation_audit",
				jobId: input.context.jobId,
				conversationId: input.context.conversationId,
				userId: input.context.userId,
				stage: "citation_audit",
				operation: "citation_audit",
				occurredAt: input.context.now,
				temperature: 0,
				maxTokens: 4000,
				messages: [
					{
						role: "system",
						content:
							"Audit Synthesis Claims against their linked Evidence Notes. Use judgment for claim-type evidence requirements; do not rely on shallow source-quality labels alone. For official product specifications, direct original-vendor/manufacturer specs, manuals, geometry pages, and official support pages are the baseline authority; weaker third-party contradictions should qualify wording, not force a limitation memo. For evidenceNoteIds, use only IDs from evidenceNotes[].id; do not return source IDs, reviewedSourceIds, URLs, or titles. Return one verdict for each claim and return only JSON.",
					},
					{
						role: "user",
						content: JSON.stringify({
							claims: batch.map(({ claim, linkedEvidence }) => ({
								id: claim.id,
								statement: claim.statement,
								claimType:
									claim.claimType ??
									classifyDeepResearchClaimType(claim.statement),
								central: claim.central,
								status: claim.status,
								statusReason: claim.statusReason,
								planQuestion: claim.planQuestion,
								reportSection: claim.reportSection,
								evidenceNotes: linkedEvidence.map(({ link, evidence }) => ({
									id: evidence.id,
									relation: link.relation,
									material: link.material,
									rationale: link.rationale,
									findingText: evidence.findingText,
									supportedKeyQuestion: evidence.supportedKeyQuestion,
									comparedEntity: evidence.comparedEntity,
									comparisonAxis: evidence.comparisonAxis,
									sourceSupport: evidence.sourceSupport,
									sourceQualitySignals: evidence.sourceQualitySignals,
									sourceAuthoritySummary: evidence.sourceAuthoritySummary,
								})),
							})),
							requiredShape: {
								verdicts: [
									{
										claimId: "string",
										verdict:
											"supported|partially_supported|unsupported|contradicted|needs_repair",
										evidenceNoteIds: ["linked Evidence Note id"],
										reason: "short specific reason",
									},
								],
							},
						}),
					},
				],
			});
			const parsed = result ? parseModelJsonValue(result.content) : null;
			return claimGraphReviewerItemsFromParsed(parsed);
		},
	);

	const eligibleClaimIds = new Set(eligibleClaims.map((item) => item.claim.id));
	const verdicts = new Map<string, DeepResearchCitationAuditVerdict>();
	for (const item of batchResults.flat()) {
		const claimId =
			stringValue(item.claimId) ??
			stringValue(item.id) ??
			stringValue(item.synthesisClaimId);
		if (!claimId || !eligibleClaimIds.has(claimId)) continue;
		const verdict = claimGraphVerdictStatusValue(
			stringValue(item.verdict) ??
				stringValue(item.status) ??
				stringValue(item.auditVerdict),
		);
		if (!verdict) continue;
		verdicts.set(claimId, {
			claimId,
			verdict,
			evidenceNoteIds: firstEvidenceIdentifierArrayValue([
				item.evidenceNoteIds,
				item.evidenceIds,
				item.supportingEvidenceNoteIds,
				item.citedEvidenceNoteIds,
				item.evidenceNotes,
				item.supportingEvidence,
				item.citations,
			]),
			reason:
				stringValue(item.reason) ??
				stringValue(item.rationale) ??
				stringValue(item.explanation) ??
				"Citation audit model reviewed this Synthesis Claim.",
		});
	}
	if (verdicts.size === 0) return null;
	return ({ claim }) => verdicts.get(claim.id) ?? null;
}

export async function writeResearchReportWithLlm(
	input: WriteResearchReportInput & { context: LlmStepContext },
): Promise<ResearchReportDraft> {
	const fallback = writeResearchReport(input);
	if (
		fallback.structuredReport.core.keyFindings.some(
			(finding) => finding.claimIds.length > 0,
		)
	) {
		return fallback;
	}
	const result = await tryRunAndRecordDeepResearchModel({
		role: "report_writing",
		jobId: input.context.jobId,
		conversationId: input.context.conversationId,
		userId: input.context.userId,
		stage: "report_completion",
		operation: "report_writing",
		occurredAt: input.context.now,
		temperature: 0.2,
		maxTokens: 3000,
		messages: [
			{
				role: "system",
				content:
					"Write a readable Deep Research report draft from the approved plan and supported findings. Lead with the answer, use short descriptive headings, keep findings grouped instead of dumping source notes, disclose methods and limitations, and do not invent claims or citations. Return only JSON.",
			},
			{
				role: "user",
				content: JSON.stringify({
					researchLanguage: input.plan.researchLanguage ?? "en",
					plan: input.plan,
					synthesisNotes: input.synthesisNotes,
					sources: input.sources,
					limitations: input.limitations ?? [],
					requiredShape: {
						title: "short report title, not the whole user request",
						executiveSummary: "string",
						sections: [{ heading: "string", body: "string" }],
					},
				}),
			},
		],
	});
	const parsed = result ? parseModelJsonObject(result.content) : null;
	if (!parsed) return fallback;
	const executiveSummary = stringValue(parsed.executiveSummary);
	const sections = objectArrayValue(parsed.sections)
		.map((section) => ({
			heading: stringValue(section.heading) ?? "",
			body: stringValue(section.body) ?? "",
		}))
		.filter((section) => section.heading && section.body)
		.slice(0, 8);
	if (!executiveSummary || sections.length === 0) return fallback;
	return {
		...fallback,
		executiveSummary,
		sections,
	};
}

function mapLlmFindings(
	value: unknown,
	kind: SynthesisFinding["kind"],
	sourceRefsById: Map<string, ResearchSourceReference>,
): SynthesisFinding[] {
	return objectArrayValue(value)
		.map((item) => {
			const statement = stringValue(item.statement);
			const sourceRefs = stringArrayValue(item.sourceIds)
				.map((sourceId) => sourceRefsById.get(sourceId))
				.filter((sourceRef): sourceRef is ResearchSourceReference =>
					Boolean(sourceRef),
				);
			if (!statement || sourceRefs.length === 0) return null;
			return {
				kind,
				statement,
				sourceRefs,
				claimType:
					kind === "supported"
						? classifyDeepResearchClaimType(statement)
						: undefined,
				central: kind === "supported" ? true : undefined,
			};
		})
		.filter((finding): finding is SynthesisFinding => Boolean(finding));
}

function sourceForPrompt(source: DeepResearchSource) {
	return {
		id: source.id,
		title: source.title ?? source.url,
		url: source.url,
		reviewedNote: source.reviewedNote,
		extractedClaims: source.extractedClaims,
		supportedKeyQuestions: source.supportedKeyQuestions,
		snippet: source.snippet,
		sourceText: limitText(source.sourceText ?? "", 8000),
	};
}

function limitText(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function claimGraphVerdictStatusValue(
	value: string | null,
): DeepResearchCitationAuditVerdictStatus | null {
	if (
		value === "supported" ||
		value === "partially_supported" ||
		value === "unsupported" ||
		value === "contradicted" ||
		value === "needs_repair"
	) {
		return value;
	}
	return null;
}

function claimGraphReviewerItemsFromParsed(
	parsed: unknown,
): Record<string, unknown>[] {
	if (Array.isArray(parsed)) return objectArrayValue(parsed);
	if (!parsed || typeof parsed !== "object") return [];
	const object = parsed as Record<string, unknown>;
	for (const value of [
		object.verdicts,
		object.claims,
		object.audits,
		object.results,
	]) {
		const items = objectArrayValue(value);
		if (items.length > 0) return items;
	}
	return [];
}

function firstEvidenceIdentifierArrayValue(values: unknown[]): string[] {
	for (const value of values) {
		const strings = evidenceIdentifierArrayValue(value);
		if (strings.length > 0) return strings;
	}
	return [];
}

function evidenceIdentifierArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object" || Array.isArray(item)) return null;
			const object = item as Record<string, unknown>;
			return (
				stringValue(object.evidenceNoteId) ??
				stringValue(object.id) ??
				stringValue(object.sourceId) ??
				stringValue(object.reviewedSourceId)
			);
		})
		.filter((item): item is string => Boolean(item));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, Math.floor(parsed));
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const limit = Math.max(1, Math.floor(concurrency));
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				results[currentIndex] = await mapper(items[currentIndex]);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function reportIntentValue(
	value: string | null,
): ResearchPlan["reportIntent"] | null {
	if (
		value === "comparison" ||
		value === "recommendation" ||
		value === "investigation" ||
		value === "market_scan" ||
		value === "product_scan" ||
		value === "limitation_focused"
	) {
		return value;
	}
	return null;
}
