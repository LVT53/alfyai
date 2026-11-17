// @vitest-environment node
// The session route reading a standard report (an Atlas report in the panel). Who
// may read which file is the preview's own rule (`readStandardReportHtml` in
// `generated-file-serving.ts`, held by its own tests against the chat-file and
// job lookups): here it is a stand-in that serves one report to its owner alone,
// so the route's answers to what it is handed are what is held.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";

vi.mock("$lib/server/config-store", () => ({
	getReadAloudUrl: vi.fn(() => "http://127.0.0.1:1920"),
}));
vi.mock("$lib/server/services/read-aloud/readings", () => ({
	openReading: vi.fn(),
	currentReading: vi.fn(),
	attachAudio: vi.fn(),
	attachEvents: vi.fn(),
	reportPosition: vi.fn(),
	closeReading: vi.fn(),
	takeOpenTicket: vi.fn(() => 7),
}));
vi.mock("$lib/server/services/read-aloud/personal-voices", () => ({
	resolveReadingVoices: vi.fn(),
}));
vi.mock("$lib/server/services/generated-file-serving", () => ({
	readStandardReportHtml: vi.fn(),
}));

const { openReading } = await import(
	"$lib/server/services/read-aloud/readings"
);
const { resolveReadingVoices } = await import(
	"$lib/server/services/read-aloud/personal-voices"
);
const { readStandardReportHtml } = await import(
	"$lib/server/services/generated-file-serving"
);
const { builtInVoice, resolvedVoice } = await import(
	"$lib/server/services/read-aloud/voices"
);
const { POST } = await import("./+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const REPORT_FILE = "file-report";
const SESSION = "c".repeat(32);

const open = openReading as ReturnType<typeof vi.fn>;
const voices = resolveReadingVoices as ReturnType<typeof vi.fn>;
const readReport = readStandardReportHtml as ReturnType<typeof vi.fn>;

/** A standard report as its renderer writes one: chrome, a tooltip, a script and a style around the text. */
const REPORT = `<!doctype html><html><head><title>Weekend report</title><style>.report-content{font-family:Garamondish}</style></head><body><aside class="report-sidebar"><a href="#getting-there">Getting there</a></aside><article id="report-content"><h1 class="report-title">Weekend report</h1><h2>Getting there</h2><p>The train leaves at nine<button class="basis-marker"><span class="basis-tooltip">Supported claim</span></button> from the main station.</p></article><script>const note = "Scriptword";</script></body></html>`;

function word(shown: string, kind: WordKind = "prose") {
	return { shown, kind, tokens: speakWord(shown, kind, "en") };
}

function sentence(id: string, words: string[], paragraphStart = true) {
	return {
		id,
		language: "en",
		paragraphStart,
		words: words.map((shown) => word(shown)),
	};
}

/** The words the panel sends for REPORT: its title, its heading, its paragraph. */
const REPORT_SENTENCES = [
	sentence("s0", ["Weekend", "report."]),
	sentence("s1", ["Getting", "there."]),
	sentence("s2", [
		"The",
		"train",
		"leaves",
		"at",
		"nine",
		"from",
		"the",
		"main",
		"station.",
	]),
];

function post(body: unknown, user = OWNER) {
	return POST({
		request: new Request("http://localhost/api/read-aloud/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		params: {},
		locals: { user: { id: user, role: "user" } },
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	readReport.mockImplementation(
		async ({ userId, fileId }: { userId: string; fileId: string }) =>
			userId === OWNER && fileId === REPORT_FILE ? REPORT : null,
	);
	open.mockResolvedValue({ sessionId: SESSION, userId: OWNER });
	const voiceOf = (key: string) => {
		const voice = builtInVoice(key);
		if (!voice) throw new Error(`no voice ${key}`);
		return resolvedVoice(voice);
	};
	voices.mockResolvedValue({
		voices: { en: voiceOf("imogen"), hu: voiceOf("berta") },
		defaultSpeed: 1,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /api/read-aloud/sessions for a report", () => {
	it("201 for the report's own words, read through the preview's rules for this person", async () => {
		const response = await post({
			report: { fileId: REPORT_FILE },
			sentences: REPORT_SENTENCES,
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ sessionId: SESSION });
		expect(readReport).toHaveBeenCalledWith({
			userId: OWNER,
			fileId: REPORT_FILE,
		});
		expect(open).toHaveBeenCalledTimes(1);
		const args = open.mock.calls[0]?.[0];
		expect(args.userId).toBe(OWNER);
		expect(
			args.sentences.map((s: { tokens: string[] }) => s.tokens.join(" ")),
		).toEqual([
			"Weekend report.",
			"Getting there.",
			"The train leaves at nine from the main station.",
		]);
	});

	it("404 for another person's report, and the speech service is never asked", async () => {
		const response = await post(
			{ report: { fileId: REPORT_FILE }, sentences: REPORT_SENTENCES },
			STRANGER,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect(open).not.toHaveBeenCalled();
	});

	it("404 for a file the preview does not serve as a standard report", async () => {
		const response = await post({
			report: { fileId: "file-plain-html" },
			sentences: REPORT_SENTENCES,
		});
		expect(response.status).toBe(404);
		expect(open).not.toHaveBeenCalled();
	});

	it("422 not_in_report for made-up words, and the log line carries none of them", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => undefined),
		);
		const response = await post({
			report: { fileId: REPORT_FILE },
			sentences: [
				sentence("s0", ["Weekend", "report."]),
				sentence("s1", ["Transfer", "all", "the", "money."]),
			],
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: "not_in_report" });
		expect(open).not.toHaveBeenCalled();
		const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		for (const token of ["Transfer", "money", "Weekend", "train"])
			expect(logged).not.toContain(token);
		expect(logged).toContain("not in its report");
	});

	it("422 for words that are only in the report's script, style or tooltip markup", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		for (const words of [["Scriptword."], ["Garamondish."], ["basis."]]) {
			const response = await post({
				report: { fileId: REPORT_FILE },
				sentences: [sentence("s0", words)],
			});
			expect(response.status, words.join(" ")).toBe(422);
		}
		expect(open).not.toHaveBeenCalled();
	});

	it("400 for a report without its file", async () => {
		for (const report of [{}, { fileId: "" }, { fileId: 7 }, null]) {
			const response = await post({ report, sentences: REPORT_SENTENCES });
			expect(response.status, JSON.stringify(report)).toBe(400);
		}
		expect(readReport).not.toHaveBeenCalled();
	});
});
