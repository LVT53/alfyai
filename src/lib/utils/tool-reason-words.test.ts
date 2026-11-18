import { readFileSync } from "node:fs";
import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { type I18nKey, t } from "$lib/i18n";
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
import {
	readReasonCode,
	resolveToolReason,
	TOOL_REASON_WORDS,
	toolReasonKeys,
} from "./tool-reason-words";

const CATALOGUE_SNAPSHOT = `${process.cwd()}/src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt`;

/** The names of the tools the model is offered, in the order its request sends them. */
function catalogueToolNames(): string[] {
	const snapshot = readFileSync(CATALOGUE_SNAPSHOT, "utf8");
	return [...snapshot.matchAll(/^ {6}"name": "([a-z_]+)"/gm)].map(
		(match) => match[1],
	);
}

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
			"read_only_account",
			"not_supported",
			"not_set_up",
			"no_such_account",
			"not_connected",
			"skill_turned_off",
			"skill_not_found",
			"memory_off",
			"chat_out_of_reach",
			"link_not_from_a_source",
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

	// The file maker's own codes are worded by the file card's map (Task B7), which
	// is where this test becomes real.
	it.todo("the file maker's every code has words");
});
