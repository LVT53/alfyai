#!/usr/bin/env npx tsx
/**
 * i18n Translation Quality Validator
 *
 * Usage: npx tsx scripts/validate-i18n.ts
 *
 * Checks:
 * 1. Missing keys (EN has, HU doesn't)
 * 2. Untranslated text (EN/HU values are identical)
 * 3. Very similar text (likely copy-paste not translated)
 * 4. Empty HU values
 * 5. Parameter ({name}) mismatches between EN and HU
 * 6. Same-character ratio (if HU looks suspiciously like EN)
 *
 * Exit codes:
 *   0 = no issues
 *   1 = issues found
 */

import * as fs from "node:fs";
import * as path from "node:path";

const I18N_DIR = path.resolve("src/lib/i18n");
// Every module `src/lib/i18n/index.ts` merges into the dictionary. `connections`
// and `legal` were missing, so two whole namespaces — every connection status
// sentence, every write-confirm line, the legal pages — were never checked for
// a missing or untranslated Hungarian key. Adding a module here is not
// optional: a namespace the app ships and this list does not name is a
// namespace whose Hungarian nobody is watching.
const MODULES = [
	"chat",
	"common",
	"connections",
	"knowledge",
	"legal",
	"settings",
	"skills",
] as const;

function parseI18n() {
	const en: Record<string, string> = {};
	const hu: Record<string, string> = {};

	function extractBracedBlock(text: string, startIdx: number): string {
		let depth = 0;
		const start = text.indexOf("{", startIdx);
		if (start === -1) return "";
		depth = 1;
		let i = start + 1;
		while (depth > 0 && i < text.length) {
			if (text[i] === "{") depth++;
			else if (text[i] === "}") depth--;
			i++;
		}
		return text.slice(start + 1, i - 1);
	}

	/**
	 * Drop `//` and block comments before anything else looks at the source.
	 *
	 * The key/value regex below is a regex, not a parser, so a comment that
	 * happens to contain `word: "text"` looked exactly like a translation to
	 * it. One did: common.ts documents the greeting pool with
	 * "Every line comes in two forms: `.named` carries {name}…", and the
	 * validator duly reported a missing HU key called `forms` whose English
	 * value was `.named`. A phantom key can never be translated, so the run
	 * could not reach exit 0 no matter what anyone wrote in the dictionaries.
	 *
	 * Stripping has to be string-aware in both directions: several real values
	 * contain `//` (the URL placeholders, "e.g. https://api.openai.com/v1"),
	 * so a naive `.replace(/\/\/.*$/gm, "")` would truncate them and turn a
	 * translated key into an "empty HU value" error. This walks the file once,
	 * tracking which quote (if any) it is inside, and only treats `//` and
	 * `/*` as comment openers when it is outside a string.
	 *
	 * Escapes are honoured so a `\"` inside a double-quoted value does not end
	 * it. Comment bodies are replaced by nothing; newlines inside a block
	 * comment are kept so line-based intuition about the file survives.
	 */
	function stripComments(source: string): string {
		let out = "";
		let i = 0;
		let quote: string | null = null;
		while (i < source.length) {
			const ch = source[i];
			if (quote) {
				out += ch;
				if (ch === "\\" && i + 1 < source.length) {
					out += source[i + 1];
					i += 2;
					continue;
				}
				if (ch === quote) quote = null;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				out += ch;
				i++;
				continue;
			}
			if (ch === "/" && source[i + 1] === "/") {
				while (i < source.length && source[i] !== "\n") i++;
				continue;
			}
			if (ch === "/" && source[i + 1] === "*") {
				i += 2;
				while (
					i < source.length &&
					!(source[i] === "*" && source[i + 1] === "/")
				) {
					if (source[i] === "\n") out += "\n";
					i++;
				}
				i += 2;
				continue;
			}
			out += ch;
			i++;
		}
		return out;
	}

	function extractKeyValues(block: string, target: Record<string, string>) {
		const regex =
			/(?:["'])?([\w.]+)(?:["'])?\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`)/g;
		let match: RegExpExecArray | null = regex.exec(block);
		while (match !== null) {
			const key = match[1];
			const value = (match[2] ?? match[3] ?? "").trim();
			if (key && value !== undefined) target[key] = value;
			match = regex.exec(block);
		}
	}

	for (const mod of MODULES) {
		const filePath = path.join(I18N_DIR, `${mod}.ts`);
		if (!fs.existsSync(filePath)) continue;
		const content = stripComments(fs.readFileSync(filePath, "utf-8"));

		for (const lang of ["en", "hu"] as const) {
			const idx = content.search(new RegExp(`\\b${lang}\\s*:`));
			if (idx === -1) continue;
			const block = extractBracedBlock(content, idx);
			extractKeyValues(block, lang === "en" ? en : hu);
		}
	}

	return { en, hu };
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = [];
	for (let i = 0; i <= m; i++) dp[i] = [i];
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dp[m][n];
}

function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
	return 1 - dist / Math.max(a.length, b.length);
}

function extractParams(value: string): Set<string> {
	const params = new Set<string>();
	let cleanValue = value;
	const icuPattern = /\{(\w+),\s*\w+,/g;
	let icuMatch: RegExpExecArray | null = icuPattern.exec(cleanValue);
	while (icuMatch !== null) {
		let depth = 1;
		let end = icuMatch.index + icuMatch[0].length;
		while (depth > 0 && end < cleanValue.length) {
			if (cleanValue[end] === "{") depth++;
			else if (cleanValue[end] === "}") depth--;
			end++;
		}
		cleanValue =
			cleanValue.slice(0, icuMatch.index) +
			"{" +
			icuMatch[1] +
			"}" +
			cleanValue.slice(end);
		icuPattern.lastIndex = 0;
		icuMatch = icuPattern.exec(cleanValue);
	}
	const regex = /\{(\w+)\}/g;
	let match: RegExpExecArray | null = regex.exec(cleanValue);
	while (match !== null) {
		params.add(match[1]);
		match = regex.exec(cleanValue);
	}
	return params;
}

function validate() {
	const { en, hu } = parseI18n();

	const issues: string[] = [];
	let warnings = 0;
	let errors = 0;

	const enKeys = new Set(Object.keys(en));
	const huKeys = new Set(Object.keys(hu));

	for (const key of enKeys) {
		if (!huKeys.has(key)) {
			issues.push(`[ERROR] Missing HU key: "${key}" (EN: "${en[key]}")`);
			errors++;
		}
	}

	for (const key of huKeys) {
		if (!enKeys.has(key)) {
			issues.push(
				`[WARN] Extra HU key (no EN equivalent): "${key}" (HU: "${hu[key]}")`,
			);
			warnings++;
		}
	}

	for (const key of enKeys) {
		if (!huKeys.has(key)) continue;
		const enVal = en[key].trim();
		const huVal = hu[key].trim();
		const sim = similarity(enVal, huVal);

		if (huVal === "") {
			issues.push(
				`[ERROR] Empty HU translation for key "${key}" (EN: "${enVal}")`,
			);
			errors++;
			continue;
		}

		if (enVal === huVal) {
			issues.push(
				`[WARN] Untranslated key "${key}" — HU equals EN: "${enVal}"`,
			);
			warnings++;
			continue;
		}

		if (sim > 0.85 && enVal.length > 10) {
			issues.push(
				`[WARN] Suspiciously similar (${(sim * 100).toFixed(0)}% match) key "${key}": EN="${enVal}" / HU="${huVal}"`,
			);
			warnings++;
		}

		const enParams = extractParams(enVal);
		const huParams = extractParams(huVal);
		if (
			enParams.size !== huParams.size ||
			![...enParams].every((p) => huParams.has(p))
		) {
			issues.push(
				`[ERROR] Parameter mismatch for key "${key}": EN params=[${[...enParams].join(",")}] HU params=[${[...huParams].join(",")}]`,
			);
			errors++;
		}
	}

	console.log(`\n📊 i18n Translation Quality Report`);
	console.log(`   ${"=".repeat(40)}`);
	console.log(`   Total EN keys: ${enKeys.size}`);
	console.log(`   Total HU keys: ${huKeys.size}`);
	console.log(
		`   Coverage: ${((huKeys.size / enKeys.size) * 100).toFixed(1)}%`,
	);
	console.log(`   ${"=".repeat(40)}\n`);

	if (issues.length === 0) {
		console.log("✅ No issues found — translations look clean!");
		return 0;
	}

	console.log(`Found ${errors} error(s) and ${warnings} warning(s):\n`);
	for (const issue of issues) console.log(`  ${issue}`);
	return errors > 0 ? 1 : 0;
}

process.exit(validate());
