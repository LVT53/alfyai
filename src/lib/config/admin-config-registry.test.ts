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
	SURFACED_ADMIN_CONFIG_KEYS,
	toDisplayNumber,
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
		expect(ADVANCED_KEY_SPECS.length).toBeGreaterThanOrEqual(83);
	});
});

describe("restart-vs-live map", () => {
	it("marks scheduler-read keys as next run, not live", () => {
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.MEMORY_JUDGE_IDLE_MINUTES).toBe(
			"next-run",
		);
		expect(
			ADMIN_CONFIG_EFFECT_BY_KEY.MEMORY_CONSOLIDATION_INTERVAL_MINUTES,
		).toBe("next-run");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.MEMORY_MAINTENANCE_INTERVAL_MINUTES).toBe(
			"next-run",
		);
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.ROUTING_REGION_IDLE_MINUTES).toBe(
			"next-run",
		);
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.ROUTING_GTFS_REFRESH_DAYS).toBe(
			"next-run",
		);
	});

	it("marks per-call keys as live", () => {
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.TEI_TIMEOUT_MS).toBe("live");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.CONCURRENT_STREAM_LIMIT).toBe("live");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.FILE_PRODUCTION_MAX_OUTPUTS).toBe("live");
		expect(ADMIN_CONFIG_EFFECT_BY_KEY.ATLAS_V2_WRITER_CONCURRENCY).toBe("live");
	});

	it("claims no surfaced key needs a restart", () => {
		// Keys that would need one are deliberately kept environment-only, so a
		// "restart" badge appearing here means a key was promoted by mistake.
		expect(
			ADVANCED_KEY_SPECS.filter((entry) => entry.effect === "restart"),
		).toEqual([]);
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
			validateAdminConfigValue(spec("MEMORY_JUDGE_DRY_RUN"), "anything"),
		).toEqual({ ok: true, value: "false" });
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
