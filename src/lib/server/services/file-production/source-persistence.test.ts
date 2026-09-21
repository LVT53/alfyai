// Phase 6 D9 — the readable text of a source-first document.
//
// A `document_source` job renders PDF/DOCX/HTML/MD out of OUR OWN source JSON,
// so its text must come from that JSON and never from parsing our own PDF back.
// It used to come from `buildGeneratedDocumentProjection`, a third renderer of
// the same object whose output nobody could download; it now comes from the
// Markdown renderer, so the text the model reads back and the `.md` the user
// downloads are the same bytes.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { renderStandardReportMarkdown } from "./renderers/standard-report-markdown";
import type { GeneratedDocumentSource } from "./source-schema";
import { validateGeneratedDocumentSource } from "./source-schema";
import {
	createFileProductionLedgerFixture,
	type FileProductionLedgerFixture,
} from "./testing/ledger-fixtures";

const SOURCE = {
	version: 1,
	template: "alfyai_standard_report",
	title: "Quarterly report",
	subtitle: "Executive summary",
	date: "Generated on May 4, 2026",
	blocks: [
		{ type: "heading", level: 2, text: "Revenue" },
		{ type: "paragraph", text: "Revenue increased by 12%[[cite:1:c]]." },
		{
			type: "table",
			title: "By region",
			columns: [
				{ key: "region", label: "Region" },
				{ key: "revenue", label: "Revenue" },
			],
			rows: [{ region: "EMEA", revenue: "12.4" }],
		},
		{
			type: "chart",
			chartType: "bar",
			title: "Revenue by quarter",
			altText: "Bar chart: revenue rises each quarter.",
			caption: "Revenue, in millions.",
			units: "EUR m",
			xKey: "quarter",
			yKey: "revenue",
			data: [
				{ quarter: "Q1", revenue: 10 },
				{ quarter: "Q2", revenue: 14 },
			],
		},
	],
};

let fixture: FileProductionLedgerFixture;

function validated(source: unknown): GeneratedDocumentSource {
	const result = validateGeneratedDocumentSource(source);
	if (!result.ok)
		throw new Error(`fixture source is invalid: ${result.message}`);
	return result.source;
}

async function persist(
	input: { source?: unknown; renderedMarkdown?: string } = {},
): Promise<string> {
	const { persistGeneratedDocumentSourceArtifact } = await import(
		"./source-persistence"
	);
	const artifact = await persistGeneratedDocumentSourceArtifact({
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		fileProductionJobId: "job-1",
		title: "Quarterly report",
		source: input.source ?? SOURCE,
		...(input.renderedMarkdown === undefined
			? {}
			: { renderedMarkdown: input.renderedMarkdown }),
	});
	return artifact.id;
}

function artifactText(artifactId: string): string | null {
	const [row] = fixture.db
		.select({ contentText: schema.artifacts.contentText })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, artifactId))
		.all();
	return row?.contentText ?? null;
}

describe("persistGeneratedDocumentSourceArtifact", () => {
	beforeEach(() => {
		fixture = createFileProductionLedgerFixture("source-persistence");
		fixture.seedUser("user-1");
		fixture.seedConversation("conv-1", "user-1");
		fixture.seedAssistantMessage("assistant-1", "conv-1");
		process.env.DATABASE_PATH = fixture.dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB singleton may never have been imported.
		}
		fixture.cleanup();
		vi.restoreAllMocks();
	});

	it("writes the markdown renderer's bytes, not a projection of its own", async () => {
		const artifactId = await persist();

		const expected = renderStandardReportMarkdown(
			validated(SOURCE),
		).content.toString("utf8");
		expect(artifactText(artifactId)).toBe(expected);
		// The shapes the deleted projection could never produce, and the reason
		// the model reads a better document now: real headings, a GFM table and
		// the chart's description under its own heading.
		expect(expected).toContain("# Quarterly report");
		expect(expected).toContain("| Region | Revenue |");
		expect(expected).toContain("### Revenue by quarter");
		expect(expected).toContain("Bar chart: revenue rises each quarter.");
		// A citation annotation is still collapsed to its readable form.
		expect(expected).toContain("Revenue increased by 12%[1]ᶜ.");
		expect(expected).not.toContain("[[cite");
	});

	it("reuses the markdown a job already rendered instead of rendering twice", async () => {
		// Deliberately not what the renderer would produce: if the bytes come
		// back verbatim, the second render did not happen.
		const artifactId = await persist({
			renderedMarkdown: "# Already rendered\n\nBy the worker.\n",
		});

		expect(artifactText(artifactId)).toBe(
			"# Already rendered\n\nBy the worker.\n",
		);
	});

	it("keeps an inline image's bytes out of the artifact text", async () => {
		// Right in a downloaded `.md`, wrong in an artifact: this text is
		// chunked, embedded and handed to the model, where megabytes of base64
		// would fill the window with something no reader can use.
		const artifactId = await persist({
			source: {
				...SOURCE,
				blocks: [
					{
						type: "image",
						source: {
							kind: "data",
							mimeType: "image/png",
							data: "QUFBQUFBQUFBQUFBQUFBQQ==",
						},
						altText: "Revenue chart",
						caption: "Quarterly revenue",
					},
				],
			},
		});

		const text = artifactText(artifactId) ?? "";
		expect(text).toContain("![Revenue chart](embedded image/png)");
		expect(text).toContain("Quarterly revenue");
		expect(text).not.toContain("base64");
		expect(text).not.toContain("QUFBQUFBQUFBQUFBQUFBQQ==");
	});

	it("leaves the text empty when the renderer throws, so readback can fill it", async () => {
		vi.doMock("./renderers/standard-report-markdown", () => ({
			renderStandardReportMarkdown: () => {
				throw new Error("renderer exploded");
			},
		}));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const artifactId = await persist();

		// Never a half-written document: the artifact carries no text at all,
		// which is what `chat-files.ts` reads as "queue the rendered binaries
		// for readback like any other generated file".
		expect(artifactText(artifactId)).toBe("");
		expect(warn).toHaveBeenCalledTimes(1);
		vi.doUnmock("./renderers/standard-report-markdown");
	});

	it("does not rewrite the text of a document it already persisted", async () => {
		const first = await persist();
		const second = await persist({
			renderedMarkdown: "# A different render\n",
		});

		expect(second).toBe(first);
		expect(artifactText(first)).toBe(
			renderStandardReportMarkdown(validated(SOURCE)).content.toString("utf8"),
		);
	});
});
