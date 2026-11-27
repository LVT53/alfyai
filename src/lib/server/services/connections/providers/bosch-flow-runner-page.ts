import type { BoschDetailGrant } from "./bosch-flow-details";
export const runnerWords = {
	en: {
		permissions: "Access for future cycling questions",
		fullScope:
			"Allow AlfyAI to read your Bosch bike and service records, component identifiers, dealer notes, ride statistics, fitness measurements and precise ride locations when you ask.",
		allowAll: "Allow all supported data",
		choose: "Choose which data to allow",
		saveService:
			"Your private helper will save your credentials on this server and keep this access after restart.",
		permissionsHint:
			"Select the data AlfyAI may fetch when you ask. Leave all unchecked to share only your existing ride summary. You can change these choices here.",
		details:
			"Bike profile and pass, frame and component serial numbers, registrations, battery tests, software updates, dealer names and addresses, workshop notes, and ride statistics including speed and altitude",
		fitness:
			"Cadence, rider power and calories for the selected ride, including recorded samples",
		location: "Precise locations and routes for the selected ride",
		savePermissions: "Save data permissions",

		enabled: "Bike data is fetched when you ask AlfyAI a cycling question.",
		stopDemand: "Stop on-demand access",
		noRefresh:
			"Bosch did not issue a refresh token. Reauthorize before enabling unattended access.",
		launch:
			"Open the private setup link printed by the runner in your terminal.",
		denied: "This request is unavailable.",
		busy: "Another request is running. Return to setup when it finishes.",
		invalid: "Check your pairing key, personal client details or login state.",
		oauth: "Bosch did not complete sign-in.",
		stale: "This preview has expired. Return to setup for a new preview.",
		pairing:
			"The AlfyAI pairing key is no longer valid. Pair again in Connections.",
		syncError:
			"AlfyAI did not accept the summary. Return to setup to review it again.",
		failed:
			"Could not finish. Check your Bosch client, data release and internet connection, then return to setup.",
		title: "Bosch eBike Flow",
		sub: "Connect your own bike",
		intro:
			"Use your personal Bosch Data Act client and the pairing key from AlfyAI Connections.",
		key: "AlfyAI pairing key",
		client: "Bosch client ID",
		secret: "Bosch client secret (if issued)",
		remember:
			"Save my client, refresh credential and AlfyAI pairing key privately on this computer for future syncs.",
		sign: "Sign in with Bosch",
		review: "Review your ride summary",
		info: "The one-time summary contains the fields below. Choose separately what AlfyAI can read for future questions.",
		bikes: "Bikes",
		rides: "Rides",
		partial: "This snapshot is partial. Some records could not be included.",
		summaryFields: "View all fields",
		confirm: "Send this summary to AlfyAI",
		discard: "Discard",
		saved: "Saved setup",
		preview: "Fetch a fresh preview",
		forget: "Forget saved credentials",
		done: "Your ride summary was sent to AlfyAI.",
		stop: "Press Ctrl+C in the terminal to close this local helper.",
	},
	hu: {
		permissions: "Hozzáférés a későbbi kerékpáros kérdésekhez",
		fullScope:
			"Az AlfyAI a kérdéseidhez lekérheti a Bosch kerékpár és a szerviz adatait, az alkatrészazonosítókat, a szerviz megjegyzéseit, a túrastatisztikákat, a teljesítményadatokat és a túrák pontos helyadatait.",
		allowAll: "Minden támogatott adat engedélyezése",
		choose: "Az engedélyezett adatok kiválasztása",
		saveService:
			"A privát segéd ezen a szerveren menti a hitelesítő adataidat, és újraindítás után is megtartja ezt a hozzáférést.",
		permissionsHint:
			"Válaszd ki, milyen adatokat kérhet le az AlfyAI a kérdéseidhez. Ha egyiket sem jelölöd be, továbbra is csak a túraösszesítés érhető el. A választásaidat itt módosíthatod.",
		details:
			"Kerékpárprofil és kerékpárútlevél, váz- és sorozatszámok, regisztrációk, akkumulátortesztek, szoftverfrissítések, szerviznevek, címek és megjegyzések, valamint túraadatok, köztük sebesség és magasság",
		fitness:
			"A kiválasztott túra pedálfordulata, kerékpáros teljesítménye és kalóriaadatai, a rögzített mintákkal együtt",
		location: "A kiválasztott túra pontos helyadatai és útvonala",
		savePermissions: "Adathozzáférés mentése",

		enabled:
			"Az AlfyAI akkor kér le kerékpáros adatokat, amikor erről kérdezel.",
		stopDemand: "Igény szerinti hozzáférés leállítása",
		noRefresh:
			"Jelentkezz be újra a felügyelet nélküli hozzáférés engedélyezéséhez.",
		launch: "Nyisd meg a terminálban kiírt privát beállítási hivatkozást.",
		denied: "Ez a kérés nem érhető el.",
		busy: "Egy másik kérés még folyamatban van. Utána térj vissza a beállításokhoz.",
		invalid:
			"Ellenőrizd a párosítási kulcsot, a kliens adatait és a bejelentkezést.",
		oauth: "A Bosch-bejelentkezés nem fejeződött be.",
		stale: "Az előnézet lejárt. Kérj új előnézetet a beállításoknál.",
		pairing:
			"A párosítási kulcs már érvénytelen. Párosítsd újra a Kapcsolatoknál.",
		syncError:
			"Az AlfyAI nem fogadta el az összesítést. Térj vissza az előnézethez.",
		failed:
			"A művelet nem sikerült. Ellenőrizd a Bosch-kliens adatait, az adatengedélyt és az internetkapcsolatot.",
		title: "Bosch eBike Flow",
		sub: "Kapcsold össze a kerékpárodat",
		intro:
			"Add meg a személyes Bosch Data Act-kliensed adatait és az AlfyAI Kapcsolatok oldalán kapott párosítási kulcsot.",
		key: "AlfyAI párosítási kulcs",
		client: "Bosch kliensazonosító",
		secret: "Bosch kliens titkos kulcsa (ha kaptál)",
		remember:
			"A kliensadatok, a frissítési adat és a párosítási kulcs mentése ezen a gépen a későbbi szinkronizáláshoz.",
		sign: "Bejelentkezés a Boschnál",
		review: "Tekintsd át a túrák összesítését",
		info: "Az egyszeri összesítés az alábbi mezőket tartalmazza. Külön választhatod ki, hogy a későbbi kérdésekhez mit olvashat az AlfyAI.",
		bikes: "Kerékpárok",
		rides: "Túrák",
		partial: "Ez részleges összesítés. Néhány adat hiányzik.",
		summaryFields: "Összes mező",
		confirm: "Összesítés küldése az AlfyAI-nak",
		discard: "Elvetés",
		saved: "Mentett beállítások",
		preview: "Új előnézet lekérése",
		forget: "Mentett hitelesítő adatok törlése",
		done: "Az összesítést elküldtük az AlfyAI-nak.",
		stop: "A helyi segéd bezárásához nyomj Ctrl+C-t a terminálban.",
	},
} as const;
const esc = (v: string) =>
	v
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
type Data = {
	hu: boolean;
	csrf: string;
	prepared: {
		snapshot: { bikes: unknown[]; rides: unknown[]; complete: boolean };
		review: string;
	} | null;
	saved: boolean;
	completed: boolean;
	canSave: boolean;
	demand: boolean;
	dataGrants: BoschDetailGrant[];
	approval: string | null;
	service: boolean;
};
export function runnerPage(d: Data) {
	const w = runnerWords[d.hu ? "hu" : "en"];
	const form = (path: string, content: string) =>
		`<form method="post" action="${path}"><input type="hidden" name="csrf" value="${esc(d.csrf)}">${content}</form>`;
	const field = (
		name: string,
		label: string,
		type: string,
		required: boolean,
	) =>
		`<label>${label}<input type="${type}" name="${name}" autocomplete="off" ${required ? "required" : ""}></label>`;
	const button = (s: string, secondary = false) =>
		`<button${secondary ? ' class="secondary"' : ""}>${s}</button>`;
	const review = d.prepared;
	const screen = review
		? `<h1>${w.review}</h1><p>${w.info}</p><p>${w.bikes} · ${review.snapshot.bikes.length} &nbsp; ${w.rides} · ${review.snapshot.rides.length}</p>${review.snapshot.complete ? "" : `<p>${w.partial}</p>`}<details><summary>${w.summaryFields}</summary><pre>${esc(JSON.stringify(review.snapshot, null, 2))}</pre></details>`
		: (d.completed ? `<p role="status">${w.done}</p>` : "") +
			(d.saved
				? `<h1>${w.saved}</h1>${form("/refresh", button(w.preview))}${form("/forget", button(w.forget, true))}`
				: `<h1>${w.sub}</h1><p>${w.intro}</p>${form("/authorize", field("pairing", w.key, "password", true) + field("clientId", w.client, "text", true) + field("clientSecret", w.secret, "password", false) + (d.canSave ? `<label class="check"><input name="remember" value="yes" type="checkbox">${w.remember}</label>` : "") + button(w.sign))}`);
	const onceActions = review
		? form(
				"/sync",
				`<input type="hidden" name="review" value="${esc(review.review)}">${button(w.confirm, true)}`,
			) + form("/discard", button(w.discard, true))
		: "";
	const path = d.demand ? "/permissions" : "/enable";
	const reviewInput = d.approval
		? `<input type="hidden" name="review" value="${esc(d.approval)}">`
		: "";
	const groups = ["details", "fitness", "location"] as const;
	const allFields = groups
		.map((grant) => `<input type="hidden" name="grant" value="${grant}">`)
		.join("");
	const checkboxes = groups
		.map(
			(grant) =>
				`<label class="check"><input type="checkbox" name="grant" value="${grant}" ${d.dataGrants.includes(grant) ? "checked" : ""}>${w[grant]}</label>`,
		)
		.join("");
	const permissions =
		d.demand || d.approval
			? `<section><h2>${w.permissions}</h2><p>${w.fullScope}</p>${!d.demand && d.service ? `<p>${w.saveService}</p>` : ""}${form(path, reviewInput + allFields + button(w.allowAll))}<details><summary>${w.choose}</summary>${form(path, `${reviewInput}<p>${w.permissionsHint}</p>${checkboxes}${button(w.savePermissions, true)}`)}</details></section>`
			: "";
	const demandControl =
		permissions +
		(d.demand ? form("/stop", button(w.stopDemand, true)) : onceActions);

	return `<!doctype html><html lang="${d.hu ? "hu" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${w.title} · AlfyAI</title><style>:root{color-scheme:light dark;font:16px/1.5 system-ui}body{margin:0}main{max-width:36rem;margin:7vh auto;padding:1.5rem}header{border-bottom:1px solid #8887;padding-bottom:1rem}h1{font-size:clamp(2rem,5vw,2.8rem);line-height:1.08}p{margin:1rem 0}label{display:block;margin:1rem 0}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:.65rem;border:1px solid #888;border-radius:.4rem;font:inherit}.check{display:flex;gap:.6rem;align-items:start}button{font:inherit;font-weight:600;padding:.65rem 1rem;margin:.3rem 0;border:0;border-radius:.45rem;background:#245b42;color:white;cursor:pointer}.secondary{background:transparent;border:1px solid #888;color:inherit}pre{max-height:40vh;overflow:auto;padding:1rem;border:1px solid #8886}footer{margin:2rem 0;color:GrayText;font-size:.9rem}</style><main><header><strong>AlfyAI</strong> / Bosch eBike Flow</header>${d.demand ? `<h1>${w.title}</h1><p>${w.enabled}</p>` : screen}${demandControl}<footer>${w.stop}</footer></main></html>`;
}
