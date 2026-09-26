import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveEvalArtifactsConfig } from "./config";

describe("resolveEvalArtifactsConfig", () => {
	it("defaults to suite=all, thinking=off, everything else unset", () => {
		const config = resolveEvalArtifactsConfig({});

		expect(config).toEqual({
			suite: "all",
			only: null,
			limit: null,
			replay: false,
			skipEval: false,
			thinking: "off",
			// Asserted precisely, separately, below — it must be an absolute
			// path, not the bare cwd-relative string this used to be.
			outDir: expect.any(String),
			baseUrl: null,
			model: null,
			apiKey: null,
		});
	});

	it("defaults outDir to an absolute path under this harness's own gitignored results/, independent of cwd", () => {
		// A relative default ("results") would resolve against
		// process.cwd() in run.ts (`resolve(process.cwd(), outDir)`), so a
		// run from the repo root landed outside
		// scripts/eval-artifact-contracts/results/* — the directory
		// .gitignore actually excludes — and could be committed by
		// accident. The default must be absolute and anchored to this
		// module's own location, not the invoking shell's cwd.
		//
		// Built with dirname(fileURLToPath(import.meta.url)), NOT
		// fileURLToPath(new URL(".", import.meta.url)): the latter is
		// Vite's own static asset-URL convention, so under vitest it
		// silently resolves to an http://localhost dev-server URL instead
		// of a real file: path — see config.ts's DEFAULT_OUT_DIR comment.
		const config = resolveEvalArtifactsConfig({});
		const thisDir = dirname(fileURLToPath(import.meta.url));

		expect(isAbsolute(config.outDir)).toBe(true);
		expect(config.outDir).toBe(join(thisDir, "results"));
		expect(
			config.outDir.endsWith(
				join("scripts", "eval-artifact-contracts", "results"),
			),
		).toBe(true);
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
