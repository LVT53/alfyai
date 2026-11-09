import { describe, expect, it } from "vitest";
import { mineruSpeaksTasksProtocol } from "./protocol-version";

describe("mineruSpeaksTasksProtocol", () => {
	it.each([
		["4.1.0", true],
		["4.1.7", true],
		["v4.2", true],
		[" 4.10.0 ", true],
		["5.0.0", true],
		["4.0.12", false],
		["4.0.4", false],
		["3.9.9", false],
		["0.9", false],
	])("reads %s as %s", (version, expected) => {
		expect(mineruSpeaksTasksProtocol(version)).toBe(expected);
	});

	it.each([
		"",
		"nightly",
		"4",
		"4.x",
		"latest-4.1",
	])("cannot read %j, which is no evidence either way", (version) => {
		expect(mineruSpeaksTasksProtocol(version)).toBeNull();
	});
});
