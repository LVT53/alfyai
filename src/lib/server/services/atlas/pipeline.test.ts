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
					if (input.stage === "assemble") {
						return {
							text: [
								"# Enterprise Search Architectures",
								"",
								"## Executive Summary",
								"Enterprise search architecture choices are mainly about balancing lexical recall, semantic matching, governance, and operational cost. Hybrid retrieval is the most defensible default when teams need reliable coverage and explainable matching across varied internal content.",
								"",
								"## Findings",
								"Keyword search remains useful for exact terminology, product names, error codes, and compliance language. Vector retrieval improves semantic discovery when users describe concepts rather than exact strings. A reranking layer is valuable because it can narrow broad candidate sets into evidence that better matches the user's intent.",
								"",
								"## Limitations",
								"This overview is based on representative sources and should be validated against the specific corpus, access model, and latency budget before implementation.",
							].join("\n"),
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
						assemble: [
							"# Retrieval Strategy Atlas",
							"",
							"## Executive Summary",
							"Hybrid retrieval is strongest when lexical recall is followed by semantic reranking. The accepted evidence points to a practical pattern: keyword retrieval preserves exact-match coverage, vector retrieval broadens conceptual recall, and reranking helps control noisy matches before the report or answer layer consumes the evidence.",
							"",
							"## Findings",
							"The evidence shows recall improves when keyword and vector retrieval are combined, but source quality depends on reranking. Teams should treat the first retrieval pass as a candidate generator rather than a final evidence set. The stronger architecture keeps search broad, then converges on fewer accepted sources that can be quoted and audited.",
							"",
							"## Limitations",
							"This finding is bounded by the accepted source set and should be validated with corpus-specific evaluation before production rollout.",
						].join("\n"),
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
		expect(assemblePrompt.instructions).toContain(
			"Do not write a process report",
		);
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
									: [
											"# Retrieval Systems",
											"",
											"## Executive Summary",
											"The evidence shows hybrid retrieval combines lexical and semantic recall. That combination is useful because lexical matching keeps exact domain terms visible while semantic search catches related concepts that do not share the same wording.",
											"",
											"## Findings",
											"Hybrid retrieval improves breadth while reranking controls noisy matches. A broad first pass should not become the quoted evidence set by itself; the system needs a convergence step that ranks, filters, and keeps only the strongest accepted sources for final claims.",
											"",
											"## Limitations",
											"The conclusion is limited to the accepted evidence in this smoke fixture and does not claim that one retrieval stack is universally best.",
										].join("\n"),
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

	it("falls back to synthesized findings when assembly remains source-only", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
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
				id: "atlas-source-only",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Source-only report",
				query: "Explain routing docs history",
				lifecycle: {
					family: {
						familyId: "atlas-source-only",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-source-only",
						currentAtlasJobId: "atlas-source-only",
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
							title: "Routing docs",
							url: "https://example.com/routing",
							snippet:
								"Fetched page excerpt: SvelteKit routing is filesystem based.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "SvelteKit routing docs"
							: input.stage === "synthesize"
								? "SvelteKit routing documentation centers on filesystem routing and route files, with later documentation clarifying layout, server-only endpoints, and dynamic parameters."
								: input.stage === "curate"
									? "Curated evidence: SvelteKit docs describe src/routes as the routing root and +page.svelte, +layout.svelte, and +server files as route file conventions."
									: input.stage === "integrate"
										? "Outline: Executive Summary; Findings; Limitations."
										: "# Source-only report\n\n2026-06-19",
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining("## Executive Summary"),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("filesystem based"),
					}),
				]),
			}),
		);
	});

	it("uses accepted source excerpts when model stages collapse to generic fallback text", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
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
				id: "atlas-source-derived-fallback",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Source-derived fallback",
				query: "Explain routing docs history without a process summary",
				lifecycle: {
					family: {
						familyId: "atlas-source-derived-fallback",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-source-derived-fallback",
						currentAtlasJobId: "atlas-source-derived-fallback",
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
							title: "Routing docs",
							url: "https://example.com/routing",
							snippet:
								"Search result snippet: At the heart of SvelteKit is a filesystem-based router. Fetched page excerpt: The routes of your app are defined by the directories in your codebase, with src/routes as the root route.",
						},
						{
							id: "web-2",
							title: "Route files docs",
							url: "https://example.com/route-files",
							snippet:
								"Fetched page excerpt: A +page.svelte component defines a page of your app, while +server files define API endpoints for matching routes.",
						},
					],
					rejectedSources: [],
					limitation: null,
				})),
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "SvelteKit routing docs"
							: input.stage === "assemble"
								? "I checked the sources and synthesized findings for the report."
								: `${input.stage} result`,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						totalTokens: 2,
						costUsdMicros: 1,
					},
				})),
				auditBasis,
				writeCheckpoint: vi.fn(async () => {}),
				renderOutputs,
			},
		});

		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.stringContaining(
					'"Routing docs" shows that at the heart of SvelteKit is a filesystem-based router.',
				),
			}),
		);
		expect(auditBasis).toHaveBeenCalledWith(
			expect.objectContaining({
				assembledMarkdown: expect.not.stringContaining(
					"Atlas did not receive a detailed enough synthesis",
				),
			}),
		);
		expect(renderOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				blocks: expect.arrayContaining([
					expect.objectContaining({
						type: "paragraph",
						text: expect.stringContaining("filesystem-based router"),
					}),
				]),
			}),
		);
	});

	it("falls back to generated search variants when decompose returns no usable search queries", async () => {
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

		const expectedQueries = [
			"browser caching strategies SaaS dashboards evidence",
			"browser caching strategies SaaS dashboards comparison",
			"browser caching strategies SaaS dashboards best practices",
		];
		expect(searchWeb).toHaveBeenCalledWith(expectedQueries);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: {
				queries: expectedQueries,
			},
		});
	});

	it("adds current-date grounding to freshness-sensitive news searches instead of trusting stale model years", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-1",
					title: "Current AI regulation news",
					url: "https://example.com/ai-regulation-2026",
					snippet: "Fresh 2026 reporting on AI regulation.",
				},
			],
			limitation: null,
		}));

		await runAtlasPipeline({
			job: {
				id: "atlas-current-news",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "Current news Atlas",
				query: "What is the latest news on AI regulation?",
				lifecycle: {
					family: {
						familyId: "atlas-current-news",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-current-news",
						currentAtlasJobId: "atlas-current-news",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose"
							? "AI regulation latest news 2024"
							: `${input.stage} result`,
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
				renderOutputs: vi.fn(async () => ({
					fileProductionJobId: "fp-job-1",
					htmlChatGeneratedFileId: "file-html",
					pdfChatGeneratedFileId: "file-pdf",
					markdownChatGeneratedFileId: "file-md",
				})),
			},
		});

		expect(searchWeb).toHaveBeenCalledWith(
			expect.arrayContaining([
				"AI regulation latest news 2026",
				"What is the latest news on AI regulation recent news 2026",
			]),
		);
		expect(searchWeb).not.toHaveBeenCalledWith(
			expect.arrayContaining(["AI regulation latest news 2024"]),
		);
	});

	it("does not surface the original prompt as the only research query when decompose echoes it", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const userPrompt =
			"Please research the current enterprise RAG architecture patterns for regulated SaaS teams";
		const searchWeb = vi.fn(async () => ({
			sources: [
				{
					id: "web-1",
					title: "RAG architecture docs",
					url: "https://example.com/rag",
					snippet: "RAG architecture docs",
				},
			],
			limitation: null,
		}));
		const heartbeat = vi.fn(async () => {});

		await runAtlasPipeline({
			job: {
				id: "atlas-prompt-echo",
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				action: "create",
				parentAtlasJobId: null,
				profile: "overview",
				title: "RAG architecture",
				query: userPrompt,
				lifecycle: {
					family: {
						familyId: "atlas-prompt-echo",
						mode: "new_family",
						action: "create",
						rootAtlasJobId: "atlas-prompt-echo",
						currentAtlasJobId: "atlas-prompt-echo",
						parentAtlasJobId: null,
						forkedFromAtlasJobId: null,
					},
					seed: null,
				},
			},
			now: new Date("2026-06-19T13:00:00.000Z"),
			dependencies: {
				resolveSources: vi.fn(async () => ({ localSources: [] })),
				searchWeb,
				runModelStage: vi.fn(async (input) => ({
					text:
						input.stage === "decompose" ? userPrompt : `${input.stage} result`,
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

		const expectedQueries = [
			"current enterprise RAG architecture patterns regulated SaaS teams evidence 2026",
			"current enterprise RAG architecture patterns regulated SaaS teams comparison 2026",
			"current enterprise RAG architecture patterns regulated SaaS teams best practices 2026",
			"Please research the current enterprise RAG architecture patterns for regulated SaaS teams recent news 2026",
			"Please research the current enterprise RAG architecture patterns for regulated SaaS teams latest updates 2026",
		];
		expect(searchWeb).toHaveBeenCalledWith(expectedQueries);
		expect(searchWeb).not.toHaveBeenCalledWith([userPrompt]);
		expect(heartbeat).toHaveBeenCalledWith({
			stage: "search",
			progressPercent: 25,
			progressDetails: { queries: expectedQueries },
		});
	});

	it("uses the selected Atlas profile to change search breadth", async () => {
		const { runAtlasPipeline } = await import("./pipeline");
		const queryCountsByProfile: Record<string, number> = {};
		const decomposeSystemsByProfile: Record<string, string> = {};
		const manyQueries = Array.from(
			{ length: 28 },
			(_value, index) => `SvelteKit routing profile query ${index + 1}`,
		).join("\n");

		for (const profile of ["overview", "in-depth", "exhaustive"] as const) {
			await runAtlasPipeline({
				job: {
					id: `atlas-profile-${profile}`,
					userId: "user-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					action: "create",
					parentAtlasJobId: null,
					profile,
					title: `Profile ${profile}`,
					query: "Compare SvelteKit routing documentation history",
					lifecycle: {
						family: {
							familyId: `atlas-profile-${profile}`,
							mode: "new_family",
							action: "create",
							rootAtlasJobId: `atlas-profile-${profile}`,
							currentAtlasJobId: `atlas-profile-${profile}`,
							parentAtlasJobId: null,
							forkedFromAtlasJobId: null,
						},
						seed: null,
					},
				},
				dependencies: {
					resolveSources: vi.fn(async () => ({ localSources: [] })),
					searchWeb: vi.fn(async (queries) => {
						queryCountsByProfile[profile] = queries.length;
						return {
							sources: [
								{
									id: `web-${profile}`,
									title: "Routing docs",
									url: "https://example.com/routing",
									snippet:
										"SvelteKit routing documentation describes filesystem routes.",
								},
							],
							rejectedSources: [],
							limitation: null,
						};
					}),
					runModelStage: vi.fn(async (input) => ({
						text: (() => {
							if (input.stage === "decompose") {
								decomposeSystemsByProfile[profile] = input.system;
								return manyQueries;
							}
							return [
										"# Profile report",
										"",
										"## Executive Summary",
										"The evidence shows SvelteKit routing documentation centers on filesystem routes and route files, with enough detail for a concise profile comparison report.",
										"",
										"## Findings",
										"Profile-specific search breadth should change how many decomposed queries reach search, while the fixed pipeline and audit still run for every profile.",
										"",
										"## Limitations",
										"This fixture uses one accepted source and focuses on profile routing behavior.",
									].join("\n");
						})(),
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
					renderOutputs: vi.fn(async () => ({
						fileProductionJobId: `fp-${profile}`,
						htmlChatGeneratedFileId: `html-${profile}`,
						pdfChatGeneratedFileId: `pdf-${profile}`,
						markdownChatGeneratedFileId: `md-${profile}`,
					})),
				},
			});
		}

		expect(queryCountsByProfile).toEqual({
			overview: 6,
			"in-depth": 14,
			exhaustive: 28,
		});
		expect(decomposeSystemsByProfile.overview).toContain(
			"Profile posture: Overview",
		);
		expect(decomposeSystemsByProfile["in-depth"]).toContain(
			"Profile posture: In-Depth",
		);
		expect(decomposeSystemsByProfile.exhaustive).toContain(
			"Profile posture: Exhaustive",
		);
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
