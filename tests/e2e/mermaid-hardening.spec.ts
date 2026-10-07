import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import type { CanvasNode } from "../../src/lib/shared/artifacts/canvas";
import {
	bareSpot,
	centre,
	click,
	idOfKind,
	nodeOf,
	wrapperOf,
} from "./artifact-canvas-edit-helpers";
import {
	openCanvasPanel,
	seedCanvas,
	storedBoard,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// A diagram a model writes is the model's own words, and anything that reaches the
// reader through the chat can have come from a page the model read. FX-E: what the
// chat's Mermaid draws never makes the reader's browser call an address and never
// shows a link, whichever way the source asks for one (an image shape, an init
// directive that turns HTML labels on, a front-matter config, a `click` or `link`
// line, a CSS `url()` in a class or state style, even spelled with CSS escapes).
// Every case counts what the browser asked a stand-in host for (`page.route`) and
// looks for links in what is drawn; the diagram itself must still be drawn, so the
// fix is a removal and not a refusal. The same component draws a board's diagram
// block, so the board is checked too, through the reader's own edit form.

const HOST = "sentinel.invalid";
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** Every request the page makes to the stand-in host, answered like a picture so a decode can succeed. */
async function watchStandInHost(page: Page): Promise<string[]> {
	const calls: string[] = [];
	await page.route(new RegExp(`^https?://[^/]*${HOST}/`), async (route) => {
		calls.push(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: "image/png",
			body: PIXEL,
			headers: { "access-control-allow-origin": "*" },
		});
	});
	return calls;
}

type Case = { name: string; words: string[]; source: string };

const URL = (path: string) => `https://${HOST}/${path}`;

/** Sources that ask for an address or a link, each still a diagram with words worth drawing. */
const HOSTILE: Case[] = [
	{
		name: "an image shape",
		words: ["Docs", "Done"],
		source: [
			"flowchart LR",
			`  A@{ img: "${URL("shape.png")}", label: "Docs", pos: "b", w: 60, h: 60 } --> B[Done]`,
		].join("\n"),
	},
	{
		name: "an image shape whose key is spelt with a YAML escape",
		words: ["Docs", "Done"],
		source: [
			"flowchart LR",
			`  A@{ "i\\u006dg": "${URL("escaped.png")}", label: "Docs" } --> B[Done]`,
		].join("\n"),
	},
	{
		name: "an init directive that turns HTML labels on",
		words: ["Docs", "Done"],
		source: [
			`%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%`,
			"flowchart LR",
			`  A["Docs <img src='${URL("label.png")}'>"] --> B[Done]`,
		].join("\n"),
	},
	{
		name: "a front-matter config that turns HTML labels on",
		words: ["Docs", "Done"],
		source: [
			"---",
			"title: Plan",
			"config:",
			"  htmlLabels: true",
			"---",
			"flowchart LR",
			`  A["Docs <img src='${URL("matter.png")}'>"] --> B[Done]`,
		].join("\n"),
	},
	{
		name: "a click line with an address",
		words: ["Docs", "Done"],
		source: [
			"flowchart LR",
			"  A[Docs] --> B[Done]",
			`  click A href "${URL("docs")}" _blank`,
		].join("\n"),
	},
	{
		name: "a click line after `end` on the same line",
		words: ["Docs", "Done"],
		source: [
			"flowchart LR",
			"  subgraph s",
			"  A[Docs] --> B[Done]",
			`  end click A href "${URL("end")}"`,
		].join("\n"),
	},
	{
		name: "a sequence diagram's link line",
		words: ["Docs", "Done", "hello"],
		source: [
			"sequenceDiagram",
			"  participant A as Docs",
			"  participant B as Done",
			`  link A: Open @ ${URL("seq")}`,
			"  A->>B: hello",
		].join("\n"),
	},
	{
		name: "a class diagram style with a url() spelt with a CSS escape",
		words: ["Docs", "Done"],
		source: [
			"classDiagram",
			"  class Docs:::linked",
			"  class Done",
			"  Docs --> Done",
			`  classDef linked fill:\\75rl(${URL("class.svg")}#a)`,
		].join("\n"),
	},
	{
		name: "a state diagram class with a plain url()",
		words: ["Docs", "Done"],
		source: [
			"stateDiagram-v2",
			"  [*] --> Docs",
			"  Docs --> Done",
			`  classDef linked fill:url(${URL("state.svg")}#a)`,
			"  class Docs linked",
		].join("\n"),
	},
	{
		name: "a class diagram's click line",
		words: ["Docs", "Done"],
		source: [
			"classDiagram",
			"  class Docs",
			"  class Done",
			"  Docs --> Done",
			`  click Docs href "${URL("class-click")}"`,
		].join("\n"),
	},
];

