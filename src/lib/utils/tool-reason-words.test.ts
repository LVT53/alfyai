import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "svelte/store";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
	FILE_PRODUCTION_ERROR_KEYS,
	FILE_PRODUCTION_STOP_CODES,
} from "$lib/components/chat/file-production-helpers";
import { type I18nKey, t } from "$lib/i18n";
import chatDict from "$lib/i18n/chat";
import toolRowsDict from "$lib/i18n/tool-rows";
import {
	ATLAS_ERROR_CODES,
	IMAGE_DERIVED_CODES,
	IMAGE_ERROR_CODES,
	IMAGE_REFUSAL_CODES,
	SHARED_REASON_CODES,
	TOOL_REASON_CODES,
	VIDEO_ERROR_CODES,
} from "$lib/shared/tool-reasons";
import { uiLanguage } from "$lib/stores/settings";
import { TOOL_ROW_I18N_KEYS } from "./tool-activity";
import { catalogueToolNames } from "./tool-catalogue.test-helpers";
import {
	readReasonCode,
	resolveToolReason,
	TOOL_REASON_WORDS,
	toolReasonKeys,
} from "./tool-reason-words";

/** Every code any registry table lists, with the table it belongs to. */
function everyCode(): { tool: string; code: string }[] {
	const out: { tool: string; code: string }[] = [];
	for (const [tool, codes] of Object.entries(TOOL_REASON_CODES)) {
		for (const code of codes) out.push({ tool, code });
	}
	for (const code of [...IMAGE_REFUSAL_CODES, ...IMAGE_ERROR_CODES]) {
		out.push({ tool: "make_image", code });
	}
	for (const code of IMAGE_DERIVED_CODES) {
		out.push({ tool: "make_image", code });
	}
	for (const code of VIDEO_ERROR_CODES) {
		out.push({ tool: "make_video", code });
	}
	for (const code of ATLAS_ERROR_CODES) {
		out.push({ tool: "atlas", code });
	}
	return out;
}

