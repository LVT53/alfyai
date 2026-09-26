// The App contract (Feature 2 · Artifacts, Slice 2): the system prompt that
// makes the generator's one call produce a self-contained web app, and the
// machine-readable mirror of its hard rules the audit and the tests share.
//
// Ported from the prototype (`.claude/worktrees/agent-afcaa6f617ee84abe/
// scripts/prototype-artifact-apps/system-prompt.ts`, `APP_CONTRACT`) with
// exactly two corrections, both required by the real product rather than a
// throwaway script:
//
// 1. The six shorthand tokens (`--pg`/`--el`/`--tx`/`--mu`/`--bd`/`--ac`)
//    become the app's real design tokens, with the real values — so a
//    generated app is never a second, silent design system next to the one
//    `src/app.css` already defines.
// 2. Nothing else changes: rule 5 keeps `window.alfy.storage.get/set`
//    exactly as prototyped (the bootstrap injects it; see `bootstrap.ts`),
//    including the feature-detect sentence that keeps an app alive in a
//    plain browser where the bridge is absent.
//
// `APP_TOKENS` is generated FROM this module's own six entries, not
// re-derived from the prompt text: the prompt's `:root`/`prefers-color-
// scheme` block is built by interpolating `APP_TOKENS`, so the prompt and
// the machine mirror cannot drift apart from each other. `contract.test.ts`
// is what keeps `APP_TOKENS` itself from drifting away from `src/app.css`.
//
// A note on where the dark values live in `src/app.css`: the spec text this
// slice was planned against describes a `@media (prefers-color-scheme:
// dark)` block inside `src/app.css`. The real file (verified while writing
// this module) instead keys dark values off a `.dark` class that
// `src/lib/stores/theme.ts` toggles on `<html>` from a `matchMedia` listener
// — there is no such `@media` block in `src/app.css` at all. That mechanism
// cannot reach inside this feature's sandboxed, opaque-origin iframe (no
// class the parent sets is visible to the frame's document), so the
// CONTRACT correctly asks the model for `@media (prefers-color-scheme:
// dark)` — it is the only signal the app can read on its own — while the
// drift test (`contract.test.ts`) sources its "real" dark values from
// `src/app.css`'s `.dark` class block, not from a `@media` block that does
// not exist. Reported as a deviation from the slice spec's literal text; the
// code (and this contract) match the app's actual dark-mode mechanism.
//
// Font stacks stay Helvetica/Georgia, never `--font-sans`/`--font-serif`:
// an iframe inherits nothing from the parent document, so a variable
// reference with no local definition would silently fall back to the
// browser default. Excluded from the token drift assertion for the same
// reason — there is nothing in `src/app.css` to compare them against.

export interface AppContractToken {
	name: string;
	light: string;
	dark: string;
}

/**
 * The app's six design tokens, real names and real values — copied by hand
 * from `src/app.css` (`:root` for light, `.dark` for dark) at the time this
 * module was written. `contract.test.ts` re-parses the file and fails this
 * module the day the two disagree.
 */
export const APP_TOKENS: readonly AppContractToken[] = [
	{ name: "--surface-page", light: "#fafaf8", dark: "#1a1a1a" },
	{ name: "--surface-elevated", light: "#f4f3ee", dark: "#242424" },
	{ name: "--text-primary", light: "#1a1a1a", dark: "#ececec" },
	{ name: "--text-muted", light: "#6b6b6b", dark: "#a0a0a0" },
	{
		name: "--border-default",
		light: "rgba(0, 0, 0, 0.08)",
		dark: "rgba(255, 255, 255, 0.08)",
	},
	{ name: "--accent", light: "#c15f3c", dark: "#d4836b" },
] as const;

function rootBlock(pick: "light" | "dark"): string {
	const declarations = APP_TOKENS.map(
		(token) => `${token.name}:${token[pick]}`,
	).join("; ");
	return `:root { ${declarations} }`;
}

const APP_CONTRACT_TOKEN_CSS = `${rootBlock("light")}
   @media (prefers-color-scheme: dark) { ${rootBlock("dark")} }`;

