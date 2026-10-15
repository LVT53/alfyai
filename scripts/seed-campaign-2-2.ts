#!/usr/bin/env tsx
// Seeds the sample content the AlfyAI 2.2 release campaign's screenshots are taken from:
// one Hungarian user with personal instructions, a project with instructions and files, chats
// that made a Document (with tabs, a table and a checklist), a Canvas board (frames, notes, a
// chart, a checklist and drawn marks), an App that Alfy checked and a File, a Document with a
// followable history (a named version, a change Alfy made that the user kept, a change that is
// still waiting for Keep or Undo and a margin comment that asks @Alfy), and a reply whose
// picture was not loaded.
//
// Everything here is invented sample content in Hungarian: no real person, address or file.
// It is written through the same services the app uses (`artifacts`, `projects`, the knowledge
// upload intake), never as hand-built rows, so the screenshots show what the product does.
//
// Run it on a FRESH database file only (it refuses to run twice), with the server stopped:
//   rm -f data/campaign-2-2.db data/campaign-2-2.db-shm data/campaign-2-2.db-wal
//   DATABASE_PATH=$PWD/data/campaign-2-2.db npm run db:prepare
//   DATABASE_PATH=$PWD/data/campaign-2-2.db npx tsx scripts/seed-campaign-2-2.ts
// It writes `<database dir>/campaign-2-2-manifest.json` (ids and the sign-in) for
// `scripts/campaign-shots-2-2.ts`.

import { config as dotenvConfig } from "dotenv";

dotenvConfig();
if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET =
		"campaign-seed-session-secret-12345678901234567890";
}
if (!process.env.DATABASE_PATH)
	process.env.DATABASE_PATH = "./data/campaign-2-2.db";

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The one user the screenshots sign in as. A local scratch account on a scratch database. */
export const SAMPLE_USER = {
	email: "anna@campaign.local",
	password: "Campaign-2-2-demo",
	name: "Anna Kovács",
} as const;

// ---------------------------------------------------------------------------
// Time. Nothing may lie in the future (a project page would say "in 7 hours"), and a day
// that "today" belongs to must look like a working day, so the story is told in a fixed-offset
// zone chosen so that the local time of the seed run is mid-afternoon. The screenshot browser
// uses the same zone (the manifest carries it), so History groups by the days drawn here.
// ---------------------------------------------------------------------------

