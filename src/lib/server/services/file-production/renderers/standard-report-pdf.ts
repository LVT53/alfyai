import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import {
	LineCapStyle,
	PageSizes,
	PDFDocument,
	type PDFFont,
	type PDFImage,
	type PDFPage,
	type RGB,
	rgb,
} from "pdf-lib";
import {
	type GeneratedDocumentImageLoadResult,
	loadGeneratedDocumentImage,
} from "../image-loader";
import type {
	GeneratedDocumentBlock,
	GeneratedDocumentChartBlock,
	GeneratedDocumentSource,
} from "../source-schema";
import { formatGeneratedDocumentBasisNote } from "../source-schema";
import { renderChartSvg } from "./chart-svg";

const MM_TO_PT = 72 / 25.4;
const A4 = PageSizes.A4;
const APP_FONT_ROOTS = [
	resolve(process.cwd(), "node_modules/pdfjs-dist/standard_fonts"),
	resolve(process.cwd(), "static/fonts"),
	resolve(process.cwd(), "build/client/fonts"),
	resolve(process.cwd(), "client/fonts"),
] as const;
const APP_FONT_FILES = {
	body: "LiberationSans-Regular.ttf",
	bodyBold: "LiberationSans-Bold.ttf",
	title: "LiberationSans-Regular.ttf",
	titleBold: "LiberationSans-Bold.ttf",
} as const;
const APP_BRAND_LOGO_SOURCE = "ui-vector-transparent-logo";
const LOGO_VIEWBOX_HEIGHT = 112;
const LOGO_VIEWBOX_WIDTH = 100;
const HEADER_LOGO_HEIGHT_PT = 10;
const APP_FONT_DIAGNOSTICS = {
	body: "Liberation Sans",
	bodyBold: "Liberation Sans Bold",
	title: "Liberation Sans",
	titleBold: "Liberation Sans Bold",
	code: "Liberation Sans",
	source: "pdfjs-dist bundled TrueType fonts",
} as const;

const THEME = {
	text: "#1B1815",
	paragraphText: "#3E3933",
	secondaryText: "#6F6860",
	accent: "#B65F3D",
	pageBackground: "#FAF8F4",
	panelBackground: "#F0EAE2",
	rule: "#DED6CB",
	codeBackground: "#ECE6DC",
	calloutBackground: "#F5EFE6",
} as const;

const LAYOUT = {
	marginMm: { top: 18, right: 16, bottom: 18, left: 16 },
	headerHeightPt: 26,
	footerHeightPt: 22,
	bodyFontPt: 10.5,
	lineHeight: 1.38,
	paragraphGapPt: 5,
} as const;
const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;
const MONTH_NAMES_BY_KEY: Record<string, string> = {
	jan: "January",
	feb: "February",
	mar: "March",
	apr: "April",
	may: "May",
	jun: "June",
	jul: "July",
	aug: "August",
	sep: "September",
	oct: "October",
	nov: "November",
	dec: "December",
};

export interface StandardReportPdfRenderResult {
	filename: string;
	mimeType: "application/pdf";
	content: Buffer;
	diagnostics: {
		template: "alfyai_standard_report";
		pageFormat: "A4";
		bodyFontPt: typeof LAYOUT.bodyFontPt;
		paragraphColor: typeof THEME.paragraphText;
		lineHeight: typeof LAYOUT.lineHeight;
		brandLogo: {
			source: typeof APP_BRAND_LOGO_SOURCE;
			headerHeightPt: typeof HEADER_LOGO_HEIGHT_PT;
			coverPlacement: "none";
			documentTitlePlacement: "none";
			headerPlacement: "logo-and-text";
		};
		firstPageDateLabel: string | null;
		marginMm: typeof LAYOUT.marginMm;
		colors: Pick<
			typeof THEME,
			"text" | "secondaryText" | "accent" | "pageBackground"
		>;
		fonts: typeof APP_FONT_DIAGNOSTICS;
		coverPage: boolean;
		blockTypes: GeneratedDocumentBlock["type"][];
		pageCount: number;
		tables: Array<{
			title: string | null;
			columnCount: number;
			rowCount: number;
			repeatedHeaderCount: number;
			clipped: false;
		}>;
		images: Array<{
			altText: string;
			caption: string | null;
			critical: boolean;
			placeholder: boolean;
			warningCode: string | null;
		}>;
		charts: Array<{
			title: string | null;
			chartType: GeneratedDocumentChartBlock["chartType"];
			dataPointCount: number;
			edgeInsetPt: number;
			captionLineCount: number;
			axisLabels: {
				x: string | null;
				y: string | null;
			};
			categoryLabels: string[];
			clipped: false;
			svg: string;
		}>;
	};
}

export interface StandardReportPdfRenderOptions {
	imageLoader?: (
		source: Extract<GeneratedDocumentBlock, { type: "image" }>["source"],
	) => Promise<GeneratedDocumentImageLoadResult>;
	now?: Date;
}

export class StandardReportPdfRenderError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StandardReportPdfRenderError";
	}
}

interface FontSet {
	regular: PDFFont;
	bold: PDFFont;
	mono: PDFFont;
	title: PDFFont;
	titleBold: PDFFont;
}

function mm(value: number): number {
	return value * MM_TO_PT;
}

function hexColor(hex: string): RGB {
	const value = hex.replace("#", "");
	const red = Number.parseInt(value.slice(0, 2), 16) / 255;
	const green = Number.parseInt(value.slice(2, 4), 16) / 255;
	const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
	return rgb(red, green, blue);
}

