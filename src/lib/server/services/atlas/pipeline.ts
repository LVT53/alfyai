import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	type AtlasOutputIds,
	buildAtlasDocumentSource,
} from "./renderer-output";
import type {
	AtlasHonestyMarker,
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
}): string {
	return JSON.stringify({
		query: input.query,
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

export async function runAtlasPipeline(
	input: RunAtlasPipelineInput,
): Promise<AtlasPipelineResult> {
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
		system: "Break the Atlas question into durable research queries.",
		prompt: seededPrompt({
			query: input.job.query,
			lifecycle: input.job.lifecycle,
		}),
	});
	usage = addUsage(usage, decompose.usage);

	await input.dependencies.heartbeat?.({
		stage: "search",
		progressPercent: 25,
	});
	const search = await input.dependencies.searchWeb(
		decompose.text
			.split(/\r?\n/)
			.map((line) => line.replace(/^[-*\d.]+\s*/, "").trim())
			.filter(Boolean)
			.slice(0, 8),
	);

	await input.dependencies.heartbeat?.({
		stage: "curate",
		progressPercent: 40,
	});
	const curate = await input.dependencies.runModelStage({
		stage: "curate",
		system: "Curate Atlas local and web evidence.",
		prompt: JSON.stringify({
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
		system: "Synthesize Atlas findings from curated evidence.",
		prompt: JSON.stringify({
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
		system: "Integrate Atlas findings into a coherent report outline.",
		prompt: JSON.stringify({
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
		system: "Assemble final Atlas report Markdown.",
		prompt: integrate.text,
	});
	usage = addUsage(usage, assemble.usage);

	const auditSources = [
		...sources.localSources.map((source) => ({
			title: source.title,
			url: null,
		})),
		...search.sources.map((source) => ({
			title: source.title,
			url: source.url,
		})),
	];
	await input.dependencies.heartbeat?.({
		stage: "audit",
		progressPercent: 92,
	});
	let audit = await input.dependencies.auditBasis({
		assembledMarkdown: assemble.text,
		sources: auditSources,
		limitation: search.limitation,
	});
	if (audit.usage) {
		usage = addUsage(usage, audit.usage);
	}
	let finalAssembledMarkdown = assemble.text;
	if (audit.retryRequested) {
		await input.dependencies.heartbeat?.({
			stage: "assemble",
			progressPercent: 88,
		});
		const revise = await input.dependencies.runModelStage({
			stage: "assemble",
			system:
				"Revise the Atlas report to address audit findings. Preserve supported claims, remove unsupported certainty, and add explicit limitations where evidence is weak.",
			prompt: JSON.stringify({
				assembledMarkdown: assemble.text,
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
			rejected: 0,
		},
	};
}
