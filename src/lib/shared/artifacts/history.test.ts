import { describe, expect, it } from "vitest";
import {
	MOMENT_KINDS,
	MOMENT_STATUSES,
	normalizeVersionLabel,
	VERSION_LABEL_MAX_CHARS,
} from "./history";

describe("normalizeVersionLabel", () => {
	it("stores a name as one trimmed line", () => {
		expect(normalizeVersionLabel("  Before the\n client   call ")).toEqual({
			ok: true,
			label: "Before the client call",
		});
	});

	it("reads blank and null as removing the name", () => {
		expect(normalizeVersionLabel(null)).toEqual({ ok: true, label: null });
		expect(normalizeVersionLabel("   \n ")).toEqual({ ok: true, label: null });
	});

	it("refuses a name that is not text or is past the limit, counting characters", () => {
		expect(normalizeVersionLabel(7)).toEqual({ ok: false });
		expect(normalizeVersionLabel(undefined)).toEqual({ ok: false });
		expect(
			normalizeVersionLabel("x".repeat(VERSION_LABEL_MAX_CHARS)),
		).toMatchObject({ ok: true });
		expect(
			normalizeVersionLabel("x".repeat(VERSION_LABEL_MAX_CHARS + 1)),
		).toEqual({ ok: false });
		// 60 characters of two UTF-16 units each are still 60 characters.
		expect(
			normalizeVersionLabel("\u{1F4DA}".repeat(VERSION_LABEL_MAX_CHARS)),
		).toMatchObject({ ok: true });
	});
});

describe("the shared vocabulary", () => {
	it("lists each moment kind and review status once", () => {
		expect(new Set(MOMENT_KINDS).size).toBe(MOMENT_KINDS.length);
		expect(new Set(MOMENT_STATUSES).size).toBe(MOMENT_STATUSES.length);
	});
});
