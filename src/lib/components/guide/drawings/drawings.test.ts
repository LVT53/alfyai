import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/svelte";
import { derived, get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComposerMenuRows } from "$lib/components/chat/composer-bar";
import { isLit } from "$lib/components/drawings/drawing-spot";
import { type I18nKey, t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { DOCUMENT_TYPE_FILTER_ORDER } from "../../../../routes/(app)/knowledge/_components/documents-table";
import {
	GUIDE_ENTRIES,
	GUIDE_SECTION_IDS,
	type GuideSectionId,
} from "../guide-content";
import SectionDrawing from "./SectionDrawing.svelte";
import { SECTION_DRAWING_SPOTS } from "./section-drawing-spots";

// The dictionary keys a drawing reads, recorded as it renders. Two controls can
// share a word (the Document's Keep pill and the review bar's both say "Keep"),
// so the words on screen cannot say which control a drawing follows; the keys do.
const asked = vi.hoisted(() => new Set<string>());
vi.mock("$lib/i18n", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/i18n")>();
	return {
		...original,
		t: derived(
			original.t,
			(translate) =>
				(key: I18nKey, params?: Record<string, string | number>) => {
					asked.add(key);
					return translate(key, params);
				},
		),
	};
});

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "..", "..", "drawings");

/** Every section has its drawing. */
const DRAWN = GUIDE_SECTION_IDS;

/** Every spot of every drawn section, as [section, spot]. */
const DRAWN_SPOTS = DRAWN.flatMap((section) =>
	SECTION_DRAWING_SPOTS[section].map((spot) => [section, spot] as const),
);

afterEach(() => uiLanguage.set("en"));

