import { readFileSync } from "node:fs";
import { fly } from "svelte/transition";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOTION_DURATION, MOTION_EASE } from "$lib/utils/motion";
import { CARD_RISE } from "./ask-card-motion";

// The question card's entrance, as numbers. A component test cannot wait for an entrance
// to run (jsdom plays no animation), so what the card is given is checked here, and that
// it plays, and plays once, and not under reduced motion, in a real browser
// (tests/e2e/ask-me-first.spec.ts).
describe("CARD_RISE", () => {
	it("starts a little below its place: 8 to 12 px, as a toast rises", () => {
		expect(CARD_RISE.y).toBeGreaterThanOrEqual(8);
		expect(CARD_RISE.y).toBeLessThanOrEqual(12);
	});

	it("takes the app's emphasis duration and curve, the ones a card arrives with", () => {
		expect(CARD_RISE.duration).toBe(MOTION_DURATION.emphasis);
		expect(CARD_RISE.easing).toBe(MOTION_EASE.emphasis);
		// The JS mirrors are the stylesheet's tokens (and `motion.ts` says to keep them so).
		const css = readFileSync(`${process.cwd()}/src/app.css`, "utf-8");
		expect(css).toMatch(
			new RegExp(`--duration-emphasis:\\s*${MOTION_DURATION.emphasis}ms`),
		);
		expect(css).toContain("--ease-emphasis: cubic-bezier(0.2, 0, 0, 1)");
	});

	it("moves only transform and opacity, from below and from transparent", () => {
		// `fly` fades to the node's own opacity; a drawn card has one (jsdom reports none).
		const node = document.createElement("div");
		node.style.opacity = "1";
		const config = fly(node, CARD_RISE);
		expect(config.duration).toBe(MOTION_DURATION.emphasis);
		const css = config.css;
		expect(css).toBeTypeOf("function");
		// `t` runs 0 -> 1 on the way in.
		const start = css?.(0, 1) ?? "";
		const end = css?.(1, 0) ?? "";
		const properties = (declarations: string) =>
			declarations
				.split(";")
				.map((declaration) => declaration.split(":")[0].trim())
				.filter(Boolean);
		expect(properties(start)).toEqual(["transform", "opacity"]);
		expect(properties(end)).toEqual(["transform", "opacity"]);
		expect(start).toContain(`translate(0px, ${CARD_RISE.y}px)`);
		expect(start).toContain("opacity: 0");
		expect(end).toContain("translate(0px, 0px)");
		expect(end).toContain("opacity: 1");
	});
});

// A card the server drew is on screen from the first paint. Played in, it would be hidden
// and brought back (measured in a real browser on a reload: opaque at the first paint,
// transparent 150 ms later, then rising in), so the entrance skips the cards that were in
// the page before the app ran: those present when the module loads.
describe("riseUnlessDrawnByTheServer", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		vi.resetModules();
	});

	it("plays nothing on a card that was in the page when the app started, and rises on one the client makes", async () => {
		vi.resetModules();
		document.body.innerHTML = '<article data-testid="ask-card"></article>';
		const drawn = document.querySelector('[data-testid="ask-card"]') as Element;
		const motion = await import("./ask-card-motion");

		expect(motion.riseUnlessDrawnByTheServer(drawn, motion.CARD_RISE)).toEqual({
			duration: 0,
		});

		// One made later, in a page that is already up (Alfy asks during a reply), rises.
		const made = document.createElement("article");
		made.setAttribute("data-testid", "ask-card");
		made.style.opacity = "1";
		document.body.append(made);
		expect(
			motion.riseUnlessDrawnByTheServer(made, motion.CARD_RISE).duration,
		).toBe(MOTION_DURATION.emphasis);
	});

	it("rises on every card when the page had none to start with", async () => {
		vi.resetModules();
		const motion = await import("./ask-card-motion");
		const made = document.createElement("article");
		made.style.opacity = "1";
		expect(
			motion.riseUnlessDrawnByTheServer(made, motion.CARD_RISE).duration,
		).toBe(MOTION_DURATION.emphasis);
	});
});
