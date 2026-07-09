// Legal copy (Redesign R6 — ADR 0044 Decision 5). ONE content source for the
// privacy policy: rendered by PrivacyPolicy.svelte at the public /privacy
// route, the single surface for the policy (no in-app modal).
//
// This is an accurate, product-grounded draft written from AlfyAI's actual
// data handling (connections/vault encryption, Data Locality, model
// providers, memory/incognito, write-confirmation, account archive/erasure —
// see docs/adr/0029-0032 and CONTEXT.md). It is NOT legal advice; a few
// jurisdiction/retention specifics are marked as placeholders below and
// should be confirmed by counsel before this is relied on for compliance.

const legalDict = {
	en: {
		"legal.privacy.title": "Privacy Policy",
		"legal.privacy.lastUpdatedLabel": "Last updated",
		"legal.privacy.lastUpdatedDate": "July 9, 2026",
		"legal.privacy.intro":
			'This policy explains what data AlfyAI ("we", "us") collects when you use the AlfyAI assistant, how it\'s used, and the choices you have. For privacy questions, contact us at levente@alfydesign.com.',

		"legal.privacy.section.connections.title":
			"Connections and connected accounts",
		"legal.privacy.section.connections.body":
			"AlfyAI lets you connect your own external accounts — calendar, files, email, photos, media (for example Plex), location (for example OwnTracks), and contacts — so the assistant can read, and if you allow it, write to them on your behalf. You choose which accounts to connect and which capabilities each connection may use. Connection credentials and access tokens are encrypted at rest (AES-GCM) and are never shared with other users or exposed outside your account.",

		"legal.privacy.section.dataLocality.title":
			"Where your connected-account data is processed",
		"legal.privacy.section.dataLocality.body":
			"By default, data from your connected accounts may be sent to the AI model you're chatting with to answer your question, including a third-party cloud model if you've selected one. You can turn on private, on-device processing so a local model summarizes your connected-account data before any third-party cloud model ever sees it — the raw data then stays on AlfyAI's own infrastructure instead of being sent to a third-party model, though the summary may include less detail than the raw data. If you haven't turned that on, AlfyAI shows a one-time warning the first time a message that could use your connected data would be sent to a third-party cloud model, so you can choose to continue or switch to private processing first.",

		"legal.privacy.section.modelProviders.title":
			"Third-party AI model providers",
		"legal.privacy.section.modelProviders.body":
			"When you choose a third-party cloud model rather than a locally run one, your message — and, unless private on-device processing is turned on, relevant connected-account data — is sent to that model provider to generate a response. Each provider processes this data under its own terms; where available, a link to a provider's own privacy or data-processing policy is shown next to that model in the model picker.",

		"legal.privacy.section.memory.title": "Memory and incognito conversations",
		"legal.privacy.section.memory.body":
			"To personalize replies, AlfyAI can learn and remember durable facts about you across chats, such as your preferences or recurring context. You can turn memory off at any time in Settings, which pauses new learning while keeping what's already remembered. You can also start a conversation in incognito mode: an incognito chat works fully normally, but nothing from it is learned into memory or recorded in usage analytics — it's saved to your account but not tracked or used to personalize future replies (\"saved-but-untracked\").",

		"legal.privacy.section.writes.title": "Writing to your connected accounts",
		"legal.privacy.section.writes.body":
			"AlfyAI never modifies a connected account on its own. Any write — such as creating a calendar event or sending an email — is only performed after you explicitly review and confirm that specific action; nothing is written autonomously in the background.",

		"legal.privacy.section.dataCollected.title":
			"What we collect for the service itself",
		"legal.privacy.section.dataCollected.body":
			"To provide the service we store your account details (name, email, and a securely hashed password), your conversations and any files you upload or generate, and usage and cost telemetry (such as which model handled a request and how many tokens or dollars it cost) so we can operate and improve AlfyAI. We may also process limited technical error reports, which can include your account identifier, through our error-monitoring tooling to diagnose problems. [Placeholder: exact data retention periods are still being finalized.]",

		"legal.privacy.section.rights.title": "Your data: export and erasure",
		"legal.privacy.section.rights.body":
			"You can download a human-readable Account Data Archive at any time — a password-confirmed ZIP containing your chat messages, app-controlled memory, uploaded and generated files, analytics, and related workspace records, meant for personal review rather than as a machine-importable backup. You can also request account erasure, which permanently deletes your account and personal workspace data after any of your own running work is safely stopped; only anonymous aggregate usage and cost totals are kept afterward, never anything that could identify you. Clear Memory and Knowledge and Clear Workspace Data let you reset narrower slices of your data without deleting your account.",

		"legal.privacy.section.security.title": "Security",
		"legal.privacy.section.security.body":
			"Connected-account credentials and tokens are encrypted at rest using AES-GCM. We apply reasonable technical and organizational measures to protect your data, but no online service can guarantee absolute security.",

		"legal.privacy.section.legalDetails.title": "Legal basis and jurisdiction",
		"legal.privacy.section.legalDetails.body":
			"[Placeholder: the governing jurisdiction, the legal basis for processing, and any applicable regulatory framework (for example GDPR) are still being finalized and will be added here after legal review.]",

		"legal.privacy.section.changes.title": "Changes to this policy",
		"legal.privacy.section.changes.body":
			'We may update this policy as AlfyAI\'s features change. Material changes will be reflected in the "Last updated" date above.',

		"legal.privacy.section.contact.title": "Contact us",
		"legal.privacy.section.contact.body":
			"Entity: AlfyAI. Questions about this policy or your data can be sent to levente@alfydesign.com.",
	},
	hu: {
		"legal.privacy.title": "Adatvédelmi irányelvek",
		"legal.privacy.lastUpdatedLabel": "Utolsó frissítés",
		"legal.privacy.lastUpdatedDate": "2026. július 9.",
		"legal.privacy.intro":
			'Ez a dokumentum leírja, milyen adatokat gyűjt az AlfyAI ("mi") az AlfyAI asszisztens használata során, hogyan használjuk fel ezeket, és milyen választási lehetőségeid vannak. Adatvédelemmel kapcsolatos kérdéseiddel keress minket a levente@alfydesign.com címen.',

		"legal.privacy.section.connections.title":
			"Kapcsolatok és csatlakoztatott fiókok",
		"legal.privacy.section.connections.body":
			"Az AlfyAI lehetővé teszi, hogy a saját külső fiókjaidat csatlakoztasd — naptár, fájlok, e-mail, fényképek, média (például Plex), helymeghatározás (például OwnTracks) és névjegyek —, hogy az asszisztens olvashassa, és ha engedélyezed, írhasson is beléjük a nevedben. Te választod ki, mely fiókokat csatlakoztatod, és az egyes kapcsolatok mely képességeit engedélyezed. A kapcsolatokhoz tartozó hitelesítő adatok és hozzáférési tokenek titkosítva tárolódnak (AES-GCM), és soha nem osztjuk meg őket más felhasználókkal, sem a fiókodon kívül bárkivel.",

		"legal.privacy.section.dataLocality.title":
			"Hol dolgozzuk fel a csatlakoztatott fiókjaid adatait",
		"legal.privacy.section.dataLocality.body":
			"Alapértelmezetten a csatlakoztatott fiókjaid adatai elküldődhetnek annak az AI-modellnek, amellyel épp beszélgetsz, hogy megválaszolja a kérdésedet — ideértve egy harmadik féltől származó felhőalapú modellt is, ha ilyet választottál. Bekapcsolhatod a privát, helyi feldolgozást, amikor egy helyi modell összegzi a csatlakoztatott fiókjaid adatait, mielőtt bármelyik harmadik féltől származó felhőalapú modell látná őket — a nyers adatok ekkor az AlfyAI saját infrastruktúráján maradnak ahelyett, hogy elküldenénk egy harmadik fél modelljének, bár az összegzés kevesebb részletet tartalmazhat, mint a nyers adat. Ha ezt nem kapcsoltad be, az AlfyAI egyszeri figyelmeztetést jelenít meg, amikor először fordulna elő, hogy egy, a csatlakoztatott adataidat felhasználó üzenet harmadik féltől származó felhőalapú modellhez kerülne, így választhatsz, hogy folytatod, vagy inkább a privát feldolgozásra váltasz.",

		"legal.privacy.section.modelProviders.title":
			"Harmadik féltől származó AI-modellszolgáltatók",
		"legal.privacy.section.modelProviders.body":
			"Ha egy harmadik féltől származó felhőalapú modellt választasz egy helyben futó modell helyett, az üzeneted — és, hacsak nincs bekapcsolva a privát, helyi feldolgozás, a releváns csatlakoztatott fiók-adataid is — elküldődnek az adott modellszolgáltatónak a válasz elkészítéséhez. Minden szolgáltató a saját feltételei szerint dolgozza fel ezeket az adatokat; ahol elérhető, a modellválasztóban az adott modell mellett egy link mutat a szolgáltató saját adatvédelmi vagy adatkezelési szabályzatára.",

		"legal.privacy.section.memory.title": "Memória és inkognitó beszélgetések",
		"legal.privacy.section.memory.body":
			'A válaszok személyre szabásához az AlfyAI a beszélgetéseken átívelően megtanulhat és megjegyezhet rólad tartós tényeket, például a preferenciáidat vagy visszatérő kontextust. A memóriát bármikor kikapcsolhatod a Beállításokban, ami szünetelteti az új tanulást, de megtartja a már megjegyzett dolgokat. Egy beszélgetést inkognitó módban is elindíthatsz: az inkognitó beszélgetés teljesen normálisan működik, de semmi nem kerül belőle a memóriába, és a használati statisztikákba sem rögzítjük — elmentődik a fiókodba, de nem követjük, és nem használjuk a jövőbeli válaszaid személyre szabásához ("elmentve, de nem követve").',

		"legal.privacy.section.writes.title": "Írás a csatlakoztatott fiókjaidba",
		"legal.privacy.section.writes.body":
			"Az AlfyAI soha nem módosít egy csatlakoztatott fiókot magától. Minden írás — például egy naptáresemény létrehozása vagy egy e-mail elküldése — csak azután történik meg, hogy kifejezetten átnézted és jóváhagytad az adott műveletet; semmi nem íródik önállóan, a háttérben.",

		"legal.privacy.section.dataCollected.title":
			"Mit gyűjtünk magához a szolgáltatáshoz",
		"legal.privacy.section.dataCollected.body":
			"A szolgáltatás nyújtásához tároljuk a fiókadataidat (név, e-mail-cím és egy biztonságosan hashelt jelszó), a beszélgetéseidet és a feltöltött vagy generált fájljaidat, valamint a használati és költségadatokat (például hogy melyik modell dolgozta fel a kérést, és az mennyi tokenbe vagy dollárba került), hogy üzemeltetni és fejleszteni tudjuk az AlfyAI-t. A hibák diagnosztizálásához a hibafigyelő eszközünkön keresztül korlátozott terjedelmű technikai hibajelentéseket is feldolgozhatunk, amelyek tartalmazhatják a fiókazonosítódat. [Helykitöltő: a pontos adatmegőrzési időszakok még kidolgozás alatt állnak.]",

		"legal.privacy.section.rights.title": "Az adataid: exportálás és törlés",
		"legal.privacy.section.rights.body":
			"Bármikor letölthetsz egy ember által olvasható Fiókadat-archívumot — egy jelszóval megerősített ZIP-fájlt, amely tartalmazza a csevegéseidet, az alkalmazás által kezelt memóriádat, a feltöltött és generált fájljaidat, az analitikai adataidat és a kapcsolódó munkaterületi rekordokat; ez személyes áttekintésre szolgál, nem gépi importálásra alkalmas biztonsági mentésként. Kérheted a fiók törlését is, ami véglegesen törli a fiókodat és a személyes munkaterületi adataidat, miután a hozzád tartozó futó munkák biztonságosan leálltak; ezután csak névtelenített, összesített használati és költségadatok maradnak meg, semmi, ami azonosítani tudna téged. A Memória és tudás törlése, valamint a Munkaterületi adatok törlése lehetővé teszi, hogy szűkebb adatköröket állíts vissza a fiókod törlése nélkül.",

		"legal.privacy.section.security.title": "Biztonság",
		"legal.privacy.section.security.body":
			"A csatlakoztatott fiókjaidhoz tartozó hitelesítő adatok és tokenek AES-GCM titkosítással tárolódnak. Ésszerű technikai és szervezeti intézkedéseket alkalmazunk az adataid védelmére, de egyetlen online szolgáltatás sem garantálhat teljes biztonságot.",

		"legal.privacy.section.legalDetails.title": "Jogalap és joghatóság",
		"legal.privacy.section.legalDetails.body":
			"[Helykitöltő: az irányadó joghatóság, az adatkezelés jogalapja és az alkalmazandó szabályozási keret (például GDPR) még kidolgozás alatt áll, és jogi felülvizsgálat után kerül majd ide.]",

		"legal.privacy.section.changes.title": "Ezen irányelvek változásai",
		"legal.privacy.section.changes.body":
			'Előfordulhat, hogy frissítjük ezt a dokumentumot az AlfyAI funkcióinak változásával. A lényegi változásokat a fenti "Utolsó frissítés" dátum jelzi.',

		"legal.privacy.section.contact.title": "Kapcsolat",
		"legal.privacy.section.contact.body":
			"Üzemeltető: AlfyAI. Ezzel az irányelvvel vagy az adataiddal kapcsolatos kérdéseidet a levente@alfydesign.com címre küldheted.",
	},
} as const;

export default legalDict;

// Stable render order for PrivacyPolicy.svelte — keeps the single content
// source authoritative over section ordering (not left to object key order).
export const PRIVACY_POLICY_SECTIONS = [
	"connections",
	"dataLocality",
	"modelProviders",
	"memory",
	"writes",
	"dataCollected",
	"rights",
	"security",
	"legalDetails",
	"changes",
	"contact",
] as const;
