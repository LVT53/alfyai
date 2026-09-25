import { afterEach, describe, expect, it, vi } from "vitest";

// Mock process.env for testing
const originalEnv = process.env;

describe("Environment Configuration", () => {
	afterEach(() => {
		process.env = { ...originalEnv };
		vi.resetModules();
	});

	it("should not require Langflow credentials at boot", async () => {
		delete process.env.LANGFLOW_API_KEY;
		delete process.env.LANGFLOW_API_URL;
		delete process.env.LANGFLOW_FLOW_ID;
		delete process.env.LANGFLOW_WEBHOOK_SECRET;
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		const { config } = await import("./env");
		expect(config).not.toHaveProperty("langflowApiKey");
		expect(config).not.toHaveProperty("langflowApiUrl");
		expect(config).not.toHaveProperty("langflowFlowId");
		expect(config).not.toHaveProperty("langflowWebhookSecret");
	});

	it("should use mock default when SESSION_SECRET is missing outside production", async () => {
		// Clear the env var. Outside production this still falls back, so local
		// dev and the test suites keep working; the production refusal is
		// covered in session-secret.test.ts and hooks.server.test.ts.
		delete process.env.SESSION_SECRET;

		const { config } = await import("./env");
		expect(config.sessionSecret).toBe(
			"mock-session-secret-for-dev-testing-only",
		);
	});

	it("never throws on a bad secret, because readConfig also runs at build time", async () => {
		// config-store.ts calls buildDefaultConfig() at module scope and
		// SvelteKit's postbuild `analyse` pass imports it, so reading the config
		// happens during `npm run build`. The production refusal therefore lives
		// at the runtime entry points (hooks.server.ts `init`,
		// scripts/prepare-db.ts), never here — a throw on this path would fail
		// the build on any host whose environment carries NODE_ENV=production.
		process.env.NODE_ENV = "production";
		delete process.env.PLAYWRIGHT_TEST;
		process.env.SESSION_SECRET = "change-me-to-a-random-long-secret";

		const { config } = await import("./env");
		expect(() => config.sessionSecret).not.toThrow();
		expect(config.sessionSecret).toBe("change-me-to-a-random-long-secret");
	});

	it("should apply defaults when optional vars are missing", async () => {
		// Set required vars
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		// Clear optional vars to test defaults
		delete process.env.ALFYAI_API_SIGNING_KEY;
		delete process.env.TITLE_GEN_URL;
		delete process.env.TITLE_GEN_API_KEY;
		delete process.env.TITLE_GEN_MODEL;
		delete process.env.TITLE_GEN_SYSTEM_PROMPT_EN;
		delete process.env.TITLE_GEN_SYSTEM_PROMPT_HU;
		delete process.env.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN;
		delete process.env.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU;
		delete process.env.TEI_EMBEDDER_URL;
		delete process.env.TEI_EMBEDDER_API_KEY;
		delete process.env.TEI_EMBEDDER_MODEL;
		delete process.env.TEI_EMBEDDER_BATCH_SIZE;
		delete process.env.TEI_RERANKER_URL;
		delete process.env.TEI_RERANKER_API_KEY;
		delete process.env.TEI_RERANKER_MODEL;
		delete process.env.TEI_RERANKER_MAX_TEXTS;
		delete process.env.TEI_TIMEOUT_MS;
		delete process.env.PARALLEL_API_KEY;
		delete process.env.PARALLEL_BASE_URL;
		delete process.env.PARALLEL_FREE_MONTHLY_USD;
		delete process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.WEBHOOK_PORT;
		delete process.env.REQUEST_TIMEOUT_MS;
		delete process.env.MAX_MESSAGE_LENGTH;
		delete process.env.COMPOSER_COMMAND_REGISTRY_ENABLED;
		delete process.env.DATABASE_PATH;

		const { config } = await import("./env");

		expect(config.alfyaiApiSigningKey).toBe("");
		expect(config.titleGenUrl).toBe("http://localhost:30001/v1");
		expect(config.titleGenApiKey).toBe("");
		expect(config.titleGenModel).toBe("nemotron-nano");
		expect(config.titleGenSystemPromptEn).toBe("");
		expect(config.titleGenSystemPromptHu).toBe("");
		expect(config.titleGenSystemPromptCodeAppendixEn).toBe("");
		expect(config.titleGenSystemPromptCodeAppendixHu).toBe("");
		expect(config.teiEmbedderUrl).toBe("");
		expect(config.teiEmbedderApiKey).toBe("");
		expect(config.teiEmbedderModel).toBe("");
		expect(config.teiEmbedderBatchSize).toBe(8);
		expect(config.teiRerankerUrl).toBe("");
		expect(config.teiRerankerApiKey).toBe("");
		expect(config.teiRerankerModel).toBe("");
		expect(config.teiRerankerMaxTexts).toBe(32);
		expect(config.teiTimeoutMs).toBe(300000);
		expect(config.parallelApiKey).toBe("");
		expect(config.parallelBaseUrl).toBe("https://api.parallel.ai");
		expect(config.parallelFreeMonthlyUsd).toBe(5);
		expect(config.braveSearchApiKey).toBe("");
		expect(config.requestTimeoutMs).toBe(300000);
		expect(config.modelTimeoutFailoverEnabled).toBe(false);
		expect(config.modelTimeoutFailoverTimeoutMs).toBe(60000);
		expect(config.modelTimeoutFailoverTargetModel).toBe("model2");
		expect(config.composerCommandRegistryEnabled).toBe(true);
		expect(config.maxMessageLength).toBe(1_048_576);
		expect(config.sessionSecret).toBe(
			"test-session-secret-12345678901234567890123456789012",
		);
		expect(config.databasePath).toBe("./data/chat.db");
	});

	it("should allow disabling Composer Command Registry explicitly", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "false";

		const { config } = await import("./env");

		expect(config.composerCommandRegistryEnabled).toBe(false);
	});

	it("defaults the Parallel free allowance to 5 USD", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		delete process.env.PARALLEL_FREE_MONTHLY_USD;

		const { config } = await import("./env");

		expect(config.parallelFreeMonthlyUsd).toBe(5);
	});

	it("accepts a zero Parallel free allowance", async () => {
		// Zero is meaningful — "charge every Parallel call" — so the parser
		// must not treat it as a missing value.
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.PARALLEL_FREE_MONTHLY_USD = "0";

		const { config } = await import("./env");

		expect(config.parallelFreeMonthlyUsd).toBe(0);
	});

	it("accepts a fractional Parallel free allowance", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.PARALLEL_FREE_MONTHLY_USD = "2.5";

		const { config } = await import("./env");

		expect(config.parallelFreeMonthlyUsd).toBe(2.5);
	});

	it("falls back to the default on a negative or garbage allowance", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		process.env.PARALLEL_FREE_MONTHLY_USD = "-1";
		expect((await import("./env")).config.parallelFreeMonthlyUsd).toBe(5);

		vi.resetModules();
		process.env.PARALLEL_FREE_MONTHLY_USD = "lots";
		expect((await import("./env")).config.parallelFreeMonthlyUsd).toBe(5);
	});

	// The home summary's cache TTL. Unset is the thirty seconds the home screen
	// is designed around; `0` is a real setting — "no cache", which the e2e
	// suite runs with because it seeds rows behind the server's back — so the
	// parser must not read it as missing.
	it("defaults the home summary cache TTL to thirty seconds", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		delete process.env.HOME_SUMMARY_CACHE_TTL_MS;

		const { config } = await import("./env");

		expect(config.homeSummaryCacheTtlMs).toBe(30_000);
	});

	it("reads a home summary cache TTL in milliseconds", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.HOME_SUMMARY_CACHE_TTL_MS = "5000";

		const { config } = await import("./env");

		expect(config.homeSummaryCacheTtlMs).toBe(5000);
	});

	it("accepts a zero home summary cache TTL as 'no cache'", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.HOME_SUMMARY_CACHE_TTL_MS = "0";

		const { config } = await import("./env");

		expect(config.homeSummaryCacheTtlMs).toBe(0);
	});

	it("falls back to the default on a garbage or negative home summary cache TTL", async () => {
		// Falls back rather than clamping: a negative clamped to 0 would quietly
		// turn a typo into "never cache".
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		process.env.HOME_SUMMARY_CACHE_TTL_MS = "soon";
		expect((await import("./env")).config.homeSummaryCacheTtlMs).toBe(30_000);

		vi.resetModules();
		process.env.HOME_SUMMARY_CACHE_TTL_MS = "-1";
		expect((await import("./env")).config.homeSummaryCacheTtlMs).toBe(30_000);
	});

	// The research_web answer-brief markdown cap. Unlike the home summary TTL,
	// `0` is NOT a real setting here — a brief-less payload makes no sense — so
	// it falls back to the default the same as a negative or garbage value.
	it("defaults the web research brief cap to 12000 characters", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		delete process.env.WEB_RESEARCH_BRIEF_MAX_CHARS;

		const { config } = await import("./env");

		expect(config.webResearchBriefMaxChars).toBe(12_000);
	});

	it("reads a web research brief cap in characters", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = "5000";

		const { config } = await import("./env");

		expect(config.webResearchBriefMaxChars).toBe(5000);
	});

	it("falls back to the default on a zero, garbage, or negative web research brief cap", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = "0";
		expect((await import("./env")).config.webResearchBriefMaxChars).toBe(
			12_000,
		);

		vi.resetModules();
		process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = "soon";
		expect((await import("./env")).config.webResearchBriefMaxChars).toBe(
			12_000,
		);

		vi.resetModules();
		process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = "-500";
		expect((await import("./env")).config.webResearchBriefMaxChars).toBe(
			12_000,
		);
	});

	it("should derive unset context budget defaults from the configured model window", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.MAX_MODEL_CONTEXT = "1000000";
		delete process.env.COMPACTION_UI_THRESHOLD;
		delete process.env.TARGET_CONSTRUCTED_CONTEXT;
		delete process.env.MODEL_1_MAX_MODEL_CONTEXT;
		delete process.env.MODEL_1_COMPACTION_UI_THRESHOLD;
		delete process.env.MODEL_1_TARGET_CONSTRUCTED_CONTEXT;
		delete process.env.MODEL_2_MAX_MODEL_CONTEXT;
		delete process.env.MODEL_2_COMPACTION_UI_THRESHOLD;
		delete process.env.MODEL_2_TARGET_CONSTRUCTED_CONTEXT;

		const { config } = await import("./env");

		expect(config.maxModelContext).toBe(1_000_000);
		expect(config.compactionUiThreshold).toBe(800_000);
		expect(config.targetConstructedContext).toBe(900_000);
		expect(config.model1MaxModelContext).toBe(1_000_000);
		expect(config.model1CompactionUiThreshold).toBe(800_000);
		expect(config.model1TargetConstructedContext).toBe(900_000);
		expect(config.model2MaxModelContext).toBe(1_000_000);
		expect(config.model2CompactionUiThreshold).toBe(800_000);
		expect(config.model2TargetConstructedContext).toBe(900_000);
	});

	it("should return valid config object when all vars are present", async () => {
		// Set all env vars to test values
		process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
		process.env.TITLE_GEN_URL = "http://test-nemotron:9000/v1";
		process.env.TITLE_GEN_API_KEY = "test-nemotron-key";
		process.env.TITLE_GEN_MODEL = "test-model";
		process.env.TITLE_GEN_SYSTEM_PROMPT_EN = "Write short titles only.";
		process.env.TITLE_GEN_SYSTEM_PROMPT_HU = "Irj rovid cimeket.";
		process.env.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN =
			"Mention the language when known.";
		process.env.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU =
			"Emeld ki a technológiát ha ismert.";
		process.env.TEI_EMBEDDER_URL = "http://embedder:8081";
		process.env.TEI_EMBEDDER_API_KEY = "embed-key";
		process.env.TEI_EMBEDDER_MODEL = "bge-m3";
		process.env.TEI_EMBEDDER_BATCH_SIZE = "24";
		process.env.TEI_RERANKER_URL = "http://reranker:8082";
		process.env.TEI_RERANKER_API_KEY = "rerank-key";
		process.env.TEI_RERANKER_MODEL = "bge-reranker-v2-m3";
		process.env.TEI_RERANKER_MAX_TEXTS = "16";
		process.env.TEI_TIMEOUT_MS = "4000";
		process.env.PARALLEL_API_KEY = "parallel-key";
		process.env.PARALLEL_BASE_URL = "http://127.0.0.1:9999";
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		process.env.REQUEST_TIMEOUT_MS = "5000";
		process.env.MODEL_TIMEOUT_FAILOVER_ENABLED = "true";
		process.env.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS = "2500";
		process.env.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL = "provider:backup:model-a";
		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "true";
		process.env.MAX_MESSAGE_LENGTH = "5000";
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.DATABASE_PATH = "./test-data/test.db";

		const { config } = await import("./env");

		expect(config.alfyaiApiSigningKey).toBe("test-signing-key");
		expect(config.titleGenUrl).toBe("http://test-nemotron:9000/v1");
		expect(config.titleGenApiKey).toBe("test-nemotron-key");
		expect(config.titleGenModel).toBe("test-model");
		expect(config.titleGenSystemPromptEn).toBe("Write short titles only.");
		expect(config.titleGenSystemPromptHu).toBe("Irj rovid cimeket.");
		expect(config.titleGenSystemPromptCodeAppendixEn).toBe(
			"Mention the language when known.",
		);
		expect(config.titleGenSystemPromptCodeAppendixHu).toBe(
			"Emeld ki a technológiát ha ismert.",
		);
		expect(config.teiEmbedderUrl).toBe("http://embedder:8081");
		expect(config.teiEmbedderApiKey).toBe("embed-key");
		expect(config.teiEmbedderModel).toBe("bge-m3");
		expect(config.teiEmbedderBatchSize).toBe(24);
		expect(config.teiRerankerUrl).toBe("http://reranker:8082");
		expect(config.teiRerankerApiKey).toBe("rerank-key");
		expect(config.teiRerankerModel).toBe("bge-reranker-v2-m3");
		expect(config.teiRerankerMaxTexts).toBe(16);
		expect(config.teiTimeoutMs).toBe(4000);
		expect(config.parallelApiKey).toBe("parallel-key");
		expect(config.parallelBaseUrl).toBe("http://127.0.0.1:9999");
		expect(config.braveSearchApiKey).toBe("brave-key");
		expect(config.requestTimeoutMs).toBe(5000);
		expect(config.modelTimeoutFailoverEnabled).toBe(true);
		expect(config.modelTimeoutFailoverTimeoutMs).toBe(2500);
		expect(config.modelTimeoutFailoverTargetModel).toBe(
			"provider:backup:model-a",
		);
		expect(config.composerCommandRegistryEnabled).toBe(true);
		expect(config.maxMessageLength).toBe(5000);
		expect(config.sessionSecret).toBe(
			"test-session-secret-12345678901234567890123456789012",
		);
		expect(config.databasePath).toBe("./test-data/test.db");
	});

	it("should ignore retired WEBHOOK_PORT values at boot", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.WEBHOOK_PORT = "not-a-number";

		const { config } = await import("./env");

		expect(config).not.toHaveProperty("webhookPort");
		expect(config.requestTimeoutMs).toBe(300000);
	});

	it("warns once, and only once, about a leftover ATLAS_PIPELINE", async () => {
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.ATLAS_PIPELINE = "v1";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { config } = await import("./env");
			void config.atlasStaleMonths;
			void config.atlasWorkerEnabled;
			const pipelineWarnings = warn.mock.calls.filter((call) =>
				String(call[0]).includes("ATLAS_PIPELINE"),
			);
			expect(pipelineWarnings).toEqual([
				[
					"[CONFIG] ATLAS_PIPELINE is no longer read; Atlas always runs pipeline v3.",
				],
			]);
			expect(config).not.toHaveProperty("atlasPipeline");
		} finally {
			warn.mockRestore();
		}
	});
});
