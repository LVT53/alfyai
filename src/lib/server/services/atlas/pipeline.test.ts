import { describe, expect, it, vi } from "vitest";

describe("Atlas pipeline slices", () => {
	it("runs the fixed pipeline order, writes checkpoints only after completed rounds, audits honesty markers, and renders sibling outputs", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const stages: string[] = [];
		const checkpointRounds: number[] = [];
		const heartbeat = vi.fn(async () => {});

		const result = await runAtlasPipeline({
			job: {
				id: "atlas-job-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "in-depth",
				title: "Atlas research",
				query: "Compare enterprise search architectures",
				lifecycle: {
					family: {
						familyId: "atlas-job-1",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-job-1",
						currentAtlasJobId: "atlas-job-1",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({
					localSources: [
						{
							id: "local-1",
							title: "Architecture notes",
							authority: "explicit",
							text: "Internal architecture constraints",
						},
					],
				})),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Vendor docs",
							url: "https://example.com/docs",
							snippet: "Official vendor docs",
						},
					],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					stages.push(input.stage);
					if (input.stage === "decompose") {
						return {
							text: "- enterprise search retrieval architecture\n- hybrid search evaluation methods",
							usage: {
								inputTokens: 10,
								outputTokens: 5,
								totalTokens: 15,
								costUsdMicros: 25,
							},
						};
					}
					return {
						text: `${input.stage} result`,
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							totalTokens: 15,
							costUsdMicros: 25,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [
						{
							code: "limited_web",
							message: "Web evidence is representative, not exhaustive.",
							severity: "info" as const,
						},
					],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async (checkpoint) => {
					checkpointRounds.push(checkpoint.roundNumber);
				}),
				heartbeat,
				renderOutputs: vi.fn(async (source) => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
					sourceTitle: source.title,
				})),
			},
		});

		expect(stages).toEqual([
			"decompose",
			"curate",
			"synthesize",
			"integrate",
			"assemble",
		]);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: {
				queries: [
					"enterprise search retrieval architecture",
					"hybrid search evaluation methods",
				],
			},
		});
		expect(checkpointRounds).toEqual([1]);
		expect(result).toMatchObject({
			status: "succeeded",
			stage: "audit",
			outputs: {
				fileProductionJobId: "fp-job-1",
				htmlChatGeneratedFileId: "file-html",
				pdfChatGeneratedFileId: "file-pdf",
				markdownChatGeneratedFileId: "file-md",
			},
			audit: {
				honestyMarkers: [
					{
						code: "limited_web",
						severity: "info",
					},
				],
			},
			usage: {
				inputTokens: 50,
				outputTokens: 25,
				totalTokens: 75,
				costUsdMicros: 125,
			},
		});
	});

	it("threads same-family lifecycle seeds into prompts, checkpoints, and rendered source metadata", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		const writeCheckpoint = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-child-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-2",
				action: "revise",
				parentAtlasJobId: "atlas-parent-1",
				profile: "in-depth",
				title: "Revised Atlas research",
				query: "Revise the report for implementation risks",
				lifecycle: {
					family: {
						familyId: "atlas-family-1",
						mode: "same_family",
						action: "revise",
						rootAtlasJobId: "atlas-root-1",
						currentAtlasJobId: "atlas-child-1",
						parentAtlasJobId: "atlas-parent-1",
						forkedFromAtlasJobId: null,
					},
					seed: {
						parentAtlasJobId: "atlas-parent-1",
						compressedFindings: {
							synthesize: "Prior compressed findings",
						},
						curatedSourcePool: {
							local: [{ id: "parent-local", title: "Parent source" }],
						},
						checkpoint: { assembledMarkdown: "Prior report" },
						documentSourceSummary: {
							atlasFamily: { familyId: "atlas-family-1" },
						},
					},
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					return {
						text: `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint,
				renderOutputs,
			},
		});

		expect(JSON.parse(prompts.decompose)).toMatchObject({
			query: "Revise the report for implementation risks",
			detectedLanguage: "en",
			atlasLifecycle: {
				action: "revise",
				parentSeed: {
					parentAtlasJobId: "atlas-parent-1",
					compressedFindings: { synthesize: "Prior compressed findings" },
				},
			},
		});
		expect(JSON.parse(prompts.curate)).toMatchObject({
			detectedLanguage: "en",
			parentCuratedSourcePool: {
				local: [{ id: "parent-local", title: "Parent source" }],
			},
			atlasLifecycle: {
				familyId: "atlas-family-1",
				mode: "same_family",
			},
		});
		expect(JSON.parse(prompts.synthesize)).toMatchObject({
			detectedLanguage: "en",
			parentCompressedFindings: { synthesize: "Prior compressed findings" },
		});
		expect(writeCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({
				documentSourceSummary: expect.objectContaining({
					atlasFamily: expect.objectContaining({
						familyId: "atlas-family-1",
						mode: "same_family",
						action: "revise",
					}),
					parentSeedUsed: {
						parentAtlasJobId: "atlas-parent-1",
						compressedFindings: true,
						curatedSourcePool: true,
					},
				}),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				cover: expect.objectContaining({
					eyebrow: "Report date: 2026-06-19",
				}),
			}),
		);
	});

	it("assembles final report content from curated evidence and synthesized findings rather than process summaries", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const prompts: Record<string, string> = {};
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-findings-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Retrieval Strategy Atlas",
				query: "Compare retrieval strategies",
				lifecycle: {
					family: {
						familyId: "atlas-findings-1",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-findings-1",
						currentAtlasJobId: "atlas-findings-1",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Evaluation report",
							url: "https://example.com/eval",
							snippet: "Hybrid retrieval improves recall but needs reranking.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					prompts[input.stage] = input.prompt;
					const textByStage: Record<string, string> = {
						decompose: "retrieval strategy evaluation",
						curate:
							"Curated fact: hybrid retrieval improves recall and reranking reduces noise.",
						synthesize:
							"Finding: hybrid retrieval is strongest when lexical recall is followed by semantic reranking.",
						integrate:
							"Outline: Executive Summary; Hybrid retrieval tradeoffs; Limitations.",
						assemble:
							"# Retrieval Strategy Atlas\n\n## Executive Summary\nHybrid retrieval is strongest when lexical recall is followed by semantic reranking.\n\n## Findings\nThe evidence shows recall improves when keyword and vector retrieval are combined, but source quality depends on reranking.",
					};
					return {
						text: textByStage[input.stage] ?? `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		const assemblePrompt = JSON.parse(prompts.assemble);
		expect(assemblePrompt.curatedEvidence).toContain("Curated fact");
		expect(assemblePrompt.synthesis).toContain("Finding: hybrid retrieval");
		expect(assemblePrompt.outline).toContain("Hybrid retrieval tradeoffs");
		expect(assemblePrompt.instructions).toContain("Do not write a process report");
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("Hybrid retrieval is strongest"),
					}),
				]),
			}),
		);
	});

	it("repairs a process-only assembled draft before audit and rendering", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		let assembleCalls = 0;
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-process-repair",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Process repair report",
				query: "Compare retrieval systems",
				lifecycle: {
					family: {
						familyId: "atlas-process-repair",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-process-repair",
						currentAtlasJobId: "atlas-process-repair",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({
					sources: [
						{
							id: "web-1",
							title: "Retrieval systems",
							url: "https://example.com/retrieval",
							snippet:
								"Fetched page excerpt: Hybrid retrieval combines lexical and semantic recall.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => {
					if (input.stage === "assemble") {
						assembleCalls += 1;
						return {
							text:
								assembleCalls === 1
									? "I checked the sources and synthesized findings for the report."
									: "# Retrieval Systems\n\n## Executive Summary\nThe evidence shows hybrid retrieval combines lexical and semantic recall.\n\n## Findings\nHybrid retrieval improves breadth while reranking controls noisy matches.",
							usage: {
								inputTokens: 1,
								outputTokens: 1,
								totalTokens: 2,
								costUsdMicros: 1,
							},
						};
					}
					return {
						text:
							input.stage === "decompose"
								? "retrieval systems"
								: `${input.stage} substantive output`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(assembleCalls).toBe(2);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("hybrid retrieval"),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("hybrid retrieval"),
					}),
				]),
			}),
		);
	});

	it("falls back to the user query when decompose returns no usable search queries", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-1",
					title: "Caching docs",
					url: "https://example.com/cache",
					snippet: "Cache strategy docs",
				},
			],
			limitation: null,
		}));
		const heartbeat = vi.fn(async () => {});

		await runAtlasPipeline({
			job: {
				id: "atlas-fallback-queries",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Browser caching",
				query: "Compare browser caching strategies for SaaS dashboards",
				lifecycle: {
					family: {
						familyId: "atlas-fallback-queries",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-fallback-queries",
						currentAtlasJobId: "atlas-fallback-queries",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => ({
					text: input.stage === "decompose" ? "" : `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis: vi.fn(async () => ({
					passed: true,
					honestyMarkers: [],
					retryRequested: false,
				})),
				writeCheckpoint: vi.fn(async () => {}),
				heartbeat,
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(searchWeb).toHaveBeenCalledWith([
			"Compare browser caching strategies for SaaS dashboards",
		]);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: {
				queries: ["Compare browser caching strategies for SaaS dashboards"],
			},
		});
	});

	it("fails the pipeline instead of rendering outputs when the audit gate has critical markers", async () => {
		const { AtlasPipelineQualityError, runAtlasPipeline } = await import(
			"./pipeline"
		);
		const writeCheckpoint = vi.fn(async () => {});
		const renderOutputs = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await expect(
			runAtlasPipeline({
				job: {
					id: "atlas-no-sources",
					userId: "user-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					action: "create",
					parentAtlasJobId: null,
					profile: "overview",
					title: "No-source report",
					query: "Research without sources",
					lifecycle: {
						family: {
							familyId: "atlas-no-sources",
							mode: "new_family",
							action: "create",
							rootAtlasJobId: "atlas-no-sources",
							currentAtlasJobId: "atlas-no-sources",
							parentAtlasJobId: null,
							forkedFromAtlasJobId: null,
						},
						seed: null,
					},
				},
				dependencies: {
					resolveSources: vi.fn(async () => ({ localSources: [] })),
					searchWeb: vi.fn(async () => ({
						sources: [],
						limitation: null,
					})),
					runModelStage: vi.fn(async (input) => ({
						text:
							input.stage === "decompose"
								? "Research without sources"
								: `${input.stage} result`,
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					})),
					auditBasis: vi.fn(async () => ({
						passed: false,
						honestyMarkers: [
							{
								code: "atlas_no_sources",
								message: "Atlas could not attach external sources.",
								severity: "critical" as const,
							},
						],
						retryRequested: false,
					})),
					writeCheckpoint,
					renderOutputs,
				},
			}),
		).rejects.toBeInstanceOf(AtlasPipelineQualityError);

		expect(writeCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({
				qualityDiagnostics: expect.objectContaining({
					passed: false,
				}),
			}),
		);
		expect(renderOutputs).not.toHaveBeenCalled();
	});

	it("detects Hungarian Atlas requests and carries that language through stage prompts and audit", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const systems: Record<string, string> = {};
		const auditBasis = vi.fn(async () => ({
			passed: true,
			honestyMarkers: [],
			retryRequested: false,
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-hu-1",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Magyar Atlas",
				query: "Kérlek kutasd meg a magyar vállalati keresési megoldásokat",
				lifecycle: {
					family: {
						familyId: "atlas-hu-1",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-hu-1",
						currentAtlasJobId: "atlas-hu-1",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb: vi.fn(async () => ({ sources: [], limitation: null })),
				runModelStage: vi.fn(async (input) => {
					systems[input.stage] = input.system;
					return {
						text:
							input.stage === "decompose" ? "- vállalati keresés" : "eredmény",
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
							costUsdMicros: 1,
						},
					};
				}),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(systems.decompose).toContain("magyar");
		expect(systems.assemble).toContain("magyar");
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({ language: "hu" }),
		);
	});
});
