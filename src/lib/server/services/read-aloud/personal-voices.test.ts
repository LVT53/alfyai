// @vitest-environment node
// Personal voices and the voice choice (Plan 3, Task 2), against a real
// migrated SQLite file: privacy is a WHERE-clause guarantee, so it is proven
// against a real query planner, the way tests/cross-cutting/isolation.test.ts
// does. Made-up people only: `user-a` and `user-b`.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	type Knobs,
	PERSONAL_VOICES_MAX,
	STYLES,
	ZERO_KNOBS,
} from "$lib/shared/read-aloud/voice-knobs";
import {
	createPersonalVoice,
	deletePersonalVoice,
	readAloudSettingsFor,
	resolveReadingVoices,
	setReadAloudPreferences,
	TooManyVoices,
	UnknownVoice,
	updatePersonalVoice,
} from "./personal-voices";
import { RETIRED_BUILT_IN_VOICES } from "./voices";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

const USER_A = "user-a";
const USER_B = "user-b";

const IMOGEN = "default_b78b28baf5c31a1d";
const SAVANNAH = "default_de4d191ca7574982";
const BERTA = "default_bf7632822e6b4dc0";
const IMRE = "default_fde02d0881bd267d";
const RUPERT = "default_3765f0d1140c05c0";

function bedtime(): Knobs {
	const style = STYLES.find((candidate) => candidate.key === "bedtime");
	if (!style) throw new Error("no bedtime style");
	return style.knobs;
}

function seedUser(userId: string) {
	sqlite
		.prepare(
			"insert into users (id, email, password_hash) values (?, ?, 'hash')",
		)
		.run(userId, `${userId}@example.com`);
}

function voiceRow(id: string) {
	return sqlite.prepare("select * from read_aloud_voices where id = ?").get(id);
}