/** Ordinary diagrams: what the chat has always drawn, which the sanitizer must leave exactly as it is. */
const ORDINARY: Case[] = [
	{
		name: "a flowchart with styles, classes and a database shape",
		words: ["Start", "Choice", "Store"],
		source: [
			"%% a plain comment",
			"flowchart TD",
			"  A[Start] --> B{Choice}",
			"  B -->|yes| C@{ shape: cyl, label: \"Store\" }",
			"  B -->|no| D[Skip]",
			"  style A fill:#f9f,stroke:#333,stroke-width:2px",
			"  classDef good fill:#bbf,stroke:#33f",
			"  class D good",
			"  linkStyle 0 stroke:#f00,stroke-width:2px",
		].join("\n"),
	},
	{
		name: "a flowchart whose labels say click and link",
		words: ["Click here", "Link it"],
		source: [
			"flowchart LR",
			'  A["Click here"] -->|link| B["Link it"]',
		].join("\n"),
	},
	{
		name: "a titled sequence diagram with a coloured block",
		words: ["Alice", "Bob", "hello"],
		source: [
			"---",
			"title: Greeting",
			"---",
			"sequenceDiagram",
			"  participant A as Alice",
			"  participant B as Bob",
			"  rect rgb(200, 220, 255)",
			"  A->>B: hello",
			"  end",
		].join("\n"),
	},
	{
		name: "a class diagram",
		words: ["Animal", "Dog"],
		source: [
			"classDiagram",
			"  class Animal {",
			"    +String name",
			"    +eat()",
			"  }",
			"  Animal <|-- Dog",
		].join("\n"),
	},
	{
		name: "a state diagram",
		words: ["Still", "Moving"],
		source: [
			"stateDiagram-v2",
			"  [*] --> Still",
			"  Still --> Moving",
			"  Moving --> [*]",
		].join("\n"),
	},
	{
		name: "an ER diagram",
		words: ["CUSTOMER", "ORDER"],
		source: [
			"erDiagram",
			"  CUSTOMER ||--o{ ORDER : places",
		].join("\n"),
	},
	{
		name: "a Gantt chart",
		words: ["Plan", "Task one"],
		source: [
			"gantt",
			"  title Plan",
			"  dateFormat YYYY-MM-DD",
			"  section Work",
			"  Task one :a1, 2024-01-01, 7d",
		].join("\n"),
	},
	{
		name: "a pie chart",
		words: ["Dogs", "Cats"],
		source: ['pie title Pets', '  "Dogs" : 386', '  "Cats" : 85'].join("\n"),
	},
];

let sequence = 700;

/** A chat with one reply per case, each a ```mermaid fence, oldest first. */
async function seedReplies(page: Page, cases: Case[]): Promise<string> {
	const conversationId = await createConversation(page, "Diagram hardening");
	for (const entry of cases) {
		sequence += 1;
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: sequence,
			role: "assistant",
			content: `${entry.name}\n\n\`\`\`mermaid\n${entry.source}\n\`\`\`\n`,
			createdAt: new Date(Date.now() + sequence),
		});
	}
	return conversationId;
}

