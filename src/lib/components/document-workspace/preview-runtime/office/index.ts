import { escapeHtml, sanitizeHtml } from "$lib/utils/html-sanitizer";
import type { PreviewRuntimeAdapter } from "../index";

export type OfficePreviewKind = "docx" | "xlsx" | "pptx" | "odt";
type OfficeRuntimeAdapter = Extract<
	PreviewRuntimeAdapter,
	{ kind: OfficePreviewKind }
>;

export type OfficePreviewRenderResult =
	| {
			status: "ready";
			kind: OfficePreviewKind;
			html: string;
			totalPages?: number;
			currentPage?: number;
	  }
	| {
			status: "error";
			kind: OfficePreviewKind;
			error: string;
	  };

export async function renderOfficePreview(
	adapter: OfficeRuntimeAdapter,
): Promise<OfficePreviewRenderResult> {
	switch (adapter.kind) {
		case "docx":
			return renderDocxPreview(adapter.blob);
		case "xlsx":
			return renderXlsxPreview(adapter.blob);
		case "pptx":
			return renderPptxPreview(adapter.blob);
		case "odt":
			return renderOdtPreview(adapter.blob);
	}
}

export async function renderDocxPreview(
	blob: Blob,
): Promise<OfficePreviewRenderResult> {
	try {
		const mammoth = await import("mammoth");
		const arrayBuffer = await blob.arrayBuffer();
		const result = await mammoth.convertToHtml({ arrayBuffer });
		return {
			status: "ready",
			kind: "docx",
			html: sanitizeHtml(result.value),
		};
	} catch {
		return {
			status: "error",
			kind: "docx",
			error: "Failed to render DOCX file",
		};
	}
}

export async function renderXlsxPreview(
	blob: Blob,
): Promise<OfficePreviewRenderResult> {
	try {
		const ExcelJS = await import("exceljs");
		const arrayBuffer = await blob.arrayBuffer();
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(arrayBuffer);

		let html = '<div class="xlsx-container">';
		workbook.eachSheet((worksheet, sheetId) => {
			const sheetName = worksheet.name || `Sheet ${sheetId}`;
			html += `<div class="sheet"><h4>${escapeHtml(sheetName)}</h4><table class="xlsx-table">`;

			const columnCount = worksheet.columnCount;
			for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
				const row = worksheet.getRow(rowNumber);
				html += "<tr>";
				for (
					let columnNumber = 1;
					columnNumber <= columnCount;
					columnNumber += 1
				) {
					const cell = row.getCell(columnNumber);
					html += `<td>${escapeHtml(formatXlsxCellForPreview(cell))}</td>`;
				}
				html += "</tr>";
			}

			html += "</table></div>";
		});
		html += "</div>";

		return {
			status: "ready",
			kind: "xlsx",
			html,
		};
	} catch {
		return {
			status: "error",
			kind: "xlsx",
			error: "Failed to render XLSX file",
		};
	}
}

export async function renderPptxPreview(
	blob: Blob,
): Promise<OfficePreviewRenderResult> {
	let viewer: { destroy: () => void } | null = null;
	try {
		const { PPTXViewer } = await import("pptxviewjs");
		const arrayBuffer = await blob.arrayBuffer();
		const canvas = document.createElement("canvas");
		canvas.width = 1280;
		canvas.height = 720;

		viewer = new PPTXViewer({
			canvas,
			slideSizeMode: "fit",
			backgroundColor: "#ffffff",
			autoChartRerenderDelayMs: 0,
		});

		const pptxViewer = viewer as {
			loadFile: (input: ArrayBuffer) => Promise<void>;
			getSlideCount: () => number;
			goToSlide: (index: number) => Promise<void>;
			destroy: () => void;
		};
		await pptxViewer.loadFile(arrayBuffer);

		const slideCount = pptxViewer.getSlideCount();
		let html = '<div class="pptx-container">';
		for (let i = 0; i < slideCount; i++) {
			await pptxViewer.goToSlide(i);
			const dataUrl = canvas.toDataURL("image/png");
			html += `
					<div class="pptx-slide">
						<div class="pptx-slide-frame">
							<img src="${escapeHtml(dataUrl)}" alt="Slide ${i + 1}" class="pptx-slide-image" />
							<div class="pptx-slide-badge">Slide ${i + 1} / ${slideCount}</div>
						</div>
					</div>
				`;
			if (i < slideCount - 1) {
				html += '<div class="pptx-slide-separator" aria-hidden="true"></div>';
			}
		}
		html += "</div>";

		return {
			status: "ready",
			kind: "pptx",
			html,
			totalPages: slideCount,
			currentPage: 1,
		};
	} catch {
		return {
			status: "error",
			kind: "pptx",
			error: "Failed to render PPTX file",
		};
	} finally {
		try {
			viewer?.destroy();
		} catch {
			// Best-effort cleanup mirrors the current preview behavior.
		}
	}
}

