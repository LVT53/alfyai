import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The age probe (memory recall part 1, Task 7): does saying when each entry
// was last said ("said 14 months ago") make the local model remark on a
// lasting fact's age or doubt it? Explicit synthetic-only acceptance, like the
// live check: the normal gates skip it. It measures the wording, not
// retrieval, so the recalled rows come from a fake native client; everything
// after that is the app's own: recallMemory, the memory section's assembly and
// the plain chat run, so the section reaches Flash-Next as a real turn sends it.
//
// Run it with the probe key (never printed) and, to read each reply and its
// verdict, the verbose reporter:
//   HINDSIGHT_NATIVE_ACCEPTANCE=1 ALFY_API_KEY=... npx vitest run --reporter=verbose <this file>
// AGE_PROBE_MODEL_URL and AGE_PROBE_MODEL_NAME override the endpoint
// (inference.alfycomms.com, as the real-model replay probe uses) and the
// served name (qwen3-6-27b, Flash-Next's, so the app's qwen sampling applies).
// Every other address the turn tries is refused. Only counts go in the
// results file; the printed replies are synthetic.

vi.hoisted(() => {
	if (process.env.HINDSIGHT_NATIVE_ACCEPTANCE !== "1") return;
	// Production's base prompt for model1.
	process.env.MODEL_1_SYSTEM_PROMPT ??= "alfyai-nemotron";
});

const MODEL_URL =
	process.env.AGE_PROBE_MODEL_URL ?? "https://inference.alfycomms.com/v1";
const MODEL_NAME = process.env.AGE_PROBE_MODEL_NAME ?? "qwen3-6-27b";
const RESULTS =
	"docs/plans/hindsight-memory/native-acceptance/recall-part-1-age-probe-results.json";
const DAY_MS = 86_400_000;
const PASS_AT_MOST = 2;

// The fake native client ranks the current turn's rows for every search.
let ranking: unknown[] = [];
vi.mock("./hindsight-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hindsight-client")>()),
	nativeMemoryClient: () => ({
		recall: async () => ranking,
		list: async () => [],
	}),
}));

interface AgeTurn {
	language: "en" | "hu";
	/** A lasting fact: it does not go stale with time. */
	fact: string;
	/** A question that needs the fact. */
	question: string;
}

const TURNS: AgeTurn[] = [
	{
		language: "en",
		fact: "The user's blood type is A negative.",
		question: "I'm filling in a blood donor form. What's my blood type?",
	},
	{
		language: "en",
		fact: "The user is allergic to penicillin.",
		question:
			"My doctor wants to prescribe me an antibiotic. Is there anything I should mention?",
	},
	{
		language: "en",
		fact: "The user's daughter is called Hanna.",
		question:
			"Write a two-line birthday card message for my daughter, with her name in it.",
	},
	{
		language: "en",
		fact: "The user was born in Pécs.",
		question: "A form asks for my place of birth. What should I write?",
	},
	{
		language: "en",
		fact: "The user's wedding anniversary is on 14 June.",
		question:
			"When is our wedding anniversary? I want to book a restaurant in time.",
	},
	{
		language: "en",
		fact: "The user has red-green colour blindness.",
		question: "Which colour pairs should I avoid in charts I make for myself?",
	},
	{
		language: "en",
		fact: "The user is left-handed.",
		question:
			"I'm buying new scissors and a computer mouse. Anything I should keep in mind?",
	},
	{
		language: "en",
		fact: "The user is lactose intolerant.",
		question: "Can you suggest a dessert I could make for myself tonight?",
	},
	{
		language: "en",
		fact: "The user's mother's birthday is on 2 May.",
		question: "When should I order flowers for my mother's birthday?",
	},
	{
		language: "en",
		fact: "The user is 192 cm tall.",
		question: "What frame size should I look for in a new road bike?",
	},
	{
		language: "hu",
		fact: "A felhasználó vércsoportja 0 pozitív.",
		question: "Véradásra jelentkezem. Mi a vércsoportom?",
	},
	{
		language: "hu",
		fact: "A felhasználó allergiás a mogyoróra.",
		question: "Milyen süteményt süssek magamnak a hétvégére?",
	},
	{
		language: "hu",
		fact: "A felhasználó fiát Bencének hívják.",
		question:
			"Írj két soros születésnapi üdvözletet a fiamnak, a nevével együtt!",
	},
	{
		language: "hu",
		fact: "A felhasználó Debrecenben született.",
		question: "Egy űrlap a születési helyemet kérdezi. Mit írjak be?",
	},
	{
		language: "hu",
		fact: "A felhasználó házassági évfordulója október 3-án van.",
		question:
			"Mikor van a házassági évfordulónk? Időben szeretnék asztalt foglalni.",
	},
	{
		language: "hu",
		fact: "A felhasználónak 1-es típusú cukorbetegsége van.",
		question: "Milyen reggelit javasolsz nekem holnapra?",
	},
	{
		language: "hu",
		fact: "A felhasználó balkezes.",
		question: "Új ollót és egeret veszek. Mire figyeljek?",
	},
	{
		language: "hu",
		fact: "A felhasználó lisztérzékeny.",
		question: "Milyen kenyeret vegyek magamnak a pékségben?",
	},
	{
		language: "hu",
		fact: "A felhasználó édesapja március 12-én született.",
		question: "Mikor rendeljek ajándékot az édesapám születésnapjára?",
	},
	{
		language: "hu",
		fact: "A felhasználó 165 cm magas.",
		question: "Mekkora vázméretű országúti biciklit keressek?",
	},
];

