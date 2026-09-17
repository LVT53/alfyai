import { describe, expect, it } from "vitest";
import { intlLocale } from "./locale";

// The app had this mapping in three places and hardcoded the wrong answer in
// a dozen more: chat timestamps, the personal analytics tab, the system
// analytics tab and the generated PDF reports all pinned "en-US" or "en-GB"
// regardless of the language everything around them was written in. These
// assertions are about the DECISION, not about ICU: "en" means British
// English here, and a language the app does not ship falls back to it rather
// than throwing inside a formatter.
describe("intlLocale", () => {
	it("maps the two languages the app ships", () => {
		expect(intlLocale("en")).toBe("en-GB");
		expect(intlLocale("hu")).toBe("hu-HU");
	});

	it("falls back to English for anything else", () => {
		// A missing preference, a legacy row, a string that was never narrowed.
		expect(intlLocale(undefined)).toBe("en-GB");
		expect(intlLocale(null)).toBe("en-GB");
		expect(intlLocale("")).toBe("en-GB");
		expect(intlLocale("de")).toBe("en-GB");
	});

	it("gives the two languages genuinely different output", () => {
		// The point of the whole change: same number, same date, two forms.
		const number = 1234567;
		expect(number.toLocaleString(intlLocale("en"))).not.toBe(
			number.toLocaleString(intlLocale("hu")),
		);

		const date = new Date(Date.UTC(2026, 8, 17));
		const opts = {
			year: "numeric",
			month: "long",
			day: "numeric",
			timeZone: "UTC",
		} as const;
		expect(
			new Intl.DateTimeFormat(intlLocale("en"), opts).format(date),
		).not.toBe(new Intl.DateTimeFormat(intlLocale("hu"), opts).format(date));
	});

	it("keeps English on the day-month order the chat timestamps expect", () => {
		// en-US would render this "September 17, 2026"; the chat's full
		// timestamp is "17 September 2026, 14:52" and must stay that way.
		const formatted = new Intl.DateTimeFormat(intlLocale("en"), {
			year: "numeric",
			month: "long",
			day: "numeric",
			timeZone: "UTC",
		}).format(new Date(Date.UTC(2026, 8, 17)));

		expect(formatted).toBe("17 September 2026");
	});
});