describe("the words of every tool outcome", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("every key resolves in English and Hungarian, to different, non-empty words", () => {
		const keys = toolReasonKeys();
		expect(keys.length).toBeGreaterThan(100);
		for (const key of keys) {
			uiLanguage.set("en");
			const en = get(t)(key, { place: "Fő utca 99" });
			uiLanguage.set("hu");
			const hu = get(t)(key, { place: "Fő utca 99" });
			expect(en, `${key} in English`).not.toBe(key);
			expect(hu, `${key} in Hungarian`).not.toBe(key);
			expect(en.trim(), `${key} in English`).not.toBe("");
			expect(hu.trim(), `${key} in Hungarian`).not.toBe("");
			expect(hu, `${key} is untranslated`).not.toBe(en);
		}
	});

	it("every word a row says on its own line resolves in English and Hungarian, to different words", () => {
		expect(TOOL_ROW_I18N_KEYS.length).toBeGreaterThan(0);
		for (const key of TOOL_ROW_I18N_KEYS) {
			uiLanguage.set("en");
			const en = get(t)(key, { count: 3, place: "x", time: "x" });
			uiLanguage.set("hu");
			const hu = get(t)(key, { count: 3, place: "x", time: "x" });
			expect(en, `${key} in English`).not.toBe(key);
			expect(hu, `${key} in Hungarian`).not.toBe(key);
			expect(hu, `${key} is untranslated`).not.toBe(en);
		}
	});

	it("no sentence names an artifact, and Hungarian says készség for a skill", () => {
		for (const language of ["en", "hu"] as const) {
			for (const [key, value] of Object.entries(toolRowsDict[language])) {
				expect(value, `${language} ${key}`).not.toMatch(/artifact|artefakt/i);
			}
		}
		expect(toolRowsDict.hu["toolRows.use_skill.skill_turned_off"]).toContain(
			"készség",
		);
		expect(toolRowsDict.hu["toolRows.use_skill.fallback"]).toContain("készség");
		expect(
			Object.values(toolRowsDict.hu).filter((value) => /skill/i.test(value)),
		).toEqual([]);
	});

	it("no sentence the file card says speaks a developer's language, in English or Hungarian", () => {
		// The words of the developer who wrote the check ("projection", "renderer",
		// "Unicode font", "exceeds the configured limit", "renderelés", "szöveges
		// vetület", "Unicode betűkészlet") are not a person's words.
		const developerWords = {
			en: /projection|render|unicode|configured|sandbox|exceed|worker|schema|payload/i,
			hu: /render|vetület|unicode|korlát|időtúllépés|sandbox|payload/i,
		} as const;
		for (const language of ["en", "hu"] as const) {
			const sentences = Object.entries(chatDict[language]).filter(([key]) =>
				key.startsWith("fileProduction.error."),
			);
			expect(sentences.length).toBeGreaterThan(25);
			for (const [key, value] of sentences) {
				expect(value, `${language} ${key}`).not.toMatch(
					developerWords[language],
				);
			}
		}
	});

	it("every tool in the model's catalogue has a fallback", () => {
		const names = catalogueToolNames().filter((name) => name !== "ask_user");
		expect(names.length).toBeGreaterThanOrEqual(24);
		for (const name of names) {
			const table = (TOOL_REASON_WORDS as Record<string, unknown>)[name] as
				| { fallback: I18nKey }
				| undefined;
			expect(table, `${name} has no words`).toBeDefined();
			expect(table?.fallback, `${name} fallback`).toMatch(/^[a-zA-Z]+\./);
			expect(resolveToolReason(name, null).key).toBe(table?.fallback);
		}
	});

	it("every code a tool can name has its own entry, never the fallback by accident", () => {
		for (const { tool, code } of everyCode()) {
			const table = (
				TOOL_REASON_WORDS as unknown as Record<
					string,
					{ codes: Record<string, unknown> }
				>
			)[tool];
			expect(table, `${tool} has no words`).toBeDefined();
			expect(table.codes[code], `${tool} ${code}`).toBeDefined();
		}
	});

	it("gives each code the kind the plan says: stops on purpose are quiet, failures are red", () => {
		const stops = new Set([
			"request_adjusted",
			"ambiguous",
			"already_offered",
			"empty_text",
			"text_too_long",
			"writes_turned_off",
			"calendar_edit_consent",
			"read_only_account",
			"not_supported",
			"not_set_up",
			"no_such_account",
			"not_connected",
			"skill_turned_off",
			"skill_not_found",
			"memory_off",
			"chat_out_of_reach",
			"history_request_required",
			"history_title_unresolved",
			"link_not_from_a_source",
			"inspection_unknown_result",
			"inspection_text_only",
			"inspection_budget",
			"reading_budget_used",
			"reply_limit_reached",
			"kind_not_creatable",
			"kind_not_editable",
			"not_editable_as_text",
			"rebuild_limit_reached",
			"changed_since_read",
			"image_blocked",
			"video_blocked",
			"too_large",
			"stopped",
			"out_of_time",
			// The spec's other stops on purpose: the map's coverage limits, the
			// filter and the checks, the explicit-picture refusal, a Stop of an Atlas.
			"out_of_coverage",
			"region_preparing",
			"multi_region",
			"transit_unavailable",
			"transparent_unavailable",
			"explicit_request",
			"not_asked_for",
			"atlas_v3_no_evidence",
			"cancelled",
			// A refusal only the model needs: the picture row's own "adjusting" state.
			"unknown_picture",
			"too_many_pictures",
			"too_many_takes",
			"too_many_calls",
			"retry_unknown",
			"retry_twice",
		]);
		const infos = new Set([
			"details_kept_local",
			"details_withheld",
			// The tool gave up waiting but the take is still rendering.
			"image_tool_timeout",
			"video_tool_timeout",
		]);
		for (const { tool, code } of everyCode()) {
			const expected = stops.has(code)
				? "stop"
				: infos.has(code)
					? "info"
					: code === "nothing_found"
						? "empty"
						: "fail";
			expect(resolveToolReason(tool, code).kind, `${tool} ${code}`).toBe(
				expected,
			);
		}
	});

	it("an unknown or missing code is the tool's fallback, as a failure", () => {
		for (const tool of ["research_web", "calendar", "make_video", "atlas"]) {
			const table = (
				TOOL_REASON_WORDS as unknown as Record<string, { fallback: I18nKey }>
			)[tool];
			expect(resolveToolReason(tool, "some_new_code")).toEqual({
				code: "some_new_code",
				kind: "fail",
				key: table.fallback,
			});
			expect(resolveToolReason(tool, null)).toEqual({
				code: null,
				kind: "fail",
				key: table.fallback,
			});
		}
	});

	it("a tool outside the registry gets the generic fallback, and the shared words for a shared code", () => {
		expect(resolveToolReason("some_future_tool", null)).toEqual({
			code: null,
			kind: "fail",
			key: "toolRows.generic.fallback",
		});
		expect(resolveToolReason("some_future_tool", "oddity").key).toBe(
			"toolRows.generic.fallback",
		);
		expect(resolveToolReason("some_future_tool", "stopped")).toEqual({
			code: "stopped",
			kind: "stop",
			key: "toolRows.shared.stopped",
		});
		// A name that is a property of every object is still no tool.
		expect(resolveToolReason("constructor", null).key).toBe(
			"toolRows.generic.fallback",
		);
	});

	it("reads a call saved under an older tool name as the tool its row stands for", () => {
		expect(resolveToolReason("web_search", null).key).toBe(
			"toolRows.research_web.fallback",
		);
		expect(resolveToolReason("legacy_web_search", "nothing_found")).toEqual({
			code: "nothing_found",
			kind: "empty",
			key: "toolRows.research_web.nothing_found",
		});
	});

	it("the three shared outcomes have words for every tool", () => {
		const tools = Object.keys(TOOL_REASON_WORDS);
		expect(tools.length).toBeGreaterThanOrEqual(25);
		for (const tool of tools) {
			expect(resolveToolReason(tool, "stopped").kind).toBe("stop");
			expect(resolveToolReason(tool, "out_of_time")).toMatchObject({
				kind: "stop",
				key: "toolRows.shared.out_of_time",
			});
			expect(resolveToolReason(tool, "timed_out").kind).toBe("fail");
		}
		expect([...SHARED_REASON_CODES].sort()).toEqual([
			"out_of_time",
			"stopped",
			"timed_out",
		]);
	});

	it("reads an older fetch_url refusal that carried no code as the link the app did not open", () => {
		// Saved before codes: ok false and a count of the addresses it refused, status
		// done, and not a word more.
		expect(readReasonCode("fetch_url", { ok: false, refusedUrlCount: 1 })).toBe(
			"link_not_from_a_source",
		);
		expect(readReasonCode("fetch_url", { ok: false, refusedUrlCount: 3 })).toBe(
			"link_not_from_a_source",
		);
		// A call saved under an older name for the same tool reads the same.
		expect(
			readReasonCode("legacy_fetch_url", { ok: false, refusedUrlCount: 1 }),
		).toBe("link_not_from_a_source");
		// Nothing else is a refusal: a read that worked, none refused, or one the
		// server named itself.
		expect(
			readReasonCode("fetch_url", { ok: true, refusedUrlCount: 1 }),
		).toBeNull();
		expect(
			readReasonCode("fetch_url", { ok: false, refusedUrlCount: 0 }),
		).toBeNull();
		expect(readReasonCode("fetch_url", { ok: false })).toBeNull();
		expect(
			readReasonCode("fetch_url", {
				ok: false,
				refusedUrlCount: 1,
				reasonCode: "site_timeout",
			}),
		).toBe("site_timeout");
		// And no other tool's `refusedUrlCount` makes it one.
		expect(
			readReasonCode("research_web", { ok: false, refusedUrlCount: 1 }),
		).toBeNull();
	});

	it("a step the reply left unfinished is a quiet stop with one sentence for every tool, and no server list holds it", () => {
		// The browser's own reading of a call the server never closed, in a reply the
		// person did not stop (an update, a crash): not the server's `stopped`.
		const expected = {
			code: "unfinished",
			kind: "stop",
			key: "toolRows.shared.unfinished",
		};
		for (const tool of [
			...Object.keys(TOOL_REASON_WORDS),
			"some_future_tool",
		]) {
			expect(resolveToolReason(tool, "unfinished"), tool).toEqual(expected);
		}
		expect(toolReasonKeys()).toContain("toolRows.shared.unfinished");
		expect(SHARED_REASON_CODES as readonly string[]).not.toContain(
			"unfinished",
		);
		for (const codes of Object.values(TOOL_REASON_CODES)) {
			expect(codes as readonly string[]).not.toContain("unfinished");
		}
		// It reads from the metadata the row's builder gives a cut-off call, for a
		// picture and a clip too, whose own fields say nothing of it.
		for (const tool of [
			"research_web",
			"make_image",
			"make_video",
			"calendar",
		]) {
			expect(readReasonCode(tool, { reasonCode: "unfinished" }), tool).toBe(
				"unfinished",
			);
		}
	});

	it("gives every code the file maker writes its kind: a limit, a kind of file it will not make and a cancel are stops, the rest are breakages", () => {
		for (const code of FILE_PRODUCTION_STOP_CODES) {
			expect(
				Object.hasOwn(FILE_PRODUCTION_ERROR_KEYS, code),
				`${code} is a stop with no words on the file card`,
			).toBe(true);
			expect(resolveToolReason("produce_file", code).kind, code).toBe("stop");
		}
		for (const [code, key] of Object.entries(FILE_PRODUCTION_ERROR_KEYS)) {
			const words = resolveToolReason("produce_file", code);
			// The words are the card's own, whatever the kind.
			expect(words.key, code).toBe(key);
			if (!FILE_PRODUCTION_STOP_CODES.has(code)) {
				expect(words.kind, code).toBe("fail");
			}
		}
		// Taking too long is a breakage, not a limit the app set on purpose.
		for (const code of ["renderer_timeout", "sandbox_timeout"]) {
			expect(resolveToolReason("produce_file", code).kind, code).toBe("fail");
		}
		// The render budget's cancel says what a Stop says.
		expect(resolveToolReason("produce_file", "render_cancelled")).toEqual({
			code: "render_cancelled",
			kind: "stop",
			key: "toolRows.shared.stopped",
		});
		// The person's own Cancel is the job's status, read as the shared stop.
		expect(resolveToolReason("produce_file", "stopped").kind).toBe("stop");
		// A code from a newer server, or none, is a failure with the card's fallback.
		expect(
			resolveToolReason("produce_file", "a_code_from_a_newer_server"),
		).toEqual({
			code: "a_code_from_a_newer_server",
			kind: "fail",
			key: "fileProduction.failedDescription",
		});
		expect(resolveToolReason("produce_file", null).kind).toBe("fail");
	});

	it("a shared code uses the tool's own words when it has them", () => {
		expect(resolveToolReason("image_search", "timed_out")).toEqual({
			code: "timed_out",
			kind: "fail",
			key: "toolRows.image_search.search_timeout",
		});
		expect(resolveToolReason("fetch_url", "timed_out").key).toBe(
			"toolRows.fetch_url.site_timeout",
		);
		expect(resolveToolReason("run_python", "timed_out").key).toBe(
			"toolRows.run_python.timed_out",
		);
		// A tool with nothing of its own says it the shared way.
		expect(resolveToolReason("research_web", "timed_out").key).toBe(
			"toolRows.shared.timed_out",
		);
		// A picture or a clip that was stopped keeps its verb and says no more.
		expect(resolveToolReason("make_image", "stopped")).toEqual({
			code: "stopped",
			kind: "stop",
			key: null,
		});
		expect(resolveToolReason("make_video", "stopped").key).toBeNull();
		expect(resolveToolReason("calendar", "stopped").key).toBe(
			"toolRows.shared.stopped",
		);
	});

	it("keeps the words of a picture and a clip where they already live", () => {
		expect(resolveToolReason("make_image", "explicit_request")).toEqual({
			code: "explicit_request",
			kind: "stop",
			key: "toolActivity.pictureReason.explicitRequest",
		});
		expect(resolveToolReason("make_image", "image_unchecked").kind).toBe(
			"fail",
		);
		expect(resolveToolReason("make_image", "image_render_timeout").key).toBe(
			"toolActivity.pictureReason.renderTimeout",
		);
		expect(resolveToolReason("make_image", "image_unreadable").key).toBe(
			"toolActivity.pictureReason.unreadable",
		);
		expect(resolveToolReason("make_video", "video_blocked").key).toBe(
			"artifacts.video.card.blockedDetail",
		);
		expect(
			resolveToolReason("make_video", "video_server_unreachable").key,
		).toBe("artifacts.video.card.unavailable");
		expect(resolveToolReason("atlas", "atlas_pipeline_failed").key).toBe(
			"atlas.failed",
		);
		// An Atlas stopped by the person keeps the row's own cancelled state.
		expect(resolveToolReason("atlas", "cancelled")).toEqual({
			code: "cancelled",
			kind: "stop",
			key: null,
		});
	});

	it("says a changed Document, Canvas, App or Slides by its own kind, and any other generically", () => {
		const generic = resolveToolReason("edit_artifact", "changed_since_read");
		expect(generic.key).toBe("toolRows.edit_artifact.changed_since_read");
		for (const kind of ["document", "canvas", "app", "slides"]) {
			expect(
				resolveToolReason("edit_artifact", "changed_since_read", {
					artifactKind: kind,
				}).key,
			).toBe(`toolRows.edit_artifact.changed_since_read.${kind}`);
		}
		expect(
			resolveToolReason("edit_artifact", "changed_since_read", {
				artifactKind: "file",
			}).key,
		).toBe("toolRows.edit_artifact.changed_since_read");
		// The kind changes nothing for any other code or tool.
		expect(
			resolveToolReason("edit_artifact", "rebuild_limit_reached", {
				artifactKind: "app",
			}).key,
		).toBe("toolRows.edit_artifact.rebuild_limit_reached");
	});

	it("the account tools say their own account's name, in both languages", () => {
		uiLanguage.set("en");
		const en = get(t);
		expect(
			en(resolveToolReason("calendar", "not_connected").key as I18nKey),
		).toBe(
			"Calendar isn't connected yet. You can connect it in Settings › Connections.",
		);
		expect(en(resolveToolReason("tasks", "not_connected").key as I18nKey)).toBe(
			"Tasks aren't connected yet. You can connect them in Settings › Connections.",
		);
		uiLanguage.set("hu");
		const hu = get(t);
		expect(
			hu(resolveToolReason("calendar", "not_connected").key as I18nKey),
		).toBe(
			"A naptár még nincs csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod.",
		);
		expect(
			hu(resolveToolReason("contacts", "needs_reconnect").key as I18nKey),
		).toBe(
			"A névjegyeket újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		);
		// The nine are told apart: no two tools share a sentence for a code that
		// names the account, so a "calendar" never reads in an email's row.
		const sentences = new Set(
			[
				"calendar",
				"contacts",
				"email",
				"files",
				"location",
				"media",
				"photos",
				"repos",
				"tasks",
			].map((tool) =>
				hu(resolveToolReason(tool, "not_connected").key as I18nKey),
			),
		);
		expect(sentences.size).toBe(9);
	});

	it("names the place a route could not find, from the person's own words", () => {
		uiLanguage.set("en");
		expect(
			get(t)(resolveToolReason("map_route", "place_not_found").key as I18nKey, {
				place: "Fő utca 99",
			}),
		).toBe("Alfy couldn't find “Fő utca 99” on the map.");
		uiLanguage.set("hu");
		expect(
			get(t)(resolveToolReason("map_route", "place_not_found").key as I18nKey, {
				place: "Fő utca 99",
			}),
		).toBe("Alfy nem találta meg a térképen: „Fő utca 99”.");
	});

	describe("readReasonCode", () => {
		it("reads the shared field first, and nothing when there is none", () => {
			expect(
				readReasonCode("research_web", { reasonCode: "nothing_found" }),
			).toBe("nothing_found");
			expect(readReasonCode("research_web", {})).toBeNull();
			expect(readReasonCode("research_web", undefined)).toBeNull();
			expect(readReasonCode("research_web", { reasonCode: "" })).toBeNull();
			expect(readReasonCode("research_web", { reasonCode: 7 })).toBeNull();
		});

		it("reads the older keys a picture, a clip and a suggestion keep their code in", () => {
			expect(readReasonCode("make_image", { imageStopped: true })).toBe(
				"stopped",
			);
			expect(readReasonCode("make_video", { videoStopped: true })).toBe(
				"stopped",
			);
			expect(
				readReasonCode("make_image", {
					imageRefusal: "explicit_request",
					imageUnreadable: true,
				}),
			).toBe("image_unreadable");
			expect(
				readReasonCode("make_image", { imageRefusal: "explicit_request" }),
			).toBe("explicit_request");
			expect(
				readReasonCode("make_image", { imageError: "image_render_failed" }),
			).toBe("image_render_failed");
			expect(
				readReasonCode("make_video", { videoError: "video_blocked" }),
			).toBe("video_blocked");
			expect(
				readReasonCode("suggest_instruction", { reason: "already_offered" }),
			).toBe("already_offered");
		});

		it("lets a Stop and a deadline win over a code the tool wrote itself", () => {
			expect(
				readReasonCode("make_image", {
					reasonCode: "stopped",
					imageError: "image_error",
				}),
			).toBe("stopped");
			expect(
				readReasonCode("make_video", {
					reasonCode: "out_of_time",
					videoError: "video_error",
				}),
			).toBe("out_of_time");
			// A tool's own code beats the shared timeout.
			expect(
				readReasonCode("make_image", {
					reasonCode: "timed_out",
					imageError: "image_tool_timeout",
				}),
			).toBe("image_tool_timeout");
		});

		it("says the details stayed local for an account call a local model summarised", () => {
			expect(readReasonCode("calendar", { localDistilled: true })).toBe(
				"details_kept_local",
			);
			expect(
				readReasonCode("calendar", {
					localDistilled: true,
					reasonCode: "details_withheld",
				}),
			).toBe("details_withheld");
			// The flag means nothing for a tool that is no account.
			expect(
				readReasonCode("research_web", { localDistilled: true }),
			).toBeNull();
		});

		it("never reads a stored stream bucket as a cause", () => {
			expect(
				readReasonCode("research_web", {
					ok: false,
					error: "request timed out",
					errorCode: "timeout",
				}),
			).toBeNull();
			expect(readReasonCode("fetch_url", { errorCode: "timeout" })).toBeNull();
		});
	});

	// The file maker's own codes are worded by the file card's map
	// (`components/chat/file-production-helpers.ts`). They are open strings spread
	// over the file maker's files, so this reads them from the source: the scan
	// must find every code the plan names that those files spell, and every code it
	// finds must have words, so a new code cannot ship without its sentence.
	describe("the file maker's every code has words", () => {
		const root = process.cwd();
		const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

		function sourceFiles(dir: string): string[] {
			return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					return entry.name === "testing" ? [] : sourceFiles(path);
				}
				return entry.name.endsWith(".ts") &&
					!entry.name.endsWith(".test.ts") &&
					!entry.name.endsWith(".d.ts")
					? [path]
					: [];
			});
		}

		/** The string a value is, or the two it is when it is chosen by a condition. */
		function valuesOf(node: ts.Node): string[] {
			if (ts.isStringLiteralLike(node)) return [node.text];
			if (ts.isConditionalExpression(node)) {
				return [...valuesOf(node.whenTrue), ...valuesOf(node.whenFalse)];
			}
			if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
				return valuesOf(node.expression);
			}
			return [];
		}

		function stringsIn(node: ts.Node): string[] {
			if (ts.isStringLiteralLike(node)) return [node.text];
			const found: string[] = [];
			ts.forEachChild(node, (child) => {
				found.push(...stringsIn(child));
			});
			return found;
		}

		/**
		 * The codes a file maker's file spells: a `code:` or `errorCode:` property, a
		 * `*_ERROR_CODE` constant or a `*_ERROR_CODES` list, and the code a
		 * `fail("…", …)` helper or a `new …Error("…", …)` takes first.
		 */
		function codesSpelledIn(files: string[]): Set<string> {
			const codes = new Set<string>();
			for (const file of files) {
				const source = ts.createSourceFile(
					file,
					readFileSync(file, "utf8"),
					ts.ScriptTarget.Latest,
					true,
				);
				const visit = (node: ts.Node) => {
					if (
						ts.isPropertyAssignment(node) &&
						/^(?:code|errorCode)$/.test(node.name.getText(source))
					) {
						for (const value of valuesOf(node.initializer)) codes.add(value);
					}
					if (
						ts.isVariableDeclaration(node) &&
						node.initializer &&
						/_ERROR_CODES?$/.test(node.name.getText(source))
					) {
						for (const value of stringsIn(node.initializer)) codes.add(value);
					}
					if (
						(ts.isCallExpression(node) || ts.isNewExpression(node)) &&
						node.arguments?.[0] &&
						ts.isStringLiteralLike(node.arguments[0]) &&
						/(?:^fail|Error)$/.test(node.expression.getText(source))
					) {
						codes.add(node.arguments[0].text);
					}
					ts.forEachChild(node, visit);
				};
				visit(source);
			}
			return new Set([...codes].filter((code) => CODE_SHAPE.test(code)));
		}

		const scanned = () =>
			codesSpelledIn([
				...sourceFiles(join(root, "src/lib/server/services/file-production")),
				join(root, "src/lib/server/services/normal-chat-tools/produce-file.ts"),
			]);

		// Every code the plan names that the file maker's own files and the tool's
		// helper file spell.
		const NAMED_BY_THE_PLAN = [
			// limits.ts
			"too_many_outputs",
			"source_too_large",
			"projection_too_large",
			"page_limit_exceeded",
			"table_limit_exceeded",
			"chart_limit_exceeded",
			"image_limit_exceeded",
			"renderer_timeout",
			"sandbox_timeout",
			"output_file_too_large",
			"job_outputs_too_large",
			// execution-adapter.ts
			"missing_file_production_request",
			"invalid_file_production_request",
			"unsupported_file_production_request",
			"unsupported_output_type",
			"missing_program_requested_outputs",
			"program_execution_threw",
			"program_execution_failed",
			"generated_document_source_persistence_failed",
			"document_render_failed",
			"inline_text_write_failed",
			// storage-adapter.ts
			"program_no_outputs",
			"program_output_storage_failed",
			// intake.ts
			"invalid_inline_text_request",
			"missing_inline_text_content",
			"unsupported_inline_text_output_type",
			"invalid_json_body",
			"missing_conversation_id",
			"missing_idempotency_key",
			"missing_request_title",
			"unsupported_source_mode",
			"invalid_program_language",
			"missing_program_source",
			"missing_program_output_type",
			"unsupported_program_output_type",
			// source-schema.ts
			"invalid_document_source",
			"unsupported_document_block",
			"unsupported_table_structure",
			"unsupported_chart_type",
			"unsupported_chart_data",
			// the renderers and render-budget.ts
			"pdf_font_missing",
			"unsupported_pdf_block",
			"render_cancelled",
			// lost-attempt.ts, production-job.ts
			"worker_state_lost",
			"worker_heartbeat_timeout",
			"worker_queue_timeout",
			// produce-file.ts
			"invalid_tool_input",
			"no_previous_version_for_patches",
			"patch_failed",
			"produce_file_turn_retry_limit",
			"produce_file_turn_limit",
		];

		it("finds every code the plan names in the file maker's own files", () => {
			const found = scanned();
			expect(found.size).toBeGreaterThan(NAMED_BY_THE_PLAN.length);
			for (const code of NAMED_BY_THE_PLAN) {
				expect(found.has(code), `${code} was not found`).toBe(true);
			}
		});

		it("has words, on the file card, for every code the file maker writes", () => {
			for (const code of scanned()) {
				expect(
					Object.hasOwn(FILE_PRODUCTION_ERROR_KEYS, code),
					`${code} has no words on the file card`,
				).toBe(true);
			}
		});

		it("has words for the tool's own codes and the card's", () => {
			// The tool's other codes sit in `normal-chat-tools/index.ts`, which also
			// carries other tools' codes, so they are named here and checked there.
			const tool = readFileSync(
				join(root, "src/lib/server/services/normal-chat-tools/index.ts"),
				"utf8",
			);
			for (const code of [
				"patch_not_applicable",
				"file_production_no_output_files",
				"tool_execution_failed",
			]) {
				expect(tool, `${code} is no longer spelled by the tool`).toContain(
					`"${code}"`,
				);
				expect(
					Object.hasOwn(FILE_PRODUCTION_ERROR_KEYS, code),
					`${code} has no words on the file card`,
				).toBe(true);
			}
			// A card made before any job exists (a tool call that failed early).
			expect(Object.hasOwn(FILE_PRODUCTION_ERROR_KEYS, "tool_failed")).toBe(
				true,
			);
		});
	});
});
