import { describe, expect, it } from "vitest";
import settingsDict from "$lib/i18n/settings";
import { ADMIN_CONFIG_KEYS } from "$lib/server/config-store";
import {
	ADMIN_CONFIG_EFFECT_BY_KEY,
	ADVANCED_GROUP_ORDER,
	ADVANCED_KEY_SPECS,
	type AdminConfigKeySpec,
	advancedKeysInGroup,
	fromDisplayNumber,
	isUnwiredAdminConfigKey,
	SURFACED_ADMIN_CONFIG_KEYS,
	toDisplayNumber,
	UNWIRED_ADMIN_CONFIG_KEYS,
	validateAdminConfigValue,
} from "./admin-config-registry";

function spec(key: string): AdminConfigKeySpec {
	const found = ADVANCED_KEY_SPECS.find((entry) => entry.key === key);
	if (!found) throw new Error(`no spec for ${key}`);
	return found;
}

describe("advanced key registry", () => {
	it("only lists keys an admin is allowed to write", () => {
		const writable = new Set<string>(ADMIN_CONFIG_KEYS);
		const notWritable = ADVANCED_KEY_SPECS.map((entry) => entry.key).filter(
			(key) => !writable.has(key),
		);

		expect(notWritable).toEqual([]);
	});

	it("has no duplicate keys", () => {
		const keys = ADVANCED_KEY_SPECS.map((entry) => entry.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("puts every key in a group that is rendered", () => {
		const rendered = new Set<string>(ADVANCED_GROUP_ORDER);
		for (const entry of ADVANCED_KEY_SPECS) {
			expect(rendered.has(entry.group), entry.key).toBe(true);
		}
		expect(
			ADVANCED_GROUP_ORDER.flatMap((group) => advancedKeysInGroup(group))
				.length,
		).toBe(ADVANCED_KEY_SPECS.length);
	});

	it("translates a label and a meaning for every key, in both languages", () => {
		for (const entry of ADVANCED_KEY_SPECS) {
			for (const suffix of ["label", "meaning"] as const) {
				const key = `admin.system.keys.${entry.key}.${suffix}`;
				expect(
					settingsDict.en[key as keyof typeof settingsDict.en],
					`en ${key}`,
				).toBeTruthy();
				expect(
					settingsDict.hu[key as keyof typeof settingsDict.hu],
					`hu ${key}`,
				).toBeTruthy();
			}
		}
	});

	it("counts the keys the Advanced page promises", () => {
		// The redesign's premise: the settings that used to be env-only are all
		// reachable here. A drop in this number means a key silently lost its UI.
		// 84 before the document-extraction ledger, + its 11 keys = 95,
		// + the 12 MinerU 4 keys = 107, + FILE_PRODUCTION_WORKER_ENABLED = 108.
		expect(ADVANCED_KEY_SPECS.length).toBeGreaterThanOrEqual(108);
	});
});

describe("restart-vs-live map", () => {
	it("marks keys a scheduler re-reads per tick as next run, not live", () => {
		// These three resolve the value when the next sweep is scheduled.
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.MEMORY_JUDGE_IDLE_MINUTES).toBe(
			"next-run",
		);
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.ROUTING_REGION_IDLE_MINUTES).toBe(
			"next-run",
		);
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.ROUTING_GTFS_REFRESH_DAYS).toBe(
			"next-run",
		);
	});

	it("marks the two createIntervalJob periods as restart, not next run", () => {
		// `interval-job.ts` resolves the period inside `start()` and arms one
		// `setInterval` with it; the getter never runs again, and refreshConfig()
		// does not restart the job. Calling these "next run" would be a lie.
		expect(
			ADMIN_CONFIG_EFFECT_BY_KEY.MEMORY_CONSOLIDATION_INTERVAL_MINUTES,
		).toBe("restart");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.MEMORY_MAINTENANCE_INTERVAL_MINUTES).toBe(
			"restart",
		);
	});

	it("marks per-call keys as live", () => {
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.TEI_TIMEOUT_MS).toBe("live");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.CONCURRENT_STREAM_LIMIT).toBe("live");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.FILE_PRODUCTION_MAX_OUTPUTS).toBe("live");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.ATLAS_V2_WRITER_CONCURRENCY).toBe("live");
	});

	it("keeps the restart badge to the keys that genuinely need one", () => {
		// A key drifting into this list means its consumer stopped reading the
		// value per call; a key dropping out means it started.
		expect(
			ADVANCED_KEY_SPECS.filter((entry) => entry.effect === "restart").map(
				(entry) => entry.key,
			),
		).toEqual([
			"MEMORY_CONSOLIDATION_INTERVAL_MINUTES",
			"MEMORY_MAINTENANCE_INTERVAL_MINUTES",
		]);
	});
});

