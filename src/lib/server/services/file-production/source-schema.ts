export type GeneratedDocumentBlock =
	| { type: "heading"; level: 1 | 2 | 3; text: string }
	| GeneratedDocumentParagraphBlock
	| { type: "list"; style: "bullet" | "numbered"; items: string[] }
	| {
			type: "callout";
			tone: "info" | "warning" | "tip" | "note";
			title?: string | null;
			text: string;
	  }
	| GeneratedDocumentConfidenceMarkerBlock
	| { type: "code"; language?: string | null; text: string }
	| { type: "quote"; text: string; citation?: string | null }
	| { type: "divider" }
	| GeneratedDocumentSourceChipsBlock
	| GeneratedDocumentTableBlock
	| GeneratedDocumentChartBlock
	| GeneratedDocumentImageBlock
	| { type: "pageBreak" };

export type GeneratedDocumentScalar = string | number | boolean | null;

export interface GeneratedDocumentParagraphBlock {
	type: "paragraph";
	text: string;
	sources?: GeneratedDocumentSourceChip[];
}

export interface GeneratedDocumentTableColumn {
	key: string;
	label: string;
	kind: "text" | "number" | "currency" | "percent" | "date" | "boolean";
}

export interface GeneratedDocumentTableBlock {
	type: "table";
	title?: string | null;
	caption?: string | null;
	columns: GeneratedDocumentTableColumn[];
	rows: Record<string, GeneratedDocumentScalar>[];
}

export type GeneratedDocumentChartType =
	| "bar"
	| "stackedBar"
	| "line"
	| "area"
	| "pie"
	| "scatter"
	| "donut";

export interface GeneratedDocumentChartBlock {
	type: "chart";
	chartType: GeneratedDocumentChartType;
	title?: string | null;
	caption?: string | null;
	altText?: string | null;
	xKey?: string | null;
	yKey?: string | null;
	labelKey?: string | null;
	valueKey?: string | null;
	seriesKey?: string | null;
	radiusKey?: string | null;
	units?: string | null;
	data: Record<string, GeneratedDocumentScalar>[];
}

export type GeneratedDocumentImageSource =
	| { kind: "https"; url: string }
	| { kind: "artifact"; artifactId: string }
	| { kind: "generated_file"; fileId: string }
	| {
			kind: "data";
			mimeType: "image/png" | "image/jpeg" | "image/webp";
			data: string;
	  };

export interface GeneratedDocumentImageBlock {
	type: "image";
	source: GeneratedDocumentImageSource;
	altText: string;
	caption?: string | null;
	sourceAttribution?: GeneratedDocumentSourceAttribution | null;
	critical?: boolean;
}

export interface GeneratedDocumentSourceAttribution {
	title: string;
	url: string;
}

export interface GeneratedDocumentSourceChip {
	title: string;
	url?: string | null;
	reasoning?: string | null;
	provided?: boolean;
	kind?: "web" | "library";
}

export interface GeneratedDocumentSourceChipsBlock {
	type: "sourceChips";
	title: string;
	sources: GeneratedDocumentSourceChip[];
}

export interface GeneratedDocumentConfidenceMarkerBlock {
	type: "confidenceMarker";
	code: string;
	label: string;
	severity: "info" | "warning" | "critical";
	message: string;
}

export interface GeneratedDocumentSource {
	version: 1;
	template: "alfyai_standard_report";
	title: string;
	subtitle?: string | null;
	date?: string | null;
	language?: "en" | "hu";
	cover?: { enabled: true; eyebrow?: string | null; dateLabel?: string | null };
	blocks: GeneratedDocumentBlock[];
}

