export type GeneratedDocumentBlock =
	| { type: "heading"; level: 1 | 2 | 3; text: string }
	| { type: "paragraph"; text: string }
	| { type: "list"; style: "bullet" | "numbered"; items: string[] }
	| {
			type: "callout";
			tone: "info" | "warning" | "tip" | "note";
			title?: string | null;
			text: string;
	  }
	| { type: "code"; language?: string | null; text: string }
	| { type: "quote"; text: string; citation?: string | null }
	| { type: "divider" }
	| GeneratedDocumentTableBlock
	| GeneratedDocumentChartBlock
	| GeneratedDocumentImageBlock
	| { type: "pageBreak" };

export type GeneratedDocumentScalar = string | number | boolean | null;

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
	critical?: boolean;
}

export interface GeneratedDocumentSource {
	version: 1;
	template: "alfyai_standard_report";
	title: string;
	subtitle?: string | null;
	date?: string | null;
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

function normalizeScalarRecord(
	value: unknown,
): Record<string, GeneratedDocumentScalar> | null {
	if (!isRecord(value)) return null;

	const normalized: Record<string, GeneratedDocumentScalar> = {};
	for (const [key, cellValue] of Object.entries(value)) {
		if (key === "colspan" || key === "rowspan") return null;
		if (!isScalar(cellValue)) return null;
		normalized[key] =
			typeof cellValue === "string"
				? cellValue.replace(/\s+/g, " ").trim()
				: cellValue;
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

function normalizeTableColumn(
	value: unknown,
	index: number,
	usedKeys: Set<string>,
): TableColumnDraft | null {
	const columnRecord = isRecord(value) ? value : null;
	const label =
		cleanText(columnRecord?.label) ??
		cleanText(columnRecord?.header) ??
		cleanText(columnRecord?.name) ??
		cleanText(columnRecord?.key) ??
		cleanText(value);
	if (!label) return null;

	const explicitKey = cleanKey(columnRecord?.key);
	const key =
		explicitKey && !usedKeys.has(explicitKey)
			? explicitKey
			: makeColumnKey(label, index, usedKeys);
	if (explicitKey && key === explicitKey) usedKeys.add(explicitKey);
	const kind =
		columnRecord?.kind === "number" ||
		columnRecord?.kind === "currency" ||
		columnRecord?.kind === "percent" ||
		columnRecord?.kind === "date" ||
		columnRecord?.kind === "boolean"
			? columnRecord.kind
			: "text";
	const sourceKeys = Array.from(
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
	return { key, label, kind, sourceKeys };
}

function getTableColumnSource(block: Record<string, unknown>): unknown {
	if (Array.isArray(block.columns)) return block.columns;
	if (Array.isArray(block.headers)) return block.headers;
	if (Array.isArray(block.header)) return block.header;
	if (isRecord(block.data)) {
		if (Array.isArray(block.data.columns)) return block.data.columns;
		if (Array.isArray(block.data.headers)) return block.data.headers;
		if (Array.isArray(block.data.header)) return block.data.header;
	}
	if (Array.isArray(block.data) && Array.isArray(block.data[0]))
		return block.data[0];
	return null;
}

function getTableRowsSource(block: Record<string, unknown>): unknown {
	if (Array.isArray(block.rows)) return block.rows;
	if (Array.isArray(block.body)) return block.body;
	if (Array.isArray(block.cells)) return block.cells;
	if (isRecord(block.data)) {
		if (Array.isArray(block.data.rows)) return block.data.rows;
		if (Array.isArray(block.data.body)) return block.data.body;
		if (Array.isArray(block.data.cells)) return block.data.cells;
	}
	if (Array.isArray(block.data) && Array.isArray(block.data[0]))
		return block.data.slice(1);
	return null;
}

function normalizeTableRows(
	rowsSource: unknown,
	columns: TableColumnDraft[],
): Record<string, GeneratedDocumentScalar>[] {
	if (!Array.isArray(rowsSource)) return [];

	const hasOwn = Object.prototype.hasOwnProperty;
	const rows: Record<string, GeneratedDocumentScalar>[] = [];
	for (const rowSource of rowsSource) {
		const row: Record<string, GeneratedDocumentScalar> = {};
		if (Array.isArray(rowSource)) {
			if (rowSource.length > columns.length) return [];
			for (const [index, column] of columns.entries()) {
				const value = rowSource[index] ?? null;
				if (!isScalar(value)) return [];
				row[column.key] =
					typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
			}
			rows.push(row);
			continue;
		}

		const scalarRecord = normalizeScalarRecord(rowSource);
		if (!scalarRecord) return [];
		let matchedCellCount = 0;
		for (const column of columns) {
			let value: GeneratedDocumentScalar = null;
			for (const sourceKey of column.sourceKeys) {
				if (hasOwn.call(scalarRecord, sourceKey)) {
					value = scalarRecord[sourceKey];
					matchedCellCount += 1;
					break;
				}
			}
			row[column.key] = value;
		}
		if (matchedCellCount === 0 && Object.keys(scalarRecord).length > 0)
			return [];
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
	const chartType =
		block.chartType === "bar" ||
		block.chartType === "stackedBar" ||
		block.chartType === "line" ||
		block.chartType === "area" ||
		block.chartType === "pie" ||
		block.chartType === "scatter" ||
		block.chartType === "donut"
			? block.chartType
			: null;

	if (!chartType) {
		return {
			ok: false,
			code: "unsupported_chart_type",
			message: "Generated document source contains an unsupported chart type.",
		};
	}

	const chartJsData = normalizeChartJsData(block, chartType);
	const dataSource = Array.isArray(block.data) ? block.data : chartJsData?.data;
	const data = Array.isArray(dataSource)
		? dataSource
				.map(normalizeScalarRecord)
				.filter((row): row is Record<string, GeneratedDocumentScalar> =>
					Boolean(row),
				)
		: [];
	if (
		data.length === 0 ||
		!Array.isArray(dataSource) ||
		data.length !== dataSource.length
	) {
		return {
			ok: false,
			code: "unsupported_chart_data",
			message: "Generated document source contains unsupported chart data.",
		};
	}

	const xKey = cleanKey(block.xKey) ?? chartJsData?.xKey ?? null;
	const yKey = cleanKey(block.yKey) ?? chartJsData?.yKey ?? null;
	const labelKey = cleanKey(block.labelKey) ?? chartJsData?.labelKey ?? null;
	const valueKey = cleanKey(block.valueKey) ?? chartJsData?.valueKey ?? null;
	const seriesKey = cleanKey(block.seriesKey) ?? chartJsData?.seriesKey ?? null;
	const title = cleanText(block.title);
	const caption = cleanText(block.caption);
	const altText = cleanText(block.altText);
	const units = cleanText(block.units) ?? chartJsData?.units ?? null;
	if (!title || !caption || !altText || !units) {
		return {
			ok: false,
			code: "unsupported_chart_data",
			message:
				"Generated document charts require title, caption, units, and alt text.",
		};
	}
	if (
		(chartType === "pie" || chartType === "donut") &&
		!(labelKey && valueKey)
	) {
		return {
			ok: false,
			code: "unsupported_chart_data",
			message: "Pie-style charts require labelKey and valueKey fields.",
		};
	}
	if (chartType !== "pie" && chartType !== "donut" && !(xKey && yKey)) {
		return {
			ok: false,
			code: "unsupported_chart_data",
			message: "Generated document charts require xKey and yKey fields.",
		};
	}
	if (chartType === "stackedBar" && !seriesKey) {
		return {
			ok: false,
			code: "unsupported_chart_data",
			message: "Stacked bar charts require a seriesKey field.",
		};
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
			radiusKey: cleanKey(block.radiusKey),
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
			critical: block.critical === true,
		},
	};
}

function normalizeBlock(block: unknown): BlockNormalizationResult {
	if (!isRecord(block) || typeof block.type !== "string") {
		return {
			ok: false,
			code: "unsupported_document_block",
			message: "Generated document source contains an unsupported block.",
		};
	}

	switch (block.type) {
		case "heading": {
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
				: {
						ok: false,
						code: "unsupported_document_block",
						message: "Generated document source contains an unsupported block.",
					};
		}
		case "paragraph": {
			const text = cleanText(block.text);
			return text
				? { ok: true, block: { type: "paragraph", text } }
				: {
						ok: false,
						code: "unsupported_document_block",
						message: "Generated document source contains an unsupported block.",
					};
		}
		case "list": {
			const style = block.style === "numbered" ? "numbered" : "bullet";
			const items = Array.isArray(block.items)
				? block.items
						.map(cleanText)
						.filter((item): item is string => Boolean(item))
				: [];
			return items.length > 0
				? { ok: true, block: { type: "list", style, items } }
				: {
						ok: false,
						code: "unsupported_document_block",
						message: "Generated document source contains an unsupported block.",
					};
		}
		case "callout": {
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
				: {
						ok: false,
						code: "unsupported_document_block",
						message: "Generated document source contains an unsupported block.",
					};
		}
		case "code": {
			const text =
				typeof block.text === "string" && block.text.trim()
					? block.text.trimEnd()
					: null;
			const language = cleanText(block.language);
			return text
				? { ok: true, block: { type: "code", language, text } }
				: {
						ok: false,
						code: "unsupported_document_block",
						message: "Generated document source contains an unsupported block.",
					};
		}
		case "quote": {
			const text = cleanText(block.text);
			const citation = cleanText(block.citation);
			return text
				? { ok: true, block: { type: "quote", text, citation } }
				: {
						ok: false,
						code: "unsupported_document_block",
						message: "Generated document source contains an unsupported block.",
					};
		}
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
			return {
				ok: false,
				code: "unsupported_document_block",
				message: "Generated document source contains an unsupported block.",
			};
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
			...(cover ? { cover } : {}),
			blocks,
		},
	};
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
