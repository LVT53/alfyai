import { describe, expect, it } from "vitest";
import { describeLocalMoment, isValidTimeZone } from "./time-zone";

const at = (iso: string) => new Date(iso);

describe("describeLocalMoment", () => {
	it("gives the local date, the 24-hour time and the UTC offset in winter", () => {
		expect(
			describeLocalMoment(at("2026-11-10T13:35:00Z"), "Europe/Budapest"),
		).toEqual({
			date: "Tuesday, November 10, 2026",
			time: "14:35",
			offset: "UTC+01:00",
		});
	});

	it("moves to the summer offset in July", () => {
		expect(
			describeLocalMoment(at("2026-07-15T10:05:00Z"), "Europe/Budapest"),
		).toEqual({
			date: "Wednesday, July 15, 2026",
			time: "12:05",
			offset: "UTC+02:00",
		});
	});

	// The EU moves the clocks at 01:00 UTC on the last Sunday of March and
	// October. Each case below is a minute a person could be asking in.
	describe("the day the clocks go forward (Sunday 29 March 2026, Europe/Budapest)", () => {
		it("is still 01:59 at +01:00 the minute before the change", () => {
			expect(
				describeLocalMoment(at("2026-03-29T00:59:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Sunday, March 29, 2026",
				time: "01:59",
				offset: "UTC+01:00",
			});
		});

		it("jumps to 03:00 at +02:00, so no 02:xx exists that day", () => {
			expect(
				describeLocalMoment(at("2026-03-29T01:00:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Sunday, March 29, 2026",
				time: "03:00",
				offset: "UTC+02:00",
			});
		});

		it("is already Sunday at the local midnight that opens the day, while UTC is still Saturday", () => {
			expect(
				describeLocalMoment(at("2026-03-28T23:00:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Sunday, March 29, 2026",
				time: "00:00",
				offset: "UTC+01:00",
			});
		});
	});

	describe("the day the clocks go back (Sunday 25 October 2026, Europe/Budapest)", () => {
		it("reads 02:30 at +02:00 the first time round", () => {
			expect(
				describeLocalMoment(at("2026-10-25T00:30:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Sunday, October 25, 2026",
				time: "02:30",
				offset: "UTC+02:00",
			});
		});

		it("reads 02:30 again an hour later at +01:00: the offset tells the two apart", () => {
			expect(
				describeLocalMoment(at("2026-10-25T01:30:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Sunday, October 25, 2026",
				time: "02:30",
				offset: "UTC+01:00",
			});
		});

		it("opens the day at 00:00 in summer time, while UTC is still Saturday", () => {
			expect(
				describeLocalMoment(at("2026-10-24T22:00:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Sunday, October 25, 2026",
				time: "00:00",
				offset: "UTC+02:00",
			});
		});

		it("closes the day at winter time: the next local midnight is Monday at +01:00", () => {
			expect(
				describeLocalMoment(at("2026-10-25T23:00:00Z"), "Europe/Budapest"),
			).toEqual({
				date: "Monday, October 26, 2026",
				time: "00:00",
				offset: "UTC+01:00",
			});
		});
	});

	it("writes the hour after midnight as 00, never 24, and takes the local date with it", () => {
		const moment = describeLocalMoment(
			at("2026-11-10T23:05:00Z"),
			"Europe/Budapest",
		);
		expect(moment).toEqual({
			date: "Wednesday, November 11, 2026",
			time: "00:05",
			offset: "UTC+01:00",
		});
	});

	describe("zones whose offset is not a whole hour", () => {
		it("reads a half-hour zone (Asia/Kolkata, +05:30)", () => {
			expect(
				describeLocalMoment(at("2026-11-10T13:35:00Z"), "Asia/Kolkata"),
			).toEqual({
				date: "Tuesday, November 10, 2026",
				time: "19:05",
				offset: "UTC+05:30",
			});
		});

		it("keeps the sign and the minutes of a negative half-hour zone (America/St_Johns, -03:30)", () => {
			expect(
				describeLocalMoment(at("2026-01-10T13:35:00Z"), "America/St_Johns"),
			).toEqual({
				date: "Saturday, January 10, 2026",
				time: "10:05",
				offset: "UTC-03:30",
			});
		});

		it("reads a quarter-hour zone (Asia/Kathmandu, +05:45)", () => {
			expect(
				describeLocalMoment(at("2026-11-10T13:35:00Z"), "Asia/Kathmandu"),
			).toEqual({
				date: "Tuesday, November 10, 2026",
				time: "19:20",
				offset: "UTC+05:45",
			});
		});
	});

	it("writes UTC itself as +00:00, whichever way the runtime spells a zero offset", () => {
		expect(describeLocalMoment(at("2026-11-10T13:35:00Z"), "UTC")).toEqual({
			date: "Tuesday, November 10, 2026",
			time: "13:35",
			offset: "UTC+00:00",
		});
	});

	it("does not read the machine's own zone or locale", () => {
		// The same instant in two zones that sit on either side of a date line
		// is two different dates: nothing here may fall back to the process zone.
		const west = describeLocalMoment(
			at("2026-11-10T03:00:00Z"),
			"America/Los_Angeles",
		);
		const east = describeLocalMoment(at("2026-11-10T03:00:00Z"), "Asia/Tokyo");
		expect(west?.date).toBe("Monday, November 9, 2026");
		expect(east?.date).toBe("Tuesday, November 10, 2026");
	});

	it("answers null for a zone the runtime does not know, and for a time that is not a time", () => {
		expect(
			describeLocalMoment(at("2026-11-10T13:35:00Z"), "Mars/Olympus"),
		).toBeNull();
		expect(describeLocalMoment(at("2026-11-10T13:35:00Z"), "")).toBeNull();
		expect(
			describeLocalMoment(at("2026-11-10T13:35:00Z"), "+01:00"),
		).toBeNull();
		expect(
			describeLocalMoment(new Date(Number.NaN), "Europe/Budapest"),
		).toBeNull();
	});
});

describe("isValidTimeZone", () => {
	it.each([
		"Europe/Budapest",
		"UTC",
		"Asia/Kolkata",
		// A browser can still report the old name of a zone.
		"Asia/Calcutta",
		"America/Argentina/Buenos_Aires",
		"America/Port-au-Prince",
		"Etc/GMT+8",
	])("accepts the IANA name %s", (zone) => {
		expect(isValidTimeZone(zone)).toBe(true);
	});

	it.each([
		["an empty string", ""],
		["a name the runtime does not know", "Mars/Olympus"],
		["a UTC offset, which is not an IANA name", "+01:00"],
		["an offset without a colon", "-0500"],
		["a leading space", " Europe/Budapest"],
		["a trailing newline", "Europe/Budapest\n"],
		["an empty path segment", "Europe//Budapest"],
		["a path out of the zone folder", "../../etc/passwd"],
		["text that is not a name at all", "UTC; DROP TABLE users"],
		["a name too long to be one", `Europe/${"A".repeat(80)}`],
		["a number", 3600],
		["null", null],
		["undefined", undefined],
		["an object", { zone: "Europe/Budapest" }],
	])("rejects %s", (_label, value) => {
		expect(isValidTimeZone(value)).toBe(false);
	});
});
