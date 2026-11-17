// A person's own voices and their voice choice (Plan 3, Task 2; spec §4.5-§4.7
// and §6.5).
//
// A personal voice is a built-in voice plus five knob values and a name, and it
// is its maker's alone: every query below carries the signed-in person's id
// (`readAloudVoices.userId` or `users.id`), no function takes another person as
// its subject, and a choice is only ever read against the person's own voices.
// The choice (one per language) is a built-in voice key or one of the person's
// voice ids; a value that is not the person's, not of that language or not a
// voice any more is read as the language's default, so a stale choice can
// never reach another person's voice or a voice of the wrong language.
//
// Knob values are stored as slider values. A Zonos control is made from them
// only when a reading or a preview is made (`resolvedVoice` →
// `knobsToControls`), so a safe range that is measured again reaches saved
// voices too.

import { randomUUID } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { readAloudVoices, users } from "$lib/server/db/schema";
import {
	clipVoiceName,
	isReadingSpeed,
	type Knobs,
	PERSONAL_VOICES_MAX,
	snapKnob,
	type VoiceLanguage,
} from "$lib/shared/read-aloud/voice-knobs";
import {
	builtInVoice,
	defaultVoiceFor,
	RETIRED_BUILT_IN_VOICES,
	type ResolvedVoice,
	resolvedVoice,
} from "./voices";

export type VoiceDraft = { name: string; base: string; knobs: Knobs };

export type PersonalVoice = {
	id: string;
	name: string;
	/** The key of the built-in voice it is made from. */
	base: string;
	baseName: string;
	language: VoiceLanguage;
	knobs: Knobs;
	/** The base is not a built-in voice of this language any more: it reads as the language's default. */
	baseMissing: boolean;
};

/** The choice of each language: a built-in voice key or one of the person's voice ids. Never unset here. */
export type VoiceChoice = Record<VoiceLanguage, string>;

export type ReadAloudSettings = {
	voices: PersonalVoice[];
	choice: VoiceChoice;
	defaultSpeed: number;
};

/** A base that is not a built-in voice, or a choice that is neither a built-in voice of its language nor one of the person's voices of it. */
export class UnknownVoice extends Error {
	constructor(message = "Not a voice this person can use") {
		super(message);
		this.name = "UnknownVoice";
	}
}

/** The person already keeps `PERSONAL_VOICES_MAX` voices. */
export class TooManyVoices extends Error {
	constructor(message = "The person keeps the most voices they can") {
		super(message);
		this.name = "TooManyVoices";
	}
}

type VoiceFields = Pick<
	typeof readAloudVoices.$inferSelect,
	| "id"
	| "name"
	| "baseVoice"
	| "language"
	| "pace"
	| "pitch"
	| "depth"
	| "energy"
	| "projection"
>;

/** Anything that can select: the database, or a transaction on it. */
type Reader = Pick<typeof db, "select">;

function languageOf(stored: string): VoiceLanguage {
	return stored === "hu" ? "hu" : "en";
}

function baseNameOf(key: string): string {
	const builtIn = builtInVoice(key);
	if (builtIn) return builtIn.name;
	if (Object.hasOwn(RETIRED_BUILT_IN_VOICES, key)) {
		return RETIRED_BUILT_IN_VOICES[key].name;
	}
	return key.charAt(0).toUpperCase() + key.slice(1);
}

function toPersonalVoice(row: VoiceFields): PersonalVoice {
	const language = languageOf(row.language);
	const base = builtInVoice(row.baseVoice);
	return {
		id: row.id,
		name: row.name,
		base: row.baseVoice,
		baseName: baseNameOf(row.baseVoice),
		language,
		knobs: {
			pace: row.pace,
			pitch: row.pitch,
			depth: row.depth,
			energy: row.energy,
			projection: row.projection,
		},
		baseMissing: !base || base.language !== language,
	};
}

function snappedKnobs(knobs: Knobs): Knobs {
	return {
		pace: snapKnob("pace", knobs.pace),
		pitch: snapKnob("pitch", knobs.pitch),
		depth: snapKnob("depth", knobs.depth),
		energy: snapKnob("energy", knobs.energy),
		projection: snapKnob("projection", knobs.projection),
	};
}

/** What a stored choice stands for in `language`, or null when it is unset or points nowhere. */
function validChoice(
	language: VoiceLanguage,
	stored: string | null | undefined,
	voices: readonly PersonalVoice[],
): string | null {
	if (!stored) return null;
	const builtIn = builtInVoice(stored);
	if (builtIn) return builtIn.language === language ? builtIn.key : null;
	return voices.some(
		(voice) => voice.id === stored && voice.language === language,
	)
		? stored
		: null;
}