function userRow(userId: string) {
	return sqlite
		.prepare(
			"select read_aloud_en_voice as en, read_aloud_hu_voice as hu, read_aloud_speed as speed from users where id = ?",
		)
		.get(userId) as { en: string | null; hu: string | null; speed: number };
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-personal-voices-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	seedUser(USER_A);
	seedUser(USER_B);
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

describe("a person's voices and choice", () => {
	it("a new person reads with Imogen and Berta at 1×", async () => {
		expect(await readAloudSettingsFor(USER_A)).toEqual({
			voices: [],
			choice: { en: "imogen", hu: "berta" },
			defaultSpeed: 1,
		});
		const reading = await resolveReadingVoices(USER_A);
		expect(reading.defaultSpeed).toBe(1);
		expect(reading.voices.en).toMatchObject({
			speakerId: IMOGEN,
			controls: {},
		});
		expect(reading.voices.hu).toMatchObject({
			speakerId: BERTA,
			controls: { "room.clean": 2 },
		});
	});

	it("creates, lists, edits and deletes a voice of one's own", async () => {
		const created = await createPersonalVoice(USER_A, {
			name: "  Test Voice  ",
			base: "savannah",
			knobs: { ...ZERO_KNOBS, pace: 1.234, energy: 0.1234 },
		});
		expect(created).toMatchObject({
			name: "Test Voice",
			base: "savannah",
			baseName: "Savannah",
			language: "en",
			baseMissing: false,
			knobs: { pace: 1.25, pitch: 0, depth: 0, energy: 0, projection: 0 },
		});
		expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
		// What is stored is what was snapped, and the name as trimmed.
		expect(voiceRow(created.id)).toMatchObject({
			user_id: USER_A,
			name: "Test Voice",
			base_voice: "savannah",
			language: "en",
			pace: 1.25,
			energy: 0,
		});
		expect((await readAloudSettingsFor(USER_A)).voices).toEqual([created]);

		const edited = await updatePersonalVoice(USER_A, created.id, {
			name: "Renamed",
			knobs: { ...created.knobs, depth: 1 },
		});
		expect(edited).toMatchObject({
			id: created.id,
			name: "Renamed",
			base: "savannah",
			knobs: { pace: 1.25, depth: 1 },
		});
		expect((await readAloudSettingsFor(USER_A)).voices).toEqual([edited]);

		// A patch with only a name keeps the base and the knobs.
		const renamed = await updatePersonalVoice(USER_A, created.id, {
			name: "  Again  ",
		});
		expect(renamed).toMatchObject({
			name: "Again",
			base: "savannah",
			knobs: { pace: 1.25, depth: 1 },
		});

		expect(await deletePersonalVoice(USER_A, created.id)).toEqual({
			en: "imogen",
			hu: "berta",
		});
		expect((await readAloudSettingsFor(USER_A)).voices).toEqual([]);
		expect(voiceRow(created.id)).toBeUndefined();
	});

	it("lists a person's voices oldest first, even when made in the same second", async () => {
		const names = ["One", "Two", "Three", "Four"];
		for (const name of names) {
			await createPersonalVoice(USER_A, {
				name,
				base: "imogen",
				knobs: ZERO_KNOBS,
			});
		}
		expect(
			(await readAloudSettingsFor(USER_A)).voices.map((voice) => voice.name),
		).toEqual(names);
	});

	it("refuses a base that is not a built-in voice, on making and on editing", async () => {
		await expect(
			createPersonalVoice(USER_A, {
				name: "x",
				base: "nobody",
				knobs: ZERO_KNOBS,
			}),
		).rejects.toBeInstanceOf(UnknownVoice);
		const voice = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "imogen",
			knobs: ZERO_KNOBS,
		});
		await expect(
			updatePersonalVoice(USER_A, voice.id, { base: "nobody" }),
		).rejects.toBeInstanceOf(UnknownVoice);
		expect(voiceRow(voice.id)).toMatchObject({ base_voice: "imogen" });
	});

	it("never lists, changes, deletes or reads another person's voice", async () => {
		const aVoice = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "rupert",
			knobs: bedtime(),
		});
		const before = voiceRow(aVoice.id);

		expect((await readAloudSettingsFor(USER_B)).voices).toEqual([]);
		expect(
			await updatePersonalVoice(USER_B, aVoice.id, { name: "x" }),
		).toBeNull();
		expect(voiceRow(aVoice.id)).toEqual(before);
		expect(await deletePersonalVoice(USER_B, aVoice.id)).toBeNull();
		expect(voiceRow(aVoice.id)).toEqual(before);
		await expect(
			setReadAloudPreferences(USER_B, { en: aVoice.id }),
		).rejects.toBeInstanceOf(UnknownVoice);
		expect(userRow(USER_B).en).toBeNull();

		// A's id written straight into B's choice reads as the default.
		sqlite
			.prepare("update users set read_aloud_en_voice = ? where id = ?")
			.run(aVoice.id, USER_B);
		expect((await readAloudSettingsFor(USER_B)).choice.en).toBe("imogen");
		const reading = await resolveReadingVoices(USER_B);
		expect(reading.voices.en).toMatchObject({
			speakerId: IMOGEN,
			controls: {},
		});
		// And A's own reading still uses the voice.
		await setReadAloudPreferences(USER_A, { en: aVoice.id });
		expect((await resolveReadingVoices(USER_A)).voices.en.speakerId).toBe(
			RUPERT,
		);
	});

	it("deleting the chosen voice gives the choice back to its base", async () => {
		const voice = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "savannah",
			knobs: bedtime(),
		});
		await setReadAloudPreferences(USER_A, { en: voice.id });
		expect((await resolveReadingVoices(USER_A)).voices.en.speakerId).toBe(
			SAVANNAH,
		);

		expect(await deletePersonalVoice(USER_A, voice.id)).toEqual({
			en: "savannah",
			hu: "berta",
		});
		expect(userRow(USER_A).en).toBe("savannah");
		expect((await readAloudSettingsFor(USER_A)).choice.en).toBe("savannah");
		expect((await resolveReadingVoices(USER_A)).voices.en).toMatchObject({
			speakerId: SAVANNAH,
			controls: {},
		});
	});

	it("deleting a voice that is not chosen leaves the choice as it was", async () => {
		const voice = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "savannah",
			knobs: bedtime(),
		});
		await setReadAloudPreferences(USER_A, { en: "rupert", hu: "imre" });
		expect(await deletePersonalVoice(USER_A, voice.id)).toEqual({
			en: "rupert",
			hu: "imre",
		});
	});

	it("a choice is of its own language", async () => {
		await expect(
			setReadAloudPreferences(USER_A, { en: "berta" }),
		).rejects.toBeInstanceOf(UnknownVoice);
		const english = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "imogen",
			knobs: ZERO_KNOBS,
		});
		await expect(
			setReadAloudPreferences(USER_A, { hu: english.id }),
		).rejects.toBeInstanceOf(UnknownVoice);
		await expect(
			setReadAloudPreferences(USER_A, { en: "nobody" }),
		).rejects.toBeInstanceOf(UnknownVoice);
		// Nothing was saved by the refusals.
		expect(userRow(USER_A)).toMatchObject({ en: null, hu: null });

		expect(await setReadAloudPreferences(USER_A, { en: "rupert" })).toEqual({
			choice: { en: "rupert", hu: "berta" },
			defaultSpeed: 1,
		});
		expect(await setReadAloudPreferences(USER_A, { hu: "imre" })).toEqual({
			choice: { en: "rupert", hu: "imre" },
			defaultSpeed: 1,
		});
	});

	it("saves nothing when one of two choices is refused", async () => {
		await expect(
			setReadAloudPreferences(USER_A, { en: "rupert", hu: "nobody" }),
		).rejects.toBeInstanceOf(UnknownVoice);
		expect(userRow(USER_A)).toMatchObject({ en: null, hu: null });
	});

	it("moving a chosen voice to another language returns that choice to the default", async () => {
		const voice = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "rupert",
			knobs: bedtime(),
		});
		await setReadAloudPreferences(USER_A, { en: voice.id });
		expect(userRow(USER_A).en).toBe(voice.id);

		const moved = await updatePersonalVoice(USER_A, voice.id, { base: "imre" });
		expect(moved).toMatchObject({
			language: "hu",
			base: "imre",
			baseName: "Imre",
		});
		expect(userRow(USER_A).en).toBeNull();
		expect((await readAloudSettingsFor(USER_A)).choice).toEqual({
			en: "imogen",
			hu: "berta",
		});
		// It is a Hungarian voice now, so it can be chosen for Hungarian.
		await setReadAloudPreferences(USER_A, { hu: voice.id });
		expect((await resolveReadingVoices(USER_A)).voices.hu.speakerId).toBe(IMRE);
	});

	it("refuses a 51st voice, for that person only", async () => {
		for (let count = 0; count < PERSONAL_VOICES_MAX; count++) {
			await createPersonalVoice(USER_A, {
				name: `Voice ${count}`,
				base: "imogen",
				knobs: ZERO_KNOBS,
			});
		}
		await expect(
			createPersonalVoice(USER_A, {
				name: "One too many",
				base: "imogen",
				knobs: ZERO_KNOBS,
			}),
		).rejects.toBeInstanceOf(TooManyVoices);
		expect((await readAloudSettingsFor(USER_A)).voices).toHaveLength(50);
		// Someone else still can, and a deleted voice makes room.
		await createPersonalVoice(USER_B, {
			name: "Mine",
			base: "imogen",
			knobs: ZERO_KNOBS,
		});
		const [first] = (await readAloudSettingsFor(USER_A)).voices;
		await deletePersonalVoice(USER_A, first.id);
		await createPersonalVoice(USER_A, {
			name: "Room again",
			base: "imogen",
			knobs: ZERO_KNOBS,
		});
	});

	it("a personal voice reads with its base's speaker and its knobs on top of the base's controls", async () => {
		const voice = await createPersonalVoice(USER_A, {
			name: "Test Voice",
			base: "berta",
			knobs: bedtime(),
		});
		await setReadAloudPreferences(USER_A, { hu: voice.id });
		const reading = await resolveReadingVoices(USER_A);
		expect(reading.voices.hu.speakerId).toBe(BERTA);
		expect(reading.voices.hu.controls).toEqual({
			"room.clean": 2,
			"delivery.tempo": -1,
			"texture.deep": 1,
			"mood.arousal": -2.5,
			"delivery.whisper": 0.6,
		});
		// English was not touched.
		expect(reading.voices.en).toMatchObject({
			speakerId: IMOGEN,
			controls: {},
		});
	});

	it("a voice whose base is gone is listed with baseMissing and reads as its language's default", async () => {
		sqlite
			.prepare(
				"insert into read_aloud_voices (id, user_id, name, base_voice, language, pace) values (?, ?, ?, ?, ?, ?)",
			)
			.run("orphan-voice", USER_A, "Test Voice", "gone", "en", 1);
		const { voices } = await readAloudSettingsFor(USER_A);
		expect(voices).toEqual([
			expect.objectContaining({
				id: "orphan-voice",
				base: "gone",
				baseName: "Gone",
				language: "en",
				baseMissing: true,
				knobs: { pace: 1, pitch: 0, depth: 0, energy: 0, projection: 0 },
			}),
		]);
		// It can still be chosen, and it then reads as the default voice, without its knobs.
		await setReadAloudPreferences(USER_A, { en: "orphan-voice" });
		expect((await readAloudSettingsFor(USER_A)).choice.en).toBe("orphan-voice");
		expect((await resolveReadingVoices(USER_A)).voices.en).toMatchObject({
			speakerId: IMOGEN,
			controls: {},
		});
	});

	it("names a voice's retired base from the retired list", async () => {
		const retired = RETIRED_BUILT_IN_VOICES as Record<
			string,
			{ name: string; language: "en" | "hu" }
		>;
		retired.oldie = { name: "Oldie", language: "en" };
		try {
			sqlite
				.prepare(
					"insert into read_aloud_voices (id, user_id, name, base_voice, language) values (?, ?, ?, ?, ?)",
				)
				.run("retired-voice", USER_A, "Test Voice", "oldie", "en");
			const [voice] = (await readAloudSettingsFor(USER_A)).voices;
			expect(voice).toMatchObject({
				baseName: "Oldie",
				baseMissing: true,
			});
		} finally {
			delete retired.oldie;
		}
	});

	it("reads a choice that points nowhere as the language's default", async () => {
		sqlite
			.prepare(
				"update users set read_aloud_en_voice = ?, read_aloud_hu_voice = ? where id = ?",
			)
			.run("deleted-voice-id", "rupert", USER_A);
		// A deleted id, and an English built-in left in the Hungarian column.
		expect((await readAloudSettingsFor(USER_A)).choice).toEqual({
			en: "imogen",
			hu: "berta",
		});
		const reading = await resolveReadingVoices(USER_A);
		expect(reading.voices.en.speakerId).toBe(IMOGEN);
		expect(reading.voices.hu.speakerId).toBe(BERTA);
	});

	it("saves a Default speed of the six, and reads a stored speed that is not one of them as 1×", async () => {
		expect(
			await setReadAloudPreferences(USER_A, { defaultSpeed: 1.5 }),
		).toEqual({
			choice: { en: "imogen", hu: "berta" },
			defaultSpeed: 1.5,
		});
		expect((await resolveReadingVoices(USER_A)).defaultSpeed).toBe(1.5);
		await expect(
			setReadAloudPreferences(USER_A, { defaultSpeed: 1.3 }),
		).rejects.toBeInstanceOf(RangeError);
		expect(userRow(USER_A).speed).toBe(1.5);

		sqlite
			.prepare("update users set read_aloud_speed = 1.3 where id = ?")
			.run(USER_A);
		expect((await readAloudSettingsFor(USER_A)).defaultSpeed).toBe(1);
		expect((await resolveReadingVoices(USER_A)).defaultSpeed).toBe(1);
	});

	it("deleting the person deletes their voices", async () => {
		await createPersonalVoice(USER_A, {
			name: "A's",
			base: "imogen",
			knobs: ZERO_KNOBS,
		});
		const bVoice = await createPersonalVoice(USER_B, {
			name: "B's",
			base: "imogen",
			knobs: ZERO_KNOBS,
		});
		sqlite.prepare("delete from users where id = ?").run(USER_A);
		expect(
			sqlite
				.prepare(
					"select count(*) as n from read_aloud_voices where user_id = ?",
				)
				.get(USER_A),
		).toEqual({ n: 0 });
		expect(voiceRow(bVoice.id)).toBeDefined();
	});
});