export type GeneratedDocumentSourceValidationResult =
	| { ok: true; source: GeneratedDocumentSource }
	| { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function cleanText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function cleanDocumentLanguage(
	value: unknown,
): GeneratedDocumentSource["language"] {
	return value === "hu" || value === "en" ? value : undefined;
}

function cleanKey(value: unknown): string | null {
	const text = cleanText(value);
	return text && /^[A-Za-z0-9_.-]+$/.test(text) ? text : null;
}

function isScalar(value: unknown): value is GeneratedDocumentScalar {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function isNonNull<T>(value: T | null): value is T {
	return value !== null;
}

function normalizeScalarRecord(
	value: unknown,
): Record<string, GeneratedDocumentScalar> | null {
	if (!isRecord(value)) return null;

	const normalized: Record<string, GeneratedDocumentScalar> = {};
	for (const [key, cellValue] of Object.entries(value)) {
		if (key === "colspan" || key === "rowspan") return null;
		if (!isScalar(cellValue)) return null;
		normalized[key] = normalizeTableScalar(cellValue);
	}
	return normalized;
}

type TableColumnDraft = GeneratedDocumentTableColumn & { sourceKeys: string[] };

function makeColumnKey(
	label: string,
	index: number,
	usedKeys: Set<string>,
): string {
	const base =
		label
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || `col_${index + 1}`;
	let key = base;
	let suffix = 2;
	while (usedKeys.has(key)) {
		key = `${base}_${suffix}`;
		suffix += 1;
	}
	usedKeys.add(key);
	return key;
}

function normalizeTableScalar(
	value: GeneratedDocumentScalar,
): GeneratedDocumentScalar {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

function getTableColumnLabel(
	columnRecord: Record<string, unknown> | null,
	value: unknown,
): string | null {
	return (
		cleanText(columnRecord?.label) ??
		cleanText(columnRecord?.header) ??
		cleanText(columnRecord?.name) ??
		cleanText(columnRecord?.key) ??
		cleanText(value)
	);
}

function getTableColumnKey(
	columnRecord: Record<string, unknown> | null,
	label: string,
	index: number,
	usedKeys: Set<string>,
): string {
	const explicitKey = cleanKey(columnRecord?.key);
	if (explicitKey && !usedKeys.has(explicitKey)) {
		usedKeys.add(explicitKey);
		return explicitKey;
	}
	return makeColumnKey(label, index, usedKeys);
}

function getTableColumnKind(
	columnRecord: Record<string, unknown> | null,
): GeneratedDocumentTableColumn["kind"] {
	return columnRecord?.kind === "number" ||
		columnRecord?.kind === "currency" ||
		columnRecord?.kind === "percent" ||
		columnRecord?.kind === "date" ||
		columnRecord?.kind === "boolean"
		? columnRecord.kind
		: "text";
}

function getTableColumnSourceKeys(
	columnRecord: Record<string, unknown> | null,
	label: string,
	key: string,
): string[] {
	const explicitKey = cleanKey(columnRecord?.key);
	return Array.from(
		new Set(
			[
				explicitKey,
				cleanText(columnRecord?.label),
				cleanText(columnRecord?.header),
				cleanText(columnRecord?.name),
				cleanText(columnRecord?.key),
				label,
				key,
			].filter((sourceKey): sourceKey is string => Boolean(sourceKey)),
		),
	);
}

function normalizeTableColumn(
	value: unknown,
	index: number,
	usedKeys: Set<string>,
): TableColumnDraft | null {
	const columnRecord = isRecord(value) ? value : null;
	const label = getTableColumnLabel(columnRecord, value);
	if (!label) return null;

	const key = getTableColumnKey(columnRecord, label, index, usedKeys);
	return {
		key,
		label,
		kind: getTableColumnKind(columnRecord),
		sourceKeys: getTableColumnSourceKeys(columnRecord, label, key),
	};
}

function getTableArraySource(value: unknown, keys: readonly string[]): unknown {
	if (!isRecord(value)) return null;
	for (const key of keys) {
		if (Array.isArray(value[key])) return value[key];
	}
	return null;
}

function getTableColumnSource(block: Record<string, unknown>): unknown {
	return (
		getTableArraySource(block, ["columns", "headers", "header"]) ??
		getTableArraySource(block.data, ["columns", "headers", "header"]) ??
		(Array.isArray(block.data) && Array.isArray(block.data[0])
			? block.data[0]
			: null)
	);
}

function getTableRowsSource(block: Record<string, unknown>): unknown {
	return (
		getTableArraySource(block, ["rows", "body", "cells"]) ??
		getTableArraySource(block.data, ["rows", "body", "cells"]) ??
		(Array.isArray(block.data) && Array.isArray(block.data[0])
			? block.data.slice(1)
			: null)
	);
}

function normalizeTableRowCell(
	value: GeneratedDocumentScalar,
): GeneratedDocumentScalar {
	return normalizeTableScalar(value);
}

function normalizeTableArrayRow(
	rowSource: unknown[],
	columns: TableColumnDraft[],
): Record<string, GeneratedDocumentScalar> | null {
	if (rowSource.length > columns.length) return null;
	const row: Record<string, GeneratedDocumentScalar> = {};
	for (const [index, column] of columns.entries()) {
		const value = rowSource[index] ?? null;
		if (!isScalar(value)) return null;
		row[column.key] = normalizeTableRowCell(value);
	}
	return row;
}

function findTableColumnValue(
	rowSource: Record<string, GeneratedDocumentScalar>,
	column: TableColumnDraft,
): { found: boolean; value: GeneratedDocumentScalar } {
	const hasOwn = Object.prototype.hasOwnProperty;
	for (const sourceKey of column.sourceKeys) {
		if (hasOwn.call(rowSource, sourceKey)) {
			return { found: true, value: rowSource[sourceKey] };
		}
	}
	return { found: false, value: null };
}

function normalizeTableObjectRow(
	rowSource: unknown,
	columns: TableColumnDraft[],
): Record<string, GeneratedDocumentScalar> | null {
	const scalarRecord = normalizeScalarRecord(rowSource);
	if (!scalarRecord) return null;

	const row: Record<string, GeneratedDocumentScalar> = {};
	let matchedCellCount = 0;
	for (const column of columns) {
		const { found, value } = findTableColumnValue(scalarRecord, column);
		if (found) matchedCellCount += 1;
		row[column.key] = value;
	}
	if (matchedCellCount === 0 && Object.keys(scalarRecord).length > 0)
		return null;
	return row;
}

function normalizeTableRows(
	rowsSource: unknown,
	columns: TableColumnDraft[],
): Record<string, GeneratedDocumentScalar>[] {
	if (!Array.isArray(rowsSource)) return [];

	const rows: Record<string, GeneratedDocumentScalar>[] = [];
	for (const rowSource of rowsSource) {
		if (Array.isArray(rowSource)) {
			const row = normalizeTableArrayRow(rowSource, columns);
			if (!row) return [];
			rows.push(row);
			continue;
		}

		const row = normalizeTableObjectRow(rowSource, columns);
		if (!row) return [];
		rows.push(row);
	}
	return rows;
}

function cleanChartLabel(value: unknown, fallback: string): string {
	if (typeof value === "string")
		return value.replace(/\s+/g, " ").trim() || fallback;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return fallback;
}

function numericChartValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim().replace(/,/g, ""));
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (isRecord(value)) {
		return numericChartValue(value.y ?? value.value ?? value.count);
	}
	return null;
}

function normalizeChartJsData(
	block: Record<string, unknown>,
	chartType: GeneratedDocumentChartType,
): {
	data: Record<string, GeneratedDocumentScalar>[];
	xKey?: string | null;
	yKey?: string | null;
	labelKey?: string | null;
	valueKey?: string | null;
	seriesKey?: string | null;
	units?: string | null;
} | null {
	if (!isRecord(block.data) || !Array.isArray(block.data.datasets)) return null;

	const labels = Array.isArray(block.data.labels) ? block.data.labels : [];
	const datasets = block.data.datasets.filter(
		(dataset): dataset is Record<string, unknown> => isRecord(dataset),
	);
	if (datasets.length === 0) return null;

	const firstDataset = datasets[0];
	const firstDatasetData = Array.isArray(firstDataset.data)
		? firstDataset.data
		: [];
	const firstDatasetLabel = cleanText(firstDataset.label) ?? "value";

	if (chartType === "pie" || chartType === "donut") {
		const rows = firstDatasetData
			.map((value, index) => {
				const numericValue = numericChartValue(value);
				return numericValue === null
					? null
					: {
							label: cleanChartLabel(labels[index], `Item ${index + 1}`),
							value: numericValue,
						};
			})
			.filter((row): row is { label: string; value: number } => Boolean(row));
		return rows.length > 0
			? {
					data: rows,
					labelKey: "label",
					valueKey: "value",
					units: firstDatasetLabel,
				}
			: null;
	}

	if (chartType === "stackedBar") {
		const rows = datasets.flatMap((dataset, datasetIndex) => {
			const series = cleanText(dataset.label) ?? `Series ${datasetIndex + 1}`;
			const values = Array.isArray(dataset.data) ? dataset.data : [];
			return values
				.map((value, index) => {
					const numericValue = numericChartValue(value);
					return numericValue === null
						? null
						: {
								label: cleanChartLabel(labels[index], `Item ${index + 1}`),
								series,
								value: numericValue,
							};
				})
				.filter(
					(row): row is { label: string; series: string; value: number } =>
						Boolean(row),
				);
		});
		return rows.length > 0
			? {
					data: rows,
					xKey: "label",
					yKey: "value",
					seriesKey: "series",
					units: firstDatasetLabel,
				}
			: null;
	}

	if (chartType === "scatter") {
		const rows = firstDatasetData
			.map((value, index) => {
				const x = isRecord(value) ? numericChartValue(value.x) : index + 1;
				const y = numericChartValue(value);
				return x === null || y === null
					? null
					: {
							label: cleanChartLabel(labels[index], `Point ${index + 1}`),
							x,
							value: y,
						};
			})
			.filter((row): row is { label: string; x: number; value: number } =>
				Boolean(row),
			);
		return rows.length > 0
			? { data: rows, xKey: "x", yKey: "value", units: firstDatasetLabel }
			: null;
	}

	const rows = firstDatasetData
		.map((value, index) => {
			const numericValue = numericChartValue(value);
			return numericValue === null
				? null
				: {
						label: cleanChartLabel(labels[index], `Item ${index + 1}`),
						value: numericValue,
					};
		})
		.filter((row): row is { label: string; value: number } => Boolean(row));
	return rows.length > 0
		? { data: rows, xKey: "label", yKey: "value", units: firstDatasetLabel }
		: null;
}

const supportedChartTypes = [
	"bar",
	"stackedBar",
	"line",
	"area",
	"pie",
	"scatter",
	"donut",
] as const;

function getSupportedChartType(
	value: unknown,
): GeneratedDocumentChartType | null {
	return typeof value === "string" &&
		(supportedChartTypes as readonly string[]).includes(value)
		? (value as GeneratedDocumentChartType)
		: null;
}

function unsupportedChartDataResult(message: string): BlockNormalizationResult {
	return {
		ok: false,
		code: "unsupported_chart_data",
		message,
	};
}

function unsupportedDocumentBlockResult(): BlockNormalizationResult {
	return {
		ok: false,
		code: "unsupported_document_block",
		message: "Generated document source contains an unsupported block.",
	};
}

function normalizeChartDataRows(
	dataSource: unknown,
): Record<string, GeneratedDocumentScalar>[] | null {
	if (!Array.isArray(dataSource) || dataSource.length === 0) return null;

	const data = dataSource.map(normalizeScalarRecord).filter(isNonNull);
	return data.length === dataSource.length ? data : null;
}

type NormalizedChartFields = {
	title: string | null;
	caption: string | null;
	altText: string | null;
	units: string | null;
	xKey: string | null;
	yKey: string | null;
	labelKey: string | null;
	valueKey: string | null;
	seriesKey: string | null;
	radiusKey: string | null;
};

function getNormalizedChartFields(
	block: Record<string, unknown>,
	chartJsData: ReturnType<typeof normalizeChartJsData>,
): NormalizedChartFields {
	return {
		title: cleanText(block.title),
		caption: cleanText(block.caption),
		altText: cleanText(block.altText),
		units: cleanText(block.units) ?? chartJsData?.units ?? null,
		xKey: cleanKey(block.xKey) ?? chartJsData?.xKey ?? null,
		yKey: cleanKey(block.yKey) ?? chartJsData?.yKey ?? null,
		labelKey: cleanKey(block.labelKey) ?? chartJsData?.labelKey ?? null,
		valueKey: cleanKey(block.valueKey) ?? chartJsData?.valueKey ?? null,
		seriesKey: cleanKey(block.seriesKey) ?? chartJsData?.seriesKey ?? null,
		radiusKey: cleanKey(block.radiusKey),
	};
}

function isPieStyleChart(chartType: GeneratedDocumentChartType): boolean {
	return chartType === "pie" || chartType === "donut";
}

function requiresSeriesKey(chartType: GeneratedDocumentChartType): boolean {
	return chartType === "stackedBar";
}

function normalizeHeadingBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const text = cleanText(block.text);
	const hasExplicitLevel =
		Object.hasOwn(block, "level") && block.level !== undefined;
	const level = !hasExplicitLevel
		? 2
		: block.level === 1 || block.level === 2 || block.level === 3
			? block.level
			: null;
	return text && level
		? { ok: true, block: { type: "heading", level, text } }
		: unsupportedDocumentBlockResult();
}

function normalizeParagraphBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const text = cleanText(block.text);
	if (!text) return unsupportedDocumentBlockResult();
	const sources = normalizeSourceChipArray(block.sources);
	return {
		ok: true,
		block:
			sources.length > 0
				? { type: "paragraph", text, sources }
				: { type: "paragraph", text },
	};
}

function normalizeListBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const style = block.style === "numbered" ? "numbered" : "bullet";
	const items = Array.isArray(block.items)
		? block.items.map(cleanText).filter((item): item is string => Boolean(item))
		: [];
	return items.length > 0
		? { ok: true, block: { type: "list", style, items } }
		: unsupportedDocumentBlockResult();
}

function normalizeSourceAttribution(
	value: unknown,
): GeneratedDocumentSourceAttribution | null {
	if (!isRecord(value)) return null;
	const title = cleanText(value.title);
	const url = cleanText(value.url);
	return title && url ? { title, url } : null;
}

function normalizeCalloutBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const text = cleanText(block.text);
	const title = cleanText(block.title);
	const tone =
		block.tone === "info" ||
		block.tone === "warning" ||
		block.tone === "tip" ||
		block.tone === "note"
			? block.tone
			: "note";
	return text
		? { ok: true, block: { type: "callout", tone, title, text } }
		: unsupportedDocumentBlockResult();
}

function normalizeConfidenceMarkerBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const code = cleanKey(block.code) ?? "atlas_audit_marker";
	const message = cleanText(block.message);
	if (!message) return unsupportedDocumentBlockResult();
	const severity =
		block.severity === "critical" ||
		block.severity === "warning" ||
		block.severity === "info"
			? block.severity
			: "warning";
	const label =
		cleanText(block.label) ??
		(severity === "critical"
			? "Unsupported"
			: severity === "warning"
				? "Partially Supported"
				: "Supported");
	return {
		ok: true,
		block: { type: "confidenceMarker", code, label, severity, message },
	};
}

function normalizeSourceChipsBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const title = cleanText(block.title);
	const sources = normalizeSourceChipArray(block.sources);
	return title && sources.length > 0
		? { ok: true, block: { type: "sourceChips", title, sources } }
		: unsupportedDocumentBlockResult();
}

function normalizeSourceChip(
	value: unknown,
): GeneratedDocumentSourceChip | null {
	if (!isRecord(value)) return null;
	const title = cleanText(value.title);
	if (!title) return null;
	const url = cleanText(value.url);
	const kind =
		value.kind === "web" || value.kind === "library"
			? value.kind
			: url
				? "web"
				: "library";
	return {
		title,
		url,
		reasoning: cleanText(value.reasoning),
		provided: value.provided === true,
		kind,
	};
}

