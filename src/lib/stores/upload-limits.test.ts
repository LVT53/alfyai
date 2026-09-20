import { get } from "svelte/store";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES } from "$lib/shared/file-types";
import {
	maxFileUploadSizeBytes,
	maxFileUploadSizeMb,
	resetMaxFileUploadSize,
	setMaxFileUploadSize,
} from "./upload-limits";

describe("upload limits store", () => {
	beforeEach(() => {
		resetMaxFileUploadSize();
	});

	it("starts at the registry default", () => {
		expect(get(maxFileUploadSizeBytes)).toBe(
			DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES,
		);
		expect(get(maxFileUploadSizeMb)).toBe(100);
	});

	it("takes a server-reported limit", () => {
		setMaxFileUploadSize(52_428_800);

		expect(get(maxFileUploadSizeBytes)).toBe(52_428_800);
		expect(get(maxFileUploadSizeMb)).toBe(50);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("ignores %s rather than making every file too large", (_label, value) => {
		setMaxFileUploadSize(value as number | undefined | null);

		expect(get(maxFileUploadSizeBytes)).toBe(
			DEFAULT_MAX_FILE_UPLOAD_SIZE_BYTES,
		);
	});

	it("rounds the megabyte view rather than truncating it", () => {
		setMaxFileUploadSize(Math.round(1.6 * 1024 * 1024));
		expect(get(maxFileUploadSizeMb)).toBe(2);

		setMaxFileUploadSize(Math.round(1.4 * 1024 * 1024));
		expect(get(maxFileUploadSizeMb)).toBe(1);
	});

	it("floors a fractional byte count", () => {
		setMaxFileUploadSize(1024.9);
		expect(get(maxFileUploadSizeBytes)).toBe(1024);
	});
});