/**
 * The App contract, verbatim from the prototype's `system-prompt.ts` with
 * the token correction above. This is the ENTIRE outbound system prompt for
 * the generation call (`generate.ts`) — no chat history, no other artifact,
 * no memory, no user display name ever joins it (A1.6).
 */
export const APP_CONTRACT_PROMPT = `You write small, self-contained interactive web apps that AlfyAI shows in a sandboxed panel next to the chat.

Return exactly ONE fenced code block, tagged html, that contains the complete document. Write nothing outside the fence: no greeting, no explanation, no summary after it.

Hard rules for the document:

1. Self-contained, zero network. No CDN, no <script src>, no <link href>, no web fonts, no images loaded from a URL, no fetch/XHR/WebSocket/EventSource. Inline <style> and inline <script> only.
2. No frameworks, no libraries, no build step. Plain HTML, CSS and JavaScript (ES2020 or older syntax is fine).
3. AlfyAI design tokens. Define them on :root and use them everywhere:
   ${APP_CONTRACT_TOKEN_CSS}
   body background var(--surface-page), cards and inputs var(--surface-elevated), text var(--text-primary), secondary text var(--text-muted), borders 1px solid var(--border-default), accent var(--accent). Do not invent other colours and never use #fff or #000.
4. Typography: body uses the Helvetica stack (Helvetica, Arial, sans-serif); h1, h2, h3 use Georgia, 'Times New Roman', serif. No @font-face, no font imports.
5. Persistence only through the host API that is already injected:
   const saved = await window.alfy.storage.get('my-key');  // stored value, or null
   await window.alfy.storage.set('my-key', value);         // value must be JSON-serialisable
   Never use localStorage, sessionStorage, IndexedDB or cookies. Feature-detect it (if (window.alfy && window.alfy.storage)) and keep working when it is missing. Load saved state on start and save after every user change.
6. Layout: mobile-first and fluid. It must be usable from 390 px wide up to a wide desktop. No fixed page widths, no horizontal scrolling, max-width 720px and margin 0 auto on desktop, viewport meta tag present.
7. Accessible and keyboard operable: real <button>, <input>, <label>, <select> elements, every input labelled, visible focus outline, headings in order, buttons and inputs reachable with Tab and activatable with Enter or Space, tap targets at least 40px high, and an aria-live region for status changes.
8. Language: the whole UI is in the language of the user's request (a Hungarian request means Hungarian labels, buttons, empty states and error messages). Keep code identifiers in English.
9. Keep the document under about 400 lines, and skip comments that only restate the code.
10. Put the app name in <title> and in an <h1>, and show a short usage hint when the interaction is not obvious. When the app stores data, render a useful empty state that says what to add first.
11. The document runs inside a sandboxed frame with no dialogs and no navigation of its own. If you use a <form>, handle its submit event with event.preventDefault() (the submission itself never leaves the frame, but your own script still runs and must not assume otherwise). Never call alert, confirm or prompt — draw an inline confirmation UI instead when an action needs one. Never use eval or new Function. Never navigate the page: no assigning location or location.href, no location.assign/replace, no window.open, no <a href> pointing outside the document, no <meta http-equiv="refresh">. Never use RTCPeerConnection.

The app must work the moment it is opened: no placeholder functions, no TODO, no code that throws, no dead buttons. Walk through the main interaction mentally before you answer.`;

export interface AppContractRule {
	id: string;
	label: string;
	/**
	 * "glitch": user-visible, non-fatal (a line on the card, spec Contracts).
	 * "note": dev/eval-only, never shown (Owner decision 9).
	 * "violation" (ruling 58): a sandbox-escape attempt (self-navigation,
	 * WebRTC) rather than a quality miss. Generation retries once with the
	 * violation named, then refuses with a visible, localized message —
	 * never just a card-line glitch, because these are the ones that can
	 * still leak what the app holds despite the sandbox (spec §5/ruling 58).
	 */
	severity: "glitch" | "note" | "violation";
}

/**
 * The nineteen static checks `audit.ts` runs against a generated document:
 * the prototype's original fifteen (`extract.ts`'s `contractChecks`) plus
 * four from ruling 58's sandbox review (`no-dialogs`, `no-eval`,
 * `no-navigate`, `no-webrtc`). Order matches the prototype's for the
 * original fifteen, since the eval harness and this list must agree on "one
 * entry per rule, in this order" (A2); the four new ones are appended.
 */
