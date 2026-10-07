import { describe, expect, it } from "vitest";
import { mermaidSourceProblem, sanitizeMermaidSource } from "./mermaid-source";

// FX-E. A diagram a model writes is the model's own words, and Mermaid will do
// what a source says: fetch the picture an image shape names while it draws,
// turn HTML labels on when a directive asks, make a box a link, hand a CSS
// `url()` to the browser. These tests pin what the one sanitizer takes out of a
// source before Mermaid reads it (measured against Mermaid 11.17 in Chromium:
// `scratchpad/w4/fxe`), and, as important, that every ordinary diagram goes
// through untouched.

const HOST = "https://x.test";

/** Whether Mermaid itself reads the text as a diagram (it parses, it does not draw). */
async function parses(source: string): Promise<boolean> {
	const mermaid = (await import("mermaid")).default;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		htmlLabels: false,
		flowchart: { htmlLabels: false },
	});
	try {
		await mermaid.parse(source);
		return true;
	} catch {
		return false;
	}
}

/** Diagrams the chat has always drawn: not one byte of any of them changes. */
const ORDINARY: Record<string, string> = {
	flowchart: [
		"%% a plain comment",
		"flowchart TD",
		"  A[Start] --> B{Choice}",
		"  B -->|yes| C[Do it]",
		"  B -->|no| D[Skip]",
		"  subgraph S [Group]",
		"    C --> E((End))",
		"  end",
		"  style A fill:#f9f,stroke:#333,stroke-width:2px",
		"  classDef good fill:#bbf,stroke:#33f",
		"  class D good",
		"  linkStyle 0 stroke:#f00,stroke-width:2px",
	].join("\n"),
	"flowchart with the new shape syntax": [
		"flowchart LR",
		'  A@{ shape: cyl, label: "Store" } --> B[API]',
		"  B e1@--> C",
		"  e1@{ animate: true }",
		"  D@{ shape: rect, label: Plain words }",
	].join("\n"),
	"flowchart with labels that say click and link": [
		"flowchart LR",
		'  A["Click here"] -->|link| B["Link it"]',
		"  B --> D[Please click this link to retry]",
	].join("\n"),
	sequence: [
		"sequenceDiagram",
		"  participant A as Alice",
		"  participant B as Bob",
		"  rect rgb(200, 220, 255)",
		"  A->>B: Hello Bob, see link B: docs",
		"  end",
		"  Note over A,B: A note",
		"  loop Every minute",
		"    B-->>A: ping",
		"  end",
	].join("\n"),
	"sequence with a typed participant": [
		"sequenceDiagram",
		'  participant DB@{ "type": "database" }',
		"  A->>DB: query",
	].join("\n"),
	class: [
		"classDiagram",
		"  class Animal {",
		"    +String name",
		"    +eat()",
		"  }",
		"  Animal <|-- Dog",
	].join("\n"),
	state: [
		"stateDiagram-v2",
		"  [*] --> Still",
		"  Still --> Moving",
		"  Moving --> [*]",
	].join("\n"),
	er: [
		"erDiagram",
		"  CUSTOMER ||--o{ ORDER : places",
		"  ORDER ||--|{ LINE-ITEM : contains",
	].join("\n"),
	gantt: [
		"gantt",
		"  title Plan",
		"  dateFormat YYYY-MM-DD",
		"  section Work",
		"  Task one :a1, 2024-01-01, 7d",
		"  Task two :after a1, 5d",
	].join("\n"),
	pie: ["pie title Pets", '  "Dogs" : 386', '  "Cats" : 85'].join("\n"),
	mindmap: ["mindmap", "  root((Plan))", "    Food", "    Sights"].join("\n"),
	"a title in front matter": [
		"---",
		"title: My flow",
		"---",
		"flowchart LR",
		"  A --> B",
	].join("\n"),
	"a quoted title in front matter": [
		"---",
		'title: "My flow"',
		"---",
		"flowchart LR",
		"  A --> B",
	].join("\n"),
};

