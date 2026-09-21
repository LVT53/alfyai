// The deadline, the page limit and the cancel signal, proved on the renderer
// they exist for.
//
// `FILE_PRODUCTION_RENDERER_TIMEOUT_MS` and `maxPdfPages` were both declared in
// `limits.ts` and enforced nowhere; the admin registry said as much with
// `effect: "unwired"`. The interesting half is not that they now fail a job, it
// is WHEN: the page limit has to stop layout at the page that crosses the line
// rather than after every page has been laid out, and the deadline has to be
// reachable at all from inside a synchronous pdf-lib layout.
import { describe, expect, it, vi } from "vitest";

// The verdict tests below are about which error code comes out of the adapter,
// not about the artifact row the document-source path writes on its way there.
vi.mock("./source-persistence", () => ({
	persistGeneratedDocumentSourceArtifact: vi.fn(async () => ({
		id: "artifact-1",
	})),
	markGeneratedDocumentSourceArtifactFailed: vi.fn(async () => null),
	renderGeneratedDocumentSourceText: vi.fn(() => null),
}));

import { executePersistedFileProductionRequest } from "./execution-adapter";
import {
	FileProductionRenderAbortedError,
	RenderBudget,
} from "./render-budget";
import {
	renderStandardReportPdf,
	StandardReportPdfRenderError,
} from "./renderers/standard-report-pdf";
import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
} from "./source-schema";

function source(blocks: GeneratedDocumentBlock[]): GeneratedDocumentSource {
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: "Budget report",
		blocks,
	};
}

/** Enough prose to fill roughly a page. */
const PAGE_OF_PROSE: GeneratedDocumentBlock = {
	type: "paragraph",
	text: "The quarter closed ahead of plan. ".repeat(180),
};

/** A clock the test moves by hand, so no assertion waits on real time. */
function manualClock(startMs = 0) {
	let current = startMs;
	return {
		now: () => current,
		advance(ms: number) {
			current += ms;
		},
	};
}

