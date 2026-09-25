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

const RULE_EVALUATORS: Record<AppContractRuleId, RuleEvaluator> = {
	"no-script-src": (html) => {
		const found = firstMatches(
			html,
			/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
		);
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	"no-link-href": (html) => {
		const found = firstMatches(
			html,
			/<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
		);
		return { passed: found.length === 0, detail: found.join(", ") || "none" };
	},
	"no-remote-img": (html) => {
		const found = firstMatches(
			html,
			/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
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
		const present = /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html);
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
