import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import {
	type AtlasOutputIds,
	buildAtlasDocumentSource,
} from "./renderer-output";
import type {
	AtlasHonestyMarker,
	AtlasJobProgressDetails,
	AtlasLifecycleContext,
	AtlasPipelineJobContext,
	AtlasPipelineStage,
} from "./types";

type ModelStage = Exclude<AtlasPipelineStage, "search" | "audit" | "render">;

export interface AtlasStageUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface RunAtlasPipelineInput {
	job: AtlasPipelineJobContext;
	now?: Date;
	dependencies: {
		resolveSources: () => Promise<{
			localSources: Array<{
				id: string;
				title: string;
				authority: string;
				text: string;
			}>;
		}>;
		searchWeb: (queries: string[]) => Promise<{
			sources: Array<{
				id: string;
				title: string;
				url: string;
				snippet: string | null;
			}>;
			rejectedSources?: Array<{
				id: string;
				title: string;
				url: string;
				snippet: string | null;
				rejectionReason?: string;
			}>;
			limitation: { code: string; message: string } | null;
		}>;
		runModelStage: (input: {
			stage: ModelStage;
			prompt: string;
			system: string;
		}) => Promise<{ text: string; usage: AtlasStageUsage }>;
		auditBasis: (input: {
			assembledMarkdown: string;
			sources: Array<{ title: string; url?: string | null }>;
			limitation: { code: string; message: string } | null;
			language: SupportedLanguage;
		}) => Promise<{
			passed: boolean;
			honestyMarkers: AtlasHonestyMarker[];
			retryRequested: boolean;
			usage?: AtlasStageUsage | null;
		}>;
		writeCheckpoint: (input: {
			jobId: string;
			roundNumber: number;
			stage: string;
			checkpoint: unknown;
			curatedSourcePool: unknown;
			compressedFindings: unknown;
			usage: AtlasStageUsage;
			qualityDiagnostics: unknown;
			documentSourceSummary: unknown;
		}) => Promise<void>;
		heartbeat?: (input: {
			stage: AtlasPipelineStage;
			progressPercent: number;
			progressDetails?: AtlasJobProgressDetails;
		}) => Promise<void>;
		renderOutputs: (
			source: GeneratedDocumentSource,
		) => Promise<AtlasOutputIds & { sourceTitle?: string }>;
	};
}

export interface AtlasPipelineResult {
	status: "succeeded";
	stage: "audit";
	outputs: AtlasOutputIds;
	audit: {
		honestyMarkers: AtlasHonestyMarker[];
	};
	usage: AtlasStageUsage;
	sourceCounts: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
}

export class AtlasPipelineQualityError extends Error {
	readonly code = "atlas_quality_gate_failed";
	readonly markers: AtlasHonestyMarker[];

	constructor(markers: AtlasHonestyMarker[]) {
		const markerCodes = markers.map((marker) => marker.code).join(", ");
		super(
			`Atlas quality gate failed${markerCodes ? `: ${markerCodes}` : "."}`,
		);
		this.name = "AtlasPipelineQualityError";
		this.markers = markers;
	}
}

function addUsage(
	total: AtlasStageUsage,
	next: AtlasStageUsage,
): AtlasStageUsage {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		costUsdMicros: total.costUsdMicros + next.costUsdMicros,
	};
}

function seededPrompt(input: {
	query: string;
	lifecycle: AtlasLifecycleContext;
	language: SupportedLanguage;
}): string {
	return JSON.stringify({
		query: input.query,
		detectedLanguage: input.language,
		atlasLifecycle: {
			action: input.lifecycle.family.action,
			family: input.lifecycle.family,
			parentSeed: input.lifecycle.seed
				? {
						parentAtlasJobId: input.lifecycle.seed.parentAtlasJobId,
						compressedFindings: input.lifecycle.seed.compressedFindings,
					}
				: null,
		},
	});
}

