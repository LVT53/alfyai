/**
 * A person's IANA time zone ("Europe/Budapest"), in the one place the browser,
 * the settings route and the model prompt all read it. AGENTS.md forbids a
 * second copy of a validation rule, and the browser that detects a zone, the
 * route that stores it and the clock the model is told must agree on what a
 * zone is.
 *
 * Client-safe: no server imports, no DB, no env. Nothing here reads the
 * machine's own zone or locale: every function takes the zone it is asked
 * about, and the words are English because the one reader of them that is not a
 * person is a model request (chat-turn/AGENTS.md, ruling 79).
 */

/** The longest IANA name is about 32 characters; this leaves room and no more. */
const TIME_ZONE_MAX_CHARS = 64;

/**
 * What an IANA name looks like: a letter first, then letters, digits and
 * `_ + -`, in one to three segments ("UTC", "Europe/Budapest",
 * "America/Argentina/Buenos_Aires", "Etc/GMT+8"). `Intl` also accepts a UTC
 * offset ("+01:00") and ignores the case of a name; neither is a zone name the
 * app stores, so the shape is checked first.
 */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Whether `value` is a zone name this runtime knows. The runtime is asked
 * rather than a list: `Intl.supportedValuesOf("timeZone")` leaves out "UTC" and
 * names only one spelling of a renamed zone ("Asia/Calcutta" on one ICU,
 * "Asia/Kolkata" on another), and a browser may report either.
 */
export function isValidTimeZone(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0 || value.length > TIME_ZONE_MAX_CHARS) return false;
	if (!TIME_ZONE_SHAPE.test(value)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** One instant as a person in one zone reads it. */
export type LocalMoment = {
	/** "Tuesday, November 10, 2026". */
	date: string;
	/** 24-hour "14:35"; the hour after midnight is "00", never "24". */
	time: string;
	/** "UTC+01:00", "UTC-03:30", "UTC+00:00". */
	offset: string;
};

/**
 * What the wall clock in `timeZone` reads at `now`, or null for a zone the
 * runtime does not know (or a `now` that is not a time). The offset is the one
 * in force at `now`, which is what tells apart the two 02:30s of the night the
 * clocks go back.
 */
export function describeLocalMoment(
	now: Date,
	timeZone: string,
): LocalMoment | null {
	if (!isValidTimeZone(timeZone) || Number.isNaN(now.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		// "h23", not `hour12: false`: some engines print midnight as 24 for the
		// latter.
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((candidate) => candidate.type === type)?.value;

	const weekday = part("weekday");
	const month = part("month");
	const day = part("day");
	const year = part("year");
	const hour = part("hour");
	const minute = part("minute");
	const zoneName = part("timeZoneName");
	if (!weekday || !month || !day || !year || !hour || !minute || !zoneName) {
		return null;
	}

	return {
		date: `${weekday}, ${month} ${day}, ${year}`,
		time: `${hour}:${minute}`,
		// "GMT+01:00" in the usual case and a bare "GMT" for zero on some ICU
		// versions; spelt UTC either way.
		offset:
			zoneName === "GMT"
				? "UTC+00:00"
				: zoneName.replace(/^GMT/, "UTC").replace(/−/g, "-"),
	};
}
