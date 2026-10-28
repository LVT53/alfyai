import { describe, expect, it } from "vitest";
import { findExplicitRequestTerm } from "./request-terms";

describe("the explicit-request check on a picture prompt", () => {
	it.each([
		"a nude woman on a beach",
		"Naked man standing in the rain",
		"full nudity, studio light",
		"pornographic scene in a bedroom",
		"NSFW anime girl",
		"hentai drawing",
		"a topless model by the pool",
		"an erotic photo of a couple",
		"two people having sex",
		"a sexually explicit picture",
		"show the genitals clearly",
		"a woman without clothes",
		"xxx poster",
		"meztelen nő a tengerparton",
		"pucér férfi",
		"erotikus kép egy párról",
		"pornó jelenet",
		"aktfotó egy modellről",
		"ruha nélkül álló nő",
		"MEZTELEN emberek",
	])("refuses %j", (prompt) => {
		expect(findExplicitRequestTerm(prompt)).not.toBeNull();
	});

	it.each([
		"breast of chicken on a white plate",
		"a nude-coloured sofa in a bright living room",
		"nude color palette for a bedroom",
		"nude lipstick and nude heels product shot",
		"bathing suit catalogue, summer collection",
		"anatomy diagram of the human heart",
		"a naked mole rat in its burrow",
		"stars visible to the naked eye",
		"a candle with a naked flame",
		"fully clothed people in a park, no nudity",
		"a portrait, not nude, in a winter coat",
		"Sussex countryside at dawn",
		"Essex coastline",
		"an explicit step by step diagram of a bicycle gear",
		"a cumulus cloud over the lake",
		"a man in a tuxedo",
		"a dress in nude tones",
		"aktuális híradó stúdió",
		"egy cica a kanapén",
		"egy régi szextáns a hajó fedélzetén",
	])("lets %j through", (prompt) => {
		expect(findExplicitRequestTerm(prompt)).toBeNull();
	});

	it("names the term it found", () => {
		expect(findExplicitRequestTerm("a NUDE figure")).toBe("nude");
	});
});
