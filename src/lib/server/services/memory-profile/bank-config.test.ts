import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	PERSONAL_MEMORY_SUBJECTS,
	PROJECT_MEMORY_SUBJECTS,
} from "$lib/memory-types";
import {
	CURRENT_NATIVE_BANK_CONFIGS,
	HINDSIGHT_ENGINE_COMMIT,
	isVerifiedNativeBankConfigVersion,
	KNOWN_NATIVE_BANK_CONFIGS,
	NATIVE_BANK_CONFIG_2_VERSION,
	NATIVE_BANK_CONFIG_LEGACY_UNKNOWN,
	NATIVE_BANK_CONFIG_PENDING,
	NATIVE_BANK_CONFIG_VERSION,
	nativeBankConfig,
	nativeBankConfig2,
	nativeBankConfig2ForScopeKey,
	nativeBankConfigForScopeKey,
	PREVIOUS_NATIVE_BANK_CONFIG,
} from "./contracts";
import { HindsightClient } from "./hindsight-client";

function clientAnswering(config: unknown) {
	const fetcher = vi.fn<typeof fetch>(async (url) => {
		if (String(url).endsWith("/config")) return Response.json({ config });
		if (String(url).includes("/memories/list")) return Response.json(config);
		return new Response("unexpected", { status: 500 });
	});
	return {
		fetcher,
		client: new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher,
		}),
	};
}

/** The same value with every object's keys in reverse order, as Postgres JSONB may return them. */
function reordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reordered);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.reverse()
				.map(([k, v]) => [k, reordered(v)]),
		);
	return value;
}

function labelGroup(config: unknown, key: string) {
	const labels = (config as { entity_labels: Array<Record<string, unknown>> })
		.entity_labels;
	return labels.find((group) => group.key === key) as {
		key: string;
		type: string;
		tag: boolean;
		optional: boolean;
		description: string;
		values: Array<{ value: string; description: string }>;
	};
}

describe("bank configuration 2, kept for banks that still hold it", () => {
	it("keeps config 2 word for word, as the release before config 3 set it", () => {
		const recorded = JSON.parse(
			readFileSync(
				resolve(
					process.cwd(),
					"docs/plans/hindsight-memory/part-2-acceptance/bank-config-2.json",
				),
				"utf8",
			),
		);
		expect(nativeBankConfig2("personal")).toEqual(recorded.personal);
		expect(nativeBankConfig2("project")).toEqual(recorded.project);
	});

	it("keeps the first release's config byte for byte", () => {
		const recorded = JSON.parse(
			readFileSync(
				resolve(
					process.cwd(),
					"docs/plans/hindsight-memory/native-acceptance/bank-config.json",
				),
				"utf8",
			),
		);
		expect(PREVIOUS_NATIVE_BANK_CONFIG).toEqual(recorded);
	});

	it("adds the new mission sentences and keeps the correction rule", () => {
		for (const kind of ["personal", "project"] as const) {
			const config = nativeBankConfig2(kind);
			expect(config.retain_mission).toContain(
				PREVIOUS_NATIVE_BANK_CONFIG.retain_mission,
			);
			expect(config.retain_mission).toMatch(
				/requests to the assistant and what the user wants from this chat are not memories/i,
			);
			expect(config.retain_mission).toMatch(
				/the options, the user's reactions to them and the reasons for those reactions are not memories/i,
			);
			expect(config.retain_mission).toMatch(
				/when the choice settles, keep only its outcome/i,
			);
			expect(config.observations_mission).toContain(
				"For a correction, state only the corrected information; do not narrate earlier erroneous or superseded values or invent a real-world change.",
			);
			expect(config.observations_mission).toMatch(
				/settles an earlier wish or plan/i,
			);
			expect(config.observations_mission).toMatch(/never write an end date/i);
		}
	});

	it("labels kind and subject inside extraction, as tags, with the bank's own subjects", () => {
		for (const [scopeKey, subjects] of [
			["personal", PERSONAL_MEMORY_SUBJECTS],
			["project:9b1d0c4e-0d55-4a0b-a1d4-2b0c4a6f8e11", PROJECT_MEMORY_SUBJECTS],
		] as const) {
			const config = nativeBankConfig2ForScopeKey(scopeKey);
			const kind = labelGroup(config, "kind");
			const subject = labelGroup(config, "subject");
			for (const group of [kind, subject]) {
				expect(group).toMatchObject({
					type: "value",
					tag: true,
					optional: true,
				});
				expect(group.description.length).toBeGreaterThan(20);
				for (const value of group.values)
					expect(value.description.length).toBeGreaterThan(10);
			}
			expect(kind.values.map((v) => v.value)).toEqual([
				"lasting",
				"ongoing",
				"temporary",
			]);
			expect(kind.description).toMatch(/when unsure.*lasting/i);
			// Named entities stay on: labels come in addition to them.
			expect(config.entities_allow_free_form).toBe(true);
			expect(subject.values.map((v) => v.value)).toEqual([...subjects]);
		}
	});

	it("writes only ASCII English for the model and names no language", () => {
		const words = (value: unknown): string[] =>
			typeof value === "string"
				? [value]
				: Array.isArray(value)
					? value.flatMap(words)
					: value && typeof value === "object"
						? Object.values(value).flatMap(words)
						: [];
		for (const config of [
			...CURRENT_NATIVE_BANK_CONFIGS,
			nativeBankConfig2("personal"),
			nativeBankConfig2("project"),
		])
			for (const text of words(config)) {
				expect(text).toMatch(/^[\x20-\x7e]*$/);
				expect(text).not.toMatch(/hungarian|english|magyar|angol/i);
			}
	});
});

