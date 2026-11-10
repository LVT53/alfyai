import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// The serif has one job: a page's own top title. The Home and project greeting
// and the titles of Settings, Knowledge, the Feature Guide, the login page and
// the error page wear Libre Baskerville; everything else is Nimbus Sans L, the
// Document, its panel, cards, fields and modal headings included
// (src/lib/components/AGENTS.md, "Font ownership"). It crept into Documents
// because the Tailwind class (`font-serif`), the token (`var(--font-serif)`) and
// the family typed out (`'Libre Baskerville', serif`) are three ways in, and
// nothing said no to any of them. This holds the three as a test, so a new
// component cannot bring the serif back by accident.
//
// A file may name the serif only in the way its title does: the Home greeting
// reads the token, the Knowledge title uses the class. That is why a list of
// files is not enough: the Home page's error box and the login page's two
// fields both wore the class in a file that was on such a list for its title.
//
// A new page title is a new entry in MAY_NAME_THE_SERIF with the title it sets.
// Anything else that wants the serif is a design decision for the owner, not an
// entry here. Test files are not read: they ship nothing, and some say what a
// surface must not use (the App contract's test names Georgia, Times and the
// token to say the App prompt may not use them, and the audit's tests write
// serif faces to show it flags them).
//
// The Apps the model writes are sans too, but nothing here can read them: they
// are model output. Their rule is the App contract, which names the sans stack
// (artifacts/app/contract.ts), and the audit's `no-serif` note, which reports a
// serif in a generated App (artifacts/app/audit.ts). That audit is a source file
// this test does read, so it names the faces in patterns and never in a font
// declaration of its own.

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const SOURCE_FILE = /\.(?:svelte|ts|js|mjs|css|html)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|js)$/;

type Way = "class" | "token" | "family";

// The three ways the serif gets in. A bare mention of the token (a comment, a
// string that says an App must not use it) is none of them.
const WAYS_IN: Array<{ id: Way; what: string; pattern: RegExp }> = [
	{
		id: "class",
		what: "the Tailwind class `font-serif`",
		pattern: /(?<![\w-])font-serif(?![\w-])/,
	},
	{
		id: "token",
		what: "a read of the token `var(--font-serif)`",
		pattern: /var\(\s*--font-serif\b/,
	},
	{
		id: "family",
		what: "a `font-family` that names a serif face",
		pattern:
			/(?<![\w-])font(?:-family)?\s*:[^;{}]*(?:Libre Baskerville|Georgia|Times New Roman|(?<![\w-])serif\b)/i,
	},
];

type MayNameTheSerif = Record<string, { sets: string; ways: Way[] }>;

/** The files that may name the serif: what each sets in it, and the ways it does. */
const MAY_NAME_THE_SERIF: MayNameTheSerif = {
	"src/app.css": {
		sets: "the Libre Baskerville @font-face rules (and the --font-serif token)",
		ways: ["family"],
	},
	"src/lib/components/home/HomeSurface.svelte": {
		sets: "the Home and project greeting",
		ways: ["token", "family"],
	},
	"src/routes/(app)/settings/+page.svelte": {
		sets: "the Settings page title",
		ways: ["token"],
	},
	"src/routes/(app)/knowledge/+page.svelte": {
		sets: "the Knowledge page title",
		ways: ["class"],
	},
	"src/routes/(app)/guide/+page.svelte": {
		sets: "the Feature Guide page title",
		ways: ["class"],
	},
	"src/routes/login/+page.svelte": {
		sets: "the login page title",
		ways: ["token"],
	},
	"src/routes/+error.svelte": {
		sets: "the error page title",
		ways: ["class"],
	},
};

const RULE =
	'Only a page\'s own top title wears the serif (the Home and project greeting, and the titles of Settings, Knowledge, the Feature Guide, the login page and the error page); a Document, a panel, a card, a field and a modal heading are sans. Use font-sans or var(--font-sans). A new page title goes in MAY_NAME_THE_SERIF in tests/integration/serif-conventions.test.ts with the title it sets (src/lib/components/AGENTS.md, "Font ownership").';

function waysIn(text: string): Array<{ id: Way; what: string }> {
	return WAYS_IN.filter(({ pattern }) => pattern.test(text));
}

/** What the files (path -> text) do against the rule, each finding with the way and the rule. */
function serifViolations(
	files: Record<string, string>,
	allowed: MayNameTheSerif = MAY_NAME_THE_SERIF,
): string[] {
	const found: string[] = [];
	for (const [path, text] of Object.entries(files)) {
		const permitted = allowed[path]?.ways ?? [];
		for (const way of waysIn(text)) {
			if (permitted.includes(way.id)) continue;
			found.push(
				allowed[path]
					? `${path}: uses ${way.what}, but it may name the serif only for ${allowed[path].sets}. ${RULE}`
					: `${path}: uses ${way.what}. ${RULE}`,
			);
		}
	}
	return found;
}

function readSourceFiles(dir = SRC_DIR): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			Object.assign(files, readSourceFiles(path));
		} else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
			files[relative(ROOT, path).split(sep).join("/")] = readFileSync(
				path,
				"utf8",
			);
		}
	}
	return files;
}