function normalizeSourceChipArray(
	value: unknown,
): GeneratedDocumentSourceChip[] {
	return Array.isArray(value)
		? value
				.map(normalizeSourceChip)
				.filter((source): source is GeneratedDocumentSourceChip =>
					Boolean(source),
				)
		: [];
}

function normalizeCodeBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const text =
		typeof block.text === "string" && block.text.trim()
			? block.text.trimEnd()
			: null;
	const language = cleanText(block.language);
	return text
		? { ok: true, block: { type: "code", language, text } }
		: unsupportedDocumentBlockResult();
}

function normalizeQuoteBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const text = cleanText(block.text);
	const citation = cleanText(block.citation);
	return text
		? { ok: true, block: { type: "quote", text, citation } }
		: unsupportedDocumentBlockResult();
}

type BlockNormalizationResult =
	| { ok: true; block: GeneratedDocumentBlock }
	| { ok: false; code: string; message: string };

function normalizeTableBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const usedKeys = new Set<string>();
	const columnSource = getTableColumnSource(block);
	const columns = Array.isArray(columnSource)
		? columnSource
				.map((column, index) => normalizeTableColumn(column, index, usedKeys))
				.filter((column): column is TableColumnDraft => Boolean(column))
		: [];
	const rowsSource = getTableRowsSource(block);
	const rows = normalizeTableRows(rowsSource, columns);

	if (
		columns.length === 0 ||
		rows.length === 0 ||
		!Array.isArray(rowsSource) ||
		rows.length !== rowsSource.length
	) {
		return {
			ok: false,
			code: "unsupported_table_structure",
			message:
				"Generated document source contains an unsupported table structure.",
		};
	}

	return {
		ok: true,
		block: {
			type: "table",
			title: cleanText(block.title),
			caption: cleanText(block.caption),
			columns: columns.map(({ sourceKeys: _sourceKeys, ...column }) => column),
			rows,
		},
	};
}

function normalizeChartBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	const chartType = getSupportedChartType(block.chartType);

	if (!chartType) {
		return {
			ok: false,
			code: "unsupported_chart_type",
			message: "Generated document source contains an unsupported chart type.",
		};
	}

	const chartJsData = normalizeChartJsData(block, chartType);
	const data = normalizeChartDataRows(
		Array.isArray(block.data) ? block.data : chartJsData?.data,
	);
	if (!data) {
		return unsupportedChartDataResult(
			"Generated document source contains unsupported chart data.",
		);
	}

	const {
		title,
		caption,
		altText,
		units,
		xKey,
		yKey,
		labelKey,
		valueKey,
		seriesKey,
		radiusKey,
	} = getNormalizedChartFields(block, chartJsData);
	if (!title || !caption || !altText || !units) {
		return unsupportedChartDataResult(
			"Generated document charts require title, caption, units, and alt text.",
		);
	}
	if (isPieStyleChart(chartType)) {
		if (!(labelKey && valueKey)) {
			return unsupportedChartDataResult(
				"Pie-style charts require labelKey and valueKey fields.",
			);
		}
	} else if (!(xKey && yKey)) {
		return unsupportedChartDataResult(
			"Generated document charts require xKey and yKey fields.",
		);
	}
	if (requiresSeriesKey(chartType) && !seriesKey) {
		return unsupportedChartDataResult(
			"Stacked bar charts require a seriesKey field.",
		);
	}

	return {
		ok: true,
		block: {
			type: "chart",
			chartType,
			title,
			caption,
			altText,
			xKey,
			yKey,
			labelKey,
			valueKey,
			seriesKey,
			radiusKey,
			units,
			data,
		},
	};
}

