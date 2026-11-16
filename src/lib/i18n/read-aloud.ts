/**
 * Read aloud (spec `docs/superpowers/specs/2026-11-16-read-aloud-design.md`):
 * the speaker on a reply, its notes, the floating player, the scrubber and
 * Read from here. The words are the plan's Copy section
 * (`docs/superpowers/plans/2026-11-16-read-aloud-2-reading-in-chat.md`).
 *
 * How the placeholders are filled:
 * - `{language}` is `Intl.DisplayNames` in the UI language with its first
 *   letter upper-cased ("German", "Német"); a language without a name takes
 *   `readAloud.note.noVoiceUnknown` instead.
 * - A speed is `Intl.NumberFormat` in the UI language plus "×" ("1,25×"),
 *   and an estimated total starts with "≈": neither is a key.
 *
 * Its own namespace, audited as a whole (`readAloud.` in
 * `src/lib/i18n.test-helpers.ts`), so a line that reached English and not
 * Hungarian fails the parity test.
 */
const readAloudDict = {
	en: {
		// The speaker in a reply's action row; its label follows its face.
		"readAloud.speaker.read": "Read aloud",
		"readAloud.speaker.pause": "Pause reading",
		"readAloud.speaker.resume": "Resume reading",
		// The notes (role="status"): calm for a language without a voice, a
		// reply with nothing to read and a busy voice; amber when it fails.
		"readAloud.note.noVoice": "Read aloud isn't available in {language} yet.",
		"readAloud.note.noVoiceUnknown":
			"Read aloud isn't available in this language yet.",
		"readAloud.note.nothing": "Nothing in this reply can be read aloud.",
		"readAloud.note.busy":
			"The voice is busy with another reading. Yours starts in a moment.",
		"readAloud.note.cantStart":
			"Couldn't start reading. The voice isn't answering right now.",
		"readAloud.note.stopped": "Reading stopped. The voice stopped answering.",
		"readAloud.note.offline":
			"You're offline. Reading continues when you're back.",
		"readAloud.note.updating":
			"AlfyAI is updating. Reading continues when it is back.",
		"readAloud.tryAgain": "Try again",
		"readAloud.dismiss": "Dismiss",
		// The floating player above the message box. It shows no text of the
		// reply, so these labels are what names each control.
		"readAloud.player.label": "Read aloud player",
		"readAloud.player.previous": "Previous sentence",
		"readAloud.player.next": "Next sentence",
		"readAloud.player.play": "Play",
		"readAloud.player.pause": "Pause",
		"readAloud.player.waiting": "Waiting to continue",
		"readAloud.player.locate": "Go to where it's reading",
		"readAloud.player.speed": "Speed",
		"readAloud.player.stop": "Stop reading",
		"readAloud.player.finished": "Finished",
		// The sentence scrubber, a slider whose value is a sentence.
		"readAloud.scrubber.label": "Sentence",
		"readAloud.scrubber.value": "Sentence {n} of {total}",
		// The pill on a selection in a reply.
		"readAloud.readFromHere": "Read from here",
	},
	hu: {
		"readAloud.speaker.read": "Felolvasás",
		"readAloud.speaker.pause": "Felolvasás szüneteltetése",
		"readAloud.speaker.resume": "Felolvasás folytatása",
		"readAloud.note.noVoice": "{language} nyelvű felolvasás még nem érhető el.",
		"readAloud.note.noVoiceUnknown":
			"Ezen a nyelven még nem érhető el felolvasás.",
		"readAloud.note.nothing": "Ebben a válaszban nincs felolvasható szöveg.",
		"readAloud.note.busy":
			"A hang most egy másik felolvasással foglalt. A tiéd mindjárt indul.",
		"readAloud.note.cantStart":
			"Nem sikerült elindítani a felolvasást. A hang most nem válaszol.",
		"readAloud.note.stopped": "A felolvasás megállt. A hang nem válaszol.",
		"readAloud.note.offline":
			"Nincs internetkapcsolat. A felolvasás folytatódik, amint visszatér.",
		"readAloud.note.updating":
			"Az AlfyAI frissül. A felolvasás folytatódik, amint újra elérhető.",
		"readAloud.tryAgain": "Próbáld újra",
		"readAloud.dismiss": "Bezárás",
		"readAloud.player.label": "Felolvasó lejátszó",
		"readAloud.player.previous": "Előző mondat",
		"readAloud.player.next": "Következő mondat",
		"readAloud.player.play": "Lejátszás",
		"readAloud.player.pause": "Szünet",
		"readAloud.player.waiting": "Folytatásra vár",
		"readAloud.player.locate": "Ugrás oda, ahol tart",
		"readAloud.player.speed": "Sebesség",
		"readAloud.player.stop": "Felolvasás leállítása",
		"readAloud.player.finished": "Vége",
		"readAloud.scrubber.label": "Mondat",
		"readAloud.scrubber.value": "{n}. mondat, összesen {total}",
		"readAloud.readFromHere": "Felolvasás innen",
	},
} as const;

export default readAloudDict;