describe("serif conventions", () => {
	const tree = readSourceFiles();

	it("holds on the source in the tree", () => {
		expect(serifViolations(tree)).toEqual([]);
	});

	it("keeps MAY_NAME_THE_SERIF to the files and ways that are still in use", () => {
		for (const [path, { ways }] of Object.entries(MAY_NAME_THE_SERIF)) {
			expect(tree[path], `${path} must exist`).toBeDefined();
			expect(
				waysIn(tree[path])
					.map(({ id }) => id)
					.sort(),
				`${path} names the serif in other ways than its entry says: change the entry`,
			).toEqual([...ways].sort());
		}
	});

	describe("what the check recognises", () => {
		it("flags the Tailwind class, as an attribute and as a directive", () => {
			const found = serifViolations({
				"a.svelte": `<h3 class="text-xl font-serif text-text-primary">Title</h3>`,
				"b.svelte": `<p class:font-serif={quote}>Quote</p>`,
			});
			expect(found).toHaveLength(2);
			expect(found[0]).toContain("a.svelte");
			expect(found[0]).toContain("font-serif");
		});

		it("flags a read of the token", () => {
			const found = serifViolations({
				"c.svelte": `<style>.page { font-family: var(--font-serif); }</style>`,
			});
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("var(--font-serif)");
		});

		it("flags the family typed out, which is how the Document workspace got it", () => {
			expect(
				serifViolations({
					"d.svelte": `.docx-preview { font-family: 'Libre Baskerville', serif; }`,
					"e.svelte": `.note { font: 400 16px Georgia, 'Times New Roman', serif; }`,
					"f.svelte": `.note { font-family: serif; }`,
				}),
			).toHaveLength(3);
		});

		it("names the rule in what it says", () => {
			const [message] = serifViolations({
				"g.svelte": `<i class="font-serif">x</i>`,
			});
			expect(message).toContain("Only a page's own top title wears the serif");
			expect(message).toContain("MAY_NAME_THE_SERIF");
		});

		it("leaves sans, the mono stack and a bare mention of the token alone", () => {
			expect(
				serifViolations({
					"h.svelte": `<p class="font-sans text-sm">x</p><style>p { font-family: var(--font-sans); }</style>`,
					"i.css": `body { font-family: "Nimbus Sans L", sans-serif; }`,
					"j.ts":
						"// Font stacks stay Helvetica, never `--font-sans`/`--font-serif`:\nexpect(prompt).not.toContain('--font-serif');",
					"k.svelte": `<code class="font-mono">x</code><p class="font-serifish">y</p>`,
				}),
			).toEqual([]);
		});

		it("lets a file on the list name the serif the way its title does, and no other way", () => {
			const allowed: MayNameTheSerif = {
				"login.svelte": { sets: "the login page title", ways: ["token"] },
			};
			// The title reads the token: fine. A field in the same file wearing the class is not.
			expect(
				serifViolations(
					{
						"login.svelte": `<style>h1 { font-family: var(--font-serif); }</style>`,
					},
					allowed,
				),
			).toEqual([]);
			const found = serifViolations(
				{
					"login.svelte": `<style>h1 { font-family: var(--font-serif); }</style><input class="font-serif" />`,
					"other.svelte": `<p class="font-serif">x</p>`,
				},
				allowed,
			);
			expect(found).toHaveLength(2);
			expect(found[0]).toContain("login.svelte");
			expect(found[0]).toContain("only for the login page title");
		});
	});
});
