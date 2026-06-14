import { getConfig, type RuntimeConfig } from "$lib/server/config-store";

export const FILE_PRODUCTION_LIMIT_ERROR_CODES = [
	"too_many_outputs",
	"source_too_large",
	"projection_too_large",
	"page_limit_exceeded",
	"table_limit_exceeded",
	"chart_limit_exceeded",
	"image_limit_exceeded",
	"renderer_timeout",
	"sandbox_timeout",
	"output_file_too_large",
	"job_outputs_too_large",
] as const;

export type FileProductionLimitErrorCode =
	(typeof FILE_PRODUCTION_LIMIT_ERROR_CODES)[number];

export interface FileProductionLimits {
	maxRequestedOutputs: number;
	maxSourceJsonBytes: number;
	maxProjectionBytes: number;
	maxPdfPages: number;
	maxTableRows: number;
	maxTableColumns: number;
	maxChartDataPoints: number;
	maxChartSeries: number;
	maxImageCount: number;
	maxImageBytes: number;
	maxTotalImageBytes: number;
	sandboxTimeoutMs: number;
	rendererTimeoutMs: number;
	maxOutputFileBytes: number;
	maxTotalOutputBytes: number;
}

export interface FileProductionLimitFailure {
	ok: false;
	code: FileProductionLimitErrorCode;
	message: string;
	retryable: boolean;
	limit: number;
	actual: number;
	unit: string;
}

export type FileProductionLimitResult =
	| { ok: true }
	| FileProductionLimitFailure;

type FileProductionRuntimeLimitConfig = Partial<RuntimeConfig> & {
	fileProductionMaxOutputs?: number;
	fileProductionMaxSourceJsonBytes?: number;
	fileProductionMaxProjectionBytes?: number;
	fileProductionMaxPdfPages?: number;
	fileProductionMaxTableRows?: number;
	fileProductionMaxTableColumns?: number;
	fileProductionMaxChartDataPoints?: number;
	fileProductionMaxChartSeries?: number;
	fileProductionMaxImageCount?: number;
	fileProductionMaxImageBytes?: number;
	fileProductionMaxTotalImageBytes?: number;
	fileProductionSandboxTimeoutMs?: number;
	fileProductionRendererTimeoutMs?: number;
	fileProductionMaxOutputFileBytes?: number;
	fileProductionMaxTotalOutputBytes?: number;
};

const DEFAULT_LIMITS: FileProductionLimits = {
	maxRequestedOutputs: 5,
	maxSourceJsonBytes: 2 * 1024 * 1024,
	maxProjectionBytes: 1 * 1024 * 1024,
	maxPdfPages: 250,
	maxTableRows: 10_000,
	maxTableColumns: 50,
	maxChartDataPoints: 20_000,
	maxChartSeries: 50,
	maxImageCount: 50,
	maxImageBytes: 25 * 1024 * 1024,
	maxTotalImageBytes: 200 * 1024 * 1024,
	sandboxTimeoutMs: 5 * 60 * 1000,
	rendererTimeoutMs: 5 * 60 * 1000,
	maxOutputFileBytes: 100 * 1024 * 1024,
	maxTotalOutputBytes: 250 * 1024 * 1024,
};

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.trunc(value)
		: fallback;
}