const STAGE_SYSTEMS: Record<SupportedLanguage, Record<ModelStage, string>> = {
	en: {
		decompose:
			"Break the Atlas question into durable research queries. Return only search query strings, one per line. Do not include prose, numbering, Markdown fences, or commentary.",
		curate:
			"Curate Atlas local and web evidence. Extract source-grounded facts only; do not summarize the fact that research happened.",
		synthesize:
			"Synthesize Atlas findings from curated evidence. Produce substantive findings, tradeoffs, and source-grounded uncertainty; do not write a process summary.",
		integrate:
			"Integrate Atlas findings into a coherent report outline. Preserve the substantive findings and map each section to the evidence basis.",
		assemble:
			"Assemble final Atlas report Markdown with actual findings. Do not write a process report about sources checked or steps performed.",
	},
	hu: {
		decompose:
			"Bontsd az Atlas kérdést tartós kutatási lekérdezésekre. Csak keresési lekérdezéseket adj vissza, soronként egyet. Ne adj prózát, számozást, Markdown blokkot vagy kommentárt.",
		curate:
			"Válogasd az Atlas helyi és webes bizonyítékait. Csak forrásokkal alátámasztott tényeket emelj ki; ne azt foglald össze, hogy kutatás történt.",
		synthesize:
			"Szintetizáld az Atlas megállapításait a válogatott bizonyítékokból. Valódi megállapításokat, kompromisszumokat és forrásalapú bizonytalanságot adj; ne folyamatösszefoglalót.",
		integrate:
			"Rendezd az Atlas megállapításait koherens jelentésvázlatba. Őrizd meg az érdemi megállapításokat, és kösd a szakaszokat a bizonyítékalaphoz.",
		assemble:
			"Állítsd össze a végleges Atlas jelentést Markdown formában, valódi megállapításokkal. Ne folyamatjelentést írj a vizsgált forrásokról vagy elvégzett lépésekről.",
	},
};

function stageSystem(stage: ModelStage, language: SupportedLanguage): string {
	const languageInstruction =
		language === "hu"
			? "A jelentés és a szakasz kimenete magyar legyen; a forráscímek maradjanak eredeti nyelven."
			: "Write the stage output and final report in English; keep source titles in their original language.";
	return `${STAGE_SYSTEMS[language][stage]}\n\n${languageInstruction}`;
}

function parseDecomposeQueries(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	for (const candidate of [trimmed, fencedJson].filter(
		(candidate): candidate is string => Boolean(candidate),
	)) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const rawQueries = Array.isArray(parsed)
				? parsed
				: parsed && typeof parsed === "object"
					? ((parsed as { queries?: unknown; researchQueries?: unknown })
							.queries ??
						(parsed as { researchQueries?: unknown }).researchQueries)
					: null;
			if (Array.isArray(rawQueries)) {
				const queries = rawQueries
					.map((query) =>
						typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "",
					)
					.filter(Boolean)
					.slice(0, 8);
				if (queries.length > 0) return queries;
			}
		} catch {
			// Fall through to line parsing.
		}
	}
	return text
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^[-*\d.)\s]+/, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter(Boolean)
		.slice(0, 8);
}

function fallbackDecomposeQueries(query: string): string[] {
	const trimmed = query.replace(/\s+/g, " ").trim();
	return trimmed ? [trimmed] : [];
}

function buildAssemblePrompt(input: {
	language: SupportedLanguage;
	query: string;
	curatedEvidence: string;
	synthesis: string;
	outline: string;
	sources: Array<{ title: string; url?: string | null; reasoning?: string | null }>;
	limitation: { code: string; message: string } | null;
	lifecycle: AtlasLifecycleContext["family"];
}): string {
	const instructions =
		input.language === "hu"
			? [
					"Írj teljes Atlas jelentést Markdownban.",
					"Do not write a process report about checking sources, synthesizing findings, or completing research steps.",
					"A jelentés érdemi megállapításokat tartalmazzon: Executive Summary, tematikus elemző szakaszok, Limitations és Sources.",
					"Csak az elfogadott forrásokból és a válogatott bizonyítékokból következő állításokat tegyél.",
					"Ha a bizonyíték gyenge vagy ellentmondásos, azt a Limitations részben és a releváns szakaszban mondd ki.",
				].join(" ")
			: [
					"Write a complete Atlas report in Markdown.",
					"Do not write a process report about checking sources, synthesizing findings, or completing research steps.",
					"The report must contain substantive findings: Executive Summary, thematic analytical sections, Limitations, and Sources.",
					"Make only claims supported by accepted sources and curated evidence.",
					"If evidence is weak or conflicting, state that in Limitations and in the relevant section.",
				].join(" ");
	return JSON.stringify({
		detectedLanguage: input.language,
		query: input.query,
		instructions,
		curatedEvidence: input.curatedEvidence,
		synthesis: input.synthesis,
		outline: input.outline,
		acceptedSources: input.sources,
		searchLimitation: input.limitation,
		atlasLifecycle: input.lifecycle,
	});
}

