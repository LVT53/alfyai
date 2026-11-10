import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeHomeComposerSeed } from "$lib/client/conversation-session";
import { STATIC_COMPOSER_COMMANDS } from "$lib/composer-commands";
import { type I18nKey, t } from "$lib/i18n";
import guideDict from "$lib/i18n/guide";
import { uiLanguage } from "$lib/stores/settings";
import { spotlightRequest } from "$lib/stores/spotlight";
import GuidePage from "./GuidePage.svelte";
import {
	GUIDE_ENTRIES,
	GUIDE_SECTION_IDS,
	guideEntriesFor,
	guideEntryKey,
} from "./guide-content";

const goto = vi.hoisted(() => vi.fn());
vi.mock("$app/navigation", () => ({ goto }));

const HERE = dirname(fileURLToPath(import.meta.url));

/** A day inside "Alfy asks first"'s first thirty days (it was added on 2026-11-05). */
const WHILE_NEW = new Date("2026-11-10T12:00:00Z");

beforeEach(() => {
	goto.mockReset();
	sessionStorage.clear();
	spotlightRequest.set(null);
});

afterEach(() => {
	vi.useRealTimers();
	uiLanguage.set("en");
	Reflect.deleteProperty(window, "matchMedia");
	Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

/** The row of an entry, the element a pointer or the keyboard meets. */
function rowOf(id: string): HTMLElement {
	const row = screen
		.getAllByTestId("guide-row")
		.find((candidate) => candidate.dataset.entryId === id);
	if (!row) throw new Error(`no row for the entry ${id}`);
	return row;
}

/** A part of a drawing, by the id a row names. */
function spotOf(container: HTMLElement, spot: string): HTMLElement {
	const found = container.querySelector<HTMLElement>(
		`[data-drawing-spot="${spot}"]`,
	);
	if (!found) throw new Error(`no drawn spot ${spot}`);
	return found;
}

function isLit(node: HTMLElement): boolean {
	return node.classList.contains("drawing-spot-lit");
}

/** A finger's tap: it enters and leaves, and then it clicks. */
async function tap(row: HTMLElement) {
	await fireEvent.pointerEnter(row, { pointerType: "touch" });
	await fireEvent.pointerLeave(row, { pointerType: "touch" });
	await fireEvent.click(row);
}

function stubReducedMotion(reduce: boolean) {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: vi.fn((query: string) => ({
			matches: reduce && query.includes("prefers-reduced-motion"),
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	});
}

describe("the guide page", () => {
	it("shows six sections and thirty rows", () => {
		render(GuidePage);

		const sections = screen.getAllByTestId("guide-section");
		expect(sections.map((section) => section.id)).toEqual(
			GUIDE_SECTION_IDS.map((id) => `guide-section-${id}`),
		);
		expect(screen.getAllByTestId("guide-row")).toHaveLength(30);
		expect(
			sections.map(
				(section) => within(section).getAllByTestId("guide-row").length,
			),
		).toEqual([7, 6, 4, 4, 5, 4]);
		for (const entry of GUIDE_ENTRIES) {
			expect(rowOf(entry.id).closest("section")?.id).toBe(
				`guide-section-${entry.section}`,
			);
		}
	});

	it("gives each section a name a screen reader can find it by, and a drawing", () => {
		render(GuidePage);

		for (const id of GUIDE_SECTION_IDS) {
			const name = guideDict.en[`guide.section.${id}.name`];
			const region = screen.getByRole("region", { name });
			expect(region).toBe(document.getElementById(`guide-section-${id}`));
			expect(
				within(region).getByRole("heading", { level: 2, name }),
			).toBeInTheDocument();
			expect(
				within(region).getByText(guideDict.en[`guide.section.${id}.intro`]),
			).toBeInTheDocument();
			expect(within(region).getByTestId("drawing-frame")).toBeInTheDocument();
		}
	});

	it("says what it is for under the title", () => {
		render(GuidePage);

		expect(
			screen.getByText(guideDict.en["guide.subtitle"]),
		).toBeInTheDocument();
	});

	it("is written in Hungarian for a Hungarian reader, without a raw key", () => {
		vi.setSystemTime(WHILE_NEW);
		uiLanguage.set("hu");
		render(GuidePage);

		expect(
			screen.getByRole("heading", {
				level: 2,
				name: guideDict.hu["guide.section.knowsYou.name"],
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(guideDict.hu["guide.entry.twoStep.line"]),
		).toBeInTheDocument();
		expect(screen.getAllByText("ÚJ")).toHaveLength(1);
		expect(document.body.textContent).not.toMatch(
			/\bguide\.[a-z]|\bcomposerCommands\./i,
		);
	});
});

describe("NEW", () => {
	it("marks Alfy asks first NEW during its first thirty days", () => {
		vi.setSystemTime(WHILE_NEW);
		render(GuidePage);

		const marks = screen.getAllByText("NEW");
		expect(marks).toHaveLength(1);
		expect(marks[0].closest('[data-testid="guide-row"]')).toBe(
			rowOf("asksFirst"),
		);
	});

	it("is gone after the thirty days, and nothing else ever wore it", () => {
		vi.setSystemTime(new Date("2026-12-05T00:00:00Z"));
		render(GuidePage);

		expect(screen.queryByText("NEW")).not.toBeInTheDocument();
	});

	it("is not there before the feature was added", () => {
		vi.setSystemTime(new Date("2026-11-04T23:59:59Z"));
		render(GuidePage);

		expect(screen.queryByText("NEW")).not.toBeInTheDocument();
	});
});

describe("a row's buttons", () => {
	it("names its buttons after their entry", () => {
		render(GuidePage);

		expect(
			screen.getByRole("button", { name: "Try it: Maps and travel" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Show me: Two-step sign-in" }),
		).toBeInTheDocument();
		// Every button says what it does and for which entry, in the reader's language.
		for (const entry of GUIDE_ENTRIES) {
			if (entry.action.kind === "none") continue;
			const name = get(t)(guideEntryKey(entry.id, "name"));
			const label =
				entry.action.kind === "tryIt" ? `Try it: ${name}` : `Show me: ${name}`;
			const button = within(rowOf(entry.id)).getByRole("button", {
				name: label,
			});
			// The words on the button are the short ones; the name carries the entry.
			expect(button).toHaveTextContent(
				entry.action.kind === "tryIt" ? /^Try it$/ : /^Show me$/,
			);
		}
	});

	it("names its buttons in Hungarian", () => {
		uiLanguage.set("hu");
		render(GuidePage);

		expect(
			screen.getByRole("button", { name: "Kipróbálom: Térkép és utazás" }),
		).toHaveTextContent(/^Kipróbálom$/);
		expect(
			screen.getByRole("button", {
				name: "Megnézem: Kétlépcsős bejelentkezés",
			}),
		).toHaveTextContent(/^Megnézem$/);
	});

	it("gives rows without an action no button", () => {
		render(GuidePage);

		for (const entry of GUIDE_ENTRIES) {
			const row = rowOf(entry.id);
			const buttons = within(row).queryAllByRole("button");
			expect(buttons).toHaveLength(entry.action.kind === "none" ? 0 : 1);
			// Nor are they made focusable: the keyboard reaches the actions, and
			// the row's words are said in the row.
			if (entry.action.kind === "none") {
				expect(row.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
			}
		}
		expect(
			within(rowOf("steerAReply")).queryByRole("button"),
		).not.toBeInTheDocument();
	});

	it("has eight Try its, eighteen Show mes and four rows with neither", () => {
		render(GuidePage);

		const kinds = GUIDE_ENTRIES.map((entry) => entry.action.kind);
		expect(kinds.filter((kind) => kind === "tryIt")).toHaveLength(8);
		expect(kinds.filter((kind) => kind === "showMe")).toHaveLength(18);
		expect(kinds.filter((kind) => kind === "none")).toHaveLength(4);
		expect(screen.getAllByRole("button", { name: /^Try it: / })).toHaveLength(
			8,
		);
		expect(screen.getAllByRole("button", { name: /^Show me: / })).toHaveLength(
			18,
		);
	});
});

describe("Try it and Show me", () => {
	it("Try it hands the example to Home, in English, and goes there", async () => {
		render(GuidePage);

		await fireEvent.click(
			screen.getByRole("button", { name: "Try it: Maps and travel" }),
		);

		expect(consumeHomeComposerSeed()).toBe(
			guideDict.en["guide.entry.mapsAndTravel.example"],
		);
		expect(goto).toHaveBeenCalledWith("/");
	});

	it("Try it hands Home the example in the reader's language", async () => {
		uiLanguage.set("hu");
		render(GuidePage);

		await fireEvent.click(
			screen.getByRole("button", { name: "Kipróbálom: Térkép és utazás" }),
		);

		expect(consumeHomeComposerSeed()).toBe(
			guideDict.hu["guide.entry.mapsAndTravel.example"],
		);
	});

	it("every Try it has an example of its own to hand over", async () => {
		const examples: string[] = [];
		for (const entry of GUIDE_ENTRIES) {
			if (entry.action.kind !== "tryIt") continue;
			const { unmount } = render(GuidePage);
			const name = get(t)(guideEntryKey(entry.id, "name"));
			await fireEvent.click(
				screen.getByRole("button", { name: `Try it: ${name}` }),
			);
			examples.push(consumeHomeComposerSeed() ?? "");
			unmount();
		}
		expect(examples).toHaveLength(8);
		expect(new Set(examples).size).toBe(8);
		expect(examples).not.toContain("");
	});

	it("Show me asks for the control and goes to its place", async () => {
		render(GuidePage);

		await fireEvent.click(
			screen.getByRole("button", { name: "Show me: Two-step sign-in" }),
		);

		expect(get(spotlightRequest)?.spotlight).toBe("settings.twoStep");
		expect(goto).toHaveBeenCalledWith("/settings");
	});

	it("Show me for the sidebar's Search stays on the page", async () => {
		render(GuidePage);

		await fireEvent.click(
			screen.getByRole("button", { name: "Show me: Search" }),
		);

		expect(get(spotlightRequest)?.spotlight).toBe("sidebar.search");
		expect(goto).not.toHaveBeenCalled();
	});

	it("Show me for Memory opens Knowledge on its Memory tab", async () => {
		render(GuidePage);

		await fireEvent.click(
			screen.getByRole("button", { name: "Show me: Memory" }),
		);

		expect(get(spotlightRequest)?.spotlight).toBe("knowledge.memory");
		expect(goto).toHaveBeenCalledWith("/knowledge?tab=memory");
	});
});

describe("lighting a row's spot in the drawing", () => {
	it("lights a row's spot on hover, on focus and on tap, and clears it on leave", async () => {
		const { container } = render(GuidePage);
		const row = rowOf("webAndLinks");
		const sources = spotOf(container, "sources");
		expect(isLit(sources)).toBe(false);

		// A pointer over the row.
		await fireEvent.pointerEnter(row, { pointerType: "mouse" });
		expect(isLit(sources)).toBe(true);
		await fireEvent.pointerLeave(row, { pointerType: "mouse" });
		expect(isLit(sources)).toBe(false);

		// The keyboard on the row's button.
		const button = within(row).getByRole("button");
		button.focus();
		await tick();
		expect(isLit(sources)).toBe(true);
		button.blur();
		await tick();
		expect(isLit(sources)).toBe(false);

		// A finger: it enters, leaves, and then clicks. The row ends lit.
		await tap(row);
		expect(isLit(sources)).toBe(true);
	});

	it("lights it in the row's own section, and lights only that spot", async () => {
		const { container } = render(GuidePage);

		await fireEvent.pointerEnter(rowOf("history"), { pointerType: "mouse" });

		expect(
			[...container.querySelectorAll<HTMLElement>(".drawing-spot-lit")].map(
				(node) => node.dataset.drawingSpot,
			),
		).toEqual(["history"]);
	});

	it("moves from one row to the next without a gap", async () => {
		const { container } = render(GuidePage);
		const first = rowOf("webAndLinks");
		const second = rowOf("atlasResearch");

		await fireEvent.pointerEnter(first, { pointerType: "mouse" });
		await fireEvent.pointerLeave(first, { pointerType: "mouse" });
		await fireEvent.pointerEnter(second, { pointerType: "mouse" });

		expect(isLit(spotOf(container, "sources"))).toBe(false);
		expect(isLit(spotOf(container, "atlas"))).toBe(true);
	});

	it("lights nothing for a row that has no spot in the drawing", async () => {
		const { container } = render(GuidePage);
		expect(
			GUIDE_ENTRIES.find((e) => e.id === "mapsAndTravel")?.drawingSpot,
		).toBeNull();

		await fireEvent.pointerEnter(rowOf("mapsAndTravel"), {
			pointerType: "mouse",
		});
		await fireEvent.click(rowOf("mapsAndTravel"));

		expect(container.querySelectorAll(".drawing-spot-lit")).toHaveLength(0);
	});

	it("lights nothing for a finger that only touches a row on its way to scrolling", async () => {
		const { container } = render(GuidePage);

		await fireEvent.pointerEnter(rowOf("webAndLinks"), {
			pointerType: "touch",
		});

		expect(container.querySelectorAll(".drawing-spot-lit")).toHaveLength(0);
	});

	it("keeps a tapped row lit until another row takes the light or a click lands outside the section's rows", async () => {
		const { container } = render(GuidePage);
		const sources = spotOf(container, "sources");

		await tap(rowOf("webAndLinks"));
		expect(isLit(sources)).toBe(true);

		// Another row of the same section takes the light.
		await tap(rowOf("atlasResearch"));
		expect(isLit(sources)).toBe(false);
		expect(isLit(spotOf(container, "atlas"))).toBe(true);

		// A click outside this section's rows puts it out.
		await fireEvent.click(
			screen.getByRole("heading", { level: 2, name: "Make" }),
		);
		expect(isLit(spotOf(container, "atlas"))).toBe(false);
	});

	it("keeps one light per tap: a tap in another section puts the first section's light out", async () => {
		const { container } = render(GuidePage);

		await tap(rowOf("atlasResearch"));
		await tap(rowOf("history"));

		expect(isLit(spotOf(container, "atlas"))).toBe(false);
		expect(isLit(spotOf(container, "history"))).toBe(true);
	});

	it("does not put the light out for a click on the row it just lit", async () => {
		const { container } = render(GuidePage);
		const row = rowOf("webAndLinks");

		await tap(row);
		await fireEvent.click(within(row).getByRole("button"));

		expect(isLit(spotOf(container, "sources"))).toBe(true);
	});
});

describe("the section chips", () => {
	it("link to the six sections, in order, by name", () => {
		render(GuidePage);

		const nav = screen.getByRole("navigation", { name: "Sections" });
		const chips = within(nav).getAllByRole("link");
		expect(chips.map((chip) => chip.textContent?.trim())).toEqual(
			GUIDE_SECTION_IDS.map((id) => guideDict.en[`guide.section.${id}.name`]),
		);
		expect(chips.map((chip) => chip.getAttribute("href"))).toEqual(
			GUIDE_SECTION_IDS.map((id) => `#guide-section-${id}`),
		);
	});

	it("jump to the section smoothly, and instantly for a reader who asked for less motion", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		render(GuidePage);
		const make = document.getElementById("guide-section-make");

		stubReducedMotion(false);
		const unprevented = await fireEvent.click(
			screen.getByRole("link", { name: "Make" }),
		);
		expect(unprevented).toBe(false);
		expect(scrollIntoView).toHaveBeenLastCalledWith({
			block: "start",
			behavior: "smooth",
		});
		expect(scrollIntoView.mock.contexts.at(-1)).toBe(make);

		stubReducedMotion(true);
		await fireEvent.click(screen.getByRole("link", { name: "Make" }));
		expect(scrollIntoView).toHaveBeenLastCalledWith({
			block: "start",
			behavior: "auto",
		});
	});

	it("leave a modified click to the browser, which opens the link as it was asked", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		render(GuidePage);

		const unprevented = await fireEvent.click(
			screen.getByRole("link", { name: "Make" }),
			{ ctrlKey: true },
		);

		expect(unprevented).toBe(true);
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it("move the keyboard to the section's heading, so the next Tab starts there", async () => {
		Element.prototype.scrollIntoView = vi.fn();
		render(GuidePage);

		await fireEvent.click(screen.getByRole("link", { name: "Your things" }));

		expect(document.activeElement).toBe(
			screen.getByRole("heading", { level: 2, name: "Your things" }),
		);
	});
});

describe("the shortcuts and commands box", () => {
	it("lists the keys with what each does", () => {
		render(GuidePage);

		const box = screen.getByTestId("guide-shortcuts");
		expect(
			within(box).getByRole("heading", {
				level: 2,
				name: "Shortcuts and commands",
			}),
		).toBeInTheDocument();
		const keys = within(screen.getByTestId("guide-shortcut-keys"));
		for (const [key, wording] of [
			["Ctrl/⌘+K", "Open Search"],
			["/", "Go to the message box"],
			["Ctrl/⌘+Enter", "Send"],
			["Enter", "New line"],
			["Esc", "Close a menu or dialog"],
		] as const) {
			expect(keys.getByText(key).tagName).toBe("KBD");
			expect(keys.getByText(wording)).toBeInTheDocument();
		}
	});

	it("lists every available slash command", () => {
		render(GuidePage);

		const available = STATIC_COMPOSER_COMMANDS.filter(
			(command) => command.availability === "available",
		);
		expect(available.length).toBeGreaterThan(0);
		for (const command of available) {
			expect(screen.getByText(command.token)).toBeInTheDocument();
			expect(
				screen.getByText(get(t)(command.descriptionKey as I18nKey)),
			).toBeInTheDocument();
		}
	});

	it("reads the commands' words in the reader's language, from the composer's own keys", () => {
		uiLanguage.set("hu");
		render(GuidePage);

		const model = STATIC_COMPOSER_COMMANDS.find((c) => c.id === "model");
		expect(model).toBeDefined();
		expect(
			screen.getByText(get(t)(model?.descriptionKey as I18nKey)),
		).toBeInTheDocument();
		expect(
			screen.getByText(guideDict.hu["guide.shortcuts.commandsLead"]),
		).toBeInTheDocument();
	});

	it("hides the keys on screens that are touch only, and keeps the commands", () => {
		const source = readFileSync(join(HERE, "GuideShortcuts.svelte"), "utf-8");

		// A phone has no Ctrl or Enter to press, so the key rows are hidden there
		// by the same query the rest of the app calls a touch screen; the commands
		// are typed on any keyboard and stay.
		const touch = source.slice(
			source.search(/@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)/),
		);
		expect(touch).toMatch(/\.guide-shortcuts__keys\s*\{\s*display:\s*none/);
		expect(touch).not.toMatch(
			/guide-shortcuts__commands\s*\{\s*display:\s*none/,
		);
		render(GuidePage);
		expect(screen.getByTestId("guide-shortcut-keys")).toHaveClass(
			"guide-shortcuts__keys",
		);
	});
});

describe("how it is laid out", () => {
	const components = [
		"GuidePage.svelte",
		"GuideSection.svelte",
		"GuideRow.svelte",
		"GuideShortcuts.svelte",
	];
	const sources = Object.fromEntries(
		components.map((name) => [name, readFileSync(join(HERE, name), "utf-8")]),
	);

	it("never cuts a name or a line short", () => {
		// Some Hungarian names run to two lines at 360 px; the words wrap.
		for (const [name, source] of Object.entries(sources)) {
			expect(source, `${name}: a cut-off`).not.toMatch(
				/text-overflow|ellipsis|line-clamp|truncate/,
			);
		}
	});

	it("stacks on a narrow column, with the drawing kept in view inside its band", () => {
		const section = sources["GuideSection.svelte"];
		// Pinned to the top of the scroller inside its band, and capped so that a
		// tablet does not give half its height to one picture.
		expect(section).toMatch(/position:\s*sticky/);
		expect(section).toMatch(/top:\s*0/);
		expect(section).toMatch(/max-width:\s*28rem/);
		// Two columns need 46rem of column (a phone and a tablet held upright have
		// less, and so has a 1024 px window with its sidebar open), and the column
		// is the sections' container, not the window.
		expect(section).toMatch(/@container\s*\(min-width:\s*46rem\)/);
		expect(sources["GuidePage.svelte"]).toMatch(
			/\.guide-bands\s*\{[^}]*container-type:\s*inline-size/,
		);
	});

	it("never asks a column for more than the box it is in has, so a phone does not scroll sideways", () => {
		// `minmax(20rem, 1fr)` alone is 320 px wide at least: wider than the
		// commands' box on a 360 px screen. `min(20rem, 100%)` gives way.
		const commands = sources["GuideShortcuts.svelte"].match(
			/grid-template-columns:\s*([^;]+);/,
		);
		expect(commands?.[1]).toMatch(/minmax\(min\(\d+rem,\s*100%\),\s*1fr\)/);
	});

	it("keeps what is scrolled into view clear of the pinned drawing", () => {
		// Shift+Tab to a row under the picture must not leave its button hidden
		// behind it: the band says how tall the pinned picture is, and a row and
		// its button keep that much clear (none when nothing is pinned).
		const section = sources["GuideSection.svelte"];
		expect(section).toMatch(/--guide-pinned:\s*calc\(/);
		expect(section.match(/--guide-pinned:\s*0px/g)).toHaveLength(2);
		expect(sources["GuideRow.svelte"]).toMatch(
			/scroll-margin-top:\s*var\(--guide-pinned/,
		);
	});

	it("lets a finger's tap reach the row on iOS, where only a clickable element gets a click", () => {
		expect(sources["GuideRow.svelte"]).toMatch(
			/@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{\s*\.guide-row\s*\{[^}]*cursor:\s*pointer/,
		);
	});

	it("keeps to the tokens and to Lucide", () => {
		for (const [name, source] of Object.entries(sources)) {
			expect(source, `${name}: a hex colour`).not.toMatch(
				/#[0-9a-fA-F]{3,8}\b/,
			);
			expect(source, `${name}: an rgb() colour`).not.toMatch(/rgba?\(/);
			expect(source, `${name}: a hand-drawn svg`).not.toMatch(/<svg\b/);
			expect(source, `${name}: the serif`).not.toMatch(/serif/);
			expect(source, `${name}: Svelte 4 events`).not.toMatch(
				/\bon:[a-z]|<slot|createEventDispatcher/,
			);
		}
	});

	it("gives every entry of every section a row, in the order of the list", () => {
		render(GuidePage);

		for (const id of GUIDE_SECTION_IDS) {
			const region = document.getElementById(
				`guide-section-${id}`,
			) as HTMLElement;
			expect(
				within(region)
					.getAllByTestId("guide-row")
					.map((row) => row.dataset.entryId),
			).toEqual(guideEntriesFor(id).map((entry) => entry.id));
		}
	});
});
