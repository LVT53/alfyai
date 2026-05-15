import { afterEach, describe, expect, it, vi } from "vitest";

// Mock process.env for testing
const originalEnv = process.env;

describe("Environment Configuration", () => {
	afterEach(() => {
		process.env = { ...originalEnv };
		vi.resetModules();
	});

	it("should use mock default when LANGFLOW_API_KEY is missing", async () => {
		// Clear the env var
		delete process.env.LANGFLOW_API_KEY;
		// Keep SESSION_SECRET set to isolate the test
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		const { config } = await import("./env");
		expect(config.langflowApiKey).toBe("mock-langflow-api-key");
	});

	it("should use mock default when SESSION_SECRET is missing", async () => {
		// Clear the env var
		delete process.env.SESSION_SECRET;
		// Keep LANGFLOW_API_KEY set to isolate the test
		process.env.LANGFLOW_API_KEY = "test-api-key";

		const { config } = await import("./env");
		expect(config.sessionSecret).toBe(
			"mock-session-secret-for-dev-testing-only",
		);
	});

	it("should apply defaults when optional vars are missing", async () => {
		// Set required vars
		process.env.LANGFLOW_API_KEY = "test-api-key";
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";

		// Clear optional vars to test defaults
		delete process.env.LANGFLOW_API_URL;
		delete process.env.LANGFLOW_FLOW_ID;
		delete process.env.LANGFLOW_WEBHOOK_SECRET;
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
		delete process.env.EXA_API_KEY;
		delete process.env.WEB_RESEARCH_EXA_SEARCH_TYPE;
		delete process.env.WEB_RESEARCH_EXA_NUM_RESULTS;
		delete process.env.WEB_RESEARCH_BRAVE_NUM_RESULTS;
		delete process.env.WEB_RESEARCH_MAX_SOURCES;
		delete process.env.WEB_RESEARCH_HIGHLIGHT_CHARS;
		delete process.env.WEB_RESEARCH_CONTENT_CHARS;
		delete process.env.WEB_RESEARCH_FRESHNESS_HOURS;
		delete process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.WEBHOOK_PORT;
		delete process.env.REQUEST_TIMEOUT_MS;
		delete process.env.MAX_MESSAGE_LENGTH;
		delete process.env.COMPOSER_COMMAND_REGISTRY_ENABLED;
		delete process.env.DATABASE_PATH;

		const { config } = await import("./env");

		expect(config.langflowApiUrl).toBe("http://localhost:7860");
		expect(config.langflowApiKey).toBe("test-api-key");
		expect(config.langflowFlowId).toBe("");
		expect(config.langflowWebhookSecret).toBe("");
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
		expect(config.teiEmbedderBatchSize).toBe(32);
		expect(config.teiRerankerUrl).toBe("");
		expect(config.teiRerankerApiKey).toBe("");
		expect(config.teiRerankerModel).toBe("");
		expect(config.teiRerankerMaxTexts).toBe(32);
		expect(config.teiTimeoutMs).toBe(300000);
		expect(config.exaApiKey).toBe("");
		expect(config.webResearchExaSearchType).toBe("auto");
		expect(config.webResearchExaNumResults).toBe(12);
		expect(config.webResearchBraveNumResults).toBe(10);
		expect(config.webResearchMaxSources).toBe(8);
		expect(config.webResearchHighlightChars).toBe(4000);
		expect(config.webResearchContentChars).toBe(12000);
		expect(config.webResearchFreshnessHours).toBe(24);
		expect(config.braveSearchApiKey).toBe("");
		expect(config.webhookPort).toBe(8090);
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
		process.env.LANGFLOW_API_KEY = "test-api-key";
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "false";

		const { config } = await import("./env");

		expect(config.composerCommandRegistryEnabled).toBe(false);
	});

	it("should return valid config object when all vars are present", async () => {
		// Set all env vars to test values
		process.env.LANGFLOW_API_URL = "http://test-langflow:8080";
		process.env.LANGFLOW_API_KEY = "test-api-key-123";
		process.env.LANGFLOW_FLOW_ID = "test-flow-id";
		process.env.LANGFLOW_WEBHOOK_SECRET = "test-webhook-secret";
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
		process.env.EXA_API_KEY = "exa-key";
		process.env.WEB_RESEARCH_EXA_SEARCH_TYPE = "instant";
		process.env.WEB_RESEARCH_EXA_NUM_RESULTS = "14";
		process.env.WEB_RESEARCH_BRAVE_NUM_RESULTS = "9";
		process.env.WEB_RESEARCH_MAX_SOURCES = "7";
		process.env.WEB_RESEARCH_HIGHLIGHT_CHARS = "3000";
		process.env.WEB_RESEARCH_CONTENT_CHARS = "16000";
		process.env.WEB_RESEARCH_FRESHNESS_HOURS = "6";
		process.env.BRAVE_SEARCH_API_KEY = "brave-key";
		process.env.WEBHOOK_PORT = "3000";
		process.env.REQUEST_TIMEOUT_MS = "5000";
		process.env.MODEL_TIMEOUT_FAILOVER_ENABLED = "true";
		process.env.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS = "2500";
		process.env.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL = "provider:backup";
		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "true";
		process.env.MAX_MESSAGE_LENGTH = "5000";
		process.env.SESSION_SECRET =
			"test-session-secret-12345678901234567890123456789012";
		process.env.DATABASE_PATH = "./test-data/test.db";

		const { config } = await import("./env");

		expect(config.langflowApiUrl).toBe("http://test-langflow:8080");
		expect(config.langflowApiKey).toBe("test-api-key-123");
		expect(config.langflowFlowId).toBe("test-flow-id");
		expect(config.langflowWebhookSecret).toBe("test-webhook-secret");
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
		expect(config.exaApiKey).toBe("exa-key");
		expect(config.webResearchExaSearchType).toBe("instant");
		expect(config.webResearchExaNumResults).toBe(14);
		expect(config.webResearchBraveNumResults).toBe(9);
		expect(config.webResearchMaxSources).toBe(7);
		expect(config.webResearchHighlightChars).toBe(3000);
		expect(config.webResearchContentChars).toBe(16000);
		expect(config.webResearchFreshnessHours).toBe(6);
		expect(config.braveSearchApiKey).toBe("brave-key");
		expect(config.webhookPort).toBe(3000);
		expect(config.requestTimeoutMs).toBe(5000);
		expect(config.modelTimeoutFailoverEnabled).toBe(true);
		expect(config.modelTimeoutFailoverTimeoutMs).toBe(2500);
		expect(config.modelTimeoutFailoverTargetModel).toBe("provider:backup");
		expect(config.composerCommandRegistryEnabled).toBe(true);
		expect(config.maxMessageLength).toBe(5000);
		expect(config.sessionSecret).toBe(
			"test-session-secret-12345678901234567890123456789012",
		);
		expect(config.databasePath).toBe("./test-data/test.db");
	});
});
