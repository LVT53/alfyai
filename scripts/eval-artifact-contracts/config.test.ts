import { describe, expect, it } from "vitest";
import { resolveEvalArtifactsConfig } from "./config";

describe("resolveEvalArtifactsConfig", () => {
	it("defaults to suite=all, thinking=off, outDir=results, everything else unset", () => {
		const config = resolveEvalArtifactsConfig({});

		expect(config).toEqual({
			suite: "all",
			only: null,
			limit: null,
			replay: false,
			skipEval: false,
			thinking: "off",
			outDir: "results",
			baseUrl: null,
			model: null,
			apiKey: null,
		});
	});

	it("reads every switch from its own env var", () => {
		const config = resolveEvalArtifactsConfig({
			EVAL_ARTIFACTS_SUITE: "document",
			EVAL_ARTIFACTS_ONLY: "doc-01, doc-02 ,doc-03",
			EVAL_ARTIFACTS_LIMIT: "5",
			EVAL_ARTIFACTS_REPLAY: "1",
			EVAL_ARTIFACTS_SKIP_EVAL: "true",
			EVAL_ARTIFACTS_THINKING: "on",
			EVAL_ARTIFACTS_OUT: "custom-results",
			EVAL_ARTIFACTS_BASE_URL: "http://localhost:8000/v1",
			EVAL_ARTIFACTS_MODEL: "qwen3-6-27b",
			EVAL_ARTIFACTS_API_KEY: "sk-test",
		});

		expect(config).toEqual({
			suite: "document",
			only: ["doc-01", "doc-02", "doc-03"],
			limit: 5,
			replay: true,
			skipEval: true,
			thinking: "on",
			outDir: "custom-results",
			baseUrl: "http://localhost:8000/v1",
			model: "qwen3-6-27b",
			apiKey: "sk-test",
		});
	});

	it("treats EVAL_ARTIFACTS_SKIP_MODEL as an alias of EVAL_ARTIFACTS_REPLAY", () => {
		const config = resolveEvalArtifactsConfig({
			EVAL_ARTIFACTS_SKIP_MODEL: "1",
		});

		expect(config.replay).toBe(true);
	});

	it("treats anything other than 'on' as thinking off, case-insensitively", () => {
		expect(
			resolveEvalArtifactsConfig({ EVAL_ARTIFACTS_THINKING: "ON" }).thinking,
		).toBe("on");
		expect(
			resolveEvalArtifactsConfig({ EVAL_ARTIFACTS_THINKING: "off" }).thinking,
		).toBe("off");
		expect(
			resolveEvalArtifactsConfig({ EVAL_ARTIFACTS_THINKING: "nonsense" })
				.thinking,
		).toBe("off");
	});

	it("ignores a non-positive or non-numeric limit", () => {
		expect(
			resolveEvalArtifactsConfig({ EVAL_ARTIFACTS_LIMIT: "0" }).limit,
		).toBeNull();
		expect(
			resolveEvalArtifactsConfig({ EVAL_ARTIFACTS_LIMIT: "-3" }).limit,
		).toBeNull();
		expect(
			resolveEvalArtifactsConfig({ EVAL_ARTIFACTS_LIMIT: "abc" }).limit,
		).toBeNull();
	});

	it("treats an empty or whitespace-only value the same as unset", () => {
		const config = resolveEvalArtifactsConfig({
			EVAL_ARTIFACTS_SUITE: "   ",
			EVAL_ARTIFACTS_ONLY: "",
			EVAL_ARTIFACTS_BASE_URL: "  ",
		});

		expect(config.suite).toBe("all");
		expect(config.only).toBeNull();
		expect(config.baseUrl).toBeNull();
	});
});
