import { describe, expect, it } from "vitest";
import { isPrivateHostname } from "./net";

describe("isPrivateHostname", () => {
	it.each([
		["localhost"],
		["127.0.0.1"],
		["192.168.1.96"],
		["10.1.2.3"],
		["172.16.5.5"],
		["::1"],
		["my-box.local"],
	])("returns true for %s", (host) => {
		expect(isPrivateHostname(host)).toBe(true);
	});

	it.each([
		["api.deepseek.com"],
		["1.2.3.4"],
		["example.com"],
	])("returns false for %s", (host) => {
		expect(isPrivateHostname(host)).toBe(false);
	});
});