function storyTimeZone(): string {
	const utcHour = new Date().getUTCHours();
	let offset = (((16 - utcHour) % 24) + 24) % 24; // local = utc + offset
	if (offset > 12) offset -= 24;
	if (offset === 0) return "Etc/UTC";
	// The IANA names are inverted: Etc/GMT+7 is seven hours BEHIND UTC.
	return `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

const TIME_ZONE = storyTimeZone();

function zoneOffsetMinutes(at: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: TIME_ZONE,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return Math.round((asUtc - at.getTime()) / 60000);
}

/** `daysAgo` days back from today (in the story's zone), at HH:MM on that zone's clock. */
function wall(daysAgo: number, hhmm: string): Date {
	const [hour, minute] = hhmm.split(":").map(Number);
	const now = new Date();
	const local = new Date(now.getTime() + zoneOffsetMinutes(now) * 60000);
	const utcMidnight = Date.UTC(
		local.getUTCFullYear(),
		local.getUTCMonth(),
		local.getUTCDate() - daysAgo,
		hour,
		minute,
	);
	const guess = new Date(utcMidnight);
	return new Date(utcMidnight - zoneOffsetMinutes(guess) * 60000);
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

const PROJECT_NAME = "Balatoni nyaralás";
const PROJECT_INSTRUCTIONS = [
	"Magyarul válaszolj, és tegezz.",
	"Négyen utazunk: két felnőtt és két gyerek (6 és 9 éves).",
	"A keret 450 000 Ft, ebbe belefér a szállás, az étkezés és a programok.",
	"A szállás legyen közel a strandhoz, és a gyerekeknek legyen mit csinálni.",
	"Az árakat mindig forintban add meg, és jelöld, ha valamit nem tudsz biztosan.",
].join("\n");

const PERSONAL_INSTRUCTIONS = [
	"Magyarul válaszolj, és tegezz.",
	"Röviden és lényegre törően írj, a hosszú felsorolások helyett inkább összefüggő mondatokat.",
	"Ha valamiben nem vagy biztos, mondd ki.",
].join("\n");

const PROJECT_FILES: { name: string; text: string }[] = [
	{
		name: "szallas-ajanlatok.txt",
		text: [
			"Szállásajánlatok, Balaton (3 éjszaka, 2 felnőtt és 2 gyerek)",
			"",
			"1. Vitorlás Vendégház, Balatonfüred",
			"   Ár: 118 000 Ft / 3 éjszaka. A strand 10 perc séta. Kert, grillező, két hálószoba.",
			"   Lemondás: 7 nappal az érkezés előtt ingyenes.",
			"",
			"2. Nádas Apartman, Szigliget",
			"   Ár: 96 000 Ft / 3 éjszaka. A strand 5 perc séta. Erkély, játszótér az udvaron.",
			"   Egy hálószoba és egy kanapéágy. Lemondás: nem módosítható.",
			"",
			"3. Pihenő Panzió, Balatonföldvár",
			"   Ár: 134 000 Ft / 3 éjszaka. A strand 15 perc séta. Reggeli az árban, medence.",
			"   Lemondás: 3 nappal az érkezés előtt ingyenes.",
			"",
		].join("\n"),
	},
	{
		name: "gyerekprogramok.txt",
		text: [
			"Gyerekprogramok, ötletek",
			"",
			"- Tihany: Visszhang-domb, apátság, rövid séta a félszigeten.",
			"- Füred: sétány, kikötő, fagylalt, játszótér a parton.",
			"- Szigliget: vár és kilátó, kb. 40 perc séta felfelé.",
			"- Esős napra: játszóház vagy múzeum a környéken.",
			"- A kisebbik gyerek 20 perc után elfárad a túrán, ezért kell köztes pihenő.",
			"",
		].join("\n"),
	},
	{
		name: "koltsegterv.txt",
		text: [
			"Költségterv (Ft)",
			"",
			"Szállás, 3 éjszaka: 118 000",
			"Étkezés: 95 000",
			"Utazás (benzin, autópálya-matrica): 42 000",
			"Programok és belépők: 38 000",
			"Tartalék: 50 000",
			"Összesen: 343 000, a keret 450 000",
			"",
		].join("\n"),
	},
];

const PLAN_V1 = [
	"# Háromnapos program a Balatonon",
	"",
	"Négyen utazunk: két felnőtt és két gyerek (6 és 9 éves). A szállás Balatonfüreden lesz, onnan a strand gyalog tíz perc.",
	"",
	"## Péntek – érkezés",
	"",
	"- Délután érkezés és bepakolás.",
	"- Séta a füredi sétányon, fagyi a kikötőnél.",
	"- Vacsora a szálláson, korai lefekvés.",
	"",
	"## Szombat – Tihany",
	"",
	"- Reggeli után indulás Tihanyba, rövid séta a félszigeten.",
	"- A Tihanyi Apátság és a Visszhang-domb megnézése.",
	"- Ebéd egy halsütödében, utána strand.",
	"",
	"## Vasárnap – hazaút",
	"",
	"- Reggeli és kijelentkezés tízig.",
	"- Utolsó fürdés a strandon.",
	"- Indulás délután, hogy a gyerekek még a kocsiban elalhassanak.",
].join("\n");

const COMPARISON_MD = [
	"# Szállások összehasonlítása",
	"",
	"| | Vitorlás Vendégház | Nádas Apartman | Pihenő Panzió |",
	"| --- | --- | --- | --- |",
	"| Hely | Balatonfüred | Szigliget | Balatonföldvár |",
	"| Ár, 3 éjszaka | 118 000 Ft | 96 000 Ft | 134 000 Ft |",
	"| Strand | 10 perc séta | 5 perc séta | 15 perc séta |",
	"| Hálószoba | 2 | 1 és kanapéágy | 2 |",
	"| Lemondás | 7 nappal előtte ingyenes | nem módosítható | 3 nappal előtte ingyenes |",
	"",
	"## Javaslat",
	"",
	"A Vitorlás Vendégház a legjobb választás: két hálószoba, kert, és a lemondás is rugalmas. A Nádas Apartman olcsóbb, de négyen szűk, és nem módosítható a foglalás.",
	"",
	"## Teendők a foglalás előtt",
	"",
	"- [x] Lemondási feltételek átnézve",
	"- [x] Ár összevetve a kerettel (450 000 Ft)",
	"- [ ] Rákérdezni a gyerekágyra",
	"- [ ] Foglalás a Vitorlás Vendégházban",
	"- [ ] Előleg átutalása",
].join("\n");

const BUDGET_CSV = [
	"Tétel,Összeg (Ft)",
	"Szállás (3 éjszaka),118000",
	"Étkezés,95000",
	"Utazás (benzin és autópálya-matrica),42000",
	"Programok és belépők,38000",
	"Tartalék,50000",
	"Összesen,343000",
	"",
].join("\n");

const APP_PROMPT =
	"Egy kis alkalmazás, amivel követhetem a balatoni nyaralás költségeit a 450 000 forintos kerethez képest.";

const APP_HTML = `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Balatoni költségkeret</title>
<style>
  :root { --bg:#faf8f5; --card:#ffffff; --ink:#2b2420; --muted:#7a6f66; --line:#e8e1d9; --accent:#c4552d; --accent-soft:#f6e3da; --ok:#4f8a5b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif; }
  h1 { font-size:20px; margin:0 0 2px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); margin:0 0 16px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.06em; }
  .big { font-size:32px; font-weight:700; letter-spacing:-0.02em; margin:2px 0 0; }
  .big small { font-size:15px; font-weight:500; color:var(--muted); }
  .bar { height:10px; background:#efe9e1; border-radius:99px; overflow:hidden; margin:12px 0 6px; }
  .bar > i { display:block; height:100%; background:var(--accent); border-radius:99px; transition:width .25s ease; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:9px 0; border-top:1px solid var(--line); }
  .row:first-child { border-top:0; }
  .row b { font-weight:600; }
  .muted { color:var(--muted); }
  form { display:flex; gap:8px; flex-wrap:wrap; }
  input { font:inherit; padding:9px 11px; border:1px solid var(--line); border-radius:10px; background:#fff; color:var(--ink); min-width:0; }
  input[name=name] { flex:2 1 140px; }
  input[name=amount] { flex:1 1 90px; }
  button { font:inherit; font-weight:600; padding:9px 14px; border:0; border-radius:10px; background:var(--accent); color:#fff; cursor:pointer; }
  .pill { display:inline-block; padding:2px 9px; border-radius:99px; background:var(--accent-soft); color:var(--accent); font-size:12px; font-weight:600; }
</style>
</head>
<body>
<h1>Balatoni költségkeret</h1>
<p class="sub">Négyen, három éjszaka · keret: 450 000 Ft</p>

<div class="card">
  <div class="label">Eddig elköltve</div>
  <p class="big" id="spent">0 <small>Ft</small></p>
  <div class="bar"><i id="fill" style="width:0%"></i></div>
  <div class="muted" id="left"></div>
</div>

<div class="card">
  <div class="label" style="margin-bottom:6px">Kiadások</div>
  <div id="list"></div>
</div>

<div class="card">
  <div class="label" style="margin-bottom:8px">Új kiadás</div>
  <form id="add">
    <input name="name" placeholder="Mire?" required>
    <input name="amount" type="number" min="0" step="100" placeholder="Összeg (Ft)" required>
    <button type="submit">Hozzáadás</button>
  </form>
</div>

<script>
(function () {
  var BUDGET = 450000;
  var items = [
    { name: 'Szállás, 3 éjszaka', amount: 118000 },
    { name: 'Benzin és autópálya-matrica', amount: 42000 },
    { name: 'Vacsora a kikötőnél', amount: 14500 },
    { name: 'Belépők, Tihany', amount: 9800 }
  ];
  var list = document.getElementById('list');
  var spent = document.getElementById('spent');
  var fill = document.getElementById('fill');
  var left = document.getElementById('left');
  function ft(n) { return n.toLocaleString('hu-HU') + ' Ft'; }
  function render() {
    var total = items.reduce(function (sum, item) { return sum + item.amount; }, 0);
    spent.innerHTML = total.toLocaleString('hu-HU') + ' <small>Ft</small>';
    fill.style.width = Math.min(100, Math.round(total / BUDGET * 100)) + '%';
    left.textContent = 'Még ' + ft(Math.max(0, BUDGET - total)) + ' fér bele a keretbe';
    list.innerHTML = '';
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span>' + item.name.replace(/</g, '&lt;') + '</span><b>' + ft(item.amount) + '</b>';
      list.appendChild(row);
    });
  }
  function save() {
    if (window.alfy && window.alfy.storage) window.alfy.storage.set('items', items);
  }
  document.getElementById('add').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    items.push({ name: form.name.value, amount: Number(form.amount.value) });
    form.reset();
    save();
    render();
  });
  render();
  if (window.alfy && window.alfy.storage) {
    window.alfy.storage.get('items').then(function (saved) {
      if (Array.isArray(saved) && saved.length) { items = saved; render(); }
    });
  }
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// The board: three frames (a day each) and a packing list
// ---------------------------------------------------------------------------

type BoardNode = Record<string, unknown>;

function boardBody(): {
	version: 1;
	nodes: BoardNode[];
	edges: unknown[];
	viewport: { x: number; y: number; zoom: number };
	annotations: unknown[];
} {
	const FRAME_W = 280;
	const frame = (
		id: string,
		x: number,
		label: string,
		height: number,
	): BoardNode => ({
		id,
		type: "frame",
		position: { x, y: 0 },
		width: FRAME_W,
		height,
		data: { kind: "frame", label, width: FRAME_W, height },
	});
	const note = (
		id: string,
		parentId: string,
		y: number,
		text: string,
		tone: "yellow" | "mint" | "blue" | "plain",
	): BoardNode => ({
		id,
		type: "sticky",
		parentId,
		position: { x: 20, y },
		width: 240,
		data: { kind: "sticky", text, tone },
	});
	return {
		version: 1,
		nodes: [
			frame("day-1", 0, "Péntek – érkezés", 330),
			note("d1-a", "day-1", 56, "Érkezés délután, bepakolás", "yellow"),
			note("d1-b", "day-1", 140, "Séta a sétányon, fagyi a kikötőnél", "mint"),
			note("d1-c", "day-1", 224, "Vacsora a szálláson", "blue"),
			frame("day-2", 330, "Szombat – Tihany", 330),
			note(
				"d2-a",
				"day-2",
				56,
				"Tihanyi Apátság és a Visszhang-domb",
				"yellow",
			),
			note("d2-b", "day-2", 140, "Ebéd a halsütödében", "mint"),
			note("d2-c", "day-2", 224, "Strand délután", "blue"),
			frame("day-3", 660, "Vasárnap – hazaút", 330),
			note("d3-a", "day-3", 56, "Reggeli és kijelentkezés", "yellow"),
			note("d3-b", "day-3", 140, "Utolsó fürdés", "mint"),
			note("d3-c", "day-3", 224, "Indulás délután", "blue"),
			{
				id: "packing",
				type: "checklist",
				position: { x: 0, y: 380 },
				width: 300,
				data: {
					kind: "checklist",
					label: "Ne felejtsük el",
					items: [
						{ id: "p1", text: "Fényvédő és napkalap", done: true },
						{ id: "p2", text: "Úszógumi és strandpapucs", done: true },
						{ id: "p3", text: "Tartalék ruha a gyerekeknek", done: false },
						{ id: "p4", text: "Hűtőtáska az útra", done: false },
						{ id: "p5", text: "Autópálya-matrica", done: false },
					],
				},
			},
			{
				id: "rain",
				type: "sticky",
				position: { x: 330, y: 400 },
				width: 280,
				data: {
					kind: "sticky",
					text: "Esős napra: játszóház vagy múzeum a környéken, a strand átkerül vasárnap reggelre.",
					tone: "plain",
				},
			},
			{
				id: "costs",
				type: "chart",
				position: { x: 660, y: 380 },
				width: 360,
				data: {
					kind: "chart",
					label: "Tervezett kiadások (ezer Ft)",
					code: JSON.stringify({
						type: "bar",
						data: {
							labels: ["Szállás", "Étkezés", "Utazás", "Programok", "Tartalék"],
							datasets: [{ label: "ezer Ft", data: [118, 95, 42, 38, 50] }],
						},
						options: { plugins: { legend: { display: false } } },
					}),
				},
			},
		],
		edges: [
			{ id: "e1", source: "day-1", target: "day-2" },
			{ id: "e2", source: "day-2", target: "day-3" },
		],
		viewport: { x: 0, y: 0, zoom: 1 },
		// What a reader draws by hand: a ring round the beach slot, an arrow to the rain plan, a word.
		annotations: [
			{
				id: "m1",
				kind: "ellipse",
				color: "var(--ink-red)",
				size: 3,
				from: { x: 340, y: 214 },
				to: { x: 604, y: 302 },
			},
			{
				id: "m2",
				kind: "arrow",
				color: "var(--ink-red)",
				size: 3,
				from: { x: 472, y: 306 },
				to: { x: 472, y: 394 },
			},
			{
				id: "m3",
				kind: "text",
				color: "var(--ink-red)",
				size: 22,
				at: { x: 490, y: 338 },
				text: "ha esik",
			},
		],
	};
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const databasePath = resolve(
		process.env.DATABASE_PATH ?? "./data/campaign-2-2.db",
	);
	const bcrypt = (await import("bcryptjs")).default;
	const { eq, and } = await import("drizzle-orm");
	const { db } = await import("$lib/server/db/index");
	const schema = await import("$lib/server/db/schema");
	const artifactsFacade = await import("$lib/server/services/artifacts");
	const { createProject, updateProject } = await import(
		"$lib/server/services/projects"
	);
	const { completeKnowledgeUploadFromFile } = await import(
		"$lib/server/services/knowledge/upload-intake"
	);
	const { storeGeneratedFile } = await import(
		"$lib/server/services/chat-files"
	);
	const { fileProductionJob } = await import(
		"$lib/server/services/file-production/production-job"
	);
	const { enqueue } = await import("$lib/server/services/jobs");
	const { blockVisibleText, parseDocument } = await import(
		"$lib/shared/artifact-document/blocks"
	);
	const { makeAnchor } = await import("$lib/shared/artifact-document/anchor");
	const { VERSION_SUMMARY, madeAppSummary } = await import(
		"$lib/shared/artifacts/version-summaries"
	);
	const { ARTIFACT_TOUR_CONTENT_VERSION } = await import(
		"$lib/server/artifact-tour-defaults"
	);
	const { SHIPPED_ARTIFACT_TOUR_TYPES } = await import(
		"$lib/shared/artifacts/tours"
	);
	const { prepareCanvasBoard } = artifactsFacade;

	const existing = db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(eq(schema.users.email, SAMPLE_USER.email))
		.get();
	if (existing) {
		throw new Error(
			`${SAMPLE_USER.email} already exists in ${databasePath}. Start from a fresh database file (see the header).`,
		);
	}

	// -- the user ----------------------------------------------------------
	const userId = randomUUID();
	db.insert(schema.users)
		.values({
			id: userId,
			email: SAMPLE_USER.email,
			passwordHash: bcrypt.hashSync(SAMPLE_USER.password, 10),
			name: SAMPLE_USER.name,
			role: "admin",
			uiLanguage: "hu",
			theme: "light",
			personalInstructions: PERSONAL_INSTRUCTIONS,
		})
		.run();
	// The first-open tours are somebody else's screenshots: this reader has seen them.
	for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
		db.insert(schema.artifactTourStates)
			.values({
				id: randomUUID(),
				userId,
				artifactType: kind,
				contentKey: `default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
				status: "completed",
				slideCount: 3,
				lastSlide: 2,
			})
			.run();
	}

	// -- helpers -----------------------------------------------------------
	const sequenceByConversation = new Map<string, number>();
	const nextSequence = (conversationId: string) => {
		const next = (sequenceByConversation.get(conversationId) ?? 0) + 1;
		sequenceByConversation.set(conversationId, next);
		return next;
	};
	const addConversation = (
		title: string,
		updatedAt: Date,
		projectId: string | null,
	) => {
		const id = randomUUID();
		db.insert(schema.conversations)
			.values({ id, userId, title, projectId, createdAt: updatedAt, updatedAt })
			.run();
		return id;
	};
	const addMessage = (
		conversationId: string,
		role: "user" | "assistant",
		content: string,
		createdAt: Date,
		toolCalls?: unknown[],
	) => {
		const id = randomUUID();
		db.insert(schema.messages)
			.values({
				id,
				conversationId,
				messageSequence: nextSequence(conversationId),
				role,
				content,
				toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
				createdAt,
			})
			.run();
		return id;
	};
	const createCall = (
		callId: string,
		kind: "document" | "app" | "canvas",
		title: string,
		artifactId: string,
		input: Record<string, unknown>,
	) => ({
		type: "tool_call",
		callId,
		name: "create_artifact",
		input: { artifactType: kind, title, ...input },
		status: "done",
		outputSummary: `Created ${kind} "${title}"`,
		sourceType: "tool",
		metadata: {
			ok: true,
			artifactId,
			artifactKind: kind,
			artifactTitle: title,
		},
	});
	/** Puts a row's timestamps where the story says they were. */
	const backdate = (artifactId: string, createdAt: Date, updatedAt: Date) => {
		db.update(schema.artifacts)
			.set({ createdAt, updatedAt })
			.where(eq(schema.artifacts.id, artifactId))
			.run();
	};
	const setVersionTime = (versionId: string, at: Date) => {
		db.update(schema.artifactVersions)
			.set({ createdAt: at, startedAt: at })
			.where(eq(schema.artifactVersions.id, versionId))
			.run();
	};
	const versionIdOf = (artifactId: string, versionNumber: number) => {
		const row = db
			.select({ id: schema.artifactVersions.id })
			.from(schema.artifactVersions)
			.where(
				and(
					eq(schema.artifactVersions.artifactId, artifactId),
					eq(schema.artifactVersions.versionNumber, versionNumber),
				),
			)
			.get();
		if (!row) throw new Error(`No version ${versionNumber} on ${artifactId}`);
		return row.id;
	};
	const must = <T>(value: T | null | undefined, what: string): T => {
		if (value === null || value === undefined)
			throw new Error(`Seed step failed: ${what}`);
		return value;
	};

	// -- the projects ------------------------------------------------------
	const balaton = await createProject(userId, PROJECT_NAME);
	await updateProject(userId, balaton.id, {
		instructions: PROJECT_INSTRUCTIONS,
	});
	const reno = await createProject(userId, "Lakásfelújítás");
	const projectFileIds: string[] = [];
	for (const file of PROJECT_FILES) {
		const uploaded = await completeKnowledgeUploadFromFile({
			userId,
			conversationId: null,
			projectId: balaton.id,
			file: new File([file.text], file.name, { type: "text/plain" }),
			traceId: `campaign-2-2-${randomUUID()}`,
			startedAt: Date.now(),
			waitForExtraction: true,
		});
		projectFileIds.push(uploaded.artifact.id);
		// The files were added before the chats started.
		const addedAt = wall(3, "17:40");
		for (const artifactId of [
			uploaded.artifact.id,
			uploaded.normalizedArtifact?.id,
		]) {
			if (!artifactId) continue;
			db.update(schema.artifacts)
				.set({ createdAt: addedAt, updatedAt: addedAt })
				.where(eq(schema.artifacts.id, artifactId))
				.run();
		}
		db.update(schema.projectKnowledgeLinks)
			.set({ createdAt: addedAt })
			.where(eq(schema.projectKnowledgeLinks.artifactId, uploaded.artifact.id))
			.run();
	}

	// -- chat: the main one (Document, board, App, File) -------------------
	const planChat = addConversation(
		"Háromnapos program",
		wall(1, "21:30"),
		balaton.id,
	);
	addMessage(
		planChat,
		"user",
		"Állíts össze egy háromnapos programot a gyerekekkel a Balatonra. A szállásajánlatok a projekt fájljaiban vannak.",
		wall(2, "19:02"),
	);

	const plan = await artifactsFacade.createDocumentArtifact({
		userId,
		conversationId: planChat,
		title: "Háromnapos program",
		markdown: PLAN_V1,
		author: "alfy",
		summary: VERSION_SUMMARY.alfyFirstDraft,
	});
	setVersionTime(versionIdOf(plan.id, 1), wall(2, "19:05"));

	const prepared = prepareCanvasBoard(JSON.stringify(boardBody()));
	if (!prepared.ok)
		throw new Error(`The board was refused: ${prepared.reason}`);
	const boardCreated = await artifactsFacade.createArtifact({
		userId,
		conversationId: planChat,
		kind: "canvas",
		title: "Program napokra",
		body: prepared.json,
		author: "alfy",
		versionSummary: VERSION_SUMMARY.alfyFirstDraft,
	});
	const board = must(
		boardCreated.ok ? boardCreated.artifact : null,
		"the board",
	);
	setVersionTime(versionIdOf(board.id, 1), wall(2, "19:05"));
	backdate(board.id, wall(2, "19:05"), wall(2, "19:05"));
	backdate(plan.id, wall(2, "19:05"), wall(2, "19:05"));

	addMessage(
		planChat,
		"assistant",
		[
			"Összeállítottam a háromnapos programot Balatonfüredre, a Vitorlás Vendégház ajánlatát véve alapul: két hálószobás, van hozzá kert, és a strand tíz percre van.",
			"",
			"A szombatot Tihanyra építettem, mert az két gyerekkel is jól megoldható. Mellé készítettem egy táblát is, amin napokra bontva látod az egészet.",
		].join("\n"),
		wall(2, "19:05"),
		[
			createCall("seed-doc", "document", "Háromnapos program", plan.id, {
				body: PLAN_V1,
			}),
			createCall("seed-board", "canvas", "Program napokra", board.id, {
				body: prepared.json,
			}),
		],
	);

	addMessage(
		planChat,
		"user",
		"Szuper. Készíts egy kis alkalmazást, amivel követhetem a költségeket a 450 000 forintos kerethez képest, és egy táblázatot is a tervezett kiadásokról.",
		wall(2, "19:21"),
	);
	const appCreated = await artifactsFacade.createArtifact({
		userId,
		conversationId: planChat,
		kind: "app",
		title: "Balatoni költségkeret",
		body: APP_HTML,
		author: "alfy",
		versionSummary: madeAppSummary(APP_PROMPT),
		metadata: {
			glitchRuleIds: [],
			verification: { checked: true, verdict: "clean", reason: null },
		},
	});
	const app = must(appCreated.ok ? appCreated.artifact : null, "the App");
	setVersionTime(versionIdOf(app.id, 1), wall(2, "19:26"));
	backdate(app.id, wall(2, "19:26"), wall(2, "19:26"));

	const assistantFileMessage = addMessage(
		planChat,
		"assistant",
		[
			"Kész. A költségkeret alkalmazásban felveheted a kiadásokat, és megmutatja, mennyi fér még a keretbe.",
			"",
			"A tervezett kiadásokat egy táblázatban is összeszedtem, azt bármelyik táblázatkezelőben megnyithatod.",
		].join("\n"),
		wall(2, "19:26"),
		[
			createCall("seed-app", "app", "Balatoni költségkeret", app.id, {
				prompt: APP_PROMPT,
			}),
		],
	);
	const storedFile = await storeGeneratedFile(planChat, userId, {
		filename: "balatoni-koltsegvetes.csv",
		mimeType: "text/csv",
		content: Buffer.from(BUDGET_CSV, "utf8"),
		assistantMessageId: assistantFileMessage,
	});
	const fileArtifactId = randomUUID();
	const fileAt = wall(2, "19:26");
	db.insert(schema.artifacts)
		.values({
			id: fileArtifactId,
			userId,
			conversationId: planChat,
			type: "generated_output",
			retrievalClass: "durable",
			name: "balatoni-koltsegvetes.csv",
			mimeType: "text/csv",
			contentText: "Generated file: balatoni-koltsegvetes.csv",
			metadataJson: JSON.stringify({
				generatedFile: true,
				originalChatFileId: storedFile.id,
				generatedFilename: "balatoni-koltsegvetes.csv",
				documentLabel: "balatoni-koltsegvetes.csv",
				versionNumber: 1,
			}),
			createdAt: fileAt,
			updatedAt: fileAt,
		})
		.run();
	// A job that is already done, born through the engine (`born: succeeded`), with
	// the story's own time as its clock.
	const { row: fileJob } = await enqueue(fileProductionJob, {
		now: fileAt,
		born: { status: "succeeded" },
		values: {
			conversationId: planChat,
			assistantMessageId: assistantFileMessage,
			userId,
			title: "balatoni-koltsegvetes.csv",
			origin: "unified_produce",
			sourceMode: "inline_text",
		},
	});
	const jobId = fileJob.id;
	db.insert(schema.fileProductionJobFiles)
		.values({
			id: randomUUID(),
			jobId,
			chatGeneratedFileId: storedFile.id,
			sortOrder: 0,
			createdAt: fileAt,
		})
		.run();

	// -- the plan's history: a user's edit (named), Alfy's kept change, a change waiting ----
	// (The reader's own edit: an arrival time and a later check-out, saved the way the editor saves.)
	const planDetail = must(
		await artifactsFacade.getArtifact({
			userId,
			artifactId: plan.id,
			conversationId: planChat,
		}),
		"the plan",
	);
	const edited = must(planDetail.body, "the plan's body")
		.replace(
			"Délután érkezés és bepakolás.",
			"Délután négy körül érkezés és bepakolás.",
		)
		.replace("kijelentkezés tízig", "kijelentkezés tizenegyig");
	const saved = await artifactsFacade.saveDocumentBody({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
		// The editor sends the tab strip it has with every save.
		body: {
			markdown: edited,
			tabs: artifactsFacade.documentTabsFromMetadata(planDetail.metadata),
		},
		author: "user",
		summary: VERSION_SUMMARY.edited,
	});
	if (!saved.ok)
		throw new Error(`The reader's edit was refused: ${saved.reason}`);
	setVersionTime(versionIdOf(plan.id, 2), wall(1, "18:12"));
	const versionsAfterEdit = await artifactsFacade.listVersions({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
	});
	const editVersion = must(
		versionsAfterEdit.find((version) => version.versionNumber === 2),
		"the reader's version",
	);
	await artifactsFacade.nameVersion({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
		versionId: editVersion.id,
		label: "Ezt küldtem el a családnak",
	});

	// Alfy moves Sunday's departure; the reader keeps it.
	const planRead2 = await artifactsFacade.readDocumentForAlfy({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
	});
	const departure = must(
		planRead2.blocks.find((block) => block.text.includes("Indulás délután")),
		"the departure block",
	);
	const kept = await artifactsFacade.applyDocumentPatch({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
		patch: {
			patchId: randomUUID(),
			label: "Áttette a vasárnapi indulást 14 órára",
			ops: [
				{
					opId: randomUUID(),
					kind: "replaceRange",
					blockId: departure.blockId,
					baseHash: departure.hash,
					blockLabel: departure.label,
					find: "Indulás délután",
					text: "Indulás 14 órakor",
				},
			],
		},
	});
	if (!kept.ok || kept.result.applied !== 1) {
		throw new Error(`Alfy's first change was refused: ${JSON.stringify(kept)}`);
	}
	setVersionTime(versionIdOf(plan.id, 3), wall(1, "18:41"));
	const pendingNow = await artifactsFacade.getDocumentReviewState({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
	});
	if (!pendingNow.ok) throw new Error("The review state could not be read.");
	await artifactsFacade.acknowledgeDocumentReviewBlocks({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
		blockIds: pendingNow.pending.map((block) => block.blockId),
	});

	// The reader's margin question to @Alfy, and Alfy's answer: a change now waiting for Keep or Undo.
	const parsed = parseDocument(
		must(
			(
				await artifactsFacade.getArtifact({
					userId,
					artifactId: plan.id,
					conversationId: planChat,
				})
			)?.body,
			"the plan's body",
		),
		{ mint: false },
	);
	const lunchBlock = must(
		parsed.blocks.find((block) =>
			block.markdown.includes("Ebéd egy halsütödében"),
		),
		"the lunch block",
	);
	const quote = "Ebéd egy halsütödében, utána strand.";
	// An anchor the way the editor makes it: the quote and up to 24 characters of the block's
	// VISIBLE text on each side.
	const visible = blockVisibleText(lunchBlock);
	const quoteAt = visible.indexOf(quote);
	if (quoteAt < 0)
		throw new Error("The lunch line is not in its block's visible text.");
	const anchor = must(
		makeAnchor({
			blockId: lunchBlock.id,
			quote,
			prefix: visible.slice(0, quoteAt),
			suffix: visible.slice(quoteAt + quote.length),
		}),
		"the anchor",
	);
	const question = must(
		await artifactsFacade.createComment({
			userId,
			artifactId: plan.id,
			conversationId: planChat,
			anchor,
			author: "user",
			body: "@Alfy mi legyen, ha szombaton esik az eső?",
		}),
		"the question",
	);
	const planRead3 = await artifactsFacade.readDocumentForAlfy({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
	});
	const lunch = must(
		planRead3.blocks.find((block) =>
			block.text.includes("Ebéd egy halsütödében"),
		),
		"the lunch block (read)",
	);
	const answered = await artifactsFacade.applyDocumentPatch({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
		patch: {
			patchId: `alfy-comment-${question.id}`,
			label: VERSION_SUMMARY.alfyCommentReply,
			ops: [
				{
					opId: randomUUID(),
					kind: "replaceRange",
					blockId: lunch.blockId,
					baseHash: lunch.hash,
					blockLabel: lunch.label,
					find: "Ebéd egy halsütödében, utána strand.",
					text: "Ebéd egy halsütödében, utána strand. Ha esik: játszóház vagy múzeum a közelben, a strand pedig átkerül vasárnap reggelre.",
				},
			],
		},
	});
	if (!answered.ok || answered.result.applied !== 1) {
		throw new Error(`Alfy's answer was refused: ${JSON.stringify(answered)}`);
	}
	setVersionTime(versionIdOf(plan.id, 4), wall(1, "21:30"));
	await artifactsFacade.createComment({
		userId,
		artifactId: plan.id,
		conversationId: planChat,
		anchor: null,
		parentId: question.id,
		author: "alfy",
		body: "Beírtam egy esős napi alternatívát a szombati ebéd mellé: ha esik, játszóház vagy múzeum, a strand pedig átkerül vasárnap reggelre.",
	});
	// Where the questions were asked, as the story has it.
	db.update(schema.artifactComments)
		.set({ createdAt: wall(1, "21:28") })
		.where(eq(schema.artifactComments.id, question.id))
		.run();
	db.update(schema.artifactComments)
		.set({ createdAt: wall(1, "21:30") })
		.where(
			and(
				eq(schema.artifactComments.artifactId, plan.id),
				eq(schema.artifactComments.parentId, question.id),
			),
		)
		.run();
	db.update(schema.artifacts)
		.set({ updatedAt: wall(1, "21:30") })
		.where(eq(schema.artifacts.id, plan.id))
		.run();

	// -- chat: the comparison ---------------------------------------------
	const compareChat = addConversation(
		"Szállások összehasonlítása",
		wall(3, "18:30"),
		balaton.id,
	);
	addMessage(
		compareChat,
		"user",
		"Hasonlítsd össze a három szállásajánlatot a projekt fájljai alapján.",
		wall(3, "18:24"),
	);
	// Two tabs, the way a Document with sections has them: the comparison, and what is left to do.
	const comparisonParsed = parseDocument(COMPARISON_MD);
	const todoBlock = must(
		comparisonParsed.blocks.find((block) =>
			block.markdown.includes("Teendők a foglalás előtt"),
		),
		"the to-do heading",
	);
	const comparisonCreated = await artifactsFacade.createArtifact({
		userId,
		conversationId: compareChat,
		kind: "document",
		title: "Szállások összehasonlítása",
		body: comparisonParsed.markdown,
		metadata: {
			tabs: [
				{
					id: randomUUID(),
					title: "Összehasonlítás",
					startBlockId: must(comparisonParsed.blocks[0], "the first block").id,
				},
				{
					id: randomUUID(),
					title: "Teendők",
					startBlockId: todoBlock.id,
				},
			],
		},
		author: "alfy",
		versionSummary: VERSION_SUMMARY.alfyFirstDraft,
	});
	const comparison = must(
		comparisonCreated.ok ? comparisonCreated.artifact : null,
		"the comparison",
	);
	setVersionTime(versionIdOf(comparison.id, 1), wall(3, "18:30"));
	backdate(comparison.id, wall(3, "18:30"), wall(3, "18:30"));
	addMessage(
		compareChat,
		"assistant",
		[
			"A három ajánlat közül a Vitorlás Vendégház a legjobb választás: két hálószobás, van hozzá kert, és a lemondás 7 nappal előtte ingyenes. A Nádas Apartman olcsóbb (96 000 Ft), de négyen szűk, és a foglalás nem módosítható.",
			"",
			"Az összehasonlítást dokumentumba is tettem.",
		].join("\n"),
		wall(3, "18:30"),
		[
			createCall(
				"seed-compare",
				"document",
				"Szállások összehasonlítása",
				comparison.id,
				{ body: COMPARISON_MD },
			),
		],
	);

	// -- chat: replies whose pictures were not loaded ----------------------
	const photoChat = addConversation(
		"A szállások képei",
		wall(1, "09:40"),
		balaton.id,
	);
	addMessage(
		photoChat,
		"user",
		"Mutass képeket a három szállásról, hogy lássam, milyen az udvaruk.",
		wall(1, "09:36"),
	);
	addMessage(
		photoChat,
		"assistant",
		[
			"A szállásadók oldalain találtam képeket az udvarokról:",
			"",
			"![Vitorlás Vendégház](https://vitorlas-haz.example/galeria/kert.jpg)",
			"",
			"![Nádas Apartman](https://nadas-apartman.example/galeria/udvar.jpg)",
			"",
			"![Pihenő Panzió](https://piheno-panzio.example/galeria/medence.jpg)",
			"",
			"Az oldalaik: [Vitorlás Vendégház](https://vitorlas-haz.example/), [Nádas Apartman](https://nadas-apartman.example/), [Pihenő Panzió](https://piheno-panzio.example/)",
		].join("\n"),
		wall(1, "09:40"),
	);

	// -- chat: the packing list --------------------------------------------
	const packChat = addConversation(
		"Csomaglista gyerekekkel",
		wall(4, "21:05"),
		balaton.id,
	);
	addMessage(
		packChat,
		"user",
		"Mit vigyünk magunkkal egy balatoni hétvégére két gyerekkel?",
		wall(4, "21:00"),
	);
	const packReply = addMessage(
		packChat,
		"assistant",
		[
			"Ezeket érdemes elvinni:",
			"",
			"- fényvédő, napkalap, törölköző",
			"- úszógumi, strandpapucs, tartalék ruha",
			"- játékok a strandra és a kocsiba",
			"- hűtőtáska innivalóval és rágcsálnivalóval",
			"- az autópálya-matrica igazolása",
		].join("\n"),
		wall(4, "21:05"),
	);
	// The two follow-ups under the reply: what the reader might send next, in their own words.
	db.update(schema.messages)
		.set({
			metadataJson: JSON.stringify({
				followUps: [
					"Készíts ebből ellenőrzőlistát",
					"Mi férjen a hűtőtáskába?",
				],
			}),
		})
		.where(eq(schema.messages.id, packReply))
		.run();

	// -- chats outside the project ------------------------------------------
	const menuChat = addConversation(
		"Heti menü és bevásárlólista",
		wall(1, "18:10"),
		null,
	);
	addMessage(
		menuChat,
		"user",
		"Adj egy egyszerű heti menüt négy főre, legyen benne pár gyerekbarát vacsora.",
		wall(1, "18:05"),
	);
	addMessage(
		menuChat,
		"assistant",
		[
			"Íme egy egyszerű heti menü:",
			"",
			"- Hétfő: sajtos tészta, saláta",
			"- Kedd: csirkemell zöldségekkel, rizs",
			"- Szerda: lecsó kolbásszal",
			"- Csütörtök: húsleves, palacsinta",
			"- Péntek: sült krumpli, tükörtojás",
		].join("\n"),
		wall(1, "18:10"),
	);
	const washerChat = addConversation(
		"A mosógép hibakódja",
		wall(6, "17:20"),
		null,
	);
	addMessage(
		washerChat,
		"user",
		"A mosógép kijelzőjén E21 látszik. Mit jelent?",
		wall(6, "17:15"),
	);
	addMessage(
		washerChat,
		"assistant",
		"Az E21 a legtöbb mosógépen azt jelzi, hogy a víz nem folyik le. Nézd meg a szivattyú szűrőjét és a lefolyótömlőt, hogy nincs-e eltömődve.",
		wall(6, "17:20"),
	);
	const renoChat = addConversation(
		"Festés: mennyi festék kell?",
		wall(5, "19:40"),
		reno.id,
	);
	addMessage(
		renoChat,
		"user",
		"Egy 4 x 3,5 méteres szoba falát festeném, mennyi festék kell?",
		wall(5, "19:35"),
	);
	addMessage(
		renoChat,
		"assistant",
		"Egy ekkora szobához, 2,6 méteres belmagassággal, nagyjából 39 négyzetméter falfelület van. Két réteghez kb. 5 liter festék elég, ha az ablakokat és az ajtót nem számolod le.",
		wall(5, "19:40"),
	);

	// -- done: the manifest -------------------------------------------------
	const manifest = {
		timeZone: TIME_ZONE,
		user: {
			email: SAMPLE_USER.email,
			password: SAMPLE_USER.password,
			id: userId,
		},
		project: { id: balaton.id, name: PROJECT_NAME, fileIds: projectFileIds },
		otherProject: { id: reno.id },
		conversations: {
			plan: planChat,
			comparison: compareChat,
			photo: photoChat,
			packing: packChat,
		},
		artifacts: {
			plan: plan.id,
			board: board.id,
			app: app.id,
			file: fileArtifactId,
			comparison: comparison.id,
		},
		question: question.id,
	};
	const manifestPath = join(
		dirname(databasePath),
		"campaign-2-2-manifest.json",
	);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Seeded ${SAMPLE_USER.email}. Manifest: ${manifestPath}`);
}

await main();