describe("bank configuration 3", () => {
	it("keeps config 2's missions and adds one rule about how the assistant should answer", () => {
		for (const kind of ["personal", "project"] as const) {
			const config = nativeBankConfig(kind);
			const before = nativeBankConfig2(kind);
			expect(config.observations_mission).toBe(before.observations_mission);
			expect(config.retain_mission).toContain(
				PREVIOUS_NATIVE_BANK_CONFIG.retain_mission,
			);
			// Config 2's rules about requests, brainstorms and outcomes stay.
			expect(config.retain_mission).toMatch(
				/requests to the assistant and what the user wants from this chat are not memories/i,
			);
			expect(config.retain_mission).toMatch(
				/the options, the user's reactions to them and the reasons for those reactions are not memories/i,
			);
			expect(config.retain_mission).toMatch(
				/when the choice settles, keep only its outcome/i,
			);
			// The new rule: a stated preference about how to answer is a lasting
			// memory even as a plain request; one piece of work is not.
			expect(config.retain_mission).toMatch(
				/preference about how the assistant should answer/i,
			);
			expect(config.retain_mission).toMatch(
				/length, format, language or tone/i,
			);
			expect(config.retain_mission).toMatch(
				/even when it is phrased as a request/i,
			);
			expect(config.retain_mission).toMatch(/one particular piece of work/i);
			expect(config.retain_mission).not.toBe(before.retain_mission);
		}
	});

	it("words kind so that something bought, got or owned is lasting and only a passing event is temporary", () => {
		for (const kind of ["personal", "project"] as const) {
			const group = labelGroup(nativeBankConfig(kind), "kind");
			const words = Object.fromEntries(
				group.values.map((v) => [v.value, v.description]),
			);
			expect(words.lasting).toMatch(/possessions/i);
			expect(words.lasting).toMatch(/bought/i);
			expect(words.lasting).toMatch(/got|given/i);
			expect(words.lasting).toMatch(/phone/i);
			expect(words.lasting).toMatch(/how they like the assistant to answer/i);
			expect(words.temporary).toMatch(
				/buying, getting or selling something is not/i,
			);
			expect(words.temporary).toMatch(/so it is lasting/i);
			// Config 2's list of passing events stays.
			for (const event of ["an exam", "a trip", "an appointment", "a deadline"])
				expect(words.temporary).toContain(event);
			expect(group.description).toMatch(/when unsure.*lasting/i);
			expect(words.lasting).not.toBe(
				labelGroup(nativeBankConfig2(kind), "kind").values[0].description,
			);
		}
	});

	it("labels kind and subject with the same subjects as config 2", () => {
		for (const kind of ["personal", "project"] as const) {
			const config = nativeBankConfig(kind);
			expect(labelGroup(config, "subject")).toEqual(
				labelGroup(nativeBankConfig2(kind), "subject"),
			);
			expect(config.entities_allow_free_form).toBe(true);
		}
		expect(
			labelGroup(nativeBankConfig("personal"), "kind").values,
		).toHaveLength(3);
	});

	it("stores its own version, and every stored version of a verified config is known", () => {
		expect(NATIVE_BANK_CONFIG_VERSION).toBe("alfyai-bank-config-3");
		expect(NATIVE_BANK_CONFIG_2_VERSION).toBe("alfyai-bank-config-2");
		for (const version of [
			HINDSIGHT_ENGINE_COMMIT,
			NATIVE_BANK_CONFIG_2_VERSION,
			NATIVE_BANK_CONFIG_VERSION,
		])
			expect(isVerifiedNativeBankConfigVersion(version)).toBe(true);
		for (const version of [
			NATIVE_BANK_CONFIG_PENDING,
			NATIVE_BANK_CONFIG_LEGACY_UNKNOWN,
			null,
			"",
			"alfyai-bank-config-4",
		])
			expect(isVerifiedNativeBankConfigVersion(version)).toBe(false);
	});

	it("is the current config; config 1, 2 and 3 are the ones a path that only verifies accepts", () => {
		expect(CURRENT_NATIVE_BANK_CONFIGS).toEqual([
			nativeBankConfig("personal"),
			nativeBankConfig("project"),
		]);
		expect(KNOWN_NATIVE_BANK_CONFIGS).toEqual([
			PREVIOUS_NATIVE_BANK_CONFIG,
			nativeBankConfig2("personal"),
			nativeBankConfig2("project"),
			...CURRENT_NATIVE_BANK_CONFIGS,
		]);
		expect(nativeBankConfigForScopeKey("personal")).toEqual(
			nativeBankConfig("personal"),
		);
		expect(nativeBankConfigForScopeKey("project:p1")).toEqual(
			nativeBankConfig("project"),
		);
	});
});

