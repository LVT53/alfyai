// The static contract audit (Feature 2 · Artifacts, Slice 2): a pure,
// synchronous read of a generated app's own HTML against the fifteen
// `APP_CONTRACT_RULES`, ported unchanged from the prototype's `extract.ts`
// (`contractChecks`) — these exact regexes are what caught the two prototype
// apps that reached for something they should not have, and a "tidy-up"
// here changes what the product calls a glitch.
//
// The audit is advisory, never a gate: `auditAppHtml` has no path back to
// "do not show the app" (Owner decision 9). A `glitch` becomes one of three
// user-visible lines on the card (`AppBody.svelte`); a `note` is recorded for
// the eval harness and the slice report, and never rendered.
import {
	APP_CONTRACT_RULES,
	APP_TOKENS,
	type AppContractRuleId,
	type AppContractSeverity,
} from "./contract";

export interface ContractCheck {
	rule: AppContractRuleId;
	severity: AppContractSeverity;
	passed: boolean;
	/** One short, user-safe sentence, or null when the check passed. Never contains the app's HTML. */
	detail: string | null;
}

type RuleEvaluator = (html: string) => { passed: boolean; detail: string };

const TOKEN_NAMES = APP_TOKENS.map((token) => token.name);

function firstMatches(html: string, regex: RegExp, limit = 3): string[] {
	return [...html.matchAll(regex)].map((match) => match[1]).slice(0, limit);
}

// Bounded to 4096 chars between `<` and `>` (ruling 58): an unbounded
// `[^>]*` backtracks catastrophically against a pathological ~96 KB document
// with no `>` at all (measured ~0.65s before this bound; audit.test.ts's own
// timing test keeps it fast). No real tag attribute list approaches 4096
// chars, so this changes no verdict on any real document.
const MAX_TAG_TAIL = 4096;

