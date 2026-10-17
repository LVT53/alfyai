import { describe, expect, it } from "vitest";
import { readTwoStepBackupNotice } from "./two-step-backup-notice";

describe("the backup-code notice in the URL", () => {
	it("reads the count and strips only its own parameter", () => {
		const notice = readTwoStepBackupNotice(
			new URL("http://localhost/?twoStepBackupLeft=9&project=abc"),
		);

		expect(notice?.count).toBe(9);
		expect(notice?.cleaned.toString()).toBe("http://localhost/?project=abc");
	});

	it("is absent when the parameter is absent", () => {
		expect(readTwoStepBackupNotice(new URL("http://localhost/"))).toBeNull();
	});

	it("ignores a value that is not a count", () => {
		expect(
			readTwoStepBackupNotice(
				new URL("http://localhost/?twoStepBackupLeft=soon"),
			),
		).toBeNull();
		expect(
			readTwoStepBackupNotice(
				new URL("http://localhost/?twoStepBackupLeft=-1"),
			),
		).toBeNull();
	});
});