describe("the guide's drawings", () => {
	it.each(DRAWN)("draws every spot the %s section names", (section) => {
		const { container } = render(SectionDrawing, {
			props: { section, lit: null },
		});
		const drawn = [
			...container.querySelectorAll<HTMLElement>("[data-drawing-spot]"),
		].map((n) => n.dataset.drawingSpot);
		expect(new Set(drawn)).toEqual(new Set(SECTION_DRAWING_SPOTS[section]));
	});

	it("lights only the named spot", () => {
		const { container } = render(SectionDrawing, {
			props: { section: "ask", lit: "atlas" },
		});
		expect(
			[...container.querySelectorAll(".drawing-spot-lit")].map(
				(n) => (n as HTMLElement).dataset.drawingSpot,
			),
		).toEqual(["atlas"]);
	});

	it.each(
		DRAWN_SPOTS,
	)("lights the %s drawing's %s spot, wherever it is drawn, and nothing else", (section, spot) => {
		const { container } = render(SectionDrawing, {
			props: { section, lit: spot },
		});
		const lit = [
			...container.querySelectorAll<HTMLElement>(".drawing-spot-lit"),
		];
		expect(lit.length).toBeGreaterThan(0);
		for (const node of lit) expect(node.dataset.drawingSpot).toBe(spot);
	});

	it.each([null, "noSuchSpot"])("lights nothing for %s", (lit) => {
		for (const section of DRAWN) {
			const { container, unmount } = render(SectionDrawing, {
				props: { section, lit },
			});
			expect(container.querySelectorAll(".drawing-spot-lit")).toHaveLength(0);
			unmount();
		}
	});

	it("takes its words from the real controls' keys, in the reader's language", () => {
		uiLanguage.set("hu");
		render(SectionDrawing, { props: { section: "ask", lit: null } });
		expect(
			screen.getByText(get(t)("composerTools.attachFile")),
		).toBeInTheDocument();
	});

	// The keys of the controls each drawing depicts, so a reworded control
	// rewords its drawing. Make's Keep and Undo are the inline pill's
	// (`ChangeBar.svelte`), not the review bar's. Where two controls of one
	// drawing say the same word (the Knowledge Base's "Documents" tab and its
	// Documents chip), both keys are listed and the word is on screen twice.
	//
	// It knows you: the Knowledge Base's tabs (`knowledge/+page.svelte`), the
	// Memory Profile's summary head and Needs Review card (`PersonaSummaryCard`,
	// `KnowledgeMemoryView`), and Settings > Profile's Preferences and Assistant
	// behaviour rows (`SettingsProfileTab`).
	// Your things: the Documents tab's kind chips (`DocumentsList`), Settings'
	// tabs and the Connections tab's "Add a connection" card, the "+" menu's
	// first two rows, and the "Send this email?" permission card
	// (`write-card-view.ts`).
	// Stay organized: the sidebar's search pill and section heads
	// (`Sidebar`, `ConversationList`), and Home's projects row and Recent list
	// (`HomeProjects`, `HomeRecent`).
	// Your account: Settings > Profile's two-step row, Your Activity, Preferences
	// and Data & privacy cards.
	const WORDS: Record<GuideSectionId, readonly I18nKey[]> = {
		ask: [
			"messageEvidenceDetails.sourcesLabel",
			"composerTools.attachFile",
			"composerTools.fromLibrary",
			"composerMenu.skills",
			"composerMenu.atlasReport",
		],
		make: [
			"artifacts.panel.crumb",
			"artifacts.document.change.keep",
			"artifacts.document.change.undo",
		],
		knowsYou: [
			"memory.title",
			"knowledge.documents",
			"memoryProfile.summaryTitle",
			"memoryProfile.aboutYou",
			"memoryProfile.needsReview",
			"settings_defaultModel",
			"settings_conversationStyle",
			"profileTab.personalInstructions",
			"profileTab.personalInstructionsEdit",
			"settings_memory",
			"profileTab.memoryOn",
			"profileTab.picturesAndVideos",
			"profileTab.picturesAndVideosOn",
			"settings_skillsManagerSummaryLabel",
			"profileTab.manageSkills",
		],
		yourThings: [
			"memory.title",
			"knowledge.documents",
			"knowledge.documents.filter.all",
			"knowledge.documents.filter.document",
			"knowledge.documents.filter.canvas",
			"knowledge.documents.filter.app",
			"knowledge.documents.filter.image",
			"knowledge.documents.filter.video",
			"knowledge.documents.filter.uploaded",
			"settingsProfile",
			"settingsConnections",
			"connections.addConnection.title",
			"composerTools.attachFile",
			"composerTools.fromLibrary",
			"connections.writeConfirm.question.emailSend",
			"connections.writeConfirm.cancel",
			"connections.writeConfirm.approve.emailSend",
		],
		organized: [
			"sidebar.search",
			"sidebar.pinned",
			"sidebar.projects",
			"sidebar.chats",
			"home.projectsHeading",
			"home.allConversations",
			"home.runningNow",
		],
		account: [
			"profileTab.twoStepTitle",
			"profileTab.twoStepTurnOn",
			"settings_sectionYourActivity",
			"profileTab.tokensAllTime",
			"settings_appearance",
			"settings_system",
			"settings_light",
			"settings_dark",
			"settings_interfaceLanguage",
			"profileTab.langEnglish",
			"profileTab.langHungarian",
			"settings_sectionDataPrivacy",
			"chatgptImport.settingsButton",
			"profileTab.importChooseZip",
			"settings_downloadMyData",
			"profileTab.prepareArchive",
		],
	};
	it.each(
		DRAWN.flatMap((section) =>
			(["en", "hu"] as const).map((language) => [section, language] as const),
		),
	)("draws the words of the %s drawing in %s, from its controls' keys and no others", (section, language) => {
		uiLanguage.set(language);
		asked.clear();
		render(SectionDrawing, { props: { section, lit: null } });
		expect([...asked].sort()).toEqual([...WORDS[section]].sort());
		for (const key of WORDS[section]) {
			expect(screen.getAllByText(get(t)(key)).length).toBeGreaterThan(0);
		}
	});

	// The reply's row of actions in `MessageBubble.svelte`: regenerate, fork,
	// copy, and then, while read aloud is on, the speaker (spec 4.1). The speaker
	// is a spot of its own (the guide's Listen to a reply lights it), inside the
	// row's, which Steer a reply lights.
	it("the reply's row of actions draws the speaker after Copy", () => {
		const { container } = render(SectionDrawing, {
			props: { section: "ask", lit: null },
		});
		const actions = container.querySelector<HTMLElement>(
			'[data-drawing-spot="replyActions"]',
		);
		expect(actions).not.toBeNull();
		const iconNames = [...(actions?.querySelectorAll("svg") ?? [])].map((svg) =>
			[...svg.classList].find(
				(name) => name.startsWith("lucide-") && name !== "lucide-icon",
			),
		);
		expect(iconNames).toEqual([
			"lucide-refresh-cw",
			"lucide-git-branch",
			"lucide-copy",
			"lucide-volume-2",
		]);
		const speaker = actions?.querySelector<HTMLElement>(
			'[data-drawing-spot="readAloud"]',
		);
		expect(speaker).not.toBeNull();
		expect(speaker?.querySelector("svg")).toHaveClass("lucide-volume-2");
	});

	it("follows the real row: the speaker comes after Copy in the message's action row", () => {
		const bubble = readFileSync(
			join(HERE, "..", "..", "chat", "MessageBubble.svelte"),
			"utf8",
		);
		const copy = bubble.indexOf("onclick={copyToClipboard}");
		const speaker = bubble.indexOf("<ReadAloudSpeaker");
		expect(copy).toBeGreaterThan(0);
		expect(speaker).toBeGreaterThan(copy);
	});

	// Settings > Profile's Assistant behaviour card, as `SettingsProfileTab`
	// draws it: Personal instructions, the Memory switch, the Pictures and
	// videos switch, Skills. The Knows-you drawing draws that slice in that order.
	it("draws the Assistant card's rows in the order Settings draws them", () => {
		const { container } = render(SectionDrawing, {
			props: { section: "knowsYou", lit: null },
		});
		const card = container
			.querySelector('[data-drawing-spot="instructions"]')
			?.closest(".drawn-settings-card");
		expect(card).toBeTruthy();
		expect(
			[
				...(card?.querySelectorAll<HTMLElement>("[data-drawing-spot]") ?? []),
			].map((n) => n.dataset.drawingSpot),
		).toEqual(["instructions", "memory", "pictures", "skills"]);

		const tab = readFileSync(
			join(
				HERE,
				"..",
				"..",
				"..",
				"..",
				"routes",
				"(app)",
				"settings",
				"_components",
				"SettingsProfileTab.svelte",
			),
			"utf8",
		);
		const at = (needle: string) => {
			const index = tab.indexOf(needle);
			expect(index, needle).toBeGreaterThan(0);
			return index;
		};
		const order = [
			at("$t('profileTab.personalInstructions')"),
			at("$t('settings_memory')"),
			at("$t('profileTab.picturesAndVideos')"),
			at("$t('settings_skillsManagerSummaryLabel')"),
		];
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	// Read aloud on Documents: the Document panel's header has the speaker, first of its
	// actions, so the Make drawing's panel draws it before Download.
	it("the side panel's header draws the speaker before Download", () => {
		const { container } = render(SectionDrawing, {
			props: { section: "make", lit: null },
		});
		const head = container.querySelector<HTMLElement>(".drawn-panel .head");
		const iconNames = [...(head?.querySelectorAll("svg") ?? [])].map((svg) =>
			[...svg.classList].find(
				(name) => name.startsWith("lucide-") && name !== "lucide-icon",
			),
		);
		expect(iconNames).toEqual([
			"lucide-chevron-left",
			"lucide-clock",
			"lucide-volume-2",
			"lucide-download",
			"lucide-x",
		]);
	});

	it("follows the real header: the speaker comes before Download in the panel's actions", () => {
		const workspace = readFileSync(
			join(HERE, "..", "..", "document-workspace", "DocumentWorkspace.svelte"),
			"utf8",
		);
		const speaker = workspace.indexOf("<ReadAloudSpeaker");
		const download = workspace.indexOf(
			'data-testid="artifact-download-button"',
		);
		expect(speaker).toBeGreaterThan(0);
		expect(download).toBeGreaterThan(speaker);
	});

	it("is hidden from screen readers", () => {
		const { container } = render(SectionDrawing, {
			props: { section: "make", lit: null },
		});
		expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
	});

	it("gives every section a hidden frame a test can find", () => {
		for (const section of GUIDE_SECTION_IDS) {
			const { container, unmount } = render(SectionDrawing, {
				props: { section, lit: null },
			});
			const frame = container.firstElementChild;
			expect(frame).toHaveAttribute("data-testid", "drawing-frame");
			expect(frame).toHaveAttribute("aria-hidden", "true");
			unmount();
		}
	});

	it("names only spots its section's drawing has", () => {
		for (const e of GUIDE_ENTRIES)
			if (e.drawingSpot)
				expect(SECTION_DRAWING_SPOTS[e.section]).toContain(e.drawingSpot);
	});

	it("draws every icon with Lucide, never a hand-drawn svg", () => {
		for (const section of DRAWN) {
			const { container, unmount } = render(SectionDrawing, {
				props: { section, lit: null },
			});
			const icons = [...container.querySelectorAll("svg")];
			expect(icons.length).toBeGreaterThan(0);
			for (const icon of icons) expect(icon).toHaveClass("lucide-icon");
			unmount();
		}
	});

	// The rows of the real "+" menu's "This message" section, in its order.
	const realMenuRows = () =>
		buildComposerMenuRows({
			canAttach: true,
			skillsEnabled: true,
			atlasVisible: true,
			atlasAvailable: true,
			thinkingAvailable: false,
			personalityCount: 0,
		})
			.filter((row) => row.section === "message")
			.map((row) => row.id);
	const MENU_ROW_KEYS: Record<string, I18nKey> = {
		attach: "composerTools.attachFile",
		library: "composerTools.fromLibrary",
		skills: "composerMenu.skills",
		atlas: "composerMenu.atlasReport",
	};

	it("lists the + menu's rows in the order the real menu does", () => {
		render(SectionDrawing, { props: { section: "ask", lit: null } });
		const drawn = realMenuRows().map((id) =>
			screen.getByText(get(t)(MENU_ROW_KEYS[id])),
		);
		for (let i = 1; i < drawn.length; i++) {
			expect(
				drawn[i - 1].compareDocumentPosition(drawn[i]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		}
	});

	// The keys a drawing reads, in the order it draws them: a template is
	// evaluated top to bottom, so this is the order on screen.
	function keysDrawn(section: GuideSectionId): string[] {
		asked.clear();
		const { unmount } = render(SectionDrawing, {
			props: { section, lit: null },
		});
		unmount();
		return [...asked];
	}

	it("draws the rows of the + menu that Your things shows in the real menu's order", () => {
		const shown: string[] = [MENU_ROW_KEYS.attach, MENU_ROW_KEYS.library];
		const real = realMenuRows()
			.map((id) => MENU_ROW_KEYS[id])
			.filter((key) => shown.includes(key));
		const drawn = keysDrawn("yourThings").filter((key) => shown.includes(key));
		expect(drawn).toEqual(real);
	});

	it("draws the Knowledge Base's kind chips in the order its list does", () => {
		const real = DOCUMENT_TYPE_FILTER_ORDER.map(
			(kind) => `knowledge.documents.filter.${kind}`,
		);
		const drawn = keysDrawn("yourThings").filter((key) =>
			key.startsWith("knowledge.documents.filter."),
		);
		expect(drawn).toEqual(real);
	});

	it("draws the sidebar's sections in the order the real sidebar does", () => {
		// Pinned, then Projects, then Chats (`ConversationList.svelte`).
		const sections = ["sidebar.pinned", "sidebar.projects", "sidebar.chats"];
		const drawn = keysDrawn("organized").filter((key) =>
			sections.includes(key),
		);
		expect(drawn).toEqual(sections);
	});
});

describe("the drawing kit", () => {
	it("lights a spot only when it is the lit one", () => {
		expect(isLit("atlas", "atlas")).toBe(true);
		expect(isLit("atlas", "sources")).toBe(false);
		expect(isLit("atlas", null)).toBe(false);
		expect(isLit("atlas", undefined)).toBe(false);
		// A control that is no spot is never lit, whatever is.
		expect(isLit(undefined, "atlas")).toBe(false);
		expect(isLit(undefined, null)).toBe(false);
	});

	it("draws at 330 by 222 and scales to the width it is given", () => {
		const frame = readFileSync(join(KIT, "DrawingFrame.svelte"), "utf-8");
		// The frame answers to its own width, keeps its proportions from the
		// first paint, and gives its parts one design pixel (`--u`) to size
		// themselves in: nothing measures and nothing jumps after hydration.
		// A campaign picture passes its own size; the guide's drawings never do.
		expect(frame).toMatch(/container-type:\s*inline-size/);
		expect(frame).toMatch(/width = 330,/);
		expect(frame).toMatch(/height = 222,/);
		expect(frame).toMatch(
			/aspect-ratio:\s*var\(--design-width\)\s*\/\s*var\(--design-height\)/,
		);
		expect(frame).toMatch(/--u:\s*calc\(100cqw\s*\/\s*var\(--design-width\)\)/);
		for (const file of readdirSync(HERE).filter((name) =>
			name.endsWith(".svelte"),
		)) {
			const source = readFileSync(join(HERE, file), "utf-8");
			expect(source, file).not.toMatch(
				/<DrawingFrame[^>]*\b(width|height|bare)\b/,
			);
		}
	});

	it("keeps to the tokens and to Lucide", () => {
		const files = [KIT, HERE].flatMap((dir) =>
			readdirSync(dir)
				.filter((name) => name.endsWith(".svelte"))
				.map((name) => join(dir, name)),
		);
		expect(files.length).toBeGreaterThan(8);
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			// No colour of its own: light and dark come from the tokens alone.
			expect(source, `${file}: a hex colour`).not.toMatch(
				/#[0-9a-fA-F]{3,8}\b/,
			);
			expect(source, `${file}: an rgb() colour`).not.toMatch(/rgba?\(/);
			expect(source, `${file}: a dark-mode branch`).not.toMatch(
				/\.dark\b|prefers-color-scheme/,
			);
			expect(source, `${file}: a hand-drawn svg`).not.toMatch(/<svg\b/);
		}
	});
});