describe("sanitizeMermaidSource: what an ordinary diagram keeps", () => {
	it.each(
		Object.entries(ORDINARY),
	)("leaves %s exactly as it is, and Mermaid still reads it", async (_name, source) => {
		const result = sanitizeMermaidSource(source);
		expect(result.source).toBe(source);
		expect(result.removed).toEqual([]);
		expect(await parses(result.source)).toBe(true);
	});

	it("says nothing about an empty source", () => {
		expect(sanitizeMermaidSource("")).toEqual({ source: "", removed: [] });
		expect(sanitizeMermaidSource("   \n")).toEqual({
			source: "   \n",
			removed: [],
		});
	});
});

describe("sanitizeMermaidSource: a directive reconfigures the renderer the app configured", () => {
	// Measured: `%%{init: {"htmlLabels": true}}%%` turns HTML labels on, so an `<img>` in a
	// label is fetched while the diagram is drawn; `themeCSS` and `fontFamily` carry CSS.

	it("removes an init directive and keeps the diagram", async () => {
		const result = sanitizeMermaidSource(
			`%%{init: {"htmlLabels": true, "theme": "forest"}}%%\nflowchart LR\n  A --> B`,
		);
		expect(result.source).toBe("flowchart LR\n  A --> B");
		expect(result.removed).toEqual(["directive"]);
		expect(await parses(result.source)).toBe(true);
	});

	it("removes one that runs over several lines, and one in the middle of the diagram", () => {
		expect(
			sanitizeMermaidSource(
				`%%{\n  init: { "htmlLabels": true }\n}%%\nflowchart LR\n  A --> B`,
			).source,
		).toBe("flowchart LR\n  A --> B");
		expect(
			sanitizeMermaidSource(
				`flowchart LR\n  A --> B\n  %%{init: {"htmlLabels": true}}%%\n  B --> C`,
			).source,
		).toBe("flowchart LR\n  A --> B\n  B --> C");
	});

	it("removes `initialize`, wrap and any other directive, and an unterminated one to the end", () => {
		expect(
			sanitizeMermaidSource(`%%{initialize: {}}%%\nflowchart LR\n  A --> B`)
				.source,
		).toBe("flowchart LR\n  A --> B");
		expect(
			sanitizeMermaidSource(`%%{wrap}%%\nsequenceDiagram\n  A->>B: hi`).source,
		).toBe("sequenceDiagram\n  A->>B: hi");
		const open = sanitizeMermaidSource(
			`flowchart LR\n  A --> B\n%%{init: {"themeCSS": "x"`,
		);
		expect(open.source).toBe("flowchart LR\n  A --> B");
		expect(open.removed).toEqual(["directive"]);
	});

	it("keeps an ordinary comment, even one that mentions a brace", () => {
		const source =
			"%% {not a directive} just a comment\nflowchart LR\n  A --> B";
		expect(sanitizeMermaidSource(source)).toEqual({ source, removed: [] });
	});

	it("is not fooled by a directive that, once taken out, would join two halves into a statement", () => {
		// Mermaid takes a directive out itself, so this reads `click A href ...` to it.
		const result = sanitizeMermaidSource(
			`flowchart LR\n  A --> B\n  cl%%{init: {}}%%ick A href "${HOST}/x"`,
		);
		expect(result.source).not.toMatch(/click/);
		expect(result.source).not.toContain(HOST);
		expect(result.removed).toContain("directive");
	});
});