function looksLikeProcessOnlyReport(markdown: string): boolean {
	const normalized = markdown.replace(/\s+/g, " ").trim().toLowerCase();
	if (!normalized) return true;
	const bodyBeforeSources = markdown
		.split(/\n\s*#{2,3}\s+sources\b/i)[0]
		.replace(/^\s*#\s+.+$/gm, "")
		.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const bodyWords = bodyBeforeSources ? bodyBeforeSources.split(/\s+/).length : 0;
	const hasSubstantiveReportSection =
		/^\s*#{2,3}\s+(executive summary|findings|analysis|key findings|recommendations|overview|összefoglaló|vezetői összefoglaló|megállapítások|elemzés|ajánlások)\b/im.test(
			markdown,
		);
	if (!hasSubstantiveReportSection || bodyWords < 60) return true;
	const processPhrases = [
		/\bsources?\s+(?:checked|reviewed|consulted|examined)\b/i,
		/\b(?:checked|reviewed|consulted|examined)\s+sources?\b/i,
		/\bsynthesi[sz]ed\s+(?:the\s+)?findings\b/i,
		/\bcompleted\s+(?:the\s+)?research\b/i,
		/\bresearch\s+process\b/i,
		/\bI\s+(?:checked|reviewed|consulted|examined)\b/i,
	];
	const processHitCount = processPhrases.filter((phrase) =>
		phrase.test(markdown),
	).length;
	if (processHitCount === 0) return false;
	const words = normalized.split(/\s+/).filter(Boolean).length;
	const substantiveSignals =
		/\b(evidence shows|the evidence|finding:|trade[- ]offs?|because|therefore|however|kockázat|bizonyíték|megállapítás)\b/i.test(
			markdown,
		);
	return processHitCount >= 2 || words < 180 || !substantiveSignals;
}

function buildAssembleRepairPrompt(input: {
	basePrompt: string;
	previousDraft: string;
	language: SupportedLanguage;
}): string {
	const repairInstruction =
		input.language === "hu"
			? "Az előző vázlat folyamatleírás volt. Írd újra teljes Atlas jelentésként valódi, forrásalapú megállapításokkal. Ne mondd el, hogy forrásokat ellenőriztél vagy szintetizáltál; mondd el, mit bizonyítanak a források."
			: "The previous draft was a process summary. Rewrite it as a complete Atlas report with real source-grounded findings. Do not say that sources were checked or findings were synthesized; state what the sources actually show.";
	return JSON.stringify({
		...JSON.parse(input.basePrompt),
		repairInstruction,
		previousProcessOnlyDraft: input.previousDraft,
	});
}

function buildDeterministicFallbackReport(input: {
	language: SupportedLanguage;
	query: string;
	curatedEvidence: string;
	synthesis: string;
	outline: string;
	limitation: { code: string; message: string } | null;
}): string {
	const clean = (value: string, fallback: string) => {
		const normalized = value
			.replace(/```[\s\S]*?```/g, "")
			.replace(/\s+/g, " ")
			.trim();
		return normalized || fallback;
	};
	if (input.language === "hu") {
		return [
			`# Atlas jelentés`,
			"",
			"## Vezetői összefoglaló",
			clean(
				input.synthesis,
				"Az Atlas nem kapott elég részletes szintézist, ezért a jelentés a válogatott bizonyítékokra és a korlátokra támaszkodik.",
			),
			"",
			"## Megállapítások",
			clean(
				input.curatedEvidence,
				"A válogatott bizonyítékok alapján csak óvatos, forráshoz kötött megállapítások tehetők.",
			),
			"",
			"## Elemzési keret",
			clean(input.outline, `Kutatási kérdés: ${input.query}`),
			"",
			"## Korlátok",
			input.limitation
				? `${input.limitation.message}`
				: "A jelentés az elfogadott Atlas forrásokra korlátozódik, és nem tekinthető teljes körű történeti feldolgozásnak.",
		].join("\n");
	}
	return [
		`# Atlas Report`,
		"",
		"## Executive Summary",
		clean(
			input.synthesis,
			"Atlas did not receive a detailed enough synthesis, so this report is constrained to the curated evidence and explicit limitations.",
		),
		"",
		"## Findings",
		clean(
			input.curatedEvidence,
			"The curated evidence supports only cautious, source-grounded findings.",
		),
		"",
		"## Analysis Frame",
		clean(input.outline, `Research question: ${input.query}`),
		"",
		"## Limitations",
		input.limitation
			? `${input.limitation.message}`
			: "This report is limited to the accepted Atlas sources and should not be treated as exhaustive historical coverage.",
	].join("\n");
}

export async function runAtlasPipeline(
	input: RunAtlasPipelineInput,
): Promise<AtlasPipelineResult> {
	const language = detectLanguage(input.job.query);
	const sources = await input.dependencies.resolveSources();
	const usageSeed: AtlasStageUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsdMicros: 0,
	};
	let usage = usageSeed;

	await input.dependencies.heartbeat?.({
		stage: "decompose",
		progressPercent: 10,
	});
	const decompose = await input.dependencies.runModelStage({
		stage: "decompose",
		system: stageSystem("decompose", language),
		prompt: seededPrompt({
			query: input.job.query,
			lifecycle: input.job.lifecycle,
			language,
		}),
	});
	usage = addUsage(usage, decompose.usage);
	const decomposeQueries = parseDecomposeQueries(decompose.text);
	const searchQueries =
		decomposeQueries.length > 0
			? decomposeQueries
			: fallbackDecomposeQueries(input.job.query);

	await input.dependencies.heartbeat?.({
		stage: "search",
		progressPercent: 25,
		progressDetails: { queries: searchQueries },
	});
	const search = await input.dependencies.searchWeb(searchQueries);

	await input.dependencies.heartbeat?.({
		stage: "curate",
		progressPercent: 40,
	});
	const curate = await input.dependencies.runModelStage({
		stage: "curate",
		system: stageSystem("curate", language),
		prompt: JSON.stringify({
			detectedLanguage: language,
			local: sources.localSources,
			web: search.sources,
			parentCuratedSourcePool:
				input.job.lifecycle.seed?.curatedSourcePool ?? null,
			atlasLifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, curate.usage);

	await input.dependencies.heartbeat?.({
		stage: "synthesize",
		progressPercent: 55,
	});
	const synthesize = await input.dependencies.runModelStage({
		stage: "synthesize",
		system: stageSystem("synthesize", language),
		prompt: JSON.stringify({
			detectedLanguage: language,
			curatedEvidence: curate.text,
			parentCompressedFindings:
				input.job.lifecycle.seed?.compressedFindings ?? null,
			atlasLifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, synthesize.usage);

	await input.dependencies.heartbeat?.({
		stage: "integrate",
		progressPercent: 70,
	});
	const integrate = await input.dependencies.runModelStage({
		stage: "integrate",
		system: stageSystem("integrate", language),
		prompt: JSON.stringify({
			detectedLanguage: language,
			synthesis: synthesize.text,
			atlasLifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, integrate.usage);

	await input.dependencies.heartbeat?.({
		stage: "assemble",
		progressPercent: 82,
	});
	const assemble = await input.dependencies.runModelStage({
		stage: "assemble",
		system: stageSystem("assemble", language),
		prompt: buildAssemblePrompt({
			language,
			query: input.job.query,
			curatedEvidence: curate.text,
			synthesis: synthesize.text,
			outline: integrate.text,
			sources: [
				...sources.localSources.map((source) => ({
					title: source.title,
					url: null,
					reasoning: source.text,
				})),
				...search.sources.map((source) => ({
					title: source.title,
					url: source.url,
					reasoning: source.snippet,
				})),
			],
			limitation: search.limitation,
			lifecycle: input.job.lifecycle.family,
		}),
	});
	usage = addUsage(usage, assemble.usage);
	let finalAssembledMarkdown = assemble.text;
	if (looksLikeProcessOnlyReport(finalAssembledMarkdown)) {
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 86,
		});
		const basePrompt = buildAssemblePrompt({
			language,
			query: input.job.query,
			curatedEvidence: curate.text,
			synthesis: synthesize.text,
			outline: integrate.text,
			sources: [
				...sources.localSources.map((source) => ({
					title: source.title,
					url: null,
					reasoning: source.text,
				})),
				...search.sources.map((source) => ({
					title: source.title,
					url: source.url,
					reasoning: source.snippet,
				})),
			],
			limitation: search.limitation,
			lifecycle: input.job.lifecycle.family,
		});
		const repair = await input.dependencies.runModelStage({
			stage: "assemble",
			system: stageSystem("assemble", language),
			prompt: buildAssembleRepairPrompt({
				basePrompt,
				previousDraft: finalAssembledMarkdown,
				language,
			}),
		});
		usage = addUsage(usage, repair.usage);
		finalAssembledMarkdown = repair.text;
	}
	if (looksLikeProcessOnlyReport(finalAssembledMarkdown)) {
		finalAssembledMarkdown = buildDeterministicFallbackReport({
			language,
			query: input.job.query,
			curatedEvidence: curate.text,
			synthesis: synthesize.text,
			outline: integrate.text,
			limitation: search.limitation,
		});
	}

	const auditSources = [
		...sources.localSources.map((source) => ({
			title: source.title,
			url: null,
			authority: source.authority,
			reasoning:
				source.authority === "explicit"
					? "You provided these"
					: source.authority === "working_document"
						? "Readable working document selected by Atlas"
						: "Parent or automatic library source selected by Atlas",
		})),
		...search.sources.map((source) => ({
			title: source.title,
			url: source.url,
			reasoning: source.snippet ?? "Accepted web evidence gathered by Atlas",
		})),
	];
	await input.dependencies.heartbeat?.({
		stage: "audit",
		progressPercent: 92,
	});
	let audit = await input.dependencies.auditBasis({
		assembledMarkdown: finalAssembledMarkdown,
		sources: auditSources,
		limitation: search.limitation,
		language,
	});
	if (audit.usage) {
		usage = addUsage(usage, audit.usage);
	}
	if (audit.retryRequested) {
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 88,
		});
		const revise = await input.dependencies.runModelStage({
			stage: "assemble",
			system:
				language === "hu"
					? "Dolgozd át az Atlas jelentést az audit megállapításai alapján. Tartsd meg az alátámasztott állításokat, vedd ki a nem alátámasztott bizonyosságot, és adj hozzá kifejezett korlátokat, ahol gyenge a bizonyíték. A jelentés magyar legyen."
					: "Revise the Atlas report to address audit findings. Preserve supported claims, remove unsupported certainty, and add explicit limitations where evidence is weak.",
			prompt: JSON.stringify({
				detectedLanguage: language,
				assembledMarkdown: finalAssembledMarkdown,
				auditFindings: audit,
				sources: auditSources,
			}),
		});
		usage = addUsage(usage, revise.usage);
		finalAssembledMarkdown = revise.text;
		await input.dependencies.heartbeat?.({
			stage: "audit",
			progressPercent: 94,
		});
		audit = await input.dependencies.auditBasis({
			assembledMarkdown: revise.text,
			sources: auditSources,
			limitation: search.limitation,
			language,
		});
		if (audit.usage) {
			usage = addUsage(usage, audit.usage);
		}
	}
	const auditedMarkdown =
		audit.passed && !audit.retryRequested
			? finalAssembledMarkdown
			: [
					finalAssembledMarkdown,
					"",
					"## Limitations",
					"Atlas audit requested additional verification. This version ships with explicit honesty markers instead of unsupported certainty.",
				].join("\n");

	await input.dependencies.writeCheckpoint({
		jobId: input.job.id,
		roundNumber: 1,
		stage: "audit",
		checkpoint: {
			assembledMarkdown: auditedMarkdown,
			honestyMarkers: audit.honestyMarkers,
		},
		curatedSourcePool: { local: sources.localSources, web: search.sources },
		compressedFindings: {
			synthesize: synthesize.text,
			integrate: integrate.text,
		},
		usage,
		qualityDiagnostics: audit,
		documentSourceSummary: {
			title: input.job.title,
			date: (input.now ?? new Date()).toISOString().slice(0, 10),
			atlasFamily: input.job.lifecycle.family,
			parentSeedUsed: input.job.lifecycle.seed
				? {
						parentAtlasJobId: input.job.lifecycle.seed.parentAtlasJobId,
						compressedFindings: true,
						curatedSourcePool:
							input.job.lifecycle.seed.curatedSourcePool !== null,
					}
				: null,
		},
	});

	if (!audit.passed) {
		throw new AtlasPipelineQualityError(audit.honestyMarkers);
	}

	const documentSource = buildAtlasDocumentSource({
		title: input.job.title,
		subtitle: `${input.job.profile} Atlas report`,
		family: input.job.lifecycle.family,
		assembledMarkdown: auditedMarkdown,
		sources: auditSources,
		honestyMarkers: audit.honestyMarkers,
		date: (input.now ?? new Date()).toISOString().slice(0, 10),
	});
	await input.dependencies.heartbeat?.({
		stage: "render",
		progressPercent: 97,
	});
	const outputs = await input.dependencies.renderOutputs(documentSource);

	return {
		status: "succeeded",
		stage: "audit",
		outputs,
		audit: {
			honestyMarkers: audit.honestyMarkers,
		},
		usage,
		sourceCounts: {
			local: sources.localSources.length,
			web: search.sources.length,
			accepted: sources.localSources.length + search.sources.length,
			rejected: search.rejectedSources?.length ?? 0,
		},
	};
}
