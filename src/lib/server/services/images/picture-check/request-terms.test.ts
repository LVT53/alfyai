import { describe, expect, it } from "vitest";
import { findExplicitRequestTerm } from "./request-terms";

describe("the explicit-request check on a picture prompt", () => {
	it.each([
		"a nude woman on a beach",
		"Naked man standing in the rain",
		"a NAKED couple in bed",
		"nude photos of a model",
		"full nudity, studio light",
		"pornographic scene in a bedroom",
		"a porn poster",
		"NSFW anime girl",
		"hentai drawing",
		"a topless model by the pool",
		"an erotic photo of a couple",
		"two people having sex",
		"a sexually explicit picture",
		"a woman masturbating",
		"meztelen nő a tengerparton",
		"MEZTELEN emberek",
		"meztelen fotó egy lányról",
		"pucér férfi",
		"pucer ferfi a strandon",
		"meztelenül fürdő nő",
		"erotikus kép egy párról",
		"pornó jelenet",
		"aktfotó egy modellről",
		"szexjelenet egy filmből",
	])("refuses %j", (prompt) => {
		expect(findExplicitRequestTerm(prompt)).not.toBeNull();
	});

	it.each([
		// Ordinary prompts with a look-alike word (the owner's examples).
		"breast of chicken on a white plate",
		"a nude-coloured sofa in a bright living room",
		"nude color palette for a bedroom",
		"nude lipstick and nude heels product shot",
		"a dress in nude tones",
		"bathing suit catalogue, summer collection",
		"anatomy diagram of the human heart",
		// The review's false positives (Task 18 fix round 1).
		"a naked mole-rat in its burrow",
		"a naked mole rat in its burrow",
		"a naked-mole-rat",
		"Naked Mole-Rat portrait",
		"egy meztelencsiga a kertben",
		"egy meztelen csiga a salátán",
		"AKT signaling pathway diagram",
		"Super Bowl XXX logo",
		"an undressed salad",
		"Pornichet harbour, France",
		"the Naked Chef cookbook cover",
		"a naked wall in a loft",
		// More of the same kind.
		"stars visible to the naked eye",
		"a candle with a naked flame",
		"fully clothed people in a park, no nudity",
		"a portrait, not nude, in a winter coat",
		"Sussex countryside at dawn",
		"Essex coastline",
		"an explicit step by step diagram of a bicycle gear",
		"a cumulus cloud over the lake",
		"a man in a tuxedo",
		"diagram of the human genitals for a biology class",
		"a hanger without clothes",
		"XXXL t-shirt mockup",
		"aktuális híradó stúdió",
		"egy cica a kanapén",
		"egy régi szextáns a hajó fedélzetén",
		"a nemi szervek anatómiája, tankönyvi ábra",
	])("lets %j through", (prompt) => {
		expect(findExplicitRequestTerm(prompt)).toBeNull();
	});

	it("names the term it found", () => {
		expect(findExplicitRequestTerm("a NUDE woman")).toBe("nude woman");
		expect(findExplicitRequestTerm("hentai")).toBe("hentai");
	});
});