export function getFileProductionLimits(
	config: FileProductionRuntimeLimitConfig = getConfig(),
): FileProductionLimits {
	return {
		maxRequestedOutputs: positiveInteger(
			config.fileProductionMaxOutputs,
			DEFAULT_LIMITS.maxRequestedOutputs,
		),
		maxSourceJsonBytes: positiveInteger(
			config.fileProductionMaxSourceJsonBytes,
			DEFAULT_LIMITS.maxSourceJsonBytes,
		),
		maxProjectionBytes: positiveInteger(
			config.fileProductionMaxProjectionBytes,
			DEFAULT_LIMITS.maxProjectionBytes,
		),
		maxPdfPages: positiveInteger(
			config.fileProductionMaxPdfPages,
			DEFAULT_LIMITS.maxPdfPages,
		),
		maxTableRows: positiveInteger(
			config.fileProductionMaxTableRows,
			DEFAULT_LIMITS.maxTableRows,
		),
		maxTableColumns: positiveInteger(
			config.fileProductionMaxTableColumns,
			DEFAULT_LIMITS.maxTableColumns,
		),
		maxChartDataPoints: positiveInteger(
			config.fileProductionMaxChartDataPoints,
			DEFAULT_LIMITS.maxChartDataPoints,
		),
		maxChartSeries: positiveInteger(
			config.fileProductionMaxChartSeries,
			DEFAULT_LIMITS.maxChartSeries,
		),
		maxImageCount: positiveInteger(
			config.fileProductionMaxImageCount,
			DEFAULT_LIMITS.maxImageCount,
		),
		maxImageBytes: positiveInteger(
			config.fileProductionMaxImageBytes,
			DEFAULT_LIMITS.maxImageBytes,
		),
		maxTotalImageBytes: positiveInteger(
			config.fileProductionMaxTotalImageBytes,
			DEFAULT_LIMITS.maxTotalImageBytes,
		),
		sandboxTimeoutMs: positiveInteger(
			config.fileProductionSandboxTimeoutMs,
			DEFAULT_LIMITS.sandboxTimeoutMs,
		),
		rendererTimeoutMs: positiveInteger(
			config.fileProductionRendererTimeoutMs,
			DEFAULT_LIMITS.rendererTimeoutMs,
		),
		maxOutputFileBytes: positiveInteger(
			config.fileProductionMaxOutputFileBytes,
			DEFAULT_LIMITS.maxOutputFileBytes,
		),
		maxTotalOutputBytes: positiveInteger(
			config.fileProductionMaxTotalOutputBytes,
			DEFAULT_LIMITS.maxTotalOutputBytes,
		),
	};
}

function failure(params: {
	code: FileProductionLimitErrorCode;
	message: string;
	limit: number;
	actual: number;
	unit: string;
	retryable?: boolean;
}): FileProductionLimitFailure {
	return {
		ok: false,
		code: params.code,
		message: params.message,
		retryable: params.retryable ?? false,
		limit: params.limit,
		actual: params.actual,
		unit: params.unit,
	};
}

export function validateFileProductionStaticLimits(params: {
	outputCount: number;
	sourceJsonBytes: number;
	limits?: FileProductionLimits;
}): FileProductionLimitResult {
	const limits = params.limits ?? getFileProductionLimits();
	if (params.outputCount > limits.maxRequestedOutputs) {
		return failure({
			code: "too_many_outputs",
			message: "Too many outputs were requested.",
			limit: limits.maxRequestedOutputs,
			actual: params.outputCount,
			unit: "outputs",
		});
	}

	if (params.sourceJsonBytes > limits.maxSourceJsonBytes) {
		return failure({
			code: "source_too_large",
			message: "The file production source is too large.",
			limit: limits.maxSourceJsonBytes,
			actual: params.sourceJsonBytes,
			unit: "bytes",
		});
	}

	return { ok: true };
}

export function validateFileProductionOutputLimits(params: {
	fileSizes: number[];
	limits?: FileProductionLimits;
}): FileProductionLimitResult {
	const limits = params.limits ?? getFileProductionLimits();
	const oversizedFile = params.fileSizes.find(
		(size) => size > limits.maxOutputFileBytes,
	);
	if (oversizedFile !== undefined) {
		return failure({
			code: "output_file_too_large",
			message: "A produced file is larger than the configured limit.",
			limit: limits.maxOutputFileBytes,
			actual: oversizedFile,
			unit: "bytes",
		});
	}

	const totalBytes = params.fileSizes.reduce((sum, size) => sum + size, 0);
	if (totalBytes > limits.maxTotalOutputBytes) {
		return failure({
			code: "job_outputs_too_large",
			message: "The produced files are larger than the configured job limit.",
			limit: limits.maxTotalOutputBytes,
			actual: totalBytes,
			unit: "bytes",
		});
	}

	return { ok: true };
}