describe("validateAdminConfigValue", () => {
	it("treats the empty string as a reset, never as an error", () => {
		expect(
			validateAdminConfigValue(spec("FILE_PRODUCTION_MAX_OUTPUTS"), "  "),
		).toEqual({ ok: true, value: "" });
	});

	it("rejects a non-integer for an integer key", () => {
		expect(
			validateAdminConfigValue(spec("FILE_PRODUCTION_MAX_OUTPUTS"), "3.5"),
		).toEqual({ ok: false, reason: "not-a-number" });
	});

	it("reports the bound it broke", () => {
		expect(
			validateAdminConfigValue(spec("ATLAS_V2_ENTAILMENT_BATCH"), "0"),
		).toEqual({ ok: false, reason: "below-min", limit: 1 });
		expect(
			validateAdminConfigValue(spec("ATLAS_V2_ENTAILMENT_BATCH"), "26"),
		).toEqual({ ok: false, reason: "above-max", limit: 25 });
	});

	it("accepts every pipeline the server accepts, and nothing else", () => {
		for (const value of ["v1", "v2", "v3"]) {
			expect(validateAdminConfigValue(spec("ATLAS_PIPELINE"), value)).toEqual({
				ok: true,
				value,
			});
		}
		expect(validateAdminConfigValue(spec("ATLAS_PIPELINE"), "v4")).toEqual({
			ok: false,
			reason: "invalid-option",
		});
	});

	it("normalises a boolean to the two strings the applier reads", () => {
		expect(
			validateAdminConfigValue(spec("MEMORY_JUDGE_DRY_RUN"), "true"),
		).toEqual({ ok: true, value: "true" });
		expect(
			validateAdminConfigValue(spec("MEMORY_JUDGE_DRY_RUN"), "  TRUE "),
		).toEqual({ ok: true, value: "true" });
		// The applier for NORMAL_CHAT_DEBUG_OUTBOUND reads "1" as on, matching
		// how env.ts reads the environment variable.
		expect(
			validateAdminConfigValue(spec("NORMAL_CHAT_DEBUG_OUTBOUND"), "1"),
		).toEqual({ ok: true, value: "true" });
		expect(validateAdminConfigValue(spec("MEMORY_JUDGE_DRY_RUN"), "0")).toEqual(
			{ ok: true, value: "false" },
		);
	});

	it("refuses a word that is neither on nor off, instead of reading it as off", () => {
		expect(
			validateAdminConfigValue(spec("MEMORY_JUDGE_DRY_RUN"), "anything"),
		).toEqual({ ok: false, reason: "invalid-option" });
	});
});

describe("scaled units", () => {
	it("round-trips megabytes without drifting", () => {
		const byteSpec = spec("FILE_PRODUCTION_MAX_IMAGE_BYTES");
		expect(toDisplayNumber(byteSpec, "26214400")).toBe("25");
		expect(fromDisplayNumber(byteSpec, "25")).toBe("26214400");
	});

	it("round-trips seconds without drifting", () => {
		const msSpec = spec("FILE_PRODUCTION_SANDBOX_TIMEOUT_MS");
		expect(toDisplayNumber(msSpec, "300000")).toBe("300");
		expect(fromDisplayNumber(msSpec, "300")).toBe("300000");
	});

	it("leaves unscaled and non-numeric values alone", () => {
		const plain = spec("TEI_EMBEDDER_BATCH_SIZE");
		expect(toDisplayNumber(plain, "8")).toBe("8");
		expect(fromDisplayNumber(plain, "8")).toBe("8");
		expect(fromDisplayNumber(spec("FILE_PRODUCTION_MAX_IMAGE_BYTES"), "")).toBe(
			"",
		);
	});
});

describe("surfaced keys", () => {
	it("includes every advanced key", () => {
		for (const entry of ADVANCED_KEY_SPECS) {
			expect(SURFACED_ADMIN_CONFIG_KEYS.has(entry.key), entry.key).toBe(true);
		}
	});

	it("never claims a key is surfaced that admins cannot write", () => {
		const writable = new Set<string>(ADMIN_CONFIG_KEYS);
		for (const key of SURFACED_ADMIN_CONFIG_KEYS) {
			expect(writable.has(key), key).toBe(true);
		}
	});
});