export const APP_CONTRACT_RULES = [
	{
		id: "no-script-src",
		label: "No external scripts",
		severity: "glitch",
	},
	{
		id: "no-link-href",
		label: "No external stylesheets or fonts",
		severity: "glitch",
	},
	{ id: "no-remote-img", label: "No remote images", severity: "glitch" },
	{
		id: "no-network-api",
		label: "No runtime network calls",
		severity: "glitch",
	},
	{ id: "tokens", label: "Defines all six tokens", severity: "note" },
	{
		id: "dark",
		label: "Dark mode via prefers-color-scheme",
		severity: "note",
	},
	{ id: "uses-vars", label: "Actually uses the tokens", severity: "note" },
	{
		id: "no-hardcoded-extremes",
		label: "No #fff / #000 hardcoding",
		severity: "note",
	},
	{ id: "georgia", label: "Georgia for headings", severity: "note" },
	{ id: "helvetica", label: "Helvetica for UI text", severity: "note" },
	{
		id: "alfy-storage",
		label: "Persists through window.alfy.storage",
		severity: "note",
	},
	{
		id: "no-web-storage",
		label: "No localStorage/sessionStorage/cookies",
		severity: "glitch",
	},
	{ id: "viewport", label: "Viewport meta tag", severity: "note" },
	{
		id: "fluid",
		label: "No fixed widths above 420px",
		severity: "note",
	},
	{ id: "size", label: "Under ~400 lines", severity: "note" },
	// Ruling 58 (RV-2A's sandbox review): a form's submit never fires, confirm()
	// returns false and eval throws inside the product's real sandboxed frame —
	// dialogs and eval are glitches (the app still works, degraded); navigation
	// and WebRTC are violations (a sandbox-escape attempt, not a quality miss).
	{ id: "no-dialogs", label: "No alert/confirm/prompt", severity: "glitch" },
	{ id: "no-eval", label: "No eval or new Function", severity: "glitch" },
	{
		id: "no-navigate",
		label: "Never navigates the page",
		severity: "violation",
	},
	{
		id: "no-webrtc",
		label: "No RTCPeerConnection",
		severity: "violation",
	},
] as const satisfies readonly AppContractRule[];

export type AppContractRuleId = (typeof APP_CONTRACT_RULES)[number]["id"];
export type AppContractSeverity =
	(typeof APP_CONTRACT_RULES)[number]["severity"];

/**
 * The rule ids a passing app must not trip — used by both `audit.ts` (the
 * user-visible glitch messages, Contracts) and the eval scorer.
 */
export const APP_GLITCH_RULE_IDS: readonly AppContractRuleId[] =
	APP_CONTRACT_RULES.filter((rule) => rule.severity === "glitch").map(
		(rule) => rule.id,
	);

/**
 * The rule ids that make generation retry once (naming the violation) and
 * then refuse rather than ship a card (ruling 58). Read by `generate.ts`;
 * kept beside `APP_GLITCH_RULE_IDS` since both are the audit's own severity
 * split, not a second classification.
 */
export const APP_VIOLATION_RULE_IDS: readonly AppContractRuleId[] =
	APP_CONTRACT_RULES.filter((rule) => rule.severity === "violation").map(
		(rule) => rule.id,
	);

/**
 * The prototype's measured sampling: Qwen3 thinking models want
 * temp 0.6 / top_p 0.95 / top_k 20 (`provider-compatibility.ts`'s qwen
 * family `defaultSampling`, already the provider's own default — this
 * feature adds no sampling parameter of its own; see `generate.ts`).
 * `maxOutputTokens` is this feature's one owned value: the prototype's
 * 2,486–3,607 completion tokens typical, one app near the ceiling.
 */
export const APP_SAMPLING_DEFAULTS = {
	temperature: 0.6,
	topP: 0.95,
	topK: 20,
	maxOutputTokens: 24_000,
} as const;

export const APP_MAX_OUTPUT_TOKENS = APP_SAMPLING_DEFAULTS.maxOutputTokens;
