import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for Task 10 ("Route Svelte transitions through
// reduced-motion").
//
// Svelte's JS-driven transition:/in:/out: directives are NOT reached by the
// CSS reduced-motion reset in app.css (it only overrides `animation`/
// `transition` *properties*, and Svelte's `css` transitions interpolate
// styles directly instead of going through those properties — see
// src/lib/utils/motion.ts). These components used bare `fade`/`scale`/
// `slide` in their transition directives, so under
// `prefers-reduced-motion: reduce` they still played in full.
//
// DialogShell — the representative component for this task — gets a full
// behavioral test in DialogShell.test.ts (its wrapped transitions are
// exported and asserted to collapse to `{ duration: 0 }` under reduced
// motion, and to retain full motion otherwise; motion.ts's own unit tests
// cover the wrapper itself). This file guards the remaining call sites: it
// asserts each one is wired through `reducedMotionAware` and that the
// raw, unguarded directive it replaced does not creep back in.

const componentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(componentsDir, "..", "..", "..");

function readComponent(relativePath: string): string {
	return readFileSync(join(repoRoot, relativePath), "utf-8");
}

type Case = {
	file: string;
	/** Local identifiers the file's transitions must now use. */
	wrappedNames: string[];
	/** Raw svelte/transition directives that must no longer appear. */
	bannedDirectives: RegExp[];
};

const CASES: Case[] = [
	{
		file: "src/lib/components/chat/ImageLightbox.svelte",
		wrappedNames: ["backdropFade", "figureScale"],
		bannedDirectives: [/transition:fade=/, /transition:scale=/],
	},
	{
		file: "src/lib/components/search/SearchModal.svelte",
		wrappedNames: ["backdropFade"],
		bannedDirectives: [/transition:fade=/],
	},
	{
		file: "src/lib/components/layout/Sidebar.svelte",
		wrappedNames: ["overlayFade"],
		bannedDirectives: [/transition:fade=/],
	},
	{
		file: "src/routes/(app)/+page.svelte",
		wrappedNames: ["statusFade", "greetingFade"],
		// Both the status-message fade and the "intro-copy" greeting fade
		// are routed through reducedMotionAware; guard against either one
		// regressing back to a bare svelte/transition `fade`.
		bannedDirectives: [
			/transition:fade=\{\{ duration: 150 \}\}/,
			/in:fade=\{\{ duration: isFromChat/,
		],
	},
	{
		file: "src/lib/components/ui/ProfilePictureEditor.svelte",
		wrappedNames: ["backdropFade", "panelScale"],
		bannedDirectives: [/transition:fade=/, /transition:scale=/],
	},
	{
		file: "src/lib/components/sidebar/ConversationList.svelte",
		wrappedNames: ["sectionSlide", "rowFade"],
		bannedDirectives: [/transition:slide=/, /in:fade=/, /out:fade=/],
	},
	{
		file: "src/lib/components/chat/CodeBlock.svelte",
		wrappedNames: ["bodySlide"],
		bannedDirectives: [/transition:slide=/],
	},
	{
		file: "src/lib/components/ui/TypewriterText.svelte",
		wrappedNames: ["charFade"],
		bannedDirectives: [/in:fade=/],
	},
	{
		// The thinking block's disclosures plus the collapsed summary strip /
		// pinned deliverables fade, all three through the wrappers.
		file: "src/lib/components/chat/ThinkingBlock.svelte",
		wrappedNames: ["slideTransition", "flyTransition", "fadeTransition"],
		bannedDirectives: [
			/transition:slide=/,
			/transition:fade=/,
			/in:fade=/,
			/in:fly=/,
		],
	},
	{
		// Connections redesign — the composer's account list and the
		// connection dialogs' "What went wrong?" / custom-server disclosures.
		file: "src/lib/components/chat/ConnectionsPopover.svelte",
		wrappedNames: ["popoverFly"],
		bannedDirectives: [/transition:fly=/],
	},
	{
		file: "src/routes/(app)/settings/_components/connections/Disclosure.svelte",
		wrappedNames: ["bodySlide"],
		bannedDirectives: [/transition:slide=/],
	},
	{
		// Everyday redesign — the composer's "+" menu, which on a phone
		// becomes a bottom sheet and so flies 260px. A sheet is exactly the
		// kind of motion prefers-reduced-motion is asking us not to make.
		file: "src/lib/components/chat/ComposerToolsMenu.svelte",
		wrappedNames: ["menuFly"],
		bannedDirectives: [/transition:fly=/],
	},
	{
		// Everyday redesign — the model picker's phone sheet and its scrim.
		// Both were CSS `animation`s, which can only play on the way in; the
		// element was removed outright on the way out.
		file: "src/lib/components/chat/ModelSelector.svelte",
		wrappedNames: ["sheetFly", "scrimFade"],
		bannedDirectives: [/transition:fly=/, /transition:fade=/],
	},
	{
		// Everyday redesign — the Atlas report's download action sheet.
		file: "src/lib/components/chat/AtlasActivityBody.svelte",
		wrappedNames: ["sheetFly", "scrimFade"],
		bannedDirectives: [/transition:fly=/, /transition:fade=/],
	},
];

describe("Svelte transition directives are routed through reducedMotionAware", () => {
	it.each(CASES)("$file imports reducedMotionAware from $lib/utils/motion", ({
		file,
	}) => {
		const source = readComponent(file);
		expect(source).toMatch(
			/import\s*\{\s*reducedMotionAware\s*\}\s*from\s*["']\$lib\/utils\/motion["']/,
		);
	});

	it.each(
		CASES,
	)("$file wraps its transition(s) with reducedMotionAware(...)", ({
		file,
		wrappedNames,
	}) => {
		const source = readComponent(file);
		for (const name of wrappedNames) {
			expect(source).toMatch(
				new RegExp(`const ${name} = reducedMotionAware\\(`),
			);
		}
	});

	it.each(
		CASES,
	)("$file's directives use the wrapped transition, not the bare svelte/transition export", ({
		file,
		wrappedNames,
		bannedDirectives,
	}) => {
		const source = readComponent(file);
		for (const banned of bannedDirectives) {
			expect(source).not.toMatch(banned);
		}
		// At least one directive actually references each wrapped name —
		// guards against an unused wrapper that never made it into markup.
		for (const name of wrappedNames) {
			const usedAsDirective = new RegExp(`(transition|in|out):${name}=`).test(
				source,
			);
			expect(usedAsDirective).toBe(true);
		}
	});
});