describe("RenderBudget", () => {
	it("throws once the deadline has passed, and not before", () => {
		const clock = manualClock();
		const budget = new RenderBudget({ timeoutMs: 100, now: clock.now });

		expect(() => budget.checkpoint()).not.toThrow();
		clock.advance(99);
		expect(() => budget.checkpoint()).not.toThrow();
		clock.advance(1);
		expect(() => budget.checkpoint()).toThrow(FileProductionRenderAbortedError);
		try {
			budget.checkpoint();
		} catch (error) {
			expect((error as FileProductionRenderAbortedError).code).toBe(
				"renderer_timeout",
			);
		}
	});

	it("reports a cancel as a cancel, not as a timeout", () => {
		const clock = manualClock();
		const controller = new AbortController();
		const budget = new RenderBudget({
			timeoutMs: 100,
			now: clock.now,
			signal: controller.signal,
		});

		// Past the deadline AND cancelled: the cancel is the true story, and
		// calling it a timeout would send the job down the retryable path.
		clock.advance(1_000);
		controller.abort();
		try {
			budget.checkpoint();
			throw new Error("expected the budget to throw");
		} catch (error) {
			expect((error as FileProductionRenderAbortedError).code).toBe(
				"render_cancelled",
			);
		}
	});

	it("never throws without a deadline or a signal", () => {
		const budget = new RenderBudget({});
		expect(() => budget.checkpoint()).not.toThrow();
	});

	it("hands the event loop back once the yield interval has passed", async () => {
		const clock = manualClock();
		const budget = new RenderBudget({ now: clock.now, yieldEveryMs: 50 });
		let timerRan = false;
		const timer = setTimeout(() => {
			timerRan = true;
		}, 0);

		// Too soon: no yield, so a pending macrotask cannot have run.
		clock.advance(10);
		await budget.yieldIfDue();
		expect(timerRan).toBe(false);

		clock.advance(50);
		await budget.yieldIfDue();
		expect(timerRan).toBe(true);
		clearTimeout(timer);
	});

	it("notices a cancel that arrived during the yield", async () => {
		const clock = manualClock();
		const controller = new AbortController();
		const budget = new RenderBudget({
			now: clock.now,
			yieldEveryMs: 1,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 0);

		clock.advance(10);
		await expect(budget.yieldIfDue()).rejects.toBeInstanceOf(
			FileProductionRenderAbortedError,
		);
	});
});

describe("the PDF page limit", () => {
	it("fails with page_limit_exceeded", async () => {
		await expect(
			renderStandardReportPdf(source([PAGE_OF_PROSE, PAGE_OF_PROSE]), {
				maxPages: 1,
			}),
		).rejects.toMatchObject({ code: "page_limit_exceeded" });
	});

	// The point of the limit is the CPU it does not spend. A check after
	// `pdfDoc.save()` would have reported the same error code, having laid out
	// and serialised the whole runaway document first.
	it("stops laying out at the page that crosses the line", async () => {
		const imageLoader = vi.fn(async () => ({
			ok: false as const,
			code: "image_limit_exceeded" as const,
			message: "not needed for this test",
		}));
		// An image between every page of prose, so how far layout got is
		// countable rather than a matter of timing.
		const blocks: GeneratedDocumentBlock[] = [];
		for (let index = 0; index < 40; index++) {
			blocks.push({
				type: "image",
				source: {
					kind: "https",
					url: `https://example.invalid/${index}.png`,
				},
				altText: `Figure ${index}`,
			});
			blocks.push(PAGE_OF_PROSE);
		}

		await expect(
			renderStandardReportPdf(source(blocks), { maxPages: 3, imageLoader }),
		).rejects.toBeInstanceOf(StandardReportPdfRenderError);

		// A handful, not forty: layout stopped inside the document.
		expect(imageLoader).not.toHaveBeenCalledTimes(40);
	});

	it("is not applied when no limit is given", async () => {
		const rendered = await renderStandardReportPdf(
			source([PAGE_OF_PROSE, PAGE_OF_PROSE]),
			{},
		);
		expect(rendered.diagnostics.pageCount).toBeGreaterThan(1);
	});
});

describe("the renderer deadline, inside a synchronous layout", () => {
	it("stops a long PDF layout part-way through", async () => {
		// The clock moves one millisecond per reading, so the deadline is reached
		// after a fixed number of checkpoints rather than after a wall-clock wait.
		let reading = 0;
		const budget = new RenderBudget({
			timeoutMs: 5,
			now: () => reading++,
			yieldEveryMs: 1,
		});
		const blocks = Array.from({ length: 200 }, () => PAGE_OF_PROSE);

		await expect(
			renderStandardReportPdf(source(blocks), { budget }),
		).rejects.toMatchObject({ code: "renderer_timeout" });
	});

	it("reaches a table's rows, not only its blocks", async () => {
		// One block, ten thousand rows: yielding between blocks alone would have
		// left this table holding the event loop for its whole layout.
		let reading = 0;
		const budget = new RenderBudget({
			timeoutMs: 20,
			now: () => reading++,
			yieldEveryMs: 1,
		});

		await expect(
			renderStandardReportPdf(
				source([
					{
						type: "table",
						columns: [
							{ key: "a", label: "A", kind: "text" },
							{ key: "b", label: "B", kind: "number" },
						],
						rows: Array.from({ length: 10_000 }, (_row, index) => ({
							a: `Row ${index}`,
							b: index,
						})),
					},
				]),
				{ budget },
			),
		).rejects.toMatchObject({ code: "renderer_timeout" });
	});
});

describe("the attempt's verdict", () => {
	function documentJob(blocks: GeneratedDocumentBlock[], outputs: string[]) {
		return JSON.stringify({
			sourceMode: "document_source",
			documentSource: source(blocks),
			outputs: outputs.map((type) => ({ type })),
		});
	}

	const jobInput = {
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: null,
		fileProductionJobId: "job-1",
		title: "Budget report",
		documentIntent: null,
	};

	it("is page_limit_exceeded, and is not retryable", async () => {
		const result = await executePersistedFileProductionRequest({
			...jobInput,
			requestJson: documentJob([PAGE_OF_PROSE, PAGE_OF_PROSE], ["markdown"]),
			limits: { maxPdfPages: 1 },
		});
		// Markdown has no pages; the limit is the PDF renderer's.
		expect(result.ok).toBe(true);

		const pdf = await executePersistedFileProductionRequest({
			...jobInput,
			requestJson: documentJob([PAGE_OF_PROSE, PAGE_OF_PROSE], ["pdf"]),
			limits: { maxPdfPages: 1 },
		});
		expect(pdf).toMatchObject({
			ok: false,
			errorCode: "page_limit_exceeded",
			retryable: false,
		});
	});

	it("is renderer_timeout, and IS retryable", async () => {
		const result = await executePersistedFileProductionRequest({
			...jobInput,
			requestJson: documentJob(
				Array.from({ length: 200 }, () => PAGE_OF_PROSE),
				["pdf"],
			),
			limits: { rendererTimeoutMs: 1 },
		});
		expect(result).toMatchObject({
			ok: false,
			errorCode: "renderer_timeout",
			retryable: true,
		});
	});

	it("is render_cancelled for an aborted attempt, and is not retryable", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await executePersistedFileProductionRequest({
			...jobInput,
			requestJson: documentJob([PAGE_OF_PROSE], ["pdf"]),
			signal: controller.signal,
		});
		expect(result).toMatchObject({
			ok: false,
			errorCode: "render_cancelled",
			retryable: false,
		});
	});

	it("carries the signal into the sandbox for a program job", async () => {
		const controller = new AbortController();
		const executeCode = vi.fn(async () => ({
			files: [],
			stdout: "",
			stderr: "",
			error: null as string | null,
		}));

		await executePersistedFileProductionRequest({
			...jobInput,
			requestJson: JSON.stringify({
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "print('hi')",
					filename: "out.txt",
				},
				outputs: [{ type: "txt" }],
			}),
			signal: controller.signal,
			executeCode,
		});

		expect(executeCode).toHaveBeenCalledWith("print('hi')", "python", {
			signal: controller.signal,
		});
	});
});
