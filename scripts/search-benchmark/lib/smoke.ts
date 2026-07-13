import { config as dotenvConfig } from "dotenv";

// Must load env + DATABASE_PATH BEFORE importing server modules that open the DB at import time.
dotenvConfig();
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

async function main() {
	const web = await import("../../../src/lib/server/services/web-research/index");
	const providers = await import("../../../src/lib/server/services/providers");
	const url = await import(
		"../../../src/lib/server/services/openai-compatible-url"
	);
	console.log(
		"imports ok:",
		typeof web.researchWeb,
		typeof providers.getProviderWithSecrets,
		typeof url.normalizeOpenAICompatibleBaseUrl,
	);
	const provs = await providers.listProviders();
	console.log(
		"providers resolved from DB:",
		provs.map((p) => `${p.name}(${p.enabled ? "on" : "off"})`).join(", "),
	);
	const ds = provs.find((p) => p.name === "deepseek");
	console.log("deepseek baseUrl:", ds?.baseUrl);
}

main().catch((error) => {
	console.error("SMOKE_FAIL:", error);
	process.exitCode = 1;
});