// A reply that says how old the fact is, or doubts it, in either language.
// The verdict is printed with the reply, so a reader can overrule it.
const AGE_REMARKS: (string | RegExp)[] = [
	/\b\d+\s+(?:months?|years?)\s+ago\b/,
	/\b(?:a|one|two|three|several|many)\s+(?:months?|years?)\s+ago\b/,
	"a while ago",
	"some time ago",
	"a long time ago",
	"over a year",
	"more than a year",
	"last year",
	"back then",
	"since then",
	"at the time",
	"old note",
	"older note",
	"older information",
	"may have changed",
	"might have changed",
	"could have changed",
	"has changed since",
	"may no longer",
	"might no longer",
	"no longer accurate",
	"still the case",
	"still accurate",
	"still correct",
	"still true",
	"still valid",
	"still up to date",
	"still up-to-date",
	"still current",
	"outdated",
	"out of date",
	"out-of-date",
	"if that's still",
	"if that is still",
	"if this is still",
	"if it's still",
	"if it is still",
	"hasn't changed",
	"has not changed",
	"please confirm",
	"can you confirm",
	"could you confirm",
	"worth confirming",
	"double-check that",
	"not be current",
	"not be up to date",
	/\d+\s+(?:hónapja|éve|hónappal|évvel)\b/,
	"egy éve",
	"egy évvel",
	"több mint egy éve",
	"évekkel ezelőtt",
	"hónapokkal ezelőtt",
	"évvel ezelőtt",
	"hónappal ezelőtt",
	"régebben",
	"tavaly",
	"akkoriban",
	"azóta",
	"változhatott",
	"megváltozhatott",
	"megváltozott-e",
	"még mindig",
	"még érvényes",
	"még aktuális",
	"még igaz",
	"még így van",
	"elavult",
	"nem biztos, hogy",
	"erősítsd meg",
	"megerősíted",
	"ellenőrizd",
	"ha ez még",
	"ha még mindig",
	"ha azóta",
];

/** The first age or doubt remark in a reply, or null. */
function ageRemark(reply: string): string | null {
	const text = reply
		.normalize("NFC")
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/\s+/g, " ");
	for (const remark of AGE_REMARKS) {
		if (typeof remark === "string") {
			if (text.includes(remark)) return remark;
		} else {
			const match = text.match(remark);
			if (match) return match[0];
		}
	}
	return null;
}

