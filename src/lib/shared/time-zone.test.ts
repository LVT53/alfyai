import { describe, expect, it } from "vitest";
import {
	describeLocalMoment,
	detectBrowserTimeZone,
	isValidTimeZone,
	shouldSaveDetectedTimeZone,
	timeZoneChoices,
} from "./time-zone";

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

describe("detectBrowserTimeZone", () => {
	it("is the zone this runtime reports for itself, when that is a name the app accepts", () => {
		const reported = Intl.DateTimeFormat().resolvedOptions().timeZone;

		const detected = detectBrowserTimeZone();

		expect(detected).toBe(isValidTimeZone(reported) ? reported : null);
		// Whatever it answers, it is a name the route will store.
		if (detected !== null) expect(isValidTimeZone(detected)).toBe(true);
	});
});

// When the browser's own zone replaces the one the server holds. The browser
// saves without a prompt, so the rule must never undo a zone the person chose:
// it saves when nothing is stored, and when THIS browser has moved since it
// last looked (the person travelled); an unchanged browser, or one that has
// never looked here, leaves what is stored alone.
describe("shouldSaveDetectedTimeZone", () => {
	const budapest = "Europe/Budapest";
	const london = "Europe/London";
	const tokyo = "Asia/Tokyo";

	it("saves the first zone a browser sees, when nothing is stored", () => {
		expect(
			shouldSaveDetectedTimeZone({
				stored: null,
				detected: budapest,
				lastDetected: null,
			}),
		).toBe(true);
	});

	it("saves nothing when the browser has no zone to offer", () => {
		expect(
			shouldSaveDetectedTimeZone({
				stored: null,
				detected: null,
				lastDetected: null,
			}),
		).toBe(false);
		expect(
			shouldSaveDetectedTimeZone({
				stored: budapest,
				detected: null,
				lastDetected: london,
			}),
		).toBe(false);
	});

	it("saves nothing when the server already holds the browser's zone: no write on every load", () => {
		expect(
			shouldSaveDetectedTimeZone({
				stored: budapest,
				detected: budapest,
				lastDetected: budapest,
			}),
		).toBe(false);
		expect(
			shouldSaveDetectedTimeZone({
				stored: budapest,
				detected: budapest,
				lastDetected: london,
			}),
		).toBe(false);
	});

	it("follows the browser when it has moved: it looked at Budapest last time and sees London now", () => {
		expect(
			shouldSaveDetectedTimeZone({
				stored: budapest,
				detected: london,
				lastDetected: budapest,
			}),
		).toBe(true);
	});

	it("leaves a zone the person chose alone while their browser still sees the zone it saw before", () => {
		// They live in Budapest, their browser says so, and they picked Tokyo.
		expect(
			shouldSaveDetectedTimeZone({
				stored: tokyo,
				detected: budapest,
				lastDetected: budapest,
			}),
		).toBe(false);
	});

	it("leaves the stored zone alone for a browser that has never looked here, whatever it sees", () => {
		// A second device, or one whose storage was cleared, must not overwrite
		// what the person set on the first.
		expect(
			shouldSaveDetectedTimeZone({
				stored: tokyo,
				detected: budapest,
				lastDetected: null,
			}),
		).toBe(false);
	});
});

// The few zones the Settings row offers, in a stable order: it never jumps
// after a choice, and it always holds the zone that is stored and the one the
// browser sees, whatever they are.
describe("timeZoneChoices", () => {
	it("offers a short, sorted list every zone of which this runtime can read", () => {
		const choices = timeZoneChoices({ stored: null, detected: null });

		expect(choices.length).toBeGreaterThan(5);
		expect(choices.length).toBeLessThan(25);
		expect(choices).toEqual([...choices].sort());
		expect(choices.every((zone) => isValidTimeZone(zone))).toBe(true);
		expect(choices).toContain("Europe/Budapest");
		expect(choices).toContain("UTC");
	});

	it("adds the stored zone and the browser's, once each, when they are not on the list", () => {
		const choices = timeZoneChoices({
			stored: "Asia/Kolkata",
			detected: "Pacific/Auckland",
		});

		expect(choices.filter((zone) => zone === "Asia/Kolkata")).toHaveLength(1);
		expect(choices.filter((zone) => zone === "Pacific/Auckland")).toHaveLength(
			1,
		);
		expect(choices).toEqual([...choices].sort());
	});

	it("does not repeat a zone that is already on the list", () => {
		const plain = timeZoneChoices({ stored: null, detected: null });

		expect(
			timeZoneChoices({
				stored: "Europe/Budapest",
				detected: "Europe/Budapest",
			}),
		).toEqual(plain);
	});

	it("leaves out a name this runtime cannot read, instead of offering an option that cannot be shown", () => {
		const plain = timeZoneChoices({ stored: null, detected: null });

		expect(
			timeZoneChoices({ stored: "Mars/Olympus", detected: "+01:00" }),
		).toEqual(plain);
	});
});