describe("url controls and unwired keys", () => {
	it("accepts only absolute http(s) URLs", () => {
		const spec = ADVANCED_KEY_SPECS.find(
			(entry) => entry.control.kind === "url",
		);
		if (!spec) throw new Error("expected a url control in the registry");
		expect(
			validateAdminConfigValue(spec, "https://owntracks.example/pub"),
		).toEqual({ ok: true, value: "https://owntracks.example/pub" });
		expect(validateAdminConfigValue(spec, "ftp://owntracks.example")).toEqual({
			ok: false,
			reason: "invalid-url",
		});
		expect(validateAdminConfigValue(spec, "not a url")).toEqual({
			ok: false,
			reason: "invalid-url",
		});
		expect(validateAdminConfigValue(spec, "")).toEqual({ ok: true, value: "" });
	});

	it("labels the keys no consumer reads yet as unwired, not live", () => {
		for (const key of [
			"TEI_RERANKER_MODEL",
			"FILE_PRODUCTION_SANDBOX_TIMEOUT_MS",
			"WORKING_SET_DOCUMENT_TOKEN_BUDGET",
			"WORKING_SET_PROMPT_TOKEN_BUDGET",
		]) {
			expect(
				ADVANCED_KEY_SPECS.find((entry) => entry.key === key)?.effect,
				key,
			).toBe("unwired");
		}
	});
});

// `effect: "unwired"` used to be a caption. It is now the switch that makes a
// row read-only, keeps it out of the save payload and makes the API refuse it,
// so the set has to be derivable from the registry rather than re-typed in
// three places.
describe("the inert set", () => {
	const EXPECTED = [
		"FILE_PRODUCTION_SANDBOX_TIMEOUT_MS",
		"TEI_RERANKER_MODEL",
		"WORKING_SET_DOCUMENT_TOKEN_BUDGET",
		"WORKING_SET_PROMPT_TOKEN_BUDGET",
	];

	it("is exactly the keys the registry marks unwired", () => {
		expect([...UNWIRED_ADMIN_CONFIG_KEYS].sort()).toEqual(EXPECTED);
		// Wiring one up means changing its `effect`, and this list, together —
		// which is the point: the set cannot drift from the label.
		for (const spec of ADVANCED_KEY_SPECS) {
			expect(isUnwiredAdminConfigKey(spec.key), spec.key).toBe(
				spec.effect === "unwired",
			);
		}
	});

	it("says no for a key that is wired, and for one that does not exist", () => {
		expect(isUnwiredAdminConfigKey("TEI_TIMEOUT_MS")).toBe(false);
		expect(isUnwiredAdminConfigKey("NOT_A_KEY")).toBe(false);
		expect(isUnwiredAdminConfigKey("")).toBe(false);
	});

	it("holds no secret control, which AdvancedRow cannot disable", () => {
		// SecretField takes no `disabled` prop, so an unwired secret would
		// render an editable Replace button under a "not connected" note.
		// Whoever adds one hits this instead of shipping that.
		for (const spec of ADVANCED_KEY_SPECS) {
			if (spec.effect !== "unwired") continue;
			expect(spec.control.kind, spec.key).not.toBe("secret");
		}
	});

	it("still gives every inert key a label, a meaning and a note", () => {
		// The row stays visible on purpose — an admin searching for the key
		// should find it and read why it does nothing — so its copy has to
		// exist in both languages like any other row.
		for (const key of UNWIRED_ADMIN_CONFIG_KEYS) {
			const label = `admin.system.keys.${key}.label`;
			const meaning = `admin.system.keys.${key}.meaning`;
			expect(
				settingsDict.en[label as keyof typeof settingsDict.en],
				label,
			).toBeTruthy();
			expect(
				settingsDict.hu[meaning as keyof typeof settingsDict.hu],
				meaning,
			).toBeTruthy();
		}
		expect(settingsDict.en["admin.system.effect.unwiredNote"]).toBeTruthy();
		expect(settingsDict.hu["admin.system.effect.unwiredNote"]).toBeTruthy();
		expect(settingsDict.en["admin.system.advanced.unwiredCount"]).toContain(
			"{count}",
		);
		expect(settingsDict.hu["admin.system.advanced.unwiredCount"]).toContain(
			"{count}",
		);
	});
});
