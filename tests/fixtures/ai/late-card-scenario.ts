// F16 (friction audit, ruling 77): the card that arrives late. The scripted
// model says a few sentences, then spends a while writing the document (the
// call carries the whole body, so nothing of it reaches the browser until the
// call is complete), then calls `create_artifact`, and answers once more after
// the tool returned.
//
// Its own module rather than more constants in openai-compatible-scenarios.ts:
// the scenario file is shared by every spec that scripts a model.

export const AI_SMOKE_LATE_CARD_MARKER =
	"Fake model step: say a few words, then make the document late.";

/** What the model says before it starts writing the document, piece by piece. */
export const AI_SMOKE_LATE_CARD_INTRO = [
	"Rendben, összeállítom a hétvégi tervet. ",
	"Először átgondolom, mi fér bele egy napba, ",
	"aztán a végén írok hozzá egy rövid csomagolási listát is. ",
	"Addig is itt a vázlat: szombaton a belváros, vasárnap pedig a múzeumok.",
];

/** Between two pieces of the intro. */
export const AI_SMOKE_LATE_CARD_PIECE_DELAY_MS = 120;

/** How long the model spends writing the document after its intro. */
export const AI_SMOKE_LATE_CARD_WRITING_MS = 2500;

export const AI_SMOKE_LATE_CARD_TITLE = "Hétvégi terv";

/** A checklist, so the card has a preview of the height a real one has. */
export const AI_SMOKE_LATE_CARD_MARKDOWN = [
	"# Hétvégi terv",
	"",
	"- [ ] Múzeumjegyek foglalása",
	"- [ ] Asztalfoglalás szombat estére",
	"- [ ] Esőkabát és kényelmes cipő",
	"- [ ] Vonatjegy vasárnapra",
	"- [ ] Pénz felváltása",
	"- [ ] Útlevél és kártya",
	"- [ ] Töltők a hotelből",
].join("\n");

export const AI_SMOKE_LATE_CARD_FINAL_TEXT =
	"Elkészült a dokumentum, nézd át nyugodtan.";

/** The model's pause before it answers once the tool returned. */
export const AI_SMOKE_LATE_CARD_FINAL_DELAY_MS = 800;