function normalizeImageBlock(
	block: Record<string, unknown>,
): BlockNormalizationResult {
	if (!isRecord(block.source)) {
		return {
			ok: false,
			code: "image_limit_exceeded",
			message: "Generated document image source is invalid.",
		};
	}

	let source: GeneratedDocumentImageSource | null = null;
	if (block.source.kind === "https") {
		const url = cleanText(block.source.url);
		source = url?.startsWith("https://") ? { kind: "https", url } : null;
	} else if (block.source.kind === "artifact") {
		const artifactId = cleanText(block.source.artifactId);
		source = artifactId ? { kind: "artifact", artifactId } : null;
	} else if (block.source.kind === "generated_file") {
		const fileId = cleanText(block.source.fileId);
		source = fileId ? { kind: "generated_file", fileId } : null;
	} else if (block.source.kind === "data") {
		const mimeType =
			block.source.mimeType === "image/png" ||
			block.source.mimeType === "image/jpeg" ||
			block.source.mimeType === "image/webp"
				? block.source.mimeType
				: null;
		const data =
			typeof block.source.data === "string" && block.source.data.length > 0
				? block.source.data
				: null;
		source = mimeType && data ? { kind: "data", mimeType, data } : null;
	}

	const altText = cleanText(block.altText);
	if (!source || !altText) {
		return {
			ok: false,
			code: "image_limit_exceeded",
			message: "Generated document image source is invalid.",
		};
	}

	return {
		ok: true,
		block: {
			type: "image",
			source,
			altText,
			caption: cleanText(block.caption),
			sourceAttribution: normalizeSourceAttribution(block.sourceAttribution),
			critical: block.critical === true,
		},
	};
}

function normalizeBlock(block: unknown): BlockNormalizationResult {
	if (!isRecord(block) || typeof block.type !== "string") {
		return unsupportedDocumentBlockResult();
	}

	switch (block.type) {
		case "heading":
			return normalizeHeadingBlock(block);
		case "paragraph":
			return normalizeParagraphBlock(block);
		case "list":
			return normalizeListBlock(block);
		case "sourceChips":
			return normalizeSourceChipsBlock(block);
		case "callout":
			return normalizeCalloutBlock(block);
		case "confidenceMarker":
			return normalizeConfidenceMarkerBlock(block);
		case "code":
			return normalizeCodeBlock(block);
		case "quote":
			return normalizeQuoteBlock(block);
		case "divider":
			return { ok: true, block: { type: "divider" } };
		case "table":
			return normalizeTableBlock(block);
		case "chart":
			return normalizeChartBlock(block);
		case "image":
			return normalizeImageBlock(block);
		case "pageBreak":
			return { ok: true, block: { type: "pageBreak" } };
		default:
			return unsupportedDocumentBlockResult();
	}
}

export function validateGeneratedDocumentSource(
	value: unknown,
): GeneratedDocumentSourceValidationResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			code: "invalid_document_source",
			message: "Generated document source must be an object.",
		};
	}

	const title = cleanText(value.title);
	const version = value.version;
	const template = value.template;
	if (version !== 1) {
		return {
			ok: false,
			code: "invalid_document_source",
			message: "Generated document source requires version: 1.",
		};
	}
	if (template !== "alfyai_standard_report") {
		return {
			ok: false,
			code: "invalid_document_source",
			message:
				'Generated document source requires template: "alfyai_standard_report".',
		};
	}
	if (!title) {
		return {
			ok: false,
			code: "invalid_document_source",
			message: "Generated document source requires a title.",
		};
	}

	if (!Array.isArray(value.blocks)) {
		return {
			ok: false,
			code: "invalid_document_source",
			message: "Generated document source requires blocks.",
		};
	}

	const blocks: GeneratedDocumentBlock[] = [];
	for (const block of value.blocks) {
		const normalized = normalizeBlock(block);
		if (!normalized.ok) {
			return {
				ok: false,
				code: normalized.code,
				message: normalized.message,
			};
		}
		blocks.push(normalized.block);
	}
	const cover =
		isRecord(value.cover) && value.cover.enabled === true
			? {
					enabled: true as const,
					eyebrow: cleanText(value.cover.eyebrow),
					dateLabel: cleanText(value.cover.dateLabel),
				}
			: undefined;

	return {
		ok: true,
		source: {
			version: 1,
			template: "alfyai_standard_report",
			title,
			subtitle: cleanText(value.subtitle),
			date: cleanText(value.date),
			language: cleanDocumentLanguage(value.language),
			...(cover ? { cover } : {}),
			blocks,
		},
	};
}

