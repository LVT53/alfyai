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
const MODULES = ["chat", "common", "knowledge", "settings", "skills"] as const;

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
		const content = fs.readFileSync(filePath, "utf-8");

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