describe("sanitizeMermaidSource: front matter may carry a title and nothing else", () => {
	// Measured: a front-matter `config:` is a directive by another name (`htmlLabels`,
	// `themeCSS`, ...), and it is read before the directives are.

	it("keeps the title and drops the config", async () => {
		const result = sanitizeMermaidSource(
			[
				"---",
				"title: Plan",
				"config:",
				"  htmlLabels: true",
				"  themeCSS: \"@import url('https://x.test/a.css')\"",
				"---",
				"flowchart LR",
				"  A --> B",
			].join("\n"),
		);
		expect(result.source).toBe(
			"---\ntitle: Plan\n---\nflowchart LR\n  A --> B",
		);
		expect(result.removed).toEqual(["config"]);
		expect(await parses(result.source)).toBe(true);
	});

	it("drops a block that has no title to keep", () => {
		const result = sanitizeMermaidSource(
			"---\nconfig:\n  theme: dark\n---\nflowchart LR\n  A --> B",
		);
		expect(result.source).toBe("flowchart LR\n  A --> B");
		expect(result.removed).toEqual(["config"]);
	});

	it("drops a title that is not one plain line (YAML can say more than it seems to)", () => {
		for (const title of [
			"|\n  two lines",
			"&a value",
			"*alias",
			"!!str x",
			"{ a: b }",
			"[a]",
		]) {
			const result = sanitizeMermaidSource(
				`---\ntitle: ${title}\n---\nflowchart LR\n  A --> B`,
			);
			expect(result.source, title).toBe("flowchart LR\n  A --> B");
		}
	});

	it("also reads a block that only appears once a directive in front of it is gone", () => {
		// Mermaid reads front matter first, so `%%{x}%%---` is not one to it; the source this
		// leaves would be, so the cleaning must not stop at the first thing it removed.
		const result = sanitizeMermaidSource(
			`%%{x}%%---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n  A --> B`,
		);
		expect(result.source).not.toMatch(/htmlLabels/);
		expect(result.removed).toEqual(
			expect.arrayContaining(["directive", "config"]),
		);
	});
});

describe("sanitizeMermaidSource: an image or icon shape is fetched by Mermaid while it draws", () => {
	// Measured: `A@{ img: "https://..." }` makes Mermaid ask for the picture twice, before
	// any sanitizer runs; the YAML inside may spell its keys with escapes, quotes or `? key`.

	it.each([
		[
			"an image shape",
			`A@{ img: "${HOST}/p.png", label: "Docs", pos: "b", w: 60, h: 60, constraint: "on" } --> B`,
			'A@{ label: "Docs" } --> B',
		],
		[
			"a single-quoted address",
			`A@{ img: '${HOST}/p.png', label: 'Docs' } --> B`,
			"A@{ label: 'Docs' } --> B",
		],
		["an unquoted address", `A@{ img: ${HOST}/p.png } --> B`, "A --> B"],
		[
			"a key spelt with a YAML escape",
			`A@{ "i\\u006dg": "${HOST}/p.png", label: "Docs" } --> B`,
			'A@{ label: "Docs" } --> B',
		],
		["a complex key", `A@{ ? img : "${HOST}/p.png" } --> B`, "A --> B"],
		[
			"an icon shape",
			`A@{ icon: "fa:user", form: "square", label: "Docs" } --> B`,
			'A@{ label: "Docs" } --> B',
		],
		[
			"the icon shape by name",
			`A@{ shape: icon, label: "Docs" } --> B`,
			'A@{ label: "Docs" } --> B',
		],
		[
			"a block that runs over lines",
			`A@{\n    img: "${HOST}/p.png",\n    label: "Docs"\n  } --> B`,
			'A@{ label: "Docs" } --> B',
		],
		[
			"a caption that is itself hidden behind an escape",
			`A@{ img: "${HOST}/p.png", "l\\u0061bel": "Docs" } --> B`,
			"A --> B",
		],
	])("takes out %s, keeps the node and its edge, and the caption when it is plain", async (_what, line, kept) => {
		const result = sanitizeMermaidSource(`flowchart LR\n  ${line}`);
		expect(result.source).toBe(`flowchart LR\n  ${kept}`);
		expect(result.removed).toHaveLength(1);
		expect(await parses(result.source)).toBe(true);
	});

	it("names an image or icon block for what it is, and any other block it does not know as just that", () => {
		expect(
			sanitizeMermaidSource(`flowchart LR\n  A@{ img: "${HOST}/p.png" }`)
				.removed,
		).toEqual(["image-shape"]);
		expect(
			sanitizeMermaidSource(`flowchart LR\n  A@{ colour: red }`).removed,
		).toEqual(["shape-block"]);
	});

	it("takes out two blocks on one line, and a block with a brace in a word of it", () => {
		const result = sanitizeMermaidSource(
			`flowchart LR\n  A@{ img: "${HOST}/a.png" } --> B@{ img: "${HOST}/b.png", label: "a}b" }`,
		);
		expect(result.source).not.toContain(HOST);
		expect(result.source).not.toContain("@{");
	});

	it("re-checks what taking a block out leaves, so the pieces cannot be joined into a click", () => {
		const result = sanitizeMermaidSource(
			`flowchart LR\n  A --> B\n  cl@{ img: "${HOST}/p.png" }ick A href "${HOST}/x"`,
		);
		expect(result.source).not.toMatch(/click/);
		expect(result.source).not.toContain(HOST);
	});

	it("keeps the blocks that only say a shape, a label or an edge's motion", () => {
		for (const block of [
			"@{ shape: cyl }",
			'@{ shape: rect, label: "A label with: a colon, and a comma" }',
			"@{ animate: true, animation: fast, curve: linear }",
			"@{ ticket: MC-2037, assigned: 'knsv', priority: 'High' }",
			'@{ "type": "boundary" }',
		]) {
			const source = `flowchart LR\n  A${block} --> B`;
			expect(sanitizeMermaidSource(source), block).toEqual({
				source,
				removed: [],
			});
		}
	});
});