function formatSourceProjection(source: GeneratedDocumentSourceChip): string {
	const details = [
		source.url,
		source.provided ? "You provided these" : null,
		source.reasoning,
	].filter((part): part is string => Boolean(part));
	return details.length > 0
		? `${source.title} (${details.join("; ")})`
		: source.title;
}

export function buildGeneratedDocumentProjection(
	source: GeneratedDocumentSource,
): string {
	const lines: string[] = [source.title];
	if (source.subtitle) {
		lines.push(source.subtitle);
	}
	if (source.date) {
		lines.push(source.date);
	}
	if (source.cover) {
		lines.push(
			source.cover.eyebrow ? `Cover: ${source.cover.eyebrow}` : "Cover",
		);
		if (source.cover.dateLabel) lines.push(source.cover.dateLabel);
	}
	lines.push("");

	for (const block of source.blocks) {
		switch (block.type) {
			case "heading":
				lines.push(`${"#".repeat(block.level)} ${block.text}`);
				break;
			case "paragraph":
				lines.push(block.text);
				if (block.sources && block.sources.length > 0) {
					lines.push(
						`Sources: ${block.sources.map(formatSourceProjection).join("; ")}`,
					);
				}
				break;
			case "list":
				block.items.forEach((item, index) => {
					lines.push(
						block.style === "numbered" ? `${index + 1}. ${item}` : `- ${item}`,
					);
				});
				break;
			case "callout": {
				const label = block.tone.charAt(0).toUpperCase() + block.tone.slice(1);
				lines.push(block.title ? `${label}: ${block.title}` : `${label}:`);
				lines.push(block.text);
				break;
			}
			case "confidenceMarker":
				lines.push(`${block.label}: ${block.message}`);
				break;
			case "code":
				lines.push(block.language ? `Code (${block.language}):` : "Code:");
				lines.push(block.text);
				break;
			case "quote":
				lines.push(
					block.citation
						? `> ${block.text} -- ${block.citation}`
						: `> ${block.text}`,
				);
				break;
			case "divider":
				lines.push("---");
				break;
			case "sourceChips":
				lines.push(block.title);
				block.sources.forEach((source) => {
					lines.push(`- ${formatSourceProjection(source)}`);
				});
				break;
			case "table":
				if (block.title) lines.push(`Table: ${block.title}`);
				lines.push(block.columns.map((column) => column.label).join(" | "));
				block.rows.forEach((row) => {
					lines.push(
						block.columns
							.map((column) => String(row[column.key] ?? ""))
							.join(" | "),
					);
				});
				if (block.caption) lines.push(`Caption: ${block.caption}`);
				break;
			case "chart": {
				const label = block.title
					? `${block.chartType}: ${block.title}`
					: block.chartType;
				lines.push(`Chart: ${label}`);
				if (block.altText) lines.push(`Alt text: ${block.altText}`);
				if (block.caption) lines.push(`Caption: ${block.caption}`);
				lines.push(`Data points: ${block.data.length}`);
				break;
			}
			case "image":
				lines.push(`Image: ${block.altText}`);
				if (block.caption) lines.push(`Caption: ${block.caption}`);
				if (block.sourceAttribution) {
					lines.push(
						`Source: ${block.sourceAttribution.title} - ${block.sourceAttribution.url}`,
					);
				}
				break;
			case "pageBreak":
				lines.push("[Page break]");
				break;
		}
	}

	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