function speedOf(stored: number | null | undefined): number {
	return isReadingSpeed(stored) ? stored : 1;
}

/** The person's voices (oldest first), choice and Default speed, read from `reader`. */
function loadSettings(reader: Reader, userId: string): ReadAloudSettings {
	const rows = reader
		.select()
		.from(readAloudVoices)
		.where(eq(readAloudVoices.userId, userId))
		// `created_at` has a second's grain: the row id breaks the tie in making order.
		.orderBy(asc(readAloudVoices.createdAt), sql`rowid`)
		.all();
	const user = reader
		.select({
			en: users.readAloudEnVoice,
			hu: users.readAloudHuVoice,
			speed: users.readAloudSpeed,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
	const voices = rows.map(toPersonalVoice);
	return {
		voices,
		choice: {
			en: validChoice("en", user?.en, voices) ?? defaultVoiceFor("en").key,
			hu: validChoice("hu", user?.hu, voices) ?? defaultVoiceFor("hu").key,
		},
		defaultSpeed: speedOf(user?.speed),
	};
}

export async function readAloudSettingsFor(
	userId: string,
): Promise<ReadAloudSettings> {
	return loadSettings(db, userId);
}

/**
 * Makes a voice for the person. The name is trimmed and cut to 40 code points
 * (an empty one becomes the base's name), each knob is snapped, and the voice's
 * language is the base's. Throws `UnknownVoice` for a base that is not a
 * built-in voice and `TooManyVoices` for a 51st voice.
 */
export async function createPersonalVoice(
	userId: string,
	draft: VoiceDraft,
): Promise<PersonalVoice> {
	const base = builtInVoice(draft.base);
	if (!base) throw new UnknownVoice("Not a built-in voice");
	const voice: VoiceFields = {
		id: randomUUID(),
		name: clipVoiceName(draft.name) || base.name,
		baseVoice: base.key,
		language: base.language,
		...snappedKnobs(draft.knobs),
	};
	// The count and the insert are one transaction, so two quick saves cannot make a 51st.
	db.transaction((tx) => {
		const held = tx
			.select({ held: count() })
			.from(readAloudVoices)
			.where(eq(readAloudVoices.userId, userId))
			.get();
		if ((held?.held ?? 0) >= PERSONAL_VOICES_MAX) throw new TooManyVoices();
		tx.insert(readAloudVoices)
			.values({ ...voice, userId })
			.run();
	});
	return toPersonalVoice(voice);
}

/**
 * Changes the person's own voice. Null when the voice is not theirs. A base in
 * the other language moves the voice there, and a choice that pointed at it in
 * the old language goes back to the default.
 */
export async function updatePersonalVoice(
	userId: string,
	id: string,
	patch: Partial<VoiceDraft>,
): Promise<PersonalVoice | null> {
	return db.transaction((tx) => {
		const ours = and(
			eq(readAloudVoices.id, id),
			eq(readAloudVoices.userId, userId),
		);
		const row = tx.select().from(readAloudVoices).where(ours).get();
		if (!row) return null;

		const next: VoiceFields = { ...row };
		if (patch.base !== undefined) {
			const base = builtInVoice(patch.base);
			if (!base) throw new UnknownVoice("Not a built-in voice");
			next.baseVoice = base.key;
			next.language = base.language;
		}
		if (patch.name !== undefined) {
			next.name = clipVoiceName(patch.name) || row.name;
		}
		if (patch.knobs !== undefined)
			Object.assign(next, snappedKnobs(patch.knobs));

		tx.update(readAloudVoices)
			.set({
				name: next.name,
				baseVoice: next.baseVoice,
				language: next.language,
				pace: next.pace,
				pitch: next.pitch,
				depth: next.depth,
				energy: next.energy,
				projection: next.projection,
				updatedAt: new Date(),
			})
			.where(ours)
			.run();

		const was = languageOf(row.language);
		if (languageOf(next.language) !== was) {
			tx.update(users)
				.set(
					was === "en"
						? { readAloudEnVoice: null }
						: { readAloudHuVoice: null },
				)
				.where(
					and(
						eq(users.id, userId),
						eq(
							was === "en" ? users.readAloudEnVoice : users.readAloudHuVoice,
							id,
						),
					),
				)
				.run();
		}
		return toPersonalVoice(next);
	});
}

/**
 * Deletes the person's own voice and answers their choice after. Null when the
 * voice is not theirs. In one transaction, a choice that pointed at the voice
 * goes to the voice's base (or to the default when the base is gone), so no
 * reading ever finds a choice that points nowhere (spec §4.6).
 */
export async function deletePersonalVoice(
	userId: string,
	id: string,
): Promise<VoiceChoice | null> {
	return db.transaction((tx) => {
		const ours = and(
			eq(readAloudVoices.id, id),
			eq(readAloudVoices.userId, userId),
		);
		const row = tx.select().from(readAloudVoices).where(ours).get();
		if (!row) return null;

		const base = builtInVoice(row.baseVoice);
		const baseFor = (language: VoiceLanguage) =>
			base && base.language === language ? base.key : null;
		const user = tx
			.select({ en: users.readAloudEnVoice, hu: users.readAloudHuVoice })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		const choose: {
			readAloudEnVoice?: string | null;
			readAloudHuVoice?: string | null;
		} = {};
		if (user?.en === id) choose.readAloudEnVoice = baseFor("en");
		if (user?.hu === id) choose.readAloudHuVoice = baseFor("hu");
		if (Object.keys(choose).length > 0) {
			tx.update(users).set(choose).where(eq(users.id, userId)).run();
		}

		tx.delete(readAloudVoices).where(ours).run();
		return loadSettings(tx, userId).choice;
	});
}

/** A choice, checked against the voices the person has: throws `UnknownVoice` for anything else. */
function acceptedChoice(
	language: VoiceLanguage,
	value: string,
	voices: readonly PersonalVoice[],
): string {
	const builtIn = builtInVoice(value);
	if (builtIn) {
		if (builtIn.language === language) return builtIn.key;
	} else if (
		voices.some((voice) => voice.id === value && voice.language === language)
	) {
		return value;
	}
	throw new UnknownVoice();
}

/**
 * Saves the person's choice for a language and their Default speed, whichever
 * are given, and answers both as they now are. A choice must be a built-in
 * voice of its language or one of the person's own voices of it, else nothing
 * is saved and `UnknownVoice` is thrown; a speed must be one of the six.
 */
export async function setReadAloudPreferences(
	userId: string,
	next: { en?: string; hu?: string; defaultSpeed?: number },
): Promise<{ choice: VoiceChoice; defaultSpeed: number }> {
	return db.transaction((tx) => {
		const { voices } = loadSettings(tx, userId);
		const set: {
			readAloudEnVoice?: string;
			readAloudHuVoice?: string;
			readAloudSpeed?: number;
		} = {};
		if (next.en !== undefined) {
			set.readAloudEnVoice = acceptedChoice("en", next.en, voices);
		}
		if (next.hu !== undefined) {
			set.readAloudHuVoice = acceptedChoice("hu", next.hu, voices);
		}
		if (next.defaultSpeed !== undefined) {
			if (!isReadingSpeed(next.defaultSpeed)) {
				throw new RangeError("The Default speed is not one of the six speeds");
			}
			set.readAloudSpeed = next.defaultSpeed;
		}
		if (Object.keys(set).length > 0) {
			tx.update(users)
				.set({ ...set, updatedAt: new Date() })
				.where(eq(users.id, userId))
				.run();
		}
		const settings = loadSettings(tx, userId);
		return { choice: settings.choice, defaultSpeed: settings.defaultSpeed };
	});
}

function voiceFor(
	language: VoiceLanguage,
	{ choice, voices }: ReadAloudSettings,
): ResolvedVoice {
	const chosen = choice[language];
	const builtIn = builtInVoice(chosen);
	if (builtIn) return resolvedVoice(builtIn);
	const own = voices.find((voice) => voice.id === chosen);
	const base = own && !own.baseMissing ? builtInVoice(own.base) : null;
	if (own && base) return resolvedVoice(base, own.knobs);
	// A voice whose base is gone reads with its language's default, without its knobs.
	return resolvedVoice(defaultVoiceFor(language));
}

/**
 * The voice each language reads with for this person, and the speed a reading
 * starts at. Anything but a built-in voice of the language or the person's own
 * voice of it (another person's id, a deleted id, a voice whose base is gone)
 * reads as the language's default.
 */
export async function resolveReadingVoices(userId: string): Promise<{
	voices: Record<VoiceLanguage, ResolvedVoice>;
	defaultSpeed: number;
}> {
	const settings = loadSettings(db, userId);
	return {
		voices: { en: voiceFor("en", settings), hu: voiceFor("hu", settings) },
		defaultSpeed: settings.defaultSpeed,
	};
}
