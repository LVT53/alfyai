import { describe, expect, it } from "vitest";
import type { Artifact } from "./knowledge/types";
import { resolveWorkingDocumentSelection } from "./working-document-selection";
import { englishWordingRecord } from "./working-document-wording.test-helpers";

const document: Artifact = {
	id: "doc-1",
	userId: "user-1",
	type: "generated_output",
	retrievalClass: "durable",
	name: "doc-1.md",
	mimeType: "text/markdown",
	sizeBytes: 100,
	conversationId: "conv-1",
	summary: null,
	createdAt: 1,
	updatedAt: 1,
	extension: "md",
	storagePath: null,
	contentText: null,
	metadata: {
		documentFamilyId: "family-1",
		documentLabel: "Draft",
		versionNumber: 1,
	},
};
function selection(message: string) {
	return resolveWorkingDocumentSelection({
		message,
		activeDocumentArtifactId: document.id,
		currentConversationId: "conv-1",
		artifacts: [document],
	});
}
describe("English wording recorded before Hungarian support", () => {
	it.each(englishWordingRecord)("preserves %s", (message, expected) => {
		const s = selection(message);
		const effects = {
			focus: s.activeFocus.artifactIds.length > 0,
			docFocused: s.documentFocused,
			correction: s.correction.hasSignal,
			reset: s.reset.hasSignal,
			newDoc: s.retrieval.suppressGeneratedCarryover && !s.reset.hasSignal,
		};
		expect(
			Object.entries(effects)
				.filter(([, v]) => v)
				.map(([k]) => k),
		).toEqual(expected);
	});
});

describe("Hungarian follow-ups", () => {
	it.each([
		"Rövidítsd le ezt a dokumentumot",
		"Írd át formálisabbra",
		"Fordítsd le németre",
		"Foglald össze",
		"Át tudnád nézni?",
	])("focuses the open document: %s", (message) => {
		expect(selection(message).activeFocus.artifactIds).toEqual(["doc-1"]);
	});
	it.each([
		"Írd át a bevezetőt",
		"Foglald össze a Hamlet cselekményét",
		"Javítsd meg a biciklit",
		"Fordíts le egy mondatot",
		"Update ezt",
		"Át tudnál nézni egy mondatot?",
	])("does not assume the open document: %s", (message) => {
		expect(selection(message).activeFocus.artifactIds).toEqual([]);
	});
	it("makes a correction target", () => {
		expect(
			selection("Valójában inkább az előzőt használd").correction
				.targetArtifactIds,
		).toEqual(["doc-1"]);
	});
	it("resets carryover", () => {
		const s = selection("Végeztem ezzel, térjünk át valami másra");
		expect(s.reset.hasSignal).toBe(true);
		expect(s.currentDocument).toBeNull();
	});
	it("requests a new file without inheriting the open document", () => {
		const s = selection("Készíts egy PDF-et a nyaralásról");
		expect(s.retrieval.suppressGeneratedCarryover).toBe(true);
		expect(s.activeFocus.artifactIds).toEqual([]);
	});
	it("uses the open document as input for a new file", () => {
		expect(
			selection("Készíts PDF-et ebből a dokumentumból").activeFocus.artifactIds,
		).toEqual(["doc-1"]);
	});
});

// Gate corpus is synthetic, paired with English examples recorded before the fix.
import {
	followUps,
	gates,
	generic,
} from "./working-document-hungarian.test-helpers";
import { readHungarianWording } from "./working-document-selection";