describe("sanitizeMermaidSource: a click or link line makes a box a link", () => {
	// Measured: flowchart, class, state and gantt take `click`; a sequence diagram takes
	// `link` and `links`; flowchart accepts one after `;`, after `end` and after `direction`.

	it("removes a flowchart's click line, and what follows it stays", async () => {
		const result = sanitizeMermaidSource(
			`flowchart LR\n  A --> B\n  click A href "${HOST}/docs" _blank\n  B --> C`,
		);
		expect(result.source).toBe("flowchart LR\n  A --> B\n  B --> C");
		expect(result.removed).toEqual(["click"]);
		expect(await parses(result.source)).toBe(true);
	});

	it.each([
		["a bare address", `click A "${HOST}/docs"`],
		["a call", "click A call doIt()"],
		["a callback with a tip", `click A callback "Tip"`],
		["a tab for a space", `click\tA\thref\t"${HOST}/docs"`],
		[
			"an upper-case keyword (class, state and Gantt read it)",
			`CLICK A href "${HOST}/docs"`,
		],
	])("removes a click line with %s", (_what, line) => {
		const result = sanitizeMermaidSource(`flowchart LR\n  A --> B\n  ${line}`);
		expect(result.source).toBe("flowchart LR\n  A --> B");
		expect(result.removed).toEqual(["click"]);
	});

	it("removes one after a semicolon, after `end` and after a direction, where the grammar accepts it", () => {
		expect(
			sanitizeMermaidSource(
				`flowchart LR\n  A --> B;click A href "${HOST}/x";B --> C`,
			).source,
		).not.toContain(HOST);
		expect(
			sanitizeMermaidSource(
				`flowchart LR\n  subgraph s\n  A --> B\n  end click A href "${HOST}/x"`,
			).source,
		).not.toContain(HOST);
		expect(
			sanitizeMermaidSource(
				`flowchart LR\n  direction TB click A href "${HOST}/x"\n  A --> B`,
			).source,
		).not.toContain(HOST);
		expect(
			sanitizeMermaidSource(`flowchart LR;click A href "${HOST}/x";A-->B`)
				.source,
		).not.toContain(HOST);
	});

	it("reads CRLF line ends", () => {
		const result = sanitizeMermaidSource(
			`flowchart LR\r\n  A --> B\r\n  click A href "${HOST}/x"\r\n  B --> C\r\n`,
		);
		expect(result.source).not.toContain(HOST);
		expect(result.source).toContain("B --> C");
	});

	it("removes a state or class diagram's click line, and a class diagram's link line", () => {
		const state = sanitizeMermaidSource(
			`stateDiagram-v2\n  [*] --> A\n  click A href "${HOST}/s"`,
		);
		expect(state.source).toBe("stateDiagram-v2\n  [*] --> A");
		const link = sanitizeMermaidSource(
			`classDiagram\n  class Foo\n  link Foo "${HOST}/c" "Tip"\n  click Foo href "${HOST}/d"`,
		);
		expect(link.source).toBe("classDiagram\n  class Foo");
		expect(link.removed).toEqual(expect.arrayContaining(["click", "link"]));
	});

	it("removes a sequence diagram's link and links lines, in any case, and after a semicolon", async () => {
		for (const line of [
			`link A: Dashboard @ ${HOST}/seq`,
			`links A: {"Dashboard": "${HOST}/seq"}`,
			`LINK A: Dashboard @ ${HOST}/seq`,
			`Links A: {"Dashboard": "${HOST}/seq"}`,
		]) {
			const result = sanitizeMermaidSource(
				`sequenceDiagram\n  participant A\n  ${line}\n  A->>A: hi`,
			);
			expect(result.source, line).toBe(
				"sequenceDiagram\n  participant A\n  A->>A: hi",
			);
			expect(result.removed).toEqual(["link"]);
			expect(await parses(result.source)).toBe(true);
		}
		expect(
			sanitizeMermaidSource(
				`sequenceDiagram\n  A->>A: hi; link A: D @ ${HOST}/seq`,
			).source,
		).not.toContain(HOST);
	});

	it("removes a sequence diagram's properties line, which can name an icon the browser then loads", async () => {
		// Measured: `properties A: {"icon": "https://…"}` draws an <image> for the actor, and
		// the browser asks for it as the diagram is measured.
		for (const line of [
			`properties A: {"icon": "${HOST}/p.png", "class": "service"}`,
			`PROPERTIES A: {"icon": "${HOST}/p.png"}`,
			`properties A: {"icon": "@clock"}`,
		]) {
			const result = sanitizeMermaidSource(
				`sequenceDiagram\n  participant A\n  ${line}\n  A->>A: hi`,
			);
			expect(result.source, line).toBe(
				"sequenceDiagram\n  participant A\n  A->>A: hi",
			);
			expect(result.removed).toEqual(["properties"]);
			expect(await parses(result.source)).toBe(true);
		}
		expect(
			sanitizeMermaidSource(
				`sequenceDiagram\n  A->>A: hi; properties A: {"icon": "${HOST}/p.png"}`,
			).source,
		).not.toContain(HOST);
	});

	it("keeps words that only look like one: a node called click or link, a label, a note", () => {
		for (const source of [
			"flowchart LR\n  click --> B",
			"flowchart LR\n  link[Link page] --> B",
			"flowchart LR\n  link --> click",
			'flowchart LR\n  A["click B href x"] --> B',
			"stateDiagram-v2\n  [*] --> A\n  note right of A\n    click here to continue\n  end note",
			"sequenceDiagram\n  A->>B: link to docs: see below",
			"sequenceDiagram\n  A->>B: properties of the account: see below",
			"flowchart LR\n  properties --> B",
		]) {
			expect(sanitizeMermaidSource(source), source).toEqual({
				source,
				removed: [],
			});
		}
	});
});

