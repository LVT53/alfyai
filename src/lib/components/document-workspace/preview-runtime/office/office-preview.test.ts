import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	renderDocxPreview,
	renderOdtPreview,
	renderPptxPreview,
	renderXlsxPreview,
} from "./index";

const officeMocks = vi.hoisted(() => ({
	convertToHtml: vi.fn(),
	pptxDestroy: vi.fn(),
	pptxGetSlideCount: vi.fn(),
	pptxGoToSlide: vi.fn(),
	pptxLoadFile: vi.fn(),
	PPTXViewer: vi.fn(),
}));

vi.mock("mammoth", () => ({
	convertToHtml: officeMocks.convertToHtml,
}));

vi.mock("pptxviewjs", () => ({
	PPTXViewer: officeMocks.PPTXViewer,
}));

describe("office preview adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		officeMocks.pptxGetSlideCount.mockReturnValue(2);
		officeMocks.pptxGoToSlide.mockResolvedValue(undefined);
		officeMocks.pptxLoadFile.mockResolvedValue(undefined);
		officeMocks.PPTXViewer.mockImplementation(function MockPptxViewer() {
			return {
				destroy: officeMocks.pptxDestroy,
				getSlideCount: officeMocks.pptxGetSlideCount,
				goToSlide: officeMocks.pptxGoToSlide,
				loadFile: officeMocks.pptxLoadFile,
			};
		});
	});

	it("converts DOCX bytes with Mammoth arrayBuffer input and sanitizes the result", async () => {
		officeMocks.convertToHtml.mockResolvedValue({
			value: '<p>Hello</p><script>alert("xss")</script>',
			messages: [],
		});

		const result = await renderDocxPreview(new Blob(["docx bytes"]));

		expect(officeMocks.convertToHtml).toHaveBeenCalledWith({
			arrayBuffer: expect.any(ArrayBuffer),
		});
		expect(result).toEqual({
			status: "ready",
			kind: "docx",
			html: "<p>Hello</p>",
		});
	});

	it("maps DOCX conversion failures to the existing preview error", async () => {
		officeMocks.convertToHtml.mockRejectedValue(new Error("bad docx"));

		await expect(renderDocxPreview(new Blob(["bad"]))).resolves.toEqual({
			status: "error",
			kind: "docx",
			error: "Failed to render DOCX file",
		});
	});

	it("renders XLSX sheets with escaped cells, rich text, and formula results", async () => {
		const ExcelJS = await import("exceljs");
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("P&L <2026>");
		worksheet.getCell("A1").value = "Region";
		worksheet.getCell("B1").value = "Total";
		worksheet.getCell("A2").value = "<North>";
		worksheet.getCell("B2").value = { formula: "1+2", result: 3 };
		worksheet.getCell("C2").value = {
			richText: [{ text: "Rich " }, { text: "Text" }],
		};

		const buffer = await workbook.xlsx.writeBuffer();
		const result = await renderXlsxPreview(new Blob([buffer as BlobPart]));

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.kind).toBe("xlsx");
		expect(result.html).toContain("<h4>P&amp;L &lt;2026&gt;</h4>");
		expect(result.html).toContain("<td>&lt;North&gt;</td>");
		expect(result.html).toContain("<td>3</td>");
		expect(result.html).toContain("<td>Rich Text</td>");
	});

	it("renders ODT content.xml with escaped text and document-root fallback", async () => {
		const JSZip = (await import("jszip")).default;
		const zip = new JSZip();
		zip.file(
			"content.xml",
			`
				<root xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
					<text:h text:outline-level="1">Plan &amp; &lt;Unsafe&gt;</text:h>
					<text:p>Hello<text:s text:c="2"/>World<text:line-break/>Next</text:p>
				</root>
			`,
		);
		const buffer = await zip.generateAsync({ type: "arraybuffer" });

		const result = await renderOdtPreview(new Blob([buffer]));

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.kind).toBe("odt");
		expect(result.html).toContain('<div class="odt-preview">');
		expect(result.html).toContain("<h1>Plan &amp; &lt;Unsafe&gt;</h1>");
		expect(result.html).toContain("Hello&nbsp;&nbsp;World<br />Next");
	});

	it("renders PPTX slides to image HTML and destroys the viewer", async () => {
		const toDataURL = vi
			.spyOn(HTMLCanvasElement.prototype, "toDataURL")
			.mockReturnValueOnce("data:image/png;base64,slide-one")
			.mockReturnValueOnce("data:image/png;base64,slide-two");

		const result = await renderPptxPreview(new Blob(["pptx bytes"]));

		expect(officeMocks.PPTXViewer).toHaveBeenCalledWith(
			expect.objectContaining({
				canvas: expect.any(HTMLCanvasElement),
				slideSizeMode: "fit",
				backgroundColor: "#ffffff",
				autoChartRerenderDelayMs: 0,
			}),
		);
		expect(officeMocks.pptxLoadFile).toHaveBeenCalledWith(
			expect.any(ArrayBuffer),
		);
		expect(officeMocks.pptxGoToSlide).toHaveBeenNthCalledWith(1, 0);
		expect(officeMocks.pptxGoToSlide).toHaveBeenNthCalledWith(2, 1);
		expect(toDataURL).toHaveBeenCalledTimes(2);
		expect(officeMocks.pptxDestroy).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.kind).toBe("pptx");
		expect(result.totalPages).toBe(2);
		expect(result.currentPage).toBe(1);
		expect(result.html).toContain('<div class="pptx-container">');
		expect(result.html).toContain('alt="Slide 1"');
		expect(result.html).toContain("Slide 2 / 2");
		expect(result.html).toContain("pptx-slide-separator");
	});
});