const gateFields = {
	focus: "focusNoun",
	action: "action",
	reference: "reference",
	correction: "correction",
	reset: "reset",
	newFile: "newFile",
	inputRef: "inputRef",
} as const;
const knownNounMatches = new Set([
	"Mi az a fájlrendszer?",
	"Mit jelent a szerződéses kötelezettség fogalma?",
	"A szerkesztőség délután nyit.",
	"A folyó forrása a hegyekben van.",
	"Forrásvíz kell a kávéhoz.",
	"Nyitott kérdés maradt.",
]);
const typingStyles = {
	accented: (s: string) => s,
	unaccented: (s: string) => s.normalize("NFD").replace(/\p{M}/gu, ""),
	mixed: (s: string) => {
		let i = 0;
		return s
			.normalize("NFD")
			.replace(/(.)(\p{M}+)/gu, (all, base: string) => (i++ % 2 ? base : all))
			.normalize("NFC");
	},
	decomposed: (s: string) => s.normalize("NFD"),
};
for (const [gate, field] of Object.entries(gateFields)) {
	const corpus = gates[gate as keyof typeof gates];
	// A bare international PDF is already handled by the unchanged English gate.
	const positives = corpus.hu.map((m) =>
		m === "Kereshető a PDF?" ? "Kereshető a dokumentum?" : m,
	);
	describe(`${gate} Hungarian cues`, () => {
		for (const [style, type] of Object.entries(typingStyles)) {
			it(`reads 40 positives, ${style}`, () => {
				expect(
					positives.filter((m) => !readHungarianWording(type(m))[field]),
				).toEqual([]);
			});
		}
		it("ignores unrelated and embedded words", () => {
			const negatives = [...generic.hu, ...corpus.huHard].filter(
				(m) => !knownNounMatches.has(m),
			);
			expect(negatives.filter((m) => readHungarianWording(m)[field])).toEqual(
				[],
			);
		});
	});
}
it("adds no complete Hungarian signal to the recorded English messages or English UI strings", async () => {
	const dictionaries = import.meta.glob(
		["../../i18n/*.ts", "!../../i18n/*.test.ts", "!../../i18n/index.ts"],
		{
			eager: true,
			import: "default",
		},
	);
	const uiStrings = Object.values(dictionaries).flatMap((value) => {
		if (
			!value ||
			typeof value !== "object" ||
			!("en" in value) ||
			!value.en ||
			typeof value.en !== "object"
		)
			return [];
		return Object.values(value.en).filter(
			(v): v is string => typeof v === "string",
		);
	});
	expect(uiStrings.length).toBeGreaterThan(1000);
	const messages = [...englishWordingRecord.map(([m]) => m), ...uiStrings];
	expect(
		messages.filter((m) => {
			const w = readHungarianWording(m);
			return (
				w.focusNoun ||
				w.correction ||
				w.reset ||
				(w.action && w.reference) ||
				w.newFile
			);
		}),
	).toEqual([]);
});
it("does not infer a reference from an indefinite polite conditional", () => {
	expect(readHungarianWording("Át tudnál nézni egy mondatot?").reference).toBe(
		false,
	);
});
it("keeps English word prefixes out of the noun and verb cues", () => {
	for (const m of [
		"reception",
		"receptor",
		"receptive",
		"general",
		"generally",
		"generalize",
		"Javitero",
		"formazyl",
	]) {
		const w = readHungarianWording(m);
		expect(w.focusNoun || w.action || w.newFile, m).toBe(false);
	}
	for (const m of [
		"receptet",
		"receptek",
		"receptem",
		"receptből",
		"receptje",
	]) {
		expect(readHungarianWording(m).focusNoun, m).toBe(true);
	}
});
it("recognizes reset, correction and new-file effects across their corpus", () => {
	for (const m of gates.reset.hu)
		expect(selection(m).reset.hasSignal, m).toBe(true);
	for (const m of gates.correction.hu)
		expect(selection(m).correction.hasSignal, m).toBe(true);
	for (const m of gates.newFile.hu)
		expect(selection(m).retrieval.suppressGeneratedCarryover, m).toBe(true);
});
it("keeps unrelated Hungarian messages out of active focus", () => {
	const negatives = [...generic.hu, ...followUps.huHard].filter(
		(m) => m !== "Fordítsd le franciára, hogy jó reggelt",
	);
	expect(
		negatives.filter((m) => selection(m).activeFocus.artifactIds.length),
	).toEqual([]);
});
it("keeps the English dictionary word recept from becoming a document cue", () => {
	expect(selection("What does recept mean?").activeFocus.artifactIds).toEqual(
		[],
	);
	expect(readHungarianWording("recept").focusNoun).toBe(false);
});
it.each([
	"Foglald össze Hamlet cselekményét",
	"Elemezd Magyarország gazdaságát",
])("does not treat a named object as the open document: %s", (message) => {
	expect(selection(message).activeFocus.artifactIds).toEqual([]);
});
it.each([
	"Elkészült a dokumentum? Foglald össze.",
	"Ne lépjünk tovább, rövidítsd le ezt a dokumentumot",
	"Még nem végeztem vele",
	"Nem szeretnék új témát",
])("keeps continuity for a question or negated reset: %s", (message) => {
	expect(selection(message).reset.hasSignal).toBe(false);
});
it("does not use spring water as an existing document source", () => {
	expect(
		selection("Készíts PDF-et a forrásvízről").activeFocus.artifactIds,
	).toEqual([]);
});
it.each([
	"Foglald össze most",
	"Írd át kicsit formálisabbra",
	"Rövidítsd le egy kicsit",
])("keeps an adverb from becoming an explicit object: %s", (message) => {
	expect(selection(message).activeFocus.artifactIds).toEqual(["doc-1"]);
});