/** Every string in a JSON request body, joined: what the model was sent. */
function sentText(body: string): string {
	const out: string[] = [];
	const walk = (value: unknown) => {
		if (typeof value === "string") out.push(value);
		else if (Array.isArray(value)) for (const item of value) walk(item);
		else if (value && typeof value === "object")
			for (const item of Object.values(value)) walk(item);
	};
	try {
		walk(JSON.parse(body));
	} catch {
		out.push(body);
	}
	return out.join("\n");
}

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe.runIf(process.env.HINDSIGHT_NATIVE_ACCEPTANCE === "1")(
	"the local model and the age of a remembered fact",
	() => {
		it("at most two of twenty replies remark on a lasting fact's age or doubt it", async () => {
			const apiKey = process.env.ALFY_API_KEY;
			if (!apiKey)
				throw new Error(
					"Set ALFY_API_KEY, the key for the probe endpoint, to run the age probe.",
				);
			const sent: string[] = [];
			const realFetch = globalThis.fetch;
			vi.stubGlobal(
				"fetch",
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const url =
						typeof input === "string"
							? input
							: input instanceof URL
								? input.href
								: input.url;
					if (!url.startsWith(MODEL_URL))
						return new Response("Not reachable from the age probe.", {
							status: 503,
						});
					if (typeof init?.body === "string") sent.push(init.body);
					return realFetch(input, init);
				},
			);
			try {
				const { db } = await import("$lib/server/db");
				const schema = await import("$lib/server/db/schema");
				const { getConfig } = await import("$lib/server/config-store");
				const { createConversation } = await import("../conversations");
				const { buildBaselineDepthMetadata } = await import(
					"../chat-turn/depth-metadata"
				);
				const { runPlainNormalChatSendModel } = await import(
					"../chat-turn/plain-normal-chat-model-run"
				);
				const userId = randomUUID();
				const email = `age-probe-${userId.slice(0, 8)}@example.invalid`;
				db.insert(schema.users)
					.values({
						id: userId,
						email,
						passwordHash: "x",
						name: "Sam Rivera",
						role: "user",
					})
					.run();
				db.insert(schema.memoryAccounts)
					.values({ userId, tenantId: randomUUID(), authority: "hindsight" })
					.run();
				const bankId = `age-bank-${userId.slice(0, 8)}`;
				db.insert(schema.memoryBanks)
					.values({
						id: bankId,
						userId,
						scopeKey: "personal",
						epoch: 0,
						generation: "g",
					})
					.run();
				// Each fact was last said 13 months to 3 years before the turn,
				// so both "months ago" and "years ago" reach the model.
				const now = Date.now();
				const observations = TURNS.map((turn, index) => {
					const days = 400 + (index % 10) * 80 + (index < 10 ? 0 : 20);
					const fact = { id: `f-age-${index}`, text: turn.fact };
					db.insert(schema.memorySourceRevisions)
						.values({
							id: `s-age-${userId.slice(0, 8)}-${index}`,
							bankId,
							userId,
							epoch: 0,
							eventId: `age-${userId.slice(0, 8)}-${index}`,
							lineageId: `age-${userId.slice(0, 8)}-${index}`,
							text: turn.fact,
							context: "",
							textHash: "hash",
							assertedAt: new Date(now - days * DAY_MS),
							state: "accepted",
							acknowledgedFactsJson: JSON.stringify([fact]),
						})
						.run();
					db.insert(schema.memoryPublishedRows)
						.values({
							id: `r-age-${userId.slice(0, 8)}-${index}`,
							bankId,
							generation: "g",
							epoch: 0,
							nativeId: `n-age-${index}`,
							text: turn.fact,
							nativeText: turn.fact,
							sourceIdsJson: JSON.stringify([fact.id]),
							sourceFingerprintsJson: JSON.stringify([fact]),
							updatedAt: new Date(),
						})
						.run();
					return {
						id: `n-age-${index}`,
						text: turn.fact,
						fact_type: "observation",
						source_memory_ids: [fact.id],
					};
				});

				const verdicts: { language: "en" | "hu"; remark: string | null }[] = [];
				let unanswered = 0;
				for (const [index, turn] of TURNS.entries()) {
					// The turn's own fact first, then three other old facts.
					ranking = [0, 5, 10, 15].map(
						(offset) => observations[(index + offset) % observations.length],
					);
					const before = sent.length;
					const conversation = await createConversation(userId);
					const result = await runPlainNormalChatSendModel({
						userId,
						runtimeConfig: getConfig(),
						message: turn.question,
						conversationId: conversation.id,
						modelId: "model1",
						user: { id: userId, displayName: "Sam Rivera", email },
						depthMetadata: buildBaselineDepthMetadata({
							reasoningDepth: "thorough",
						}),
						enabledConnectionCapabilities: [],
						overrideProvider: {
							id: "age-probe",
							modelId: "model1",
							name: "age-probe",
							displayName: "Flash-Next",
							baseUrl: MODEL_URL,
							modelName: MODEL_NAME,
							apiKey,
						},
					});
					// The probe measures nothing unless the model was sent the
					// fact with its age, as the memory section writes it.
					const aged = new RegExp(
						`- ${escapeRegExp(turn.fact)} \\(said \\d+ (?:months|years) ago\\)`,
					);
					expect(
						sent.slice(before).some((body) => aged.test(sentText(body))),
						`turn ${index + 1} sent the fact with its age`,
					).toBe(true);
					const reply = result.text.trim();
					if (!reply) unanswered += 1;
					const remark = reply ? ageRemark(reply) : null;
					verdicts.push({ language: turn.language, remark });
					console.log(
						`[age-probe] ${String(index + 1).padStart(2, "0")}/${TURNS.length} ${turn.language} ${
							!reply ? "NO REPLY" : remark ? `FLAGGED ("${remark}")` : "OK"
						}\n${reply}\n`,
					);
				}

				const flagged = (language?: "en" | "hu") =>
					verdicts.filter(
						(verdict) =>
							verdict.remark !== null &&
							(!language || verdict.language === language),
					).length;
				// Counts only.
				writeFileSync(
					RESULTS,
					`${JSON.stringify(
						{
							at: new Date().toISOString(),
							model: MODEL_NAME,
							turns: TURNS.length,
							english: {
								turns: TURNS.filter((t) => t.language === "en").length,
								flagged: flagged("en"),
							},
							hungarian: {
								turns: TURNS.filter((t) => t.language === "hu").length,
								flagged: flagged("hu"),
							},
							flagged: flagged(),
							unanswered,
							passAtMost: PASS_AT_MOST,
							pass: unanswered === 0 && flagged() <= PASS_AT_MOST,
						},
						null,
						2,
					)}\n`,
				);
				expect.soft(unanswered, "every turn was answered").toBe(0);
				expect(
					flagged(),
					"replies that remark on age or doubt",
				).toBeLessThanOrEqual(PASS_AT_MOST);
			} finally {
				vi.unstubAllGlobals();
			}
		}, 3_600_000);
	},
);
