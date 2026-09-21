// Cost of the cooperative render budget, measured rather than asserted from
// first principles.
//
// Two numbers matter and they pull against each other:
//
//   - TOTAL render time must not regress meaningfully. Every yield is a
//     macrotask hop, and a renderer that stops to hop every few rows would be
//     paying for the deadline it is enforcing.
//   - The LONGEST uninterrupted stretch on the event loop must come down to
//     well under a second. That is the whole point: at ~9.5 s for a source at
//     the 2 MB ceiling, the attempt's 15 s heartbeat, every other request on
//     the box and the abort signal were all frozen behind pdf-lib's layout, and
//     a `setTimeout`-based renderer timeout could never have fired.
//
// The longest block is measured with a 10 ms interval timer: it can only tick
// when the loop is free, so the largest gap between consecutive ticks IS the
// longest stretch during which nothing else could run. That is the same timer
// starvation the heartbeat suffers, measured directly.
//
// Skipped unless FILE_PRODUCTION_BENCH=1. It is a timing measurement on a
// deliberately large fixture, which is not something to run on every CI push.
import { describe, expect, it } from "vitest";
import { RenderBudget } from "../render-budget";
import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
} from "../source-schema";
import { renderStandardReportPdf } from "./standard-report-pdf";

const ENABLED = process.env.FILE_PRODUCTION_BENCH === "1";

/**
 * A large source. `FILE_PRODUCTION_BENCH_SECTIONS` scales it; the default 40
 * is ~220 pages and a couple of seconds, and 200 puts the serialised source at
 * roughly the 2 MB `maxSourceJsonBytes` ceiling, which is the worst case
 * `config.ts` quotes at ~9.5 s.
 */
function largeSource(): GeneratedDocumentSource {
	const sections = Number(process.env.FILE_PRODUCTION_BENCH_SECTIONS ?? 40);
	const blocks: GeneratedDocumentBlock[] = [];
	const sentence =
		"Revenue in the northern region grew twelve percent quarter over quarter, driven by renewals rather than new logos. ";
	for (let section = 0; section < sections; section++) {
		blocks.push({ type: "heading", level: 2, text: `Section ${section + 1}` });
		for (let paragraph = 0; paragraph < 8; paragraph++) {
			blocks.push({ type: "paragraph", text: sentence.repeat(6) });
		}
		blocks.push({
			type: "table",
			title: `Detail ${section + 1}`,
			columns: [
				{ key: "region", label: "Region", kind: "text" },
				{ key: "quarter", label: "Quarter", kind: "text" },
				{ key: "revenue", label: "Revenue", kind: "number" },
				{ key: "growth", label: "Growth", kind: "number" },
			],
			rows: Array.from({ length: 120 }, (_row, index) => ({
				region: `Region ${index % 12}`,
				quarter: `Q${(index % 4) + 1}`,
				revenue: 1000 + index * 7,
				growth: index % 19,
			})),
		});
	}
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: "Large report",
		blocks,
	};
}

/** Renders while sampling how long the event loop was unavailable. */
async function renderAndSample(
	source: GeneratedDocumentSource,
	budget: RenderBudget | undefined,
): Promise<{ totalMs: number; longestBlockMs: number; pages: number }> {
	let last = performance.now();
	let longestBlockMs = 0;
	const sampler = setInterval(() => {
		const now = performance.now();
		longestBlockMs = Math.max(longestBlockMs, now - last);
		last = now;
	}, 10);
	sampler.unref?.();

	const startedAt = performance.now();
	last = startedAt;
	const rendered = await renderStandardReportPdf(source, { budget });
	const totalMs = performance.now() - startedAt;
	longestBlockMs = Math.max(longestBlockMs, performance.now() - last);
	clearInterval(sampler);
	return {
		totalMs,
		longestBlockMs,
		pages: rendered.diagnostics.pageCount,
	};
}

describe.skipIf(!ENABLED)("PDF render budget cost", () => {
	it("bounds the event loop without meaningfully slowing the render", async () => {
		const source = largeSource();

		// Warm the font embedding and the JIT so the two numbers compare.
		await renderStandardReportPdf(source, {});

		const before = await renderAndSample(source, undefined);
		const after = await renderAndSample(source, new RenderBudget({}));

		console.info("[BENCH] standard-report-pdf", {
			sourceJsonBytes: Buffer.byteLength(JSON.stringify(source), "utf8"),
			pages: before.pages,
			beforeTotalMs: Number(before.totalMs.toFixed(1)),
			afterTotalMs: Number(after.totalMs.toFixed(1)),
			beforeLongestBlockMs: Number(before.longestBlockMs.toFixed(1)),
			afterLongestBlockMs: Number(after.longestBlockMs.toFixed(1)),
			totalDeltaPercent: Number(
				(((after.totalMs - before.totalMs) / before.totalMs) * 100).toFixed(1),
			),
		});

		expect(after.pages).toBe(before.pages);
		// Under 10 % slower, the budget given in the task.
		expect(after.totalMs).toBeLessThan(before.totalMs * 1.1);
		// Well under a second, so the heartbeat can never miss four beats.
		expect(after.longestBlockMs).toBeLessThan(500);
	}, 120_000);
});
