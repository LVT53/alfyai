import { describe, expect, it } from "vitest";
import {
	FILE_PRODUCTION_LIMIT_ERROR_CODES,
	getFileProductionLimits,
	validateFileProductionStaticLimits,
} from "./limits";

describe("file production limits", () => {
	it("exposes stable v1 limit error codes", () => {
		expect(FILE_PRODUCTION_LIMIT_ERROR_CODES).toEqual([
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
		]);
	});

	it("reads effective limits from runtime config shaped values", () => {
		const limits = getFileProductionLimits({
			fileProductionMaxOutputs: 2,
			fileProductionMaxSourceJsonBytes: 128,
			fileProductionMaxOutputFileBytes: 512,
			fileProductionMaxTotalOutputBytes: 1024,
		});

		expect(limits.maxRequestedOutputs).toBe(2);
		expect(limits.maxSourceJsonBytes).toBe(128);
		expect(limits.maxOutputFileBytes).toBe(512);
		expect(limits.maxTotalOutputBytes).toBe(1024);
	});

	it("fails static output and source-size limits with non-retryable errors", () => {
		expect(
			validateFileProductionStaticLimits({
				outputCount: 3,
				sourceJsonBytes: 64,
				limits: getFileProductionLimits({ fileProductionMaxOutputs: 2 }),
			}),
		).toMatchObject({
			ok: false,
			code: "too_many_outputs",
			retryable: false,
			limit: 2,
			actual: 3,
			unit: "outputs",
		});

		expect(
			validateFileProductionStaticLimits({
				outputCount: 1,
				sourceJsonBytes: 129,
				limits: getFileProductionLimits({
					fileProductionMaxSourceJsonBytes: 128,
				}),
			}),
		).toMatchObject({
			ok: false,
			code: "source_too_large",
			retryable: false,
			limit: 128,
			actual: 129,
			unit: "bytes",
		});
	});
});