export async function renderOdtPreview(
	blob: Blob,
): Promise<OfficePreviewRenderResult> {
	try {
		const JSZip = (await import("jszip")).default;
		const arrayBuffer = await blob.arrayBuffer();
		const zip = await JSZip.loadAsync(arrayBuffer);
		const contentEntry = zip.file("content.xml");
		if (!contentEntry) {
			throw new Error("Missing ODT content.xml");
		}

		const xml = await contentEntry.async("string");
		const parsed = new DOMParser().parseFromString(xml, "application/xml");
		if (parsed.querySelector("parsererror")) {
			throw new Error("Invalid ODT XML");
		}

		const officeNs = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
		const officeTextRoot =
			parsed.getElementsByTagNameNS(officeNs, "text")[0] ??
			parsed.documentElement;
		const html = Array.from(officeTextRoot.childNodes)
			.map(renderOdtBlock)
			.join("");

		return {
			status: "ready",
			kind: "odt",
			html:
				html.trim().length > 0
					? `<div class="odt-preview">${html}</div>`
					: '<div class="odt-preview"><p>Preview available, but the document contains no readable text.</p></div>',
		};
	} catch {
		return {
			status: "error",
			kind: "odt",
			error: "Failed to render ODT file",
		};
	}
}

function renderOdtTextNode(node: Node): string {
	if (node.nodeType === 3) {
		return escapeHtml(node.textContent ?? "");
	}

	if (node.nodeType !== 1) {
		return "";
	}

	const element = node as Element;
	const children = Array.from(element.childNodes)
		.map(renderOdtTextNode)
		.join("");

	switch (element.localName) {
		case "s": {
			const count = Number.parseInt(element.getAttribute("text:c") ?? "1", 10);
			return "&nbsp;".repeat(Number.isFinite(count) && count > 0 ? count : 1);
		}
		case "tab":
			return "&nbsp;&nbsp;&nbsp;&nbsp;";
		case "line-break":
			return "<br />";
		case "span":
			return children;
		default:
			return children;
	}
}

function renderOdtBlock(node: Node): string {
	if (node.nodeType !== 1) {
		return "";
	}

	const element = node as Element;
	const children = Array.from(element.childNodes).map(renderOdtBlock).join("");
	const textChildren = Array.from(element.childNodes)
		.map(renderOdtTextNode)
		.join("");

	switch (element.localName) {
		case "h": {
			const level = Math.min(
				Math.max(
					Number.parseInt(
						element.getAttribute("text:outline-level") ?? "2",
						10,
					),
					1,
				),
				6,
			);
			return `<h${level}>${textChildren}</h${level}>`;
		}
		case "p":
			return `<p>${textChildren}</p>`;
		case "list":
			return `<ul>${children}</ul>`;
		case "list-item":
			return `<li>${children || textChildren}</li>`;
		case "table":
			return `<table>${children}</table>`;
		case "table-row":
			return `<tr>${children}</tr>`;
		case "table-cell":
			return `<td>${children || textChildren}</td>`;
		default:
			return children;
	}
}

type XlsxCellLike = {
	value?: unknown;
	text?: string;
	formula?: string;
	result?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatXlsxDateForPreview(value: Date): string {
	const year = value.getUTCFullYear();
	const month = String(value.getUTCMonth() + 1).padStart(2, "0");
	const day = String(value.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function formatXlsxCellValueForPreview(value: unknown): string {
	if (value == null) return "";
	if (value instanceof Date) return formatXlsxDateForPreview(value);
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(formatXlsxCellValueForPreview).filter(Boolean).join(", ");
	}
	if (!isRecord(value)) {
		return "";
	}

	if (Array.isArray(value.richText)) {
		return value.richText
			.map((part) =>
				isRecord(part) && typeof part.text === "string" ? part.text : "",
			)
			.join("");
	}
	if (typeof value.text === "string") {
		return value.text;
	}
	if (typeof value.error === "string") {
		return value.error;
	}
	const formula = typeof value.formula === "string" ? value.formula : null;
	const result = "result" in value ? value.result : null;
	if (result != null) {
		return formatXlsxCellValueForPreview(result);
	}
	if (formula) {
		return `=${formula}`;
	}
	if (typeof value.hyperlink === "string") {
		return value.hyperlink;
	}

	return "";
}

export function formatXlsxCellForPreview(cell: XlsxCellLike): string {
	if (cell.result instanceof Date) {
		return formatXlsxCellValueForPreview(cell.result);
	}
	if (cell.value instanceof Date) {
		return formatXlsxCellValueForPreview(cell.value);
	}
	if (
		typeof cell.text === "string" &&
		cell.text.trim() &&
		cell.text !== "[object Object]"
	) {
		return cell.text;
	}
	if (cell.result != null) {
		return formatXlsxCellValueForPreview(cell.result);
	}
	if (cell.formula) {
		return `=${cell.formula}`;
	}
	return formatXlsxCellValueForPreview(cell.value);
}