async function openChat(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** The links a drawing offers: an anchor, or anything that points at an address that is not its own fragment. */
async function linksIn(scope: Locator): Promise<string[]> {
	return scope.evaluate((root) => {
		const found: string[] = [];
		for (const element of root.querySelectorAll("*")) {
			if (element.localName === "a") found.push(`<a> ${element.outerHTML.slice(0, 80)}`);
			for (const name of ["href", "xlink:href", "src"]) {
				const value = element.getAttribute(name);
				if (value && !value.startsWith("#")) found.push(`${element.localName}[${name}]=${value}`);
			}
		}
		return found;
	});
}

/** What a drawn diagram holds that reaches out: external urls in any attribute or style, imports, images. */
async function reachesOut(scope: Locator): Promise<string[]> {
	return scope.evaluate((root) => {
		const found: string[] = [];
		// A function token: the name with its bracket straight after it (`url (` is not one).
		const pattern = /(?:url|image-set|src)\(\s*(?!["']?#)/i;
		for (const element of root.querySelectorAll("*")) {
			for (const attribute of Array.from(element.attributes)) {
				if (pattern.test(attribute.value) || /@import/i.test(attribute.value)) {
					found.push(`${element.localName}[${attribute.name}]`);
				}
			}
			if (element.localName === "style" && (pattern.test(element.textContent ?? "") || /@import/i.test(element.textContent ?? ""))) {
				found.push("style element");
			}
			if (["img", "image", "iframe", "object", "embed", "link"].includes(element.localName)) {
				found.push(element.localName);
			}
		}
		return found;
	});
}

/** The diagram is drawn (its picture is there, none of its words is missing, no error note). Soft: one run names every case that fails. */
async function expectDrawn(diagram: Locator, entry: Case) {
	await expect(diagram.locator("svg").first()).toBeVisible({ timeout: 30_000 });
	const text = await diagram.evaluate((root) =>
		Array.from(root.querySelectorAll("text, tspan"))
			.map((element) => element.textContent ?? "")
			.join(" "),
	);
	for (const word of entry.words) {
		expect.soft(text, `${entry.name}: the word ${word}`).toContain(word);
	}
	expect
		.soft(await diagram.locator(".markdown-diagram-error").count(), `${entry.name}: error note`)
		.toBe(0);
}

test.describe("what a diagram asks for is not what the chat's Mermaid does", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("a reply's diagram that names an image, a link or a setting makes no request and shows no link, and is still drawn", async ({
		page,
	}) => {
		const calls = await watchStandInHost(page);
		const conversationId = await seedReplies(page, HOSTILE);
		await openChat(page, conversationId);

		const diagrams = page.locator(".markdown-mermaid");
		await expect(diagrams).toHaveCount(HOSTILE.length, { timeout: 60_000 });
		for (const [index, entry] of HOSTILE.entries()) {
			const diagram = diagrams.nth(index);
			await expectDrawn(diagram, entry);
			expect.soft(await linksIn(diagram), `${entry.name}: links`).toEqual([]);
			expect
				.soft(await reachesOut(diagram), `${entry.name}: reaches out`)
				.toEqual([]);
		}
		// A request for a picture or a paint server starts as the diagram is measured and
		// can arrive a moment after it is drawn: look once more after the page is idle.
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(800);
		expect.soft(calls, "what the browser asked the stand-in host for").toEqual([]);
	});

	test("ordinary diagrams are drawn as they always were: nothing in them is left out", async ({
		page,
	}) => {
		const calls = await watchStandInHost(page);
		const conversationId = await seedReplies(page, ORDINARY);
		await openChat(page, conversationId);

		const diagrams = page.locator(".markdown-mermaid");
		await expect(diagrams).toHaveCount(ORDINARY.length, { timeout: 60_000 });
		for (const [index, entry] of ORDINARY.entries()) {
			const diagram = diagrams.nth(index);
			await expectDrawn(diagram, entry);
			await expect(diagram, `${entry.name}: nothing removed`).not.toHaveAttribute(
				"data-removed",
				/.+/,
			);
		}
		expect(calls).toEqual([]);
	});
});

const BOARD_HOSTILE = [
	"%%{init: {\"htmlLabels\": true}}%%",
	"flowchart LR",
	`  A@{ img: "${URL("board-shape.png")}", label: "Docs" } --> B["Done <img src='${URL("board-label.png")}'>"]`,
	`  click A href "${URL("board-click")}" _blank`,
].join("\n");

function diagramNode(id: string, code: string): CanvasNode {
	return {
		id,
		type: "mermaid",
		position: { x: 40, y: 40 },
		width: 480,
		data: { kind: "mermaid", label: "Flow", code },
	} as CanvasNode;
}

test.describe("a board's diagram block draws through the same gate, whoever wrote its source", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("a stored source with an image, a link and a setting is drawn without a request or a link", async ({
		page,
	}) => {
		const calls = await watchStandInHost(page);
		const conversationId = await createConversation(page, "Board diagram");
		await seedCanvas(
			conversationId,
			{ ...emptyCanvasBody(), nodes: [diagramNode("d1", BOARD_HOSTILE)] },
			"Hostile board",
		);
		await openChat(page, conversationId);
		await openCanvasPanel(page);

		const drawing = page.getByTestId("canvas-mermaid");
		await expect(drawing.locator("svg").first()).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(800);
		expect.soft(calls, "what the browser asked the stand-in host for").toEqual([]);
		expect.soft(await linksIn(drawing), "links").toEqual([]);
		expect.soft(await reachesOut(drawing), "reaches out").toEqual([]);
		await expectDrawn(drawing, { name: "the stored diagram", words: ["Docs", "Done"], source: "" });
	});

	test("the reader's own edit of a diagram's source goes through it too", async ({
		page,
	}) => {
		const calls = await watchStandInHost(page);
		const conversationId = await createConversation(page, "Board diagram edit");
		const boardId = await seedCanvas(
			conversationId,
			{
				...emptyCanvasBody(),
				nodes: [diagramNode("d1", "flowchart LR\n  A[Docs] --> B[Done]")],
			},
			"Edit board",
		);
		await openChat(page, conversationId);
		await openCanvasPanel(page);
		const id = await idOfKind(page, "mermaid");
		const drawing = nodeOf(page, id).getByTestId("canvas-mermaid");
		await expect(drawing).toContainText("Docs", { timeout: 30_000 });

		// Select the block with real presses, open its form, and type a hostile source over the old one.
		await click(page, "mouse", await bareSpot(page));
		const head = nodeOf(page, id).locator(".canvas-node__head").first();
		await click(page, "mouse", centre((await head.boundingBox()) as never));
		await expect(nodeOf(page, id)).toHaveAttribute("data-selected", "true");
		const edit = page.getByTestId("canvas-node-edit");
		await expect(edit).toBeVisible();
		await click(page, "mouse", centre((await edit.boundingBox()) as never));
		const form = page.getByTestId("canvas-edit-form");
		const source = form.getByTestId("canvas-edit-source");
		await source.click();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.insertText(BOARD_HOSTILE);
		await click(
			page,
			"mouse",
			centre((await form.getByTestId("canvas-edit-save").boundingBox()) as never),
		);
		await expect(form).toHaveCount(0);

		await expect(drawing.locator("svg").first()).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(800);
		expect.soft(calls, "what the browser asked the stand-in host for").toEqual([]);
		expect.soft(await linksIn(drawing), "links").toEqual([]);
		expect.soft(await reachesOut(drawing), "reaches out").toEqual([]);
		await expectDrawn(drawing, { name: "the edited diagram", words: ["Docs", "Done"], source: "" });
		// The board keeps what the reader typed; what is drawn is what the gate lets through.
		await expect
			.poll(async () => {
				const data = (await storedBoard(boardId)).nodes.find(
					(node) => node.id === id,
				)?.data as { code?: string } | undefined;
				return data?.code ?? "";
			})
			.toContain("board-click");
		await expect(wrapperOf(page, id)).toBeVisible();
	});
});