describe("native config verification", () => {
	it("compares array and object keys by value, whatever their key order", async () => {
		const project = nativeBankConfig("project");
		await expect(
			clientAnswering(reordered(project)).client.verifyConfig([project]),
		).resolves.toBeUndefined();
		const changed = structuredClone(project);
		changed.entity_labels[0].values[0].description += " Changed.";
		await expect(
			clientAnswering(changed).client.verifyConfig([project]),
		).rejects.toMatchObject({ code: "native_config_mismatch" });
		const missing = structuredClone(project);
		missing.entity_labels[1].values.pop();
		await expect(
			clientAnswering(missing).client.verifyConfig([project]),
		).rejects.toMatchObject({ code: "native_config_mismatch" });
	});

	it("accepts config 1, 2 and 3 where it only verifies, and each only as its own", async () => {
		for (const held of [
			PREVIOUS_NATIVE_BANK_CONFIG,
			nativeBankConfig2("personal"),
			nativeBankConfig2("project"),
			nativeBankConfig("personal"),
			nativeBankConfig("project"),
		])
			await expect(
				clientAnswering(held).client.verifyConfig(),
			).resolves.toBeUndefined();
		// A bank on config 1 or 2 is not config 3.
		for (const held of [
			PREVIOUS_NATIVE_BANK_CONFIG,
			nativeBankConfig2("personal"),
		])
			await expect(
				clientAnswering(held).client.verifyConfig(CURRENT_NATIVE_BANK_CONFIGS),
			).rejects.toMatchObject({ code: "native_config_mismatch" });
	});

	it("sends the config it is given", async () => {
		const project = nativeBankConfig("project");
		let live: unknown = {};
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			if (init?.method === "PATCH")
				live = JSON.parse(String(init.body)).updates;
			return Response.json({ config: live });
		});
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher,
		});
		await client.configure(project, async () => {});
		expect(live).toEqual(project);
	});
});

