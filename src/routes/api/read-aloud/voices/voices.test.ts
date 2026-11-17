// @vitest-environment node
// The voice and preference routes (Plan 3, Task 4), through the real service
// over a real migrated SQLite file, so that a person's privacy is proven
// through the routes themselves. Only the signed-in user (on the event) and
// `getReadAloudUrl` are mocked. Made-up people: `user-a` and `user-b`.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
vi.mock("$lib/server/config-store", () => ({
	getReadAloudUrl: vi.fn(() => "http://127.0.0.1:1920"),
}));

import { getReadAloudUrl } from "$lib/server/config-store";
import { STYLES, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import { PUT } from "../preferences/+server";
import { GET, POST } from "./+server";
import { DELETE, PATCH } from "./[id]/+server";

const USER_A = "user-a";
const USER_B = "user-b";

const feature = getReadAloudUrl as ReturnType<typeof vi.fn>;

type Call = { user?: string | null; id?: string; body?: unknown; raw?: string };

function eventFor(method: string, call: Call = {}) {
	const user = call.user === undefined ? USER_A : call.user;
	const hasBody = call.body !== undefined || call.raw !== undefined;
	return {
		request: new Request("http://localhost/api/read-aloud/voices", {
			method,
			headers: hasBody ? { "content-type": "application/json" } : {},
			body: hasBody ? (call.raw ?? JSON.stringify(call.body)) : undefined,
		}),
		params: { id: call.id ?? "" },
		locals: { user: user ? { id: user, role: "user" } : undefined },
	} as never;
}

function bedtime() {
	const style = STYLES.find((candidate) => candidate.key === "bedtime");
	if (!style) throw new Error("no bedtime style");
	return { ...style.knobs };
}

async function makeVoice(
	userId: string,
	patch: Record<string, unknown> = {},
): Promise<{ id: string; [key: string]: unknown }> {
	const response = await POST(
		eventFor("POST", {
			user: userId,
			body: { name: "Test Voice", base: "imogen", knobs: ZERO_KNOBS, ...patch },
		}),
	);
	expect(response.status).toBe(201);
	return ((await response.json()) as { voice: { id: string } }).voice;
}

function voiceRow(id: string) {
	return sqlite.prepare("select * from read_aloud_voices where id = ?").get(id);
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-voice-routes-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	for (const userId of [USER_A, USER_B]) {
		sqlite
			.prepare(
				"insert into users (id, email, password_hash) values (?, ?, 'hash')",
			)
			.run(userId, `${userId}@example.com`);
	}
	feature.mockReturnValue("http://127.0.0.1:1920");
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

describe("every voice route", () => {
	const calls: Array<
		[string, (event: never) => Response | Promise<Response>, Call]
	> = [
		["GET /voices", (event) => GET(event), {}],
		[
			"POST /voices",
			(event) => POST(event),
			{ body: { name: "x", base: "imogen", knobs: ZERO_KNOBS } },
		],
		[
			"PATCH /voices/{id}",
			(event) => PATCH(event),
			{ id: "x", body: { name: "y" } },
		],
		["DELETE /voices/{id}", (event) => DELETE(event), { id: "x" }],
		[
			"PUT /preferences",
			(event) => PUT(event),
			{ body: { defaultSpeed: 1.5 } },
		],
	];
	const methodOf = (label: string) => label.split(" ")[0] as string;

	it("401 without a user; 404 read_aloud_off when the feature is off", async () => {
		for (const [label, handler, call] of calls) {
			await expect(
				handler(eventFor(methodOf(label), { ...call, user: null })),
				label,
			).rejects.toMatchObject({ status: 401 });
		}
		feature.mockReturnValue("");
		for (const [label, handler, call] of calls) {
			const response = await handler(eventFor(methodOf(label), call));
			expect(response.status, label).toBe(404);
			expect(await response.json(), label).toEqual({ error: "read_aloud_off" });
		}
		expect(
			sqlite.prepare("select count(*) as n from read_aloud_voices").get(),
		).toEqual({ n: 0 });
	});
});

describe("GET /api/read-aloud/voices", () => {
	it("lists the built-in voices, the person's voices, the choice and the speed", async () => {
		const empty = await GET(eventFor("GET"));
		expect(empty.status).toBe(200);
		const settings = await empty.json();
		expect(settings.builtIn).toEqual([
			{ key: "imogen", name: "Imogen", language: "en" },
			{ key: "rupert", name: "Rupert", language: "en" },
			{ key: "savannah", name: "Savannah", language: "en" },
			{ key: "wyatt", name: "Wyatt", language: "en" },
			{ key: "berta", name: "Berta", language: "hu" },
			{ key: "imre", name: "Imre", language: "hu" },
		]);
		expect(settings).toMatchObject({
			voices: [],
			choice: { en: "imogen", hu: "berta" },
			defaultSpeed: 1,
		});

		const voice = await makeVoice(USER_A, { base: "berta", knobs: bedtime() });
		await PUT(eventFor("PUT", { body: { hu: voice.id, defaultSpeed: 0.75 } }));
		const after = await (await GET(eventFor("GET"))).json();
		expect(after.voices).toEqual([
			{
				id: voice.id,
				name: "Test Voice",
				base: "berta",
				baseName: "Berta",
				language: "hu",
				knobs: bedtime(),
				baseMissing: false,
			},
		]);
		expect(after.choice).toEqual({ en: "imogen", hu: voice.id });
		expect(after.defaultSpeed).toBe(0.75);
		// Someone else sees none of it.
		const other = await (await GET(eventFor("GET", { user: USER_B }))).json();
		expect(other).toMatchObject({
			voices: [],
			choice: { en: "imogen", hu: "berta" },
			defaultSpeed: 1,
		});
	});
});

describe("POST /api/read-aloud/voices", () => {
	it("creates a voice: 201 with its snapped knobs and trimmed name", async () => {
		const response = await POST(
			eventFor("POST", {
				body: {
					name: "  Test Voice  ",
					base: "savannah",
					knobs: {
						pace: 1.234,
						pitch: 0,
						depth: 0,
						energy: 0.1,
						projection: -0.6,
					},
				},
			}),
		);
		expect(response.status).toBe(201);
		const { voice } = await response.json();
		expect(voice).toMatchObject({
			name: "Test Voice",
			base: "savannah",
			baseName: "Savannah",
			language: "en",
			baseMissing: false,
			knobs: { pace: 1.25, pitch: 0, depth: 0, energy: 0, projection: -0.6 },
		});
		expect(voiceRow(voice.id)).toMatchObject({ user_id: USER_A, pace: 1.25 });
	});

	it("400 for knobs out of range, not numbers or missing, and for a name of 41 characters or only spaces", async () => {
		const good = {
			name: "Test Voice",
			base: "imogen",
			knobs: { ...ZERO_KNOBS },
		};
		const bad: Array<[string, unknown]> = [
			[
				"a knob beyond its slider",
				{ ...good, knobs: { ...ZERO_KNOBS, pace: 2.05 } },
			],
			[
				"a depth below normal",
				{ ...good, knobs: { ...ZERO_KNOBS, depth: -0.05 } },
			],
			["a knob far out", { ...good, knobs: { ...ZERO_KNOBS, energy: 1e9 } }],
			[
				"a string for a number",
				{ ...good, knobs: { ...ZERO_KNOBS, pace: "1" } },
			],
			["null for a number", { ...good, knobs: { ...ZERO_KNOBS, pitch: null } }],
			[
				"a missing knob",
				{ ...good, knobs: { pace: 0, pitch: 0, depth: 0, energy: 0 } },
			],
			["a sixth key", { ...good, knobs: { ...ZERO_KNOBS, gender: 1 } }],
			["no knobs", { name: "x", base: "imogen" }],
			["a name of 41 characters", { ...good, name: "x".repeat(41) }],
			["a name of spaces", { ...good, name: "     " }],
			["an empty name", { ...good, name: "" }],
			["a name that is not a string", { ...good, name: 7 }],
			["no base", { name: "x", knobs: ZERO_KNOBS }],
			["an empty base", { ...good, base: "" }],
			["a list", []],
			["an empty object", {}],
		];
		for (const [label, body] of bad) {
			const response = await POST(eventFor("POST", { body }));
			expect(response.status, label).toBe(400);
			expect(await response.json(), label).toEqual({
				error: "invalid_request",
			});
		}
		// A body that is not JSON, and a number JSON writes as infinity.
		for (const raw of [
			"{not json",
			"",
			`{"name":"x","base":"imogen","knobs":{"pace":1e999,"pitch":0,"depth":0,"energy":0,"projection":0}}`,
		]) {
			const response = await POST(eventFor("POST", { raw }));
			expect(response.status, raw).toBe(400);
			expect(await response.json(), raw).toEqual({ error: "invalid_request" });
		}
		expect(
			sqlite.prepare("select count(*) as n from read_aloud_voices").get(),
		).toEqual({ n: 0 });
	});

	it("accepts a name of 40 code points, an emoji counted as one, and the slider ends", async () => {
		await makeVoice(USER_A, { name: "😀".repeat(40) });
		await makeVoice(USER_A, {
			knobs: { pace: -2, pitch: 2, depth: 4, energy: -4, projection: 2 },
		});
		await makeVoice(USER_A, {
			knobs: { pace: 2, pitch: -2, depth: 0, energy: 4, projection: -1.5 },
		});
	});

	it("400 unknown_voice for a base that is not a built-in voice", async () => {
		const response = await POST(
			eventFor("POST", {
				body: { name: "Test Voice", base: "nobody", knobs: ZERO_KNOBS },
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unknown_voice" });
	});

	it("409 too_many for a 51st voice", async () => {
		for (let count = 0; count < 50; count++) {
			await makeVoice(USER_A, { name: `Voice ${count}` });
		}
		const response = await POST(
			eventFor("POST", {
				body: { name: "One too many", base: "imogen", knobs: ZERO_KNOBS },
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "too_many" });
		// Someone else is not held back by it.
		await makeVoice(USER_B);
	});
});

describe("PATCH and DELETE /api/read-aloud/voices/{id}", () => {
	it("edits and deletes one's own voice; DELETE answers the choice after", async () => {
		const voice = await makeVoice(USER_A, { base: "savannah" });
		const edited = await PATCH(
			eventFor("PATCH", {
				id: voice.id,
				body: { name: "  Renamed  ", knobs: bedtime() },
			}),
		);
		expect(edited.status).toBe(200);
		expect((await edited.json()).voice).toMatchObject({
			id: voice.id,
			name: "Renamed",
			base: "savannah",
			knobs: bedtime(),
		});

		// Another base in the same language, with no knobs sent.
		const rebased = await PATCH(
			eventFor("PATCH", { id: voice.id, body: { base: "rupert" } }),
		);
		expect((await rebased.json()).voice).toMatchObject({
			base: "rupert",
			baseName: "Rupert",
			knobs: bedtime(),
		});

		await PUT(eventFor("PUT", { body: { en: voice.id } }));
		const deleted = await DELETE(eventFor("DELETE", { id: voice.id }));
		expect(deleted.status).toBe(200);
		// The chosen voice is gone, so English is read in the voice it was made from.
		expect(await deleted.json()).toEqual({
			choice: { en: "rupert", hu: "berta" },
		});
		expect(voiceRow(voice.id)).toBeUndefined();
		const again = await DELETE(eventFor("DELETE", { id: voice.id }));
		expect(again.status).toBe(404);
	});

	it("400 for an empty patch, for a body that fails its schema and for an unknown base", async () => {
		const voice = await makeVoice(USER_A);
		for (const body of [
			{},
			{ name: "" },
			{ name: "x".repeat(41) },
			{ knobs: { ...ZERO_KNOBS, pace: 3 } },
			{ knobs: { pace: 1 } },
			{ base: "" },
		]) {
			const response = await PATCH(eventFor("PATCH", { id: voice.id, body }));
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_request" });
		}
		const unknown = await PATCH(
			eventFor("PATCH", { id: voice.id, body: { base: "nobody" } }),
		);
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({ error: "unknown_voice" });
		expect(voiceRow(voice.id)).toMatchObject({ base_voice: "imogen" });
	});

	it("answers 404 for another person's voice and 400 for choosing it", async () => {
		const aVoice = await makeVoice(USER_A, {
			base: "rupert",
			knobs: bedtime(),
		});
		const before = voiceRow(aVoice.id);

		const patched = await PATCH(
			eventFor("PATCH", {
				user: USER_B,
				id: aVoice.id,
				body: { name: "Mine now" },
			}),
		);
		expect(patched.status).toBe(404);
		expect(await patched.json()).toEqual({ error: "not_found" });

		const deleted = await DELETE(
			eventFor("DELETE", { user: USER_B, id: aVoice.id }),
		);
		expect(deleted.status).toBe(404);
		expect(await deleted.json()).toEqual({ error: "not_found" });
		expect(voiceRow(aVoice.id)).toEqual(before);

		const chosen = await PUT(
			eventFor("PUT", { user: USER_B, body: { en: aVoice.id } }),
		);
		expect(chosen.status).toBe(400);
		expect(await chosen.json()).toEqual({ error: "unknown_voice" });
		const settings = await (
			await GET(eventFor("GET", { user: USER_B }))
		).json();
		expect(settings.choice).toEqual({ en: "imogen", hu: "berta" });
		expect(settings.voices).toEqual([]);
	});
});

describe("PUT /api/read-aloud/preferences", () => {
	it("saves a choice and a Default speed; 400 for a speed that is not one of the six", async () => {
		const saved = await PUT(
			eventFor("PUT", {
				body: { en: "wyatt", hu: "imre", defaultSpeed: 1.75 },
			}),
		);
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({
			choice: { en: "wyatt", hu: "imre" },
			defaultSpeed: 1.75,
		});
		// A speed alone changes nothing else.
		const speedOnly = await PUT(eventFor("PUT", { body: { defaultSpeed: 2 } }));
		expect(await speedOnly.json()).toEqual({
			choice: { en: "wyatt", hu: "imre" },
			defaultSpeed: 2,
		});

		for (const body of [
			{ defaultSpeed: 1.3 },
			{ defaultSpeed: 3 },
			{ defaultSpeed: "1" },
			{ defaultSpeed: 0 },
			{},
			{ en: "" },
			{ en: 5 },
			[],
		]) {
			const response = await PUT(eventFor("PUT", { body }));
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_request" });
		}
		const raw = await PUT(eventFor("PUT", { raw: "{nope" }));
		expect(raw.status).toBe(400);
		expect(
			sqlite
				.prepare("select read_aloud_speed as speed from users where id = ?")
				.get(USER_A),
		).toEqual({ speed: 2 });
	});

	it("400 unknown_voice for a voice of the other language or one that does not exist", async () => {
		for (const body of [
			{ en: "berta" },
			{ hu: "rupert" },
			{ en: "nobody" },
			{ en: "x".repeat(100) },
		]) {
			const response = await PUT(eventFor("PUT", { body }));
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await response.json()).toEqual({ error: "unknown_voice" });
		}
		// Too long to be an id at all: refused by the schema.
		const tooLong = await PUT(
			eventFor("PUT", { body: { en: "x".repeat(101) } }),
		);
		expect(tooLong.status).toBe(400);
		expect(await tooLong.json()).toEqual({ error: "invalid_request" });
	});
});