describe("sanitizeMermaidSource: a CSS address in a style is fetched by the browser", () => {
	// Measured: a class or state diagram's `classDef`/`style` takes `url(...)`, and the
	// browser asks for it as the diagram is measured, even when `url` is spelt with CSS
	// escapes (`\75rl(`); a sequence block's colour, a Gantt marker and a C4 style take it too.

	it.each([
		["a url()", "url(https://x.test/a.svg#a)", "url (https://x.test/a.svg#a)"],
		[
			"an upper-case URL()",
			"URL(https://x.test/a.svg#a)",
			"URL (https://x.test/a.svg#a)",
		],
		[
			"a url() with a quoted address",
			'url("https://x.test/a.svg")',
			'url ("https://x.test/a.svg")',
		],
		[
			"a url() spelt with a hex escape",
			"\\75rl(https://x.test/a.svg#a)",
			"\\75rl (https://x.test/a.svg#a)",
		],
		[
			"a url() spelt with a hex escape and its space",
			"\\75 rl(https://x.test/a.svg#a)",
			"\\75 rl (https://x.test/a.svg#a)",
		],
		[
			"a url() spelt with letter escapes",
			"\\u\\r\\l(https://x.test/a.svg#a)",
			"\\u\\r\\l (https://x.test/a.svg#a)",
		],
		[
			"an image-set()",
			'image-set("https://x.test/a.png" 1x)',
			'image-set ("https://x.test/a.png" 1x)',
		],
		[
			"a prefixed image-set()",
			'-webkit-image-set("https://x.test/a.png" 1x)',
			'-webkit-image-set ("https://x.test/a.png" 1x)',
		],
		[
			"a src() with an address",
			'src("https://x.test/a.svg")',
			'src ("https://x.test/a.svg")',
		],
	])("keeps the browser from reading %s as a function", (_what, value, expected) => {
		const result = sanitizeMermaidSource(
			`classDiagram\n  class Foo:::c\n  classDef c fill:${value}`,
		);
		expect(result.source).toBe(
			`classDiagram\n  class Foo:::c\n  classDef c fill:${expected}`,
		);
		expect(result.removed).toEqual(["css-address"]);
	});

	it("does the same wherever a colour can be written", () => {
		for (const source of [
			`stateDiagram-v2\n  [*] --> A\n  classDef c fill:url(${HOST}/s.svg#a)\n  class A c`,
			`sequenceDiagram\n  rect url(${HOST}/r.svg#a)\n  A->>B: hi\n  end`,
			`gantt\n  dateFormat YYYY-MM-DD\n  todayMarker stroke:url(${HOST}/g.svg#a)\n  T :t1, 2024-01-01, 3d`,
			`C4Context\n  Person(a, "A", "d")\n  UpdateElementStyle(a, $bgColor="url(${HOST}/c4.svg#a)")`,
		]) {
			const result = sanitizeMermaidSource(source);
			expect(result.source, source).not.toMatch(/url\(/i);
			expect(result.removed).toEqual(["css-address"]);
		}
	});

	it("breaks an at-rule that loads a stylesheet or a font, escapes and all", () => {
		for (const [rule, expected] of [
			["@import url(x)", "@ import url (x)"],
			['@import "https://x.test/a.css"', '@ import "https://x.test/a.css"'],
			["@\\69mport 'a'", "@ \\69mport 'a'"],
			["@font-face { src: x }", "@ font-face { src: x }"],
		]) {
			const result = sanitizeMermaidSource(
				`classDiagram\n  class Foo\n  %% ${rule}\n  style Foo fill:red;${rule}`,
			);
			expect(result.source, rule).toContain(`fill:red;${expected}`);
			expect(result.removed).toContain("css-address");
		}
	});

	it("keeps the words of a label that holds a function-looking word, with a space in it", () => {
		const result = sanitizeMermaidSource(
			'flowchart LR\n  A["Parse url(s) and src(x)"] --> B',
		);
		expect(result.source).toContain("url (s)");
		expect(result.source).toContain("Parse");
		expect(result.removed).toEqual(["css-address"]);
	});

	it("leaves other functions, other uses of `url` and an address that is no function alone", () => {
		for (const source of [
			"classDiagram\n  class Foo:::c\n  classDef c fill:rgb(1,2,3),stroke:hsl(10, 20%, 30%)",
			"flowchart LR\n  A --> B\n  style A fill:#fff,stroke:#333",
			'flowchart LR\n  A["the url is https://x.test/a"] --> B',
			"flowchart LR\n  url --> src\n  image --> element",
			"flowchart LR\n  a@b.com --> import",
		]) {
			expect(sanitizeMermaidSource(source), source).toEqual({
				source,
				removed: [],
			});
		}
	});
});

describe("sanitizeMermaidSource: it always finishes, and finishing is a fixed point", () => {
	const HOSTILE = [
		`%%{init: {"htmlLabels": true}}%%\nflowchart LR\n  A --> B`,
		`---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n  A --> B`,
		`flowchart LR\n  A@{ img: "${HOST}/p.png" } --> B\n  click A href "${HOST}/x"`,
		`classDiagram\n  class Foo:::c\n  classDef c fill:\\75rl(${HOST}/a.svg#a)`,
		`sequenceDiagram\n  link A: D @ ${HOST}/s\n  A->>A: hi`,
		`cl%%{init: {}}%%ick A href "${HOST}/x"`,
		`cl@{ img: "${HOST}/p.png" }ick A href "${HOST}/x"`,
		`%%{x}%%---\nconfig:\n  a: b\n---\nflowchart LR`,
		"%%{ %%{ %%{ }%% }%% }%%",
		"@{ @{ @{ }",
		`u\\\nrl(${HOST})`,
	];

	it.each(
		HOSTILE,
	)("gives the same source when it is run on its own result: %s", (source) => {
		const once = sanitizeMermaidSource(source);
		const twice = sanitizeMermaidSource(once.source);
		expect(twice.source).toBe(once.source);
		expect(twice.removed).toEqual([]);
	});

	it("does a very large source in a moment, and cuts it at a little more than Mermaid's own limit", () => {
		const started = Date.now();
		const big = `flowchart LR\n${"  A --> B\n".repeat(20_000)}`;
		const result = sanitizeMermaidSource(big);
		expect(Date.now() - started).toBeLessThan(1500);
		expect(result.source.length).toBeGreaterThan(50_000);
		expect(result.source.length).toBeLessThan(big.length);
		const wide = sanitizeMermaidSource(
			`${"a".repeat(120_000)}(${"b".repeat(120_000)}`,
		);
		expect(wide.source.length).toBeLessThan(60_000);
	});
});

describe("mermaidSourceProblem: the door a model writes a diagram through", () => {
	it("passes an ordinary diagram", () => {
		for (const source of Object.values(ORDINARY)) {
			expect(mermaidSourceProblem(source), source).toBeNull();
		}
	});

	it.each([
		[
			"an image shape",
			`flowchart TD\n  A@{ img: "${HOST}/p.png", label: "p" }\n  A --> B`,
			"an image or icon shape",
		],
		[
			"an icon shape",
			'flowchart TD\n  A@{ icon: "fa:user", form: "square" }',
			"an image or icon shape",
		],
		[
			"a click line",
			`flowchart TD\n  A --> B\n  click B href "${HOST}"`,
			"a click line",
		],
		[
			"a click line that names no address",
			"flowchart TD\n  A --> B\n  click B doIt",
			"a click line",
		],
		[
			"a link line",
			`sequenceDiagram\n  link A: D @ ${HOST}/s\n  A->>A: hi`,
			"a link line",
		],
		[
			"a properties line",
			`sequenceDiagram\n  participant A\n  properties A: {"icon": "${HOST}/p.png"}`,
			"a properties line",
		],
		[
			"a directive",
			'%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n  A --> B',
			"a %%{ … }%% directive",
		],
		[
			"a front-matter config",
			"---\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B",
			"a front-matter config block",
		],
		[
			"a block it does not know",
			"flowchart TD\n  A@{ colour: red }",
			"a @{ … } block",
		],
		[
			"a CSS address",
			`classDiagram\n  class Foo:::c\n  classDef c fill:url(${HOST}/a.svg#a)`,
			"a CSS address",
		],
		[
			"a web address in a label",
			"sequenceDiagram\n  A->>B: GET https://x.test/users",
			"a web address",
		],
	])("refuses %s, and names it", (_what, source, named) => {
		const problem = mermaidSourceProblem(source);
		expect(problem).toContain(named);
		expect(problem).toContain("Write the diagram without it.");
	});

	it("tells the first of several things it found, in one fixed order", () => {
		const source = `%%{init: {}}%%\nflowchart TD\n  A@{ img: "${HOST}/p.png" } --> B\n  click B href "${HOST}"`;
		expect(mermaidSourceProblem(source)).toContain("an image or icon shape");
	});
});
