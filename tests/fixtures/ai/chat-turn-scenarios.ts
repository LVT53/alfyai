// What the fix round's chat specs script the model to do (FX-1): the turns the
// owner's walk met with a real model, made deterministic.
//
// Its own module (like late-card-scenario.ts): the shared scenario file is read
// by every spec that scripts a model. The model's side of each turn lives in
// tests/mocks/ai-provider/chat-turn-scripts.ts.

/**
 * A reply that makes a PDF: the model says a sentence, calls `produce_file` with
 * the document's text (a source-first PDF, rendered in-process, no sandbox), and
 * answers once more after the tool returned.
 */
export const AI_SMOKE_PRODUCE_PDF_MARKER =
	"Fake model step: produce the scripted PDF.";
export const AI_SMOKE_PRODUCE_PDF_INTRO = "Rendben, elkészítem a PDF-et. ";
export const AI_SMOKE_PRODUCE_PDF_TITLE = "Bécsi hétvégi útiterv";
export const AI_SMOKE_PRODUCE_PDF_FILENAME = "becsi-hetvegi-utiterv.pdf";
export const AI_SMOKE_PRODUCE_PDF_FINAL_TEXT = "Elkészült a PDF.";
export const AI_SMOKE_PRODUCE_PDF_CONTENT = [
	`# ${AI_SMOKE_PRODUCE_PDF_TITLE}`,
	"",
	"**Szombat:** reggeli a belvárosban, délután a Kunsthistorisches Museum, este vacsora a Naschmarkt környékén.",
	"",
	"**Vasárnap:** Schönbrunn kertjei, ebéd a Spittelbergen, délután vonat vissza Budapestre.",
].join("\n");

/**
 * A reply that makes a Document and then works on it, the way the model the audit
 * walked does: `create_artifact`, `read_artifact` (for the block ids and hashes),
 * then `edit_artifact`. The mode, written after the marker in the message, says how
 * the edits go:
 *   `edit`   one good edit,
 *   `retry`  a malformed edit (the tool refuses it), then a good one,
 *   `giveup` a malformed edit and then no more: the turn ends on the failure.
 */
export const AI_SMOKE_ITEM_TURN_MARKER =
	"Fake model step: make the scripted document and change it.";
export type ItemTurnMode = "edit" | "retry" | "giveup";
export const AI_SMOKE_ITEM_TURN_TITLE = "Bécsi hétvége";
export const AI_SMOKE_ITEM_TURN_BODY =
	"# Bécsi hétvége\n\nSzombat: a belváros és a múzeumok.\n\nVasárnap: Schönbrunn és hazaút.";
export const AI_SMOKE_ITEM_TURN_EDITED_TEXT =
	"Szombat: a belváros, a múzeumok és egy esti koncert.";
export const AI_SMOKE_ITEM_TURN_FINAL_TEXT = "Kész, átnézheted.";

export function itemTurnMessage(mode: ItemTurnMode): string {
	return `${AI_SMOKE_ITEM_TURN_MARKER} mode:${mode}`;
}

export function decodeItemTurnMode(text: string): ItemTurnMode | null {
	if (!text.includes(AI_SMOKE_ITEM_TURN_MARKER)) return null;
	const match = /mode:(edit|retry|giveup)/.exec(text);
	return (match?.[1] as ItemTurnMode | undefined) ?? null;
}