const RULE_EVALUATORS: Record<AppContractRuleId, RuleEvaluator> = {
	"no-script-src": (html) => {
		const found = firstMatches(
			html,
			new RegExp(
				`<script\\b[^>]{0,${MAX_TAG_TAIL}}\\bsrc\\s*=\\s*["']([^"']+)["']`,
				"gi",
			),
		);
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	"no-link-href": (html) => {
		const found = firstMatches(
			html,
			new RegExp(
				`<link\\b[^>]{0,${MAX_TAG_TAIL}}\\bhref\\s*=\\s*["'](https?:\\/\\/[^"']+)["']`,
				"gi",
			),
		);
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	"no-remote-img": (html) => {
		const found = firstMatches(
			html,
			new RegExp(
				`<img\\b[^>]{0,${MAX_TAG_TAIL}}\\bsrc\\s*=\\s*["'](https?:\\/\\/[^"']+)["']`,
				"gi",
			),
		);
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	"no-network-api": (html) => {
		const found = [
			"fetch(",
			"XMLHttpRequest",
			"WebSocket",
			"EventSource",
			"sendBeacon",
			"@import",
		].filter((needle) => html.includes(needle));
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	tokens: (html) => {
		const defined = TOKEN_NAMES.filter((name) =>
			new RegExp(`${name}\\s*:`).test(html),
		);
		const missing = TOKEN_NAMES.filter((name) => !defined.includes(name));
		return {
			passed: defined.length === TOKEN_NAMES.length,
			detail: `${defined.length}/${TOKEN_NAMES.length} tokens defined${
				missing.length > 0 ? `; missing ${missing.join(", ")}` : ""
			}`,
		};
	},
	dark: (html) => {
		const present = /prefers-color-scheme\s*:\s*dark/i.test(html);
		return { passed: present, detail: present ? "present" : "missing" };
	},
	"uses-vars": (html) => {
		const count = (html.match(/var\(--/g) ?? []).length;
		return { passed: count >= 5, detail: `${count} var() references` };
	},
	"no-hardcoded-extremes": (html) => {
		const found = [
			...new Set(
				(html.match(/#(?:fff|ffffff|000|000000)(?![0-9a-f])/gi) ?? []).map(
					(literal) => literal.toLowerCase(),
				),
			),
		];
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	georgia: (html) => {
		const present = /Georgia/i.test(html);
		return { passed: present, detail: present ? "present" : "missing" };
	},
	helvetica: (html) => {
		const present = /Helvetica/i.test(html);
		return { passed: present, detail: present ? "present" : "missing" };
	},
	"alfy-storage": (html) => {
		const used = /alfy\s*\.\s*storage/.test(html);
		return { passed: used, detail: used ? "used" : "not used" };
	},
	"no-web-storage": (html) => {
		const found = [
			"localStorage",
			"sessionStorage",
			"indexedDB",
			"document.cookie",
		].filter((needle) => html.includes(needle));
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	viewport: (html) => {
		const present = new RegExp(
			`<meta\\b[^>]{0,${MAX_TAG_TAIL}}name\\s*=\\s*["']viewport["']`,
			"i",
		).test(html);
		return { passed: present, detail: present ? "present" : "missing" };
	},
	fluid: (html) => {
		const widths = [...html.matchAll(/(^|[^-a-z])width\s*:\s*(\d{3,})px/gi)]
			.map((match) => Number(match[2]))
			.filter((width) => width > 420);
		return {
			passed: widths.length === 0,
			detail:
				widths.length === 0 ? "none" : `${widths.slice(0, 4).join(", ")}px`,
		};
	},
	size: (html) => {
		const lines = html.split("\n").length;
		return { passed: lines <= 460, detail: `${lines} lines` };
	},
	// Ruling 58: measured under the product's real sandboxed frame — a dialog
	// call never shows anything (no allow-modals; confirm()/prompt() resolve
	// falsy/null synchronously, alert() is a no-op) and the app's own script
	// keeps running past it, so this is a glitch, not a crash.
	"no-dialogs": (html) => {
		const found = [
			...new Set(
				(html.match(/\b(alert|confirm|prompt)\s*\(/g) ?? []).map((call) =>
					call.replace(/\s*\($/, ""),
				),
			),
		];
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	// eval/new Function throw under the real CSP (script-src has no
	// 'unsafe-eval') — a glitch (the surrounding try/catch, if any, still
	// runs), not a violation: it cannot itself leak data outside the frame.
	"no-eval": (html) => {
		const found: string[] = [];
		if (/\beval\s*\(/.test(html)) found.push("eval(");
		if (/\bnew\s+Function\s*\(/.test(html)) found.push("new Function(");
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	// A violation (ruling 58): the sandbox does not stop a frame navigating
	// ITSELF (only a hostile parent framing it, or the frame navigating
	// something else), so an app that tries can still leak what it holds —
	// exactly the "still leak by navigating itself" gap the ruling names.
	"no-navigate": (html) => {
		const found: string[] = [];
		if (/\b(?:window\.)?location(?:\.href)?\s*=[^=]/.test(html)) {
			found.push("location assignment");
		}
		if (/\blocation\s*\.\s*(?:assign|replace)\s*\(/.test(html)) {
			found.push("location.assign/replace(");
		}
		if (/\bwindow\s*\.\s*open\s*\(/.test(html)) {
			found.push("window.open(");
		}
		if (
			new RegExp(
				`<a\\b[^>]{0,${MAX_TAG_TAIL}}\\bhref\\s*=\\s*["'](?:https?:)?\\/\\/`,
				"i",
			).test(html)
		) {
			found.push("an external <a href>");
		}
		if (
			new RegExp(
				`<meta\\b[^>]{0,${MAX_TAG_TAIL}}http-equiv\\s*=\\s*["']refresh["']`,
				"i",
			).test(html)
		) {
			found.push('<meta http-equiv="refresh">');
		}
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	// A violation (ruling 58): no CSP directive stops WebRTC, so a data
	// channel is a second, unblockable way to leak what the app holds.
	"no-webrtc": (html) => {
		const found = html.includes("RTCPeerConnection");
		return { passed: !found, detail: found ? "RTCPeerConnection" : "none" };
	},
};

/**
 * Pure, synchronous, never throws. Returns one entry per `APP_CONTRACT_RULES`
 * row, in that order — all fifteen always run, because the card can show more
 * than one glitch when there is more than one (no early return on the first
 * failure).
 */
export function auditAppHtml(html: string): ContractCheck[] {
	return APP_CONTRACT_RULES.map((rule) => {
		const { passed, detail } = RULE_EVALUATORS[rule.id](html);
		return {
			rule: rule.id,
			severity: rule.severity,
			passed,
			detail: passed ? null : detail,
		};
	});
}
