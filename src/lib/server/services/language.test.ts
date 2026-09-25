import { describe, expect, it } from "vitest";
import {
	classifyLanguageSignal,
	detectExplicitLanguageRequest,
	detectLanguage,
	resolveResponseLanguage,
} from "./language";

describe("detectLanguage", () => {
	it("defaults empty input to English", () => {
		expect(detectLanguage("")).toBe("en");
	});

	it("uses the old short-input fallback for Hungarian short words", () => {
		expect(detectLanguage("Szia")).toBe("hu");
		expect(detectLanguage("igen")).toBe("hu");
		expect(detectLanguage("hello")).toBe("en");
	});

	it("detects accented Hungarian text as Hungarian", () => {
		expect(detectLanguage("Kérlek írj egy rövid emailt.")).toBe("hu");
	});

	it("detects mixed Hungarian prompts without accents", () => {
		expect(detectLanguage("Irj egy angol emailt")).toBe("hu");
		expect(detectLanguage("Valaszolj angolul egy rovid levelben")).toBe("hu");
	});

	it("keeps plain English prompts as English", () => {
		expect(detectLanguage("Write a short email in English")).toBe("en");
		expect(detectLanguage("Hello, tell me about artificial intelligence")).toBe(
			"en",
		);
	});

	it("detects mixed Hungarian-English prompts as Hungarian", () => {
		expect(
			detectLanguage("Szeretnék egy CSV fájlt generálni az adatokból"),
		).toBe("hu");
		expect(
			detectLanguage("Kérlek készíts egy reportot a Q4 eredményekről"),
		).toBe("hu");
		expect(
			detectLanguage("Írj egy Python scriptet ami letölti a fájlokat"),
		).toBe("hu");
	});

	it("detects short Hungarian inputs without diacritics as Hungarian when they contain Hungarian function words", () => {
		expect(detectLanguage("Irj egy emailt")).toBe("hu");
		expect(detectLanguage("Mondd el mi a helyzet")).toBe("hu");
		expect(detectLanguage("Valaszolj angolul")).toBe("hu");
	});

	it("detects real-world Hungarian sentences as Hungarian", () => {
		expect(
			detectLanguage(
				"Hogyan tudom beállítani a környezeti változókat Linux alatt?",
			),
		).toBe("hu");
		expect(
			detectLanguage("Mi a legjobb gyakorlat React komponensek tesztelésére?"),
		).toBe("hu");
		expect(
			detectLanguage(
				"Kérlek magyarázd el a különbséget a REST és GraphQL között",
			),
		).toBe("hu");
	});

	it("keeps plain English prompts as English even with Hungarian-like substrings", () => {
		expect(
			detectLanguage("Write a report about the Hungarian parliament"),
		).toBe("en");
		expect(
			detectLanguage("How do I configure the environment variables?"),
		).toBe("en");
	});

	// Root-cause corpus (2026-09-25 investigation): these are the exact shapes
	// of English message that used to come back Hungarian. Each used to fail
	// via one of three defects in the old scorer:
	//  - HUNGARIAN_BIGRAMS scored common English "-ly/-ny/-gy/-ty" endings as
	//    Hungarian evidence ("only", "many", "energy", "company", "really").
	//  - HUNGARIAN_SUFFIXES matched ordinary English words ("urban" ends in
	//    "-ban", the Hungarian inessive suffix).
	//  - The final tie-break flipped to Hungarian on ANY accented letter
	//    anywhere in the message, including inside a name or loanword
	//    ("café", "résumé", "Zürich", "Győr", "József", "Beyoncé") or a
	//    single-letter code/list token ("a") colliding with the Hungarian
	//    definite article.
	it("keeps ordinary English words with Hungarian-looking bigrams/suffixes as English", () => {
		expect(
			detectLanguage("I only have a few minutes, can you keep it short?"),
		).toBe("en");
		expect(
			detectLanguage(
				"This is really important for the company's energy strategy going forward.",
			),
		).toBe("en");
		expect(
			detectLanguage("Any update on the party planning for the city event?"),
		).toBe("en");
		expect(
			detectLanguage("We need better urban planning in this neighborhood."),
		).toBe("en");
		expect(
			detectLanguage(
				"Many companies are investing heavily in renewable energy technology.",
			),
		).toBe("en");
	});

	it("keeps English sentences containing Hungarian names or accented loanwords as English", () => {
		expect(
			detectLanguage("I visited Győr and Budapest last summer, it was beautiful."),
		).toBe("en");
		expect(
			detectLanguage("My colleague József is joining the call at 3pm."),
		).toBe("en");
		expect(
			detectLanguage("We're flying through Zürich on the way to the conference."),
		).toBe("en");
		expect(
			detectLanguage("Let's meet at the café near the office before the meeting."),
		).toBe("en");
		expect(detectLanguage("Please send the résumé to HR before Friday.")).toBe(
			"en",
		);
		expect(
			detectLanguage("Beyoncé's new album just dropped, have you heard it?"),
		).toBe("en");
	});

	it("keeps English code snippets as English despite single-letter parameter collisions", () => {
		expect(
			detectLanguage(
				"Here's my function:\nfunction add(a, b) { return a + b; }\nWhy is it returning NaN?",
			),
		).toBe("en");
	});
});

