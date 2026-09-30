import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVAL_CASES } from "./cases";
import { runToolSuite, TOOL_SUITES } from "./run-tool-suite";
import { scoreCanvasEval } from "./suites/canvas";
import { encodeToolPathResponse, type ToolPathRequestSpec } from "./tool-path";

const REAL_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const ENDPOINT = { baseUrl: "http://127.0.0.1:1/v1", model: "qwen3-6-27b" };

/** What a model that made a plain valid board would answer: two frames, five notes, one arrow. */
function boardAnswer(): string {
	const sticky = (
		id: string,
		text: string,
		x: number,
		parentId: string,
		y = 56,
	) => ({
		id,
		type: "sticky",
		parentId,
		position: { x, y },
		data: { kind: "sticky", text, tone: "yellow" },
	});
	const frame = (id: string, label: string, y: number) => ({
		id,
		type: "frame",
		position: { x: 40, y },
		data: { kind: "frame", label, width: 460, height: 260 },
	});
	return encodeToolPathResponse({
		toolCalls: [
			{
				name: "create_artifact",
				arguments: {
					artifactType: "canvas",
					title: "Vienna weekend",
					body: JSON.stringify({
						nodes: [
							frame("sat", "Saturday", 40),
							sticky("a", "Breakfast at Café Central", 20, "sat"),
							sticky("b", "The Kunsthistorisches Museum", 230, "sat"),
							frame("sun", "Sunday", 340),
							sticky("c", "Brunch in the Prater", 20, "sun"),
							sticky("d", "Train home", 230, "sun"),
							sticky("e", "A last coffee", 20, "sun", 152),
						],
						edges: [{ id: "e1", source: "a", target: "b" }],
					}),
				},
			},
		],
		content: "",
		finishReason: "tool_calls",
	});
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function deps(
	send: (
		endpoint: unknown,
		spec: ToolPathRequestSpec,
	) => Promise<{
		text: string;
	}>,
	fixturesRoot = REAL_FIXTURES,
) {
	return {
		endpoint: ENDPOINT,
		cases: EVAL_CASES,
		fixturesRoot,
		send: send as never,
		log: () => {},
		score: scoreCanvasEval,
		defaultThinking: "off" as const,
	};
}

describe("run-tool-suite: a live run through the tools", () => {
	it("registers the canvas suite as a tool suite", () => {
		expect(Object.keys(TOOL_SUITES)).toContain("canvas");
	});

	it("never sends a known-bad case to the model: it serves the committed answer (ruling 59)", async () => {
		const send = vi.fn(async () => ({ text: boardAnswer() }));
		const { report } = await runToolSuite(
			{
				suite: "canvas",
				only: ["canvas-create-vienna-en"],
				limit: null,
				thinking: null,
			},
			deps(send),
		);
		// One real case asked, four known-bad answered from disk.
		expect(send).toHaveBeenCalledTimes(1);
		expect(report.knownBadFailedAsExpected).toBe(true);
		expect(report.results.map((r) => r.caseId)).toEqual([
			"canvas-create-vienna-en",
		]);
	});

	it("asks the model for a real case exactly as the suite says: tools, auto choice, the case's language and message", async () => {
		const seen: ToolPathRequestSpec[] = [];
		const send = vi.fn(
			async (_endpoint: unknown, spec: ToolPathRequestSpec) => {
				seen.push(spec);
				return { text: boardAnswer() };
			},
		);
		await runToolSuite(
			{
				suite: "canvas",
				only: ["canvas-create-vienna-hu"],
				limit: null,
				thinking: null,
			},
			deps(send),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			language: "hu",
			toolChoice: "auto",
			thinking: "off",
		});
		const hungarian = EVAL_CASES.canvas.find(
			(c) => c.id === "canvas-create-vienna-hu",
		);
		expect(seen[0].user).toBe(hungarian?.prompt);
	});

	it("can run the same cases with thinking on, without touching the suite", async () => {
		const seen: ToolPathRequestSpec[] = [];
		const send = vi.fn(
			async (_endpoint: unknown, spec: ToolPathRequestSpec) => {
				seen.push(spec);
				return { text: boardAnswer() };
			},
		);
		await runToolSuite(
			{
				suite: "canvas",
				only: ["canvas-add-sunday"],
				limit: null,
				thinking: "on",
			},
			deps(send),
		);
		expect(seen[0].thinking).toBe("on");
	});

	it("scores what the model answered, with the suite's own scorer", async () => {
		const send = vi.fn(async () => ({ text: boardAnswer() }));
		const { report } = await runToolSuite(
			{
				suite: "canvas",
				only: ["canvas-create-vienna-en"],
				limit: null,
				thinking: null,
			},
			deps(send),
		);
		// Two frames, five notes and an arrow, in the right language, nothing
		// overlapping: what a plan needs, so good.
		expect(report.results[0].verdict).toBe("good");
	});

	it("records each real answer under fixtures/<suite>/responses, and only real ones", async () => {
		const root = mkdtempSync(join(tmpdir(), "canvas-fixtures-"));
		dirs.push(root);
		const send = vi.fn(async () => ({ text: boardAnswer() }));
		const { captured } = await runToolSuite(
			{
				suite: "canvas",
				only: ["canvas-create-vienna-en"],
				limit: null,
				thinking: null,
				writeResponses: true,
			},
			deps(send, root),
		);
		expect(captured.map((c) => c.caseId)).toEqual(["canvas-create-vienna-en"]);
		const written = JSON.parse(
			readFileSync(
				join(root, "canvas", "responses", "canvas-create-vienna-en.json"),
				"utf8",
			),
		);
		expect(written.response).toBe(boardAnswer());
		expect(typeof written.durationMs).toBe("number");
	});

	it("stops with a clear error for a suite that has no tool path", async () => {
		await expect(
			runToolSuite(
				{ suite: "app", only: null, limit: null, thinking: null },
				deps(vi.fn()),
			),
		).rejects.toThrow(/tool/i);
	});

	it("reads the HTTP status of a failed call, so the harness's retry and circuit breaker still apply", async () => {
		const send = vi.fn(async () => {
			const error = new Error("busy") as Error & { status: number };
			error.status = 503;
			throw error;
		});
		const { report } = await runToolSuite(
			{
				suite: "canvas",
				only: [
					"canvas-create-vienna-hu",
					"canvas-create-vienna-en",
					"canvas-add-sunday",
				],
				limit: null,
				thinking: null,
			},
			deps(send),
		);
		// Each case is tried twice (its one retry); two cases in a row ending in
		// 5xx stop the run before the third is asked.
		expect(send).toHaveBeenCalledTimes(4);
		expect(report.stoppedEarly).toBe(true);
	});
});
