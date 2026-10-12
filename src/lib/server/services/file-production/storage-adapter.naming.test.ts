import { describe, expect, it, vi } from "vitest";
import {
	type StoreGeneratedFileDependency,
	storeFileProductionOutputs,
} from "./storage-adapter";

// What a produced file is named when it is stored. A Download of a Document is the
// reader's own export: the file carries the title the reader wrote (RC-A, the audit's
// copy seam), where the renderers' own name is an ASCII slug that suits a model's
// report and loses every accented letter of a Hungarian title.

const TITLE = "Bécsi hétvégi útiterv (szombat–vasárnap)";

function stored(id: string) {
	return vi.fn<StoreGeneratedFileDependency>(
		async (_conversationId, _userId, file) => ({
			id,
			conversationId: "conv-1",
			assistantMessageId: null,
			artifactId: null,
			userId: "user-1",
			filename: file.filename,
			mimeType: file.mimeType ?? null,
			sizeBytes: Buffer.byteLength(file.content),
			storagePath: `conv-1/${id}`,
			createdAt: 1,
		}),
	);
}

function documentSourceRequest(title: string) {
	return {
		sourceMode: "document_source" as const,
		outputs: ["pdf" as const],
		documentSource: {
			version: 1 as const,
			template: "alfyai_standard_report" as const,
			title,
			blocks: [{ type: "paragraph" as const, text: "Hello." }],
		},
	};
}

function run(params: {
	origin: string;
	title?: string;
	files: { filename: string; mimeType: string }[];
}) {
	const storeGeneratedFile = stored("file-1");
	return storeFileProductionOutputs({
		job: {
			id: "job-1",
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: null,
			origin: params.origin,
		},
		attemptId: "attempt-1",
		request: documentSourceRequest(params.title ?? TITLE),
		executionResult: {
			files: params.files.map((file) => ({
				...file,
				content: Buffer.from("x"),
			})),
			stdout: "",
			stderr: "",
		},
		sourceArtifact: null,
		now: new Date("2026-10-12T10:00:00.000Z"),
		storeGeneratedFile,
	}).then((result) => ({ result, storeGeneratedFile }));
}

const names = (storeGeneratedFile: ReturnType<typeof stored>) =>
	storeGeneratedFile.mock.calls.map(([, , file]) => file.filename);

describe("the name a produced file is stored under", () => {
	it("names a PDF and a Word export after the item's title, accents and all", async () => {
		for (const [rendered, extension] of [
			["becsi-hetvegi-utiterv-szombat-vasarnap.pdf", "pdf"],
			["becsi-hetvegi-utiterv-szombat-vasarnap.docx", "docx"],
		] as const) {
			const { result, storeGeneratedFile } = await run({
				origin: "artifact_export",
				files: [{ filename: rendered, mimeType: "application/octet-stream" }],
			});

			expect(result.ok).toBe(true);
			expect(names(storeGeneratedFile)).toEqual([`${TITLE}.${extension}`]);
		}
	});

	it("keeps a path out of the name and a trailing dot off the extension", async () => {
		const { storeGeneratedFile } = await run({
			origin: "artifact_export",
			title: "Q3/Q4 plan.",
			files: [{ filename: "q3-q4-plan.pdf", mimeType: "application/pdf" }],
		});

		expect(names(storeGeneratedFile)).toEqual(["Q3-Q4 plan.pdf"]);
	});

	it("falls back to 'document' for a title with nothing to name a file by", async () => {
		const { storeGeneratedFile } = await run({
			origin: "artifact_export",
			title: " . ",
			files: [{ filename: "document.pdf", mimeType: "application/pdf" }],
		});

		expect(names(storeGeneratedFile)).toEqual(["document.pdf"]);
	});

	it("leaves a model's report named by the renderer, as before", async () => {
		const { storeGeneratedFile } = await run({
			origin: "unified_produce",
			files: [
				{
					filename: "becsi-hetvegi-utiterv-szombat-vasarnap.pdf",
					mimeType: "application/pdf",
				},
			],
		});

		expect(names(storeGeneratedFile)).toEqual([
			"becsi-hetvegi-utiterv-szombat-vasarnap.pdf",
		]);
	});
});