describe("classifyLanguageSignal", () => {
	it("reports unknown for very short, non-listed input instead of guessing English", () => {
		expect(classifyLanguageSignal("ok")).toBe("unknown");
		expect(classifyLanguageSignal("thanks")).toBe("unknown");
	});

	it("reports unknown for a bare name with no other context", () => {
		expect(classifyLanguageSignal("Zoltán")).toBe("unknown");
		expect(classifyLanguageSignal("Józsi")).toBe("unknown");
	});

	it("reports unknown for a bare pasted URL", () => {
		expect(classifyLanguageSignal("https://example.com/some-path")).toBe(
			"unknown",
		);
	});

	it("reports unknown for bare code or numbers with no letter evidence", () => {
		expect(classifyLanguageSignal("x = 1")).toBe("unknown");
		expect(classifyLanguageSignal("42")).toBe("unknown");
	});

	it("still commits to a confident answer once there is real evidence", () => {
		expect(classifyLanguageSignal("How do I configure this?")).toBe("en");
		expect(classifyLanguageSignal("Szia, hogy vagy ma?")).toBe("hu");
	});
});

describe("detectExplicitLanguageRequest", () => {
	it("recognizes an explicit request regardless of the request's own language", () => {
		expect(detectExplicitLanguageRequest("válaszolj angolul")).toBe("en");
		expect(
			detectExplicitLanguageRequest("Can you write this in Hungarian please?"),
		).toBe("hu");
		expect(detectExplicitLanguageRequest("please respond in English")).toBe(
			"en",
		);
		expect(detectExplicitLanguageRequest("kérlek magyarul")).toBe("hu");
	});

	it("returns null when there is no explicit request", () => {
		expect(detectExplicitLanguageRequest("just answer normally")).toBeNull();
		expect(detectExplicitLanguageRequest("Szia, hogy vagy?")).toBeNull();
	});
});

describe("resolveResponseLanguage", () => {
	it("uses the latest message when its language is clear", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "What time is the meeting tomorrow?",
			}),
		).toBe("en");
		expect(
			resolveResponseLanguage({ latestMessage: "Szia, hogy vagy ma?" }),
		).toBe("hu");
	});

	it("prefers the latest clear message over the prior conversation language", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "What time is the meeting tomorrow?",
				priorUserMessages: ["Szia, hogy vagy?"],
			}),
		).toBe("en");
	});

	it("falls back to the most recent clearly-detected prior user message when the latest one is ambiguous", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: ["Szia, hogy vagy?", "Kérlek segíts nekem ezzel"],
			}),
		).toBe("hu");
		expect(
			resolveResponseLanguage({
				latestMessage: "thanks",
				priorUserMessages: ["How do I configure environment variables?"],
			}),
		).toBe("en");
	});

	it("skips ambiguous prior messages and keeps looking further back", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: ["42", "https://example.com", "Szia, hogy vagy?"],
			}),
		).toBe("hu");
	});

	it("falls back to the UI language when the latest message and all prior messages are ambiguous", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: ["thanks", "42"],
				uiLanguage: "hu",
			}),
		).toBe("hu");
	});

	it("defaults to English when nothing else resolves the language", () => {
		expect(resolveResponseLanguage({ latestMessage: "ok" })).toBe("en");
		expect(
			resolveResponseLanguage({ latestMessage: "ok", priorUserMessages: [] }),
		).toBe("en");
	});

	it("honours an explicit request even when the message itself is in the other language", () => {
		expect(
			resolveResponseLanguage({
				latestMessage: "Kérlek nézd át ezt a kódot, és válaszolj angolul.",
			}),
		).toBe("en");
		expect(
			resolveResponseLanguage({
				latestMessage: "Can you write this in Hungarian please?",
			}),
		).toBe("hu");
	});

	it("never lets non-user context decide the language, because the signature has no field for it", () => {
		// priorUserMessages is documented as user-authored-only; memory facts,
		// project files, web results, and assistant text must never be passed
		// in here. This test exists as a signature-level guardrail: with an
		// ambiguous latest message and no (real) prior user evidence, the
		// resolver must fall through to the UI-language/default rule rather
		// than ever inventing a language from elsewhere.
		expect(
			resolveResponseLanguage({
				latestMessage: "ok",
				priorUserMessages: [],
				uiLanguage: "en",
			}),
		).toBe("en");
	});
});
