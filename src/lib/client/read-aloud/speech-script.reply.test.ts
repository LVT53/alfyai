import { render, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import MarkdownRenderer from "$lib/components/chat/MarkdownRenderer.svelte";
import { wordsFitReply } from "$lib/server/services/read-aloud/containment";
import { loadDetector } from "./language";
import { buildSpeechScript, type SpeechScript } from "./speech-script";

// The browser builds the speech script from the reply as the chat draws it, and the session
// route checks every word against the reply's Markdown with the same dictionary. This drives
// both ends for real: the chat's renderer (source chips on, as MessageBubble sets it), the
// script, and the containment check. A mismatch would refuse the reading (422) and it would
// never start (Review Focus 2).

const SYNTAX_REPLY = [
	"## Making **bread** at home",
	"",
	"Read [the docs](https://example.com/a_(b)) first, then call `getUserName()` once 🍞.",
	"",
	"```python",
	"total = price * 2",
	"print(total)",
	"```",
	"",
	"```ts",
	"const secretCode = 42;",
	"console.log(secretCode);",
	"export {};",
	"let a = 1;",
	"let b = 2;",
	"```",
	"",
	"| Item | Note |",
	"|---|---|",
	"| Flour | TABLECELL |",
	"",
	"1. Mix the flour well",
	"1. Add the water slowly",
	"",
	"- [ ] Preheat the oven to a high heat",
	"- [x] Grease the tin with butter",
	"",
	"> Patience is the secret ingredient, e.g. an hour [1].",
	"",
	"Salt &amp; pepper go in last, i.e. after the flour. Visit https://www.example.com/docs today.",
].join("\n");

async function renderReply(content: string): Promise<Element> {
	const { container } = render(MarkdownRenderer, {
		props: { content, compactExternalLinks: true },
	});
	await waitFor(
		() => {
			expect(container.querySelector(".code-block pre")).toBeTruthy();
			expect(container.querySelector(".markdown-checklist")).toBeTruthy();
		},
		{ timeout: 15_000 },
	);
	return container.querySelector(".markdown-container") as Element;
}

const checked = (script: SpeechScript) =>
	script.sentences.map((s) => ({
		language: s.language,
		words: s.words.map((w) => ({
			shown: w.shown,
			kind: w.kind,
			tokens: w.tokens,
		})),
	}));

describe("the speech script against the containment check", () => {
	it("reads what the chat draws, and the session route accepts every word of it", async () => {
		const root = await renderReply(SYNTAX_REPLY);
		const script = buildSpeechScript([root], await loadDetector(), {
			fallbackLanguage: "en",
		});
		const spoken = script.sentences.map((s) => s.text).join(" ");
		expect(spoken).toContain("get User Name");
		expect(spoken).toContain("total equals price star two");
		expect(spoken).toContain("One. Mix");
		expect(spoken).toContain("Two. Add");
		expect(spoken).toContain("the docs");
		expect(spoken).toContain("example dot com");
		expect(spoken).toContain("for example");
		expect(spoken).not.toMatch(
			/secret ?code|TABLECELL|https?|www\.|[*`#|[\]]/i,
		);
		expect(wordsFitReply(SYNTAX_REPLY, checked(script))).toBeNull();
	}, 30_000);

	it("ends every sentence in a stop, and the session route accepts every word of it", async () => {
		// The walk's Final 1: a list's last item, a heading that ends in a colon and a line with no
		// final mark have no stop of their own. The script gives each one; only punctuation
		// changes, so the route's check, which compares letters, is as satisfied as before.
		const content = `${SYNTAX_REPLY}\n\n- Eggs and milk\n- Butter and flour\n- A pinch of salt\n\n## What you need:\n\nThanks a lot`;
		const root = await renderReply(content);
		const script = buildSpeechScript([root], await loadDetector(), {
			fallbackLanguage: "en",
		});
		expect(script.sentences.length).toBeGreaterThan(3);
		for (const sentence of script.sentences)
			expect(sentence.tokens.at(-1)).toMatch(/[.!?…][)\]}"'”’»]*$/u);
		const spoken = script.sentences.map((s) => s.text);
		expect(spoken.join(" ")).toContain("Butter and flour. A pinch of salt.");
		expect(spoken).toContain("What you need.");
		expect(spoken.at(-1)).toBe("Thanks a lot.");
		expect(wordsFitReply(content, checked(script))).toBeNull();
	}, 30_000);

	it("accepts the addresses the early review saw refused: a Unicode host, a login, a host in brackets (R4)", async () => {
		const content = `${SYNTAX_REPLY}\n\nBuy at https://bücher.de/x or https://user:pw@example.org/x today. Source: https://www.bbc.com/news/x is good. As reported (bbc.com) it holds.`;
		const root = await renderReply(content);
		const script = buildSpeechScript([root], await loadDetector(), {
			fallbackLanguage: "en",
		});
		const spoken = script.sentences.map((s) => s.text).join(" ");
		expect(spoken).not.toMatch(/xn--|user|pw/);
		expect(wordsFitReply(content, checked(script))).toBeNull();
	}, 30_000);

	it("accepts a long code block that Read from here starts in", async () => {
		const root = await renderReply(SYNTAX_REPLY);
		const block =
			[...root.querySelectorAll(".code-block")].find((b) =>
				b.textContent?.includes("secretCode"),
			) ?? null;
		const script = buildSpeechScript([root], await loadDetector(), {
			fallbackLanguage: "en",
			readBlock: block,
		});
		expect(script.sentences.map((s) => s.text).join(" ")).toContain(
			"secret Code equals forty-two",
		);
		expect(wordsFitReply(SYNTAX_REPLY, checked(script))).toBeNull();
	}, 30_000);
});