describe("native fact fields", () => {
	it("reads a fact's tags and event dates from the list", async () => {
		const page = {
			total: 1,
			offset: 0,
			items: [
				{
					id: "f",
					text: "The user has an exam on 14 January.",
					fact_type: "world",
					tags: ["kind:temporary", "subject:work_study"],
					occurred_start: "2027-01-14T09:00:00+00:00",
					occurred_end: null,
				},
			],
		};
		const [fact] = await clientAnswering(page).client.list();
		expect(fact).toMatchObject({
			tags: ["kind:temporary", "subject:work_study"],
			occurred_start: "2027-01-14T09:00:00+00:00",
			occurred_end: null,
		});
	});

	it("rejects a malformed tag list", async () => {
		const page = {
			total: 1,
			offset: 0,
			items: [{ id: "f", text: "x", fact_type: "world", tags: [3] }],
		};
		await expect(clientAnswering(page).client.list()).rejects.toMatchObject({
			code: "native_format_unsupported",
		});
	});
});

describe("rolling back to config 2", () => {
	function patching(initial: Record<string, unknown>) {
		let live = initial;
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			if (init?.method === "PATCH")
				live = { ...live, ...JSON.parse(String(init.body)).updates };
			return Response.json({ config: live });
		});
		return {
			fetcher,
			live: () => live,
			client: new HindsightClient({
				baseUrl: "http://native",
				apiKey: "key",
				bankId: "b",
				fetcher,
			}),
		};
	}

	it("puts a bank back on its own kind's config 2, verified by readback", async () => {
		const { restoreNativeBankConfig2 } = await import("./bank-configuration");
		for (const scopeKey of ["personal", "project:p1"]) {
			const bank = patching({ ...nativeBankConfigForScopeKey(scopeKey) });
			await restoreNativeBankConfig2(bank.client, scopeKey);
			const sent = JSON.parse(
				String(
					bank.fetcher.mock.calls.find(
						([, init]) => init?.method === "PATCH",
					)?.[1]?.body,
				),
			).updates;
			expect(sent).toEqual(nativeBankConfig2ForScopeKey(scopeKey));
			expect(bank.live()).toMatchObject(nativeBankConfig2ForScopeKey(scopeKey));
		}
	});

	it("refuses a bank whose readback is not config 2 afterwards", async () => {
		const { restoreNativeBankConfig2 } = await import("./bank-configuration");
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher: vi.fn<typeof fetch>(async () =>
				Response.json({ config: nativeBankConfig("personal") }),
			),
		});
		await expect(
			restoreNativeBankConfig2(client, "personal"),
		).rejects.toMatchObject({ code: "native_config_mismatch" });
	});
});

describe("rolling back to the previous release", () => {
	it("restores config 1 and clears the labels, verified by readback", async () => {
		const { restorePreviousNativeBankConfig } = await import(
			"./bank-configuration"
		);
		let live: Record<string, unknown> = { ...nativeBankConfig("project") };
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			if (init?.method === "PATCH") {
				const updates = JSON.parse(String(init.body)).updates;
				live = { ...live, ...updates };
			}
			return Response.json({ config: live });
		});
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher,
		});
		await restorePreviousNativeBankConfig(client);
		const sent = JSON.parse(
			String(
				fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]
					?.body,
			),
		).updates;
		expect(sent).toEqual({
			...PREVIOUS_NATIVE_BANK_CONFIG,
			entity_labels: null,
		});
		// The previous release compares config 1's keys one by one.
		for (const [key, value] of Object.entries(PREVIOUS_NATIVE_BANK_CONFIG))
			expect(live[key]).toBe(value);
		expect(live.entity_labels).toBeNull();
	});

	it("refuses a bank whose readback is not config 1 afterwards", async () => {
		const { restorePreviousNativeBankConfig } = await import(
			"./bank-configuration"
		);
		const client = new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId: "b",
			fetcher: vi.fn<typeof fetch>(async () =>
				Response.json({ config: nativeBankConfig("personal") }),
			),
		});
		await expect(restorePreviousNativeBankConfig(client)).rejects.toMatchObject(
			{
				code: "native_config_mismatch",
			},
		);
	});
});