function findBundledFont(filename: string): Uint8Array {
	const candidates = APP_FONT_ROOTS.map((root) => resolve(root, filename));
	const fontPath = candidates.find((candidate) => existsSync(candidate));
	if (!fontPath) {
		throw new StandardReportPdfRenderError(
			"pdf_font_missing",
			`AlfyAI Standard Report PDF rendering requires bundled PDF font ${filename}.`,
		);
	}
	const buffer = readFileSync(fontPath);
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function slugifyFilename(title: string): string {
	const slug = title
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${slug || "document"}.pdf`;
}

function sanitizePdfText(text: string): string {
	return Array.from(text)
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return (
				codePoint === 0x09 ||
				codePoint === 0x0a ||
				codePoint === 0x0d ||
				(codePoint >= 0x20 && codePoint !== 0x7f)
			);
		})
		.join("")
		.trim();
}

function ordinalDay(day: number): string {
	const suffix =
		day % 100 >= 11 && day % 100 <= 13
			? "th"
			: day % 10 === 1
				? "st"
				: day % 10 === 2
					? "nd"
					: day % 10 === 3
						? "rd"
						: "th";
	return `${day}${suffix}`;
}

function formatGeneratedDateLabel(date: Date): string {
	const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
	return `${MONTH_NAMES[validDate.getMonth()]} ${ordinalDay(validDate.getDate())}`;
}

function normalizeDocumentDateLabel(value?: string | null): string | null {
	const text = sanitizePdfText(value ?? "");
	if (!text) return null;
	const stripped = text
		.replace(
			/^(?:generated\s+(?:on|at)|generated|created\s+(?:on|at)|created|date)\s*[:,-]?\s*/i,
			"",
		)
		.trim();
	const candidate = stripped || text;
	const monthDayMatch = candidate.match(
		/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/i,
	);
	if (monthDayMatch) {
		const monthKey = monthDayMatch[1].slice(0, 3).toLowerCase();
		const day = Number.parseInt(monthDayMatch[2], 10);
		if (MONTH_NAMES_BY_KEY[monthKey] && day >= 1 && day <= 31) {
			return `${MONTH_NAMES_BY_KEY[monthKey]} ${ordinalDay(day)}`;
		}
	}
	const isoDateMatch = candidate.match(/\b\d{4}-(\d{1,2})-(\d{1,2})\b/);
	if (isoDateMatch) {
		const monthNumber = Number.parseInt(isoDateMatch[1], 10);
		const day = Number.parseInt(isoDateMatch[2], 10);
		const monthName = MONTH_NAMES[monthNumber - 1];
		if (monthName && day >= 1 && day <= 31) {
			return `${monthName} ${ordinalDay(day)}`;
		}
	}
	return candidate;
}

function breakLongWord(
	word: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
): string[] {
	const parts: string[] = [];
	let current = "";
	for (const char of Array.from(word)) {
		const next = `${current}${char}`;
		if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
			parts.push(current);
			current = char;
		} else {
			current = next;
		}
	}
	if (current) parts.push(current);
	return parts;
}

function wrapText(
	text: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
): string[] {
	const paragraphs = sanitizePdfText(text)
		.split(/\n/)
		.map((line) => line.trimEnd());
	const lines: string[] = [];

	for (const paragraph of paragraphs) {
		const words = paragraph.split(/\s+/).filter(Boolean);
		if (words.length === 0) {
			lines.push("");
			continue;
		}

		let current = "";
		for (const word of words) {
			const pieces =
				font.widthOfTextAtSize(word, size) > maxWidth
					? breakLongWord(word, font, size, maxWidth)
					: [word];
			for (const piece of pieces) {
				const next = current ? `${current} ${piece}` : piece;
				if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
					lines.push(current);
					current = piece;
				} else {
					current = next;
				}
			}
		}
		if (current) lines.push(current);
	}

	return lines;
}

function fitTextToWidth(
	text: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
): string {
	const cleanText = sanitizePdfText(text);
	if (!cleanText || maxWidth <= 0) return "";
	if (font.widthOfTextAtSize(cleanText, size) <= maxWidth) return cleanText;

	const suffix = "...";
	const suffixWidth = font.widthOfTextAtSize(suffix, size);
	if (suffixWidth > maxWidth) return "";

	let fitted = "";
	for (const char of Array.from(cleanText)) {
		const candidate = `${fitted}${char}`;
		if (font.widthOfTextAtSize(candidate, size) + suffixWidth > maxWidth) break;
		fitted = candidate;
	}
	return fitted.trimEnd() ? `${fitted.trimEnd()}${suffix}` : "";
}

function formatChartLabel(
	value: string | null | undefined,
	fallback: string,
): string {
	const text = sanitizePdfText(value ?? "")
		.replace(/[_.-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text || /^label$/i.test(text)) return fallback;
	if (/^value$/i.test(text)) return fallback;

	return text
		.split(" ")
		.filter(Boolean)
		.map((word, index) => {
			if (word.length <= 2 && word === word.toUpperCase()) return word;
			const lower = word.toLowerCase();
			return index === 0
				? lower.charAt(0).toUpperCase() + lower.slice(1)
				: lower;
		})
		.join(" ");
}

function formatChartNumber(value: number): string {
	const rounded =
		Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(1));
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
		rounded,
	);
}

function drawAlfyAiLogo(
	page: PDFPage,
	x: number,
	y: number,
	height: number,
	opacity = 1,
): number {
	const scale = height / LOGO_VIEWBOX_HEIGHT;
	const color = hexColor("#C8A882");
	const pathOptions = {
		x,
		y: y + height,
		scale,
		borderColor: color,
		borderLineCap: LineCapStyle.Round,
		borderOpacity: opacity,
	};
	page.drawSvgPath("M50 19 C46 40 36 64 24 88", {
		...pathOptions,
		borderWidth: 4.2,
	});
	page.drawSvgPath("M50 19 C54 40 64 64 76 88", {
		...pathOptions,
		borderWidth: 4.2,
	});
	page.drawLine({
		start: { x: x + 27 * scale, y: y + 55 * scale },
		end: { x: x + 73 * scale, y: y + 55 * scale },
		thickness: 2.2 * scale,
		color,
		opacity,
		lineCap: LineCapStyle.Round,
	});
	for (const svgX of [27, 73]) {
		page.drawLine({
			start: { x: x + svgX * scale, y: y + 60 * scale },
			end: { x: x + svgX * scale, y: y + 50 * scale },
			thickness: 1.8 * scale,
			color,
			opacity: opacity * 0.75,
			lineCap: LineCapStyle.Round,
		});
	}
	page.drawLine({
		start: { x: x + 14 * scale, y: y + 22 * scale },
		end: { x: x + 36 * scale, y: y + 22 * scale },
		thickness: 3.2 * scale,
		color,
		opacity,
		lineCap: LineCapStyle.Round,
	});
	page.drawLine({
		start: { x: x + 64 * scale, y: y + 22 * scale },
		end: { x: x + 86 * scale, y: y + 22 * scale },
		thickness: 3.2 * scale,
		color,
		opacity,
		lineCap: LineCapStyle.Round,
	});
	page.drawCircle({
		x: x + 50 * scale,
		y: y + 93 * scale,
		size: 3.5 * scale,
		color,
		opacity,
	});
	return LOGO_VIEWBOX_WIDTH * scale;
}

class StandardReportPdfLayout {
	private page: PDFPage;
	private y: number;
	private readonly tableDiagnostics: StandardReportPdfRenderResult["diagnostics"]["tables"] =
		[];
	private readonly imageDiagnostics: StandardReportPdfRenderResult["diagnostics"]["images"] =
		[];
	private readonly chartDiagnostics: StandardReportPdfRenderResult["diagnostics"]["charts"] =
		[];

	constructor(
		private readonly pdfDoc: PDFDocument,
		private readonly source: GeneratedDocumentSource,
		private readonly fonts: FontSet,
		private readonly generatedAt: Date,
	) {
		this.page = this.createPage();
		this.y = this.contentTop();
	}

	private contentTop(): number {
		return A4[1] - mm(LAYOUT.marginMm.top) - LAYOUT.headerHeightPt;
	}

	private contentBottom(): number {
		return mm(LAYOUT.marginMm.bottom) + LAYOUT.footerHeightPt;
	}

	private contentX(): number {
		return mm(LAYOUT.marginMm.left);
	}

	private contentWidth(): number {
		return A4[0] - mm(LAYOUT.marginMm.left) - mm(LAYOUT.marginMm.right);
	}

	private createPage(): PDFPage {
		const page = this.pdfDoc.addPage(A4);
		page.drawRectangle({
			x: 0,
			y: 0,
			width: A4[0],
			height: A4[1],
			color: hexColor(THEME.pageBackground),
		});
		return page;
	}

	private addPage(): void {
		this.page = this.createPage();
		this.y = this.contentTop();
	}

	private ensureSpace(height: number): void {
		if (this.y - height < this.contentBottom()) {
			this.addPage();
		}
	}

	private drawWrapped(params: {
		text: string;
		font: PDFFont;
		size: number;
		color: RGB;
		x?: number;
		width?: number;
		lineHeight?: number;
	}): number {
		const x = params.x ?? this.contentX();
		const width = params.width ?? this.contentWidth();
		const lineHeight = params.lineHeight ?? params.size * LAYOUT.lineHeight;
		const lines = wrapText(params.text, params.font, params.size, width);
		const height = lines.length * lineHeight;
		this.ensureSpace(height);

		for (const line of lines) {
			this.page.drawText(line, {
				x,
				y: this.y,
				size: params.size,
				font: params.font,
				color: params.color,
			});
			this.y -= lineHeight;
		}
		return height;
	}

	drawCover(): void {
		const x = this.contentX();
		const width = this.contentWidth();
		const top = A4[1] - mm(54);
		this.y = top;
		const eyebrow = this.source.cover?.eyebrow ?? "AlfyAI Standard Report";
		this.page.drawText(eyebrow.toUpperCase(), {
			x,
			y: this.y,
			size: 9,
			font: this.fonts.bold,
			color: hexColor(THEME.accent),
		});
		this.y -= 52;
		this.drawWrapped({
			text: this.source.title,
			font: this.fonts.titleBold,
			size: 28,
			color: hexColor(THEME.text),
			width,
			lineHeight: 36,
		});
		if (this.source.subtitle) {
			this.y -= 8;
			this.drawWrapped({
				text: this.source.subtitle,
				font: this.fonts.title,
				size: 13,
				color: hexColor(THEME.secondaryText),
				width,
				lineHeight: 20,
			});
		}
		this.addPage();
	}

	drawDocumentTitle(): void {
		const x = this.contentX();
		this.y -= 12;
		this.page.drawRectangle({
			x,
			y: this.y + 8,
			width: 46,
			height: 3,
			color: hexColor(THEME.accent),
		});
		this.y -= 22;
		this.drawWrapped({
			text: this.source.title,
			font: this.fonts.titleBold,
			size: 22,
			color: hexColor(THEME.text),
			lineHeight: 30,
		});
		if (this.source.subtitle) {
			this.y -= 2;
			this.drawWrapped({
				text: this.source.subtitle,
				font: this.fonts.title,
				size: 12,
				color: hexColor(THEME.secondaryText),
				lineHeight: 18,
			});
		}
		this.y -= 18;
	}

	drawHeading(level: 1 | 2 | 3, text: string): void {
		const size = level === 1 ? 20 : level === 2 ? 15 : 13;
		const gap = level === 1 ? 16 : 13;
		const lines = wrapText(text, this.fonts.bold, size, this.contentWidth());
		this.ensureSpace(lines.length * size * 1.35 + 72);
		this.y -= gap;
		for (const line of lines) {
			this.page.drawText(line, {
				x: this.contentX(),
				y: this.y,
				size,
				font: this.fonts.bold,
				color: hexColor(THEME.text),
			});
			this.y -= size * 1.35;
		}
		this.y -= 6;
	}

	drawParagraph(text: string): void {
		this.drawWrapped({
			text,
			font: this.fonts.regular,
			size: LAYOUT.bodyFontPt,
			color: hexColor(THEME.paragraphText),
			lineHeight: LAYOUT.bodyFontPt * LAYOUT.lineHeight,
		});
		this.y -= LAYOUT.paragraphGapPt;
	}

	drawBasisNote(
		block:
			| Extract<GeneratedDocumentBlock, { type: "basisMarker" }>
			| NonNullable<
					Extract<GeneratedDocumentBlock, { type: "paragraph" }>["basisMarkers"]
			  >[number],
	): void {
		this.drawWrapped({
			text: formatGeneratedDocumentBasisNote(block),
			font: this.fonts.regular,
			size: 8.8,
			color: hexColor(THEME.secondaryText),
			lineHeight: 12,
			width: this.contentWidth() - 18,
			x: this.contentX() + 12,
		});
		this.y -= 6;
	}

	drawList(style: "bullet" | "numbered", items: string[]): void {
		const indent = 18;
		const lineHeight = LAYOUT.bodyFontPt * LAYOUT.lineHeight;
		for (const [index, item] of items.entries()) {
			const marker = style === "numbered" ? `${index + 1}.` : "•";
			const lines = wrapText(
				item,
				this.fonts.regular,
				LAYOUT.bodyFontPt,
				this.contentWidth() - indent,
			);
			this.ensureSpace(lines.length * lineHeight + 4);
			this.page.drawText(marker, {
				x: this.contentX(),
				y: this.y,
				size: LAYOUT.bodyFontPt,
				font: this.fonts.bold,
				color: hexColor(THEME.accent),
			});
			for (const line of lines) {
				this.page.drawText(line, {
					x: this.contentX() + indent,
					y: this.y,
					size: LAYOUT.bodyFontPt,
					font: this.fonts.regular,
					color: hexColor(THEME.text),
				});
				this.y -= lineHeight;
			}
			this.y -= 2;
		}
		this.y -= 6;
	}

	drawSourceChips(
		block: Extract<GeneratedDocumentBlock, { type: "sourceChips" }>,
	): void {
		const stripHtml = (text: string): string =>
			text.replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, " ");
		this.drawHeading(3, block.title);
		this.drawList(
			"bullet",
			block.sources.map((source) => {
				const cleanTitle = stripHtml(source.title);
				const cleanReasoning = source.reasoning
					? stripHtml(source.reasoning)
					: null;
				const details = [
					source.url,
					source.provided ? "You provided these" : null,
					cleanReasoning,
				].filter((part): part is string => Boolean(part));
				return details.length > 0
					? `${cleanTitle} (${details.join("; ")})`
					: cleanTitle;
			}),
		);
	}

	drawCallout(
		block: Extract<GeneratedDocumentBlock, { type: "callout" }>,
	): void {
		const x = this.contentX();
		const width = this.contentWidth();
		const padding = 12;
		const title = block.title ? `${block.title}` : block.tone.toUpperCase();
		const titleLines = wrapText(
			title,
			this.fonts.bold,
			10,
			width - padding * 2,
		);
		const bodyLines = wrapText(
			block.text,
			this.fonts.regular,
			10.5,
			width - padding * 2,
		);
		const height =
			18 + titleLines.length * 14 + bodyLines.length * 15 + padding;
		this.ensureSpace(height + 8);
		const top = this.y + 6;
		this.page.drawRectangle({
			x,
			y: top - height,
			width,
			height,
			color: hexColor(THEME.calloutBackground),
		});
		this.page.drawRectangle({
			x,
			y: top - height,
			width: 3,
			height,
			color: hexColor(THEME.accent),
		});
		let textY = top - padding - 8;
		for (const line of titleLines) {
			this.page.drawText(line, {
				x: x + padding,
				y: textY,
				size: 10,
				font: this.fonts.bold,
				color: hexColor(THEME.accent),
			});
			textY -= 14;
		}
		for (const line of bodyLines) {
			this.page.drawText(line, {
				x: x + padding,
				y: textY,
				size: 10.5,
				font: this.fonts.regular,
				color: hexColor(THEME.text),
			});
			textY -= 15;
		}
		this.y = top - height - 14;
	}

	drawCode(text: string, language?: string | null): void {
		const x = this.contentX();
		const width = this.contentWidth();
		const padding = 10;
		const size = 8.8;
		const lineHeight = 13;
		const lines = wrapText(text, this.fonts.mono, size, width - padding * 2);
		const labelHeight = language ? 16 : 0;
		const height = labelHeight + lines.length * lineHeight + padding * 2;
		this.ensureSpace(height + 8);
		const top = this.y + 6;
		this.page.drawRectangle({
			x,
			y: top - height,
			width,
			height,
			color: hexColor(THEME.codeBackground),
		});
		let textY = top - padding - 4;
		if (language) {
			this.page.drawText(language, {
				x: x + padding,
				y: textY,
				size: 8,
				font: this.fonts.bold,
				color: hexColor(THEME.secondaryText),
			});
			textY -= labelHeight;
		}
		for (const line of lines) {
			this.page.drawText(line || " ", {
				x: x + padding,
				y: textY,
				size,
				font: this.fonts.mono,
				color: hexColor(THEME.text),
			});
			textY -= lineHeight;
		}
		this.y = top - height - 14;
	}

	drawQuote(text: string, citation?: string | null): void {
		const x = this.contentX();
		const width = this.contentWidth();
		const paddingLeft = 14;
		const lines = wrapText(text, this.fonts.regular, 11.5, width - paddingLeft);
		const citationLines = citation
			? wrapText(citation, this.fonts.regular, 9.5, width - paddingLeft)
			: [];
		const height = lines.length * 17 + citationLines.length * 13 + 14;
		this.ensureSpace(height + 8);
		this.page.drawRectangle({
			x,
			y: this.y - height + 8,
			width: 3,
			height,
			color: hexColor(THEME.accent),
		});
		for (const line of lines) {
			this.page.drawText(line, {
				x: x + paddingLeft,
				y: this.y,
				size: 11.5,
				font: this.fonts.regular,
				color: hexColor(THEME.text),
			});
			this.y -= 17;
		}
		for (const line of citationLines) {
			this.page.drawText(`— ${line}`, {
				x: x + paddingLeft,
				y: this.y,
				size: 9.5,
				font: this.fonts.regular,
				color: hexColor(THEME.secondaryText),
			});
			this.y -= 13;
		}
		this.y -= 12;
	}

	drawDivider(): void {
		this.ensureSpace(22);
		this.page.drawLine({
			start: { x: this.contentX(), y: this.y },
			end: { x: this.contentX() + this.contentWidth(), y: this.y },
			thickness: 0.8,
			color: hexColor(THEME.rule),
		});
		this.y -= 22;
	}

	drawPageBreak(): void {
		this.addPage();
	}

	private formatTableValue(
		value: unknown,
		kind: Extract<
			GeneratedDocumentBlock,
			{ type: "table" }
		>["columns"][number]["kind"],
	): string {
		if (value === null || value === undefined) return "";
		if (kind === "boolean")
			return value === true ? "Yes" : value === false ? "No" : String(value);
		if (typeof value === "number") {
			if (kind === "percent") return `${(value * 100).toFixed(1)}%`;
			if (kind === "currency") {
				return new Intl.NumberFormat("en-US", {
					style: "currency",
					currency: "USD",
					maximumFractionDigits: 0,
				}).format(value);
			}
			if (kind === "number")
				return new Intl.NumberFormat("en-US").format(value);
		}
		if (kind === "date" && typeof value === "string") {
			const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
				? new Date(`${value}T00:00:00.000Z`)
				: null;
			if (parsed && !Number.isNaN(parsed.getTime())) {
				return new Intl.DateTimeFormat("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
					timeZone: "UTC",
				}).format(parsed);
			}
		}
		return sanitizePdfText(String(value));
	}

	private drawTableTextCell(params: {
		lines: string[];
		x: number;
		yTop: number;
		width: number;
		padding: number;
		size: number;
		lineHeight: number;
		font: PDFFont;
		color: RGB;
		align: "left" | "right" | "center";
	}): void {
		let textY = params.yTop - params.padding - params.size;
		for (const line of params.lines) {
			const lineWidth = params.font.widthOfTextAtSize(line, params.size);
			const textX =
				params.align === "right"
					? params.x + params.width - params.padding - lineWidth
					: params.align === "center"
						? params.x + (params.width - lineWidth) / 2
						: params.x + params.padding;
			this.page.drawText(line, {
				x: textX,
				y: textY,
				size: params.size,
				font: params.font,
				color: params.color,
			});
			textY -= params.lineHeight;
		}
	}

	drawTable(block: Extract<GeneratedDocumentBlock, { type: "table" }>): void {
		if (block.columns.length > 8) {
			throw new StandardReportPdfRenderError(
				"table_limit_exceeded",
				"Tables with more than 8 columns are not supported in the v1 portrait template.",
			);
		}

		const x = this.contentX();
		const width = this.contentWidth();
		const padding = 5;
		const headerSize = 8.5;
		const bodySize = 8.8;
		const headerLineHeight = 11;
		const bodyLineHeight = 12;
		const weights = block.columns.map((column) =>
			column.kind === "text" ? 1.35 : column.kind === "date" ? 0.95 : 0.8,
		);
		const totalWeight = weights.reduce((total, value) => total + value, 0);
		const columnWidths = weights.map(
			(weight) => (width * weight) / totalWeight,
		);
		const titleLines = block.title
			? wrapText(block.title, this.fonts.bold, 11, width)
			: [];
		const captionLines = block.caption
			? wrapText(block.caption, this.fonts.regular, 9.2, width)
			: [];
		const headerLines = block.columns.map((column, index) =>
			wrapText(
				column.label,
				this.fonts.bold,
				headerSize,
				columnWidths[index] - padding * 2,
			),
		);
		const headerHeight =
			Math.max(...headerLines.map((lines) => lines.length), 1) *
				headerLineHeight +
			padding * 2;
		const firstRowLines = block.rows[0]
			? block.columns.map((column, index) =>
					wrapText(
						this.formatTableValue(block.rows[0][column.key], column.kind),
						this.fonts.regular,
						bodySize,
						columnWidths[index] - padding * 2,
					),
				)
			: [[]];
		const firstRowHeight =
			Math.max(...firstRowLines.map((lines) => lines.length), 1) *
				bodyLineHeight +
			padding * 2;
		const captionHeight = captionLines.length * 12;
		const titleHeight = titleLines.length * 15;
		this.ensureSpace(
			titleHeight + captionHeight + headerHeight + firstRowHeight + 24,
		);

		if (titleLines.length > 0) {
			for (const line of titleLines) {
				this.page.drawText(line, {
					x,
					y: this.y,
					size: 11,
					font: this.fonts.bold,
					color: hexColor(THEME.text),
				});
				this.y -= 15;
			}
		}
		if (captionLines.length > 0) {
			for (const line of captionLines) {
				this.page.drawText(line, {
					x,
					y: this.y,
					size: 9.2,
					font: this.fonts.regular,
					color: hexColor(THEME.secondaryText),
				});
				this.y -= 12;
			}
		}
		this.y -= 4;

		let repeatedHeaderCount = 0;
		const drawHeader = (repeated: boolean) => {
			if (repeated) repeatedHeaderCount += 1;
			const top = this.y;
			this.page.drawRectangle({
				x,
				y: top - headerHeight,
				width,
				height: headerHeight,
				color: hexColor(THEME.panelBackground),
			});
			let cellX = x;
			for (const [index, column] of block.columns.entries()) {
				this.drawTableTextCell({
					lines: headerLines[index],
					x: cellX,
					yTop: top,
					width: columnWidths[index],
					padding,
					size: headerSize,
					lineHeight: headerLineHeight,
					font: this.fonts.bold,
					color: hexColor(THEME.text),
					align: column.kind === "text" ? "left" : "right",
				});
				cellX += columnWidths[index];
			}
			this.page.drawLine({
				start: { x, y: top - headerHeight },
				end: { x: x + width, y: top - headerHeight },
				thickness: 0.6,
				color: hexColor(THEME.rule),
			});
			this.y -= headerHeight;
		};

		drawHeader(false);
		const maxRowHeight =
			this.contentTop() - this.contentBottom() - headerHeight - 12;
		for (const [rowIndex, row] of block.rows.entries()) {
			const rowLines = block.columns.map((column, index) =>
				wrapText(
					this.formatTableValue(row[column.key], column.kind),
					this.fonts.regular,
					bodySize,
					columnWidths[index] - padding * 2,
				),
			);
			const rowHeight =
				Math.max(...rowLines.map((lines) => lines.length), 1) * bodyLineHeight +
				padding * 2;
			if (rowHeight > maxRowHeight) {
				throw new StandardReportPdfRenderError(
					"table_limit_exceeded",
					"A table row is too tall to render safely without clipping.",
				);
			}
			if (this.y - rowHeight < this.contentBottom()) {
				this.addPage();
				drawHeader(true);
			}
			const top = this.y;
			if (rowIndex % 2 === 1) {
				this.page.drawRectangle({
					x,
					y: top - rowHeight,
					width,
					height: rowHeight,
					color: hexColor("#F6F2EB"),
				});
			}

			let cellX = x;
			for (const [index, column] of block.columns.entries()) {
				this.drawTableTextCell({
					lines: rowLines[index],
					x: cellX,
					yTop: top,
					width: columnWidths[index],
					padding,
					size: bodySize,
					lineHeight: bodyLineHeight,
					font: this.fonts.regular,
					color: hexColor(THEME.text),
					align:
						column.kind === "text" || column.kind === "date" ? "left" : "right",
				});
				cellX += columnWidths[index];
			}
			this.page.drawLine({
				start: { x, y: top - rowHeight },
				end: { x: x + width, y: top - rowHeight },
				thickness: 0.4,
				color: hexColor(THEME.rule),
			});
			this.y -= rowHeight;
		}
		this.y -= 14;
		this.tableDiagnostics.push({
			title: block.title ?? null,
			columnCount: block.columns.length,
			rowCount: block.rows.length,
			repeatedHeaderCount,
			clipped: false,
		});
	}

	private async embedImage(
		image: GeneratedDocumentImageLoadResult & { ok: true },
	): Promise<PDFImage> {
		const bytes = new Uint8Array(image.image.bytes);
		if (image.image.mimeType === "image/png") {
			return this.pdfDoc.embedPng(bytes);
		}
		if (image.image.mimeType === "image/jpeg") {
			return this.pdfDoc.embedJpg(bytes);
		}
		throw new StandardReportPdfRenderError(
			"image_limit_exceeded",
			"PDF rendering supports PNG and JPEG images.",
		);
	}

	private drawImagePlaceholder(
		block: Extract<GeneratedDocumentBlock, { type: "image" }>,
		code: string,
	): void {
		const x = this.contentX();
		const width = this.contentWidth();
		const height = 96;
		this.ensureSpace(height + 36);
		const top = this.y + 4;
		this.page.drawRectangle({
			x,
			y: top - height,
			width,
			height,
			color: hexColor(THEME.panelBackground),
			borderColor: hexColor(THEME.rule),
			borderWidth: 0.8,
		});
		this.page.drawText("Image unavailable", {
			x: x + 14,
			y: top - 34,
			size: 10,
			font: this.fonts.bold,
			color: hexColor(THEME.secondaryText),
		});
		this.page.drawText(block.altText, {
			x: x + 14,
			y: top - 54,
			size: 9,
			font: this.fonts.regular,
			color: hexColor(THEME.secondaryText),
		});
		this.y = top - height - 8;
		if (block.caption) {
			this.drawWrapped({
				text: block.caption,
				font: this.fonts.regular,
				size: 9,
				color: hexColor(THEME.secondaryText),
				lineHeight: 12,
			});
		}
		if (block.sourceAttribution) {
			this.drawWrapped({
				text: `Source: ${block.sourceAttribution.title} - ${block.sourceAttribution.url}`,
				font: this.fonts.regular,
				size: 9,
				color: hexColor(THEME.accent),
				lineHeight: 12,
			});
		}
		this.y -= 10;
		this.imageDiagnostics.push({
			altText: block.altText,
			caption: block.caption ?? null,
			critical: block.critical === true,
			placeholder: true,
			warningCode: code,
		});
	}

	async drawImageBlock(
		block: Extract<GeneratedDocumentBlock, { type: "image" }>,
		imageLoader: NonNullable<StandardReportPdfRenderOptions["imageLoader"]>,
	): Promise<void> {
		const loaded = await imageLoader(block.source);
		if (!loaded.ok) {
			if (block.critical) {
				throw new StandardReportPdfRenderError(loaded.code, loaded.message);
			}
			this.drawImagePlaceholder(block, loaded.code);
			return;
		}

		let embedded: PDFImage;
		try {
			embedded = await this.embedImage(loaded);
		} catch (error) {
			const code =
				error instanceof StandardReportPdfRenderError
					? error.code
					: "image_limit_exceeded";
			if (block.critical) {
				throw error instanceof StandardReportPdfRenderError
					? error
					: new StandardReportPdfRenderError(
							code,
							"Image could not be embedded.",
						);
			}
			this.drawImagePlaceholder(block, code);
			return;
		}

		const maxWidth = this.contentWidth();
		const maxHeight = 280;
		const scale = Math.min(
			maxWidth / embedded.width,
			maxHeight / embedded.height,
			1,
		);
		const width = embedded.width * scale;
		const height = embedded.height * scale;
		const captionLines = block.caption
			? wrapText(block.caption, this.fonts.regular, 9, this.contentWidth())
			: [];
		const attributionLines = block.sourceAttribution
			? wrapText(
					`Source: ${block.sourceAttribution.title} - ${block.sourceAttribution.url}`,
					this.fonts.regular,
					9,
					this.contentWidth(),
				)
			: [];
		this.ensureSpace(
			height + captionLines.length * 12 + attributionLines.length * 12 + 24,
		);
		const x = this.contentX() + (this.contentWidth() - width) / 2;
		this.page.drawImage(embedded, {
			x,
			y: this.y - height,
			width,
			height,
		});
		this.y -= height + 8;
		for (const line of captionLines) {
			this.page.drawText(line, {
				x: this.contentX(),
				y: this.y,
				size: 9,
				font: this.fonts.regular,
				color: hexColor(THEME.secondaryText),
			});
			this.y -= 12;
		}
		for (const line of attributionLines) {
			this.page.drawText(line, {
				x: this.contentX(),
				y: this.y,
				size: 9,
				font: this.fonts.regular,
				color: hexColor(THEME.accent),
			});
			this.y -= 12;
		}
		this.y -= 12;
		this.imageDiagnostics.push({
			altText: block.altText,
			caption: block.caption ?? null,
			critical: block.critical === true,
			placeholder: false,
			warningCode: null,
		});
	}

	drawChart(block: Extract<GeneratedDocumentBlock, { type: "chart" }>): void {
		const renderedSvg = renderChartSvg(block);
		const x = this.contentX();
		const width = this.contentWidth();
		const titleLines = wrapText(
			block.title ?? "Chart",
			this.fonts.bold,
			12,
			width - 28,
		);
		const captionLines = block.caption
			? wrapText(block.caption, this.fonts.regular, 9, width - 28)
			: [];
		const headerOffset =
			24 +
			titleLines.length * 15 +
			(captionLines.length > 0 ? 4 + captionLines.length * 12 : 0) +
			14;
		const plotHeight = 142;
		const tickLabelHeight = 18;
		const axisLabelHeight = 14;
		const bottomPadding = 18;
		const height = Math.max(
			260,
			headerOffset +
				plotHeight +
				tickLabelHeight +
				axisLabelHeight +
				bottomPadding,
		);
		this.ensureSpace(height + 34);
		const top = this.y + 6;
		this.page.drawRectangle({
			x,
			y: top - height,
			width,
			height,
			color: hexColor(THEME.panelBackground),
			borderColor: hexColor(THEME.rule),
			borderWidth: 0.8,
		});
		let textY = top - 24;
		for (const line of titleLines) {
			this.page.drawText(line, {
				x: x + 14,
				y: textY,
				size: 12,
				font: this.fonts.bold,
				color: hexColor(THEME.text),
			});
			textY -= 15;
		}
		if (captionLines.length > 0) {
			textY -= 4;
			for (const line of captionLines) {
				this.page.drawText(line, {
					x: x + 14,
					y: textY,
					size: 9,
					font: this.fonts.regular,
					color: hexColor(THEME.secondaryText),
				});
				textY -= 12;
			}
		}
		const chartTop = top - headerOffset;
		const chartBottom = chartTop - plotHeight;

		if (block.chartType === "pie" || block.chartType === "donut") {
			const { labelKey, valueKey } = block;
			if (!labelKey || !valueKey) {
				throw new StandardReportPdfRenderError(
					"unsupported_chart_data",
					"Pie and donut charts require labelKey and valueKey.",
				);
			}
			const rows = block.data
				.map((row) => {
					const value = row[valueKey];
					return {
						label: String(row[labelKey] ?? ""),
						value: typeof value === "number" ? value : null,
					};
				})
				.filter(
					(row): row is { label: string; value: number } =>
						row.value !== null && row.value > 0,
				);
			const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
			const centerX = x + 130;
			const centerY = chartBottom + plotHeight / 2;
			this.page.drawCircle({
				x: centerX,
				y: centerY,
				size: block.chartType === "donut" ? 58 : 68,
				color: hexColor(THEME.accent),
				opacity: 0.2,
			});
			if (block.chartType === "donut") {
				this.page.drawCircle({
					x: centerX,
					y: centerY,
					size: 26,
					color: hexColor(THEME.panelBackground),
				});
			}
			for (const [index, row] of rows.entries()) {
				const legendY = chartTop - 28 - index * 20;
				this.page.drawRectangle({
					x: x + 250,
					y: legendY - 8,
					width: 34 + (row.value / total) * 90,
					height: 9,
					color: hexColor(
						["#B65F3D", "#4D7188", "#7A7F42", "#C29A3D", "#6F6860"][index % 5],
					),
				});
				this.page.drawText(
					`${row.label} ${Math.round((row.value / total) * 100)}%`,
					{
						x: x + 250,
						y: legendY + 4,
						size: 8.5,
						font: this.fonts.regular,
						color: hexColor(THEME.text),
					},
				);
			}
			this.y = top - height - 14;
			this.chartDiagnostics.push({
				title: block.title ?? null,
				chartType: block.chartType,
				dataPointCount: renderedSvg.dataPointCount,
				edgeInsetPt: 0,
				captionLineCount: captionLines.length,
				axisLabels: {
					x: null,
					y: formatChartLabel(block.units, "Value"),
				},
				categoryLabels: rows.map((row) => row.label),
				clipped: false,
				svg: renderedSvg.svg,
			});
			return;
		}

		const { xKey, yKey } = block;
		if (!xKey || !yKey) {
			throw new StandardReportPdfRenderError(
				"unsupported_chart_data",
				"Line charts require xKey and yKey.",
			);
		}

		const rows = block.data
			.map((row) => {
				const value = row[yKey];
				return {
					label: String(row[xKey] ?? ""),
					value: typeof value === "number" ? value : null,
				};
			})
			.filter(
				(row): row is { label: string; value: number } => row.value !== null,
			);
		if (rows.length === 0) {
			throw new StandardReportPdfRenderError(
				"unsupported_chart_data",
				"Chart data has no numeric values.",
			);
		}

		const plot = {
			x: x + 58,
			y: chartBottom,
			width: width - 92,
			height: plotHeight,
		};
		const values = rows.map((row) => row.value);
		const max = Math.max(...values);
		const min = Math.min(0, ...values);
		const span = max - min || 1;
		const xAxisLabel = formatChartLabel(xKey, "Category");
		const yAxisLabel = formatChartLabel(block.units || yKey, "Value");
		const isBarChart =
			block.chartType === "bar" || block.chartType === "stackedBar";
		const pointRadius = block.chartType === "scatter" ? 4 : 3;
		const barWidth = isBarChart
			? Math.max(12, (plot.width / Math.max(rows.length, 1)) * 0.5)
			: 0;
		const edgeInset = isBarChart ? barWidth / 2 + 3 : pointRadius + 3;
		const drawableWidth = Math.max(1, plot.width - edgeInset * 2);
		const point = (row: { value: number }, index: number) => ({
			x:
				plot.x +
				edgeInset +
				(rows.length === 1
					? drawableWidth / 2
					: (index / (rows.length - 1)) * drawableWidth),
			y: plot.y + ((row.value - min) / span) * plot.height,
		});
		for (let index = 0; index <= 4; index += 1) {
			const y = plot.y + (index / 4) * plot.height;
			const value = min + (span * index) / 4;
			this.page.drawLine({
				start: { x: plot.x, y },
				end: { x: plot.x + plot.width, y },
				thickness: 0.4,
				color: hexColor(THEME.rule),
			});
			const label = formatChartNumber(value);
			const labelWidth = this.fonts.regular.widthOfTextAtSize(label, 7.8);
			this.page.drawText(label, {
				x: plot.x - 8 - labelWidth,
				y: y - 3,
				size: 7.8,
				font: this.fonts.regular,
				color: hexColor(THEME.secondaryText),
			});
		}
		this.page.drawLine({
			start: { x: plot.x, y: plot.y },
			end: { x: plot.x + plot.width, y: plot.y },
			thickness: 0.7,
			color: hexColor(THEME.secondaryText),
		});
		this.page.drawLine({
			start: { x: plot.x, y: plot.y },
			end: { x: plot.x, y: plot.y + plot.height },
			thickness: 0.7,
			color: hexColor(THEME.secondaryText),
		});
		this.page.drawText(yAxisLabel, {
			x: plot.x,
			y: plot.y + plot.height + 7,
			size: 8,
			font: this.fonts.bold,
			color: hexColor(THEME.secondaryText),
		});
		const xAxisWidth = this.fonts.bold.widthOfTextAtSize(xAxisLabel, 8);
		this.page.drawText(xAxisLabel, {
			x: plot.x + plot.width / 2 - xAxisWidth / 2,
			y: plot.y - tickLabelHeight - 12,
			size: 8,
			font: this.fonts.bold,
			color: hexColor(THEME.secondaryText),
		});
		const points = rows.map(point);
		if (block.chartType === "area" && points.length > 1) {
			for (const [index, current] of Array.from(points.entries()).slice(1)) {
				const previous = points[index - 1];
				this.page.drawLine({
					start: { x: previous.x, y: plot.y },
					end: current,
					thickness: 1,
					color: hexColor(THEME.accent),
					opacity: 0.18,
				});
			}
		}
		if (isBarChart) {
			for (const [index, current] of points.entries()) {
				this.page.drawRectangle({
					x: current.x - barWidth / 2,
					y: plot.y,
					width: barWidth,
					height: Math.max(1, current.y - plot.y),
					color: hexColor(index % 2 === 0 ? THEME.accent : "#4D7188"),
				});
			}
		} else if (block.chartType === "line" || block.chartType === "area") {
			for (let index = 1; index < points.length; index += 1) {
				this.page.drawLine({
					start: points[index - 1],
					end: points[index],
					thickness: 2.2,
					color: hexColor(THEME.accent),
				});
			}
		}
		for (const current of points) {
			this.page.drawCircle({
				x: current.x,
				y: current.y,
				size: block.chartType === "scatter" ? 4 : 3,
				color: hexColor(THEME.accent),
			});
		}
		const maxVisibleLabels = Math.max(1, Math.floor(plot.width / 52));
		const labelEvery = Math.max(1, Math.ceil(rows.length / maxVisibleLabels));
		const categoryLabelWidth = Math.max(
			30,
			plot.width / Math.max(rows.length, 1) - 4,
		);
		for (const [index, row] of rows.entries()) {
			if (index % labelEvery !== 0 && index !== rows.length - 1) continue;
			const label = fitTextToWidth(
				row.label,
				this.fonts.regular,
				7.6,
				categoryLabelWidth,
			);
			if (!label) continue;
			const labelWidth = this.fonts.regular.widthOfTextAtSize(label, 7.6);
			this.page.drawText(label, {
				x: points[index].x - labelWidth / 2,
				y: plot.y - 15,
				size: 7.6,
				font: this.fonts.regular,
				color: hexColor(THEME.secondaryText),
			});
		}
		this.y = top - height - 14;
		this.chartDiagnostics.push({
			title: block.title ?? null,
			chartType: block.chartType,
			dataPointCount: renderedSvg.dataPointCount,
			edgeInsetPt: Number(edgeInset.toFixed(2)),
			captionLineCount: captionLines.length,
			axisLabels: {
				x: xAxisLabel,
				y: yAxisLabel,
			},
			categoryLabels: rows.map((row) => row.label),
			clipped: false,
			svg: renderedSvg.svg,
		});
	}

	drawUnsupported(blockType: string): never {
		throw new StandardReportPdfRenderError(
			"unsupported_pdf_block",
			`AlfyAI Standard Report PDF rendering does not yet support ${blockType} blocks.`,
		);
	}

	drawHeadersAndFooters(): void {
		const pages = this.pdfDoc.getPages();
		const firstPageDateLabel =
			normalizeDocumentDateLabel(
				this.source.cover?.dateLabel ?? this.source.date,
			) ?? formatGeneratedDateLabel(this.generatedAt);
		for (const [index, page] of pages.entries()) {
			const pageNumber = index + 1;
			const headerY = A4[1] - mm(10);
			const headerX = this.contentX();
			const headerRight = headerX + this.contentWidth();
			const headerSize = 8.5;
			const logoY = headerY - 1.5;
			const logoWidth = drawAlfyAiLogo(
				page,
				headerX,
				logoY,
				HEADER_LOGO_HEIGHT_PT,
				0.9,
			);
			const brandText = "AlfyAI";
			const brandWidth = this.fonts.bold.widthOfTextAtSize(
				brandText,
				headerSize,
			);
			const dateText = pageNumber === 1 ? firstPageDateLabel : null;
			let titleRight = headerRight;
			if (dateText) {
				const fittedDate = fitTextToWidth(
					dateText,
					this.fonts.regular,
					headerSize,
					132,
				);
				if (fittedDate) {
					const dateWidth = this.fonts.regular.widthOfTextAtSize(
						fittedDate,
						headerSize,
					);
					const dateX = headerRight - dateWidth;
					titleRight = dateX - 18;
					page.drawText(fittedDate, {
						x: dateX,
						y: headerY,
						size: headerSize,
						font: this.fonts.regular,
						color: hexColor(THEME.secondaryText),
					});
				}
			}
			const brandX = headerX + logoWidth + 5;
			page.drawText(brandText, {
				x: brandX,
				y: headerY,
				size: headerSize,
				font: this.fonts.bold,
				color: hexColor(THEME.accent),
			});
			const titleX = brandX + brandWidth + 22;
			const title = fitTextToWidth(
				this.source.title,
				this.fonts.regular,
				headerSize,
				titleRight - titleX,
			);
			if (title) {
				page.drawText(title, {
					x: titleX,
					y: headerY,
					size: headerSize,
					font: this.fonts.regular,
					color: hexColor(THEME.secondaryText),
				});
			}
			page.drawLine({
				start: { x: this.contentX(), y: headerY - 9 },
				end: { x: this.contentX() + this.contentWidth(), y: headerY - 9 },
				thickness: 0.5,
				color: hexColor(THEME.rule),
			});
			const footerText = `${pageNumber} / ${pages.length}`;
			const footerWidth = this.fonts.regular.widthOfTextAtSize(footerText, 8.5);
			page.drawText(footerText, {
				x: A4[0] - mm(LAYOUT.marginMm.right) - footerWidth,
				y: mm(10),
				size: 8.5,
				font: this.fonts.regular,
				color: hexColor(THEME.secondaryText),
			});
		}
	}

	getTableDiagnostics(): StandardReportPdfRenderResult["diagnostics"]["tables"] {
		return this.tableDiagnostics;
	}

	getImageDiagnostics(): StandardReportPdfRenderResult["diagnostics"]["images"] {
		return this.imageDiagnostics;
	}

	getChartDiagnostics(): StandardReportPdfRenderResult["diagnostics"]["charts"] {
		return this.chartDiagnostics;
	}
}

async function embedFonts(pdfDoc: PDFDocument): Promise<FontSet> {
	pdfDoc.registerFontkit(fontkit);
	// Use dependency-bundled TTF fonts for downloaded PDFs. WOFF2 can preview in
	// PDF.js but has poor compatibility in external PDF readers.
	const [regular, bold, title, titleBold] = await Promise.all([
		pdfDoc.embedFont(findBundledFont(APP_FONT_FILES.body), { subset: false }),
		pdfDoc.embedFont(findBundledFont(APP_FONT_FILES.bodyBold), {
			subset: false,
		}),
		pdfDoc.embedFont(findBundledFont(APP_FONT_FILES.title), { subset: false }),
		pdfDoc.embedFont(findBundledFont(APP_FONT_FILES.titleBold), {
			subset: false,
		}),
	]);
	return { regular, bold, mono: regular, title, titleBold };
}

export async function renderStandardReportPdf(
	source: GeneratedDocumentSource,
	options: StandardReportPdfRenderOptions = {},
): Promise<StandardReportPdfRenderResult> {
	const pdfDoc = await PDFDocument.create();
	pdfDoc.setTitle(source.title);
	pdfDoc.setAuthor("AlfyAI");
	pdfDoc.setCreator("AlfyAI file production");
	pdfDoc.setProducer("pdf-lib");
	pdfDoc.setSubject("AlfyAI Standard Report");
	pdfDoc.setKeywords(["AlfyAI", "generated document", "standard report"]);

	const fonts = await embedFonts(pdfDoc);
	const generatedAt = options.now ?? new Date();
	const layout = new StandardReportPdfLayout(
		pdfDoc,
		source,
		fonts,
		generatedAt,
	);
	if (source.cover) {
		layout.drawCover();
	} else {
		layout.drawDocumentTitle();
	}

	const imageLoader = options.imageLoader ?? loadGeneratedDocumentImage;
	for (const block of source.blocks) {
		switch (block.type) {
			case "heading":
				layout.drawHeading(block.level, block.text);
				break;
			case "paragraph":
				layout.drawParagraph(block.text);
				for (const marker of block.basisMarkers ?? []) {
					layout.drawBasisNote(marker);
				}
				break;
			case "list":
				layout.drawList(block.style, block.items);
				break;
			case "sourceChips":
				layout.drawSourceChips(block);
				break;
			case "callout":
				layout.drawCallout(block);
				break;
			case "confidenceMarker":
				layout.drawCallout({
					type: "callout",
					tone: block.severity === "critical" ? "warning" : "info",
					title: block.label,
					text: block.message,
				});
				break;
			case "basisMarker":
				layout.drawBasisNote(block);
				break;
			case "code":
				layout.drawCode(block.text, block.language);
				break;
			case "quote":
				layout.drawQuote(block.text, block.citation);
				break;
			case "divider":
				layout.drawDivider();
				break;
			case "pageBreak":
				layout.drawPageBreak();
				break;
			case "table":
				layout.drawTable(block);
				break;
			case "image":
				await layout.drawImageBlock(block, imageLoader);
				break;
			case "chart":
				layout.drawChart(block);
				break;
		}
	}
	layout.drawHeadersAndFooters();

	const content = Buffer.from(await pdfDoc.save());
	return {
		filename: slugifyFilename(source.title),
		mimeType: "application/pdf",
		content,
		diagnostics: {
			template: "alfyai_standard_report",
			pageFormat: "A4",
			bodyFontPt: LAYOUT.bodyFontPt,
			paragraphColor: THEME.paragraphText,
			lineHeight: LAYOUT.lineHeight,
			brandLogo: {
				source: APP_BRAND_LOGO_SOURCE,
				headerHeightPt: HEADER_LOGO_HEIGHT_PT,
				coverPlacement: "none",
				documentTitlePlacement: "none",
				headerPlacement: "logo-and-text",
			},
			firstPageDateLabel:
				normalizeDocumentDateLabel(source.cover?.dateLabel ?? source.date) ??
				formatGeneratedDateLabel(generatedAt),
			marginMm: LAYOUT.marginMm,
			colors: {
				text: THEME.text,
				secondaryText: THEME.secondaryText,
				accent: THEME.accent,
				pageBackground: THEME.pageBackground,
			},
			fonts: APP_FONT_DIAGNOSTICS,
			coverPage: Boolean(source.cover),
			blockTypes: source.blocks.map((block) => block.type),
			pageCount: pdfDoc.getPageCount(),
			tables: layout.getTableDiagnostics(),
			images: layout.getImageDiagnostics(),
			charts: layout.getChartDiagnostics(),
		},
	};
}
