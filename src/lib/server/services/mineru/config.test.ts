import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	isMineruConfigured,
	isSameMineruOrigin,
	MINERU_DEFAULT_TIER_VALUES,
	MINERU_OCR_MODES,
	MINERU_OUTPUT_FORMATS,
	MINERU_TIER_IDS,
	mineruDisplayOrigin,
	mineruUrl,
	resolveMineruConfig,
} from "./config";

function runtime(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return {
		mineruApiUrl: "http://127.0.0.1:8001",
		mineruApiKey: "",
		mineruDefaultTier: "auto",
		mineruOcrMode: "auto",
		mineruJobTimeoutMs: 300000,
		mineruPollMinMs: 2000,
		mineruPollMaxMs: 30000,
		mineruRequestTimeoutMs: 30000,
		mineruTransferTimeoutMs: 600000,
		mineruCapabilitiesTtlMs: 300000,
		mineruBundleMaxBytes: 33554432,
		mineruStructureChunkingEnabled: true,
		...overrides,
	} as RuntimeConfig;
}

describe("resolveMineruConfig", () => {
	it("projects every key straight through", () => {
		expect(resolveMineruConfig(runtime())).toEqual({
			baseUrl: "http://127.0.0.1:8001",
			apiKey: "",
			defaultTier: "auto",
			ocrMode: "auto",
			jobTimeoutMs: 300000,
			pollMinMs: 2000,
			pollMaxMs: 30000,
			requestTimeoutMs: 30000,
			transferTimeoutMs: 600000,
			capabilitiesTtlMs: 300000,
			bundleMaxBytes: 33554432,
			structureChunking: true,
		});
	});

	it("strips trailing slashes so mineruUrl never doubles one", () => {
		const config = resolveMineruConfig(
			runtime({ mineruApiUrl: "http://mineru.internal:8001///" }),
		);
		expect(config.baseUrl).toBe("http://mineru.internal:8001");
		expect(mineruUrl(config, "/v1/health")).toBe(
			"http://mineru.internal:8001/v1/health",
		);
	});

	it("trims the API key so a pasted newline is not sent as a bearer token", () => {
		expect(
			resolveMineruConfig(runtime({ mineruApiKey: " sk-1\n" })).apiKey,
		).toBe("sk-1");
	});

	it("clamps an unrecognised tier or ocr mode to auto rather than throwing", () => {
		// The admin route validates both against their select specs, so the only
		// way a bad value arrives is a hand-edited environment. Deferring to the
		// server beats refusing to extract anything.
		const config = resolveMineruConfig(
			runtime({ mineruDefaultTier: "turbo", mineruOcrMode: "maybe" }),
		);
		expect(config.defaultTier).toBe("auto");
		expect(config.ocrMode).toBe("auto");
	});

	it("accepts the configured values case-insensitively", () => {
		const config = resolveMineruConfig(
			runtime({ mineruDefaultTier: "Basic", mineruOcrMode: "OCR" }),
		);
		expect(config.defaultTier).toBe("basic");
		expect(config.ocrMode).toBe("ocr");
	});
});

describe("mineruUrl", () => {
	it("refuses a base URL that is not absolute", () => {
		const config = resolveMineruConfig(
			runtime({ mineruApiUrl: "127.0.0.1:8001" }),
		);
		expect(() => mineruUrl(config, "/v1/health")).toThrow(/absolute/);
	});
});

describe("isSameMineruOrigin", () => {
	const config = resolveMineruConfig(
		runtime({ mineruApiUrl: "http://127.0.0.1:8765" }),
	);

	it("accepts the server's own upload URL", () => {
		expect(
			isSameMineruOrigin(
				config,
				"http://127.0.0.1:8765/v1/uploads/upload_7e33/content",
			),
		).toBe(true);
	});

	it("rejects a different port, host or scheme", () => {
		// The API key must never be forwarded to an origin the admin did not
		// configure; a server-supplied upload_url is the one place we would.
		expect(isSameMineruOrigin(config, "http://127.0.0.1:9999/x")).toBe(false);
		expect(isSameMineruOrigin(config, "http://evil.test/x")).toBe(false);
		expect(isSameMineruOrigin(config, "https://127.0.0.1:8765/x")).toBe(false);
	});

	it("rejects anything that is not a URL at all", () => {
		expect(isSameMineruOrigin(config, "not a url")).toBe(false);
	});
});

describe("endpoint helpers", () => {
	it("reports an empty endpoint as unconfigured", () => {
		expect(isMineruConfigured(resolveMineruConfig(runtime()))).toBe(true);
		expect(
			isMineruConfigured(resolveMineruConfig(runtime({ mineruApiUrl: "  " }))),
		).toBe(false);
	});

	it("shows the origin only, never a path", () => {
		expect(
			mineruDisplayOrigin(
				resolveMineruConfig(runtime({ mineruApiUrl: "http://host:8001/base" })),
			),
		).toBe("http://host:8001");
	});
});

describe("vocabularies", () => {
	it("keeps auto out of the tier ids and inside the configurable values", () => {
		expect(MINERU_TIER_IDS).toEqual(["flash", "basic", "standard", "advanced"]);
		expect(MINERU_DEFAULT_TIER_VALUES).toEqual([
			"auto",
			"flash",
			"basic",
			"standard",
			"advanced",
		]);
		expect(MINERU_OCR_MODES).toEqual(["auto", "txt", "ocr"]);
	});

	it("requests the four formats every recorded fixture requested", () => {
		expect(MINERU_OUTPUT_FORMATS).toEqual([
			"markdown",
			"middle_json",
			"structured_content",
			"zip",
		]);
	});
});
