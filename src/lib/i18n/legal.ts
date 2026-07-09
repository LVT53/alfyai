// Legal copy (Redesign R6 — ADR 0044 Decision 5). ONE content source for the
// privacy policy: rendered by PrivacyPolicy.svelte at the public /privacy
// route, the single surface for the policy (no in-app modal).
//
// This is an accurate, product-grounded policy written from AlfyAI's actual
// data handling: accounts/sessions (auth service), conversations and files,
// local vs third-party cloud models (available-models/providers, per-model
// privacyPolicyUrl in the picker), memory + incognito (memory-controls,
// "saved-but-untracked"), connections with vault encryption and Data
// Locality (connections/locality, ADR 0044), usage/cost telemetry, Sentry
// error reports, and the Settings privacy controls (privacy-controls
// service: Account Data Archive, account erasure, Clear Memory and
// Knowledge, Clear Workspace Data — see ADR 0029-0032). It is NOT legal
// advice; it deliberately states no governing jurisdiction or statutory
// legal basis — counsel should confirm those before this is relied on for
// compliance.
//
// Section bodies may contain "\n" line breaks and "• " bullets; the renderer
// uses `white-space: pre-line`, so they display as separate lines.

const legalDict = {
	en: {
		"legal.privacy.title": "Privacy Policy",
		"legal.privacy.lastUpdatedLabel": "Last updated",
		"legal.privacy.lastUpdatedDate": "July 9, 2026",
		"legal.privacy.intro":
			'AlfyAI ("we", "us") is a personal AI assistant. This policy explains, in plain language, what data AlfyAI collects across the whole app — your account, conversations, files, memory, connected accounts, and usage telemetry — how that data is used, when it leaves our infrastructure, and the controls you have over it. It applies whenever you use AlfyAI. Privacy questions are welcome at levente@alfydesign.com.',

		"legal.privacy.section.dataCollected.title": "Information we collect",
		"legal.privacy.section.dataCollected.body":
			"Everything below is stored in your own account and kept isolated from every other user's data.\n" +
			"• Account details — your name, email address, and password. The password is stored only as a secure hash; we never store or see the password itself.\n" +
			"• Sessions and cookies — when you sign in, we set a session cookie so you stay signed in. We use no advertising or third-party tracking cookies.\n" +
			"• Conversations and files — your chats with the assistant, files you upload, and files the assistant generates for you.\n" +
			"• Memory — durable facts AlfyAI has learned about you to personalize replies (see “Memory and incognito conversations” below).\n" +
			"• Connected-account data — if you link external accounts, the data read from them while answering your requests, plus the encrypted credentials for those connections (see “Connections to your other accounts” below).\n" +
			"• Usage and cost telemetry — which model handled a request and how many tokens or dollars it cost, so we can operate the service and keep its costs honest.\n" +
			"• Error reports — if something breaks, limited technical reports (which can include your account identifier) go to our error-monitoring tooling so we can diagnose and fix the problem.",

		"legal.privacy.section.howWeUse.title": "How we use your information",
		"legal.privacy.section.howWeUse.body":
			"We use your data for four purposes:\n" +
			"• To provide the service — answering your messages, running the tools you ask for, and keeping your conversations, files, and connections available to you.\n" +
			"• To personalize — the memory feature uses what it has learned to make replies more relevant to you. You can turn this off at any time.\n" +
			"• To operate and improve AlfyAI — usage and cost telemetry shows which models are used and what they cost; error reports help us find and fix bugs.\n" +
			"• To keep your account secure — session and sign-in data protects access to your account.\n" +
			"We do not sell your data, show you advertising, or use your conversations to train AI models. Personalization happens only through the memory feature, which stays inside your own account.",

		"legal.privacy.section.aiProcessing.title":
			"AI models: local and cloud processing",
		"legal.privacy.section.aiProcessing.body":
			"AlfyAI offers a mix of AI models, and you choose which one handles each conversation:\n" +
			"• Locally run models execute on AlfyAI's own hardware. Your messages never leave our infrastructure.\n" +
			"• Third-party cloud models are optional. If you pick one, the content needed to answer — your message, relevant conversation context, and (unless private, on-device processing is turned on; see the Connections section) relevant connected-account data — is sent to that model provider to generate the response.\n" +
			"Each model provider processes data under its own terms. Where available, a link to the provider's privacy policy is shown next to that model in the model picker, so you can check before you choose. If you only ever select locally run models, your conversations are processed entirely on our own hardware.",

		"legal.privacy.section.connections.title":
			"Connections to your other accounts",
		"legal.privacy.section.connections.body":
			"You can connect your own external accounts — calendar, files, email, photos, media (for example Plex), location (for example OwnTracks), and contacts — so the assistant can work with them for you. Connections are entirely optional, and you choose which accounts to connect and which capabilities each connection may use.\n" +
			"• Reading — the assistant reads from a connection only to answer your requests.\n" +
			"• Writing — AlfyAI never changes a connected account on its own. Any write, such as creating a calendar event or sending an email, happens only after you explicitly review and confirm that specific action.\n" +
			"• Private, on-device processing — you can require that a local model summarizes your connected-account data before any third-party cloud model sees it, so the raw data stays on AlfyAI's own infrastructure (the summary may carry less detail than the raw data). While this is off, AlfyAI shows a one-time warning before a message that could use your connected data is first sent to a third-party cloud model, so you can continue or switch to private processing first.\n" +
			"• Isolation and encryption — connection credentials and access tokens are encrypted at rest (AES-GCM), scoped to your account alone, and never shared with other users or exposed outside your account.",

		"legal.privacy.section.memory.title": "Memory and incognito conversations",
		"legal.privacy.section.memory.body":
			"To personalize replies, AlfyAI can learn durable facts about you across chats — your preferences, recurring context, ongoing projects. Memory lives in your account and is used only to make your own replies better. You have two controls:\n" +
			"• Turn memory off — in Settings, at any time. This pauses new learning while keeping what is already remembered; you can separately erase remembered content (see “Your controls and rights”).\n" +
			"• Incognito conversations — an incognito chat works fully normally, but nothing from it is learned into memory or recorded in usage analytics. It is saved to your account so you can revisit it, but it is never tracked or used to personalize future replies (“saved-but-untracked”).",

		"legal.privacy.section.sharing.title": "When your data leaves AlfyAI",
		"legal.privacy.section.sharing.body":
			"We never sell your data and never share it for advertising. Your data leaves our infrastructure only in these cases:\n" +
			"• Third-party model providers — only when you choose a third-party cloud model for a conversation, as described above.\n" +
			"• Web research — when the assistant searches the web for you, search queries derived from your request are sent to search services, and the resulting public web pages are fetched. Your conversation itself is not shared with them.\n" +
			"• Error monitoring — limited technical error reports are processed by our error-monitoring tooling so we can fix problems.\n" +
			"• Your own connected accounts — reads and explicitly confirmed writes go to the services you have connected, on your behalf.\n" +
			"There are no other recipients: no advertising networks, no data brokers, no analytics resellers.",

		"legal.privacy.section.retention.title": "How long we keep your data",
		"legal.privacy.section.retention.body":
			"We keep your data for as long as your account exists, so the assistant can keep working for you — we do not currently apply fixed automatic expiry periods. Deletion is instead in your hands: at any time you can erase specific slices of your data or your entire account using the controls described below, and deletion takes effect right away, once any of your running work has been safely stopped. After account erasure, only anonymous aggregate usage and cost totals remain — nothing that could identify you.",

		"legal.privacy.section.security.title": "Security",
		"legal.privacy.section.security.body":
			"Your password is stored only as a secure hash, and sessions use HTTP-only cookies. Connected-account credentials and tokens are encrypted at rest using AES-GCM. Every user's data — conversations, files, memory, connections — is strictly scoped to their own account. Sensitive actions such as exporting your data, clearing data, or erasing your account require you to re-confirm your password. We apply reasonable technical and organizational measures to protect your data, but no online service can guarantee absolute security — please use a strong, unique password.",

		"legal.privacy.section.rights.title": "Your controls and rights",
		"legal.privacy.section.rights.body":
			"Settings gives you direct, self-serve controls — no support request needed — and we offer them to everyone, regardless of where you live:\n" +
			"• Export — download an Account Data Archive at any time: a password-confirmed ZIP containing your chat messages, app-controlled memory, uploaded and generated files, analytics, and related workspace records. It is designed for personal review in human-readable form, not as a machine-importable backup.\n" +
			"• Erase your account — account erasure permanently deletes your account and personal workspace data after any of your running work is safely stopped. Afterwards, only anonymous aggregate usage and cost totals are kept — never anything that could identify you.\n" +
			"• Clear narrower slices — Clear Memory and Knowledge erases what the assistant has learned about you along with your uploaded knowledge; Clear Workspace Data resets your workspace. Both work without deleting your account.\n" +
			"• Day-to-day controls — turn memory off, use incognito conversations, choose locally run models, and turn on private, on-device processing for connections.\n" +
			"To correct your account details, or for any other request about your data, email levente@alfydesign.com.",

		"legal.privacy.section.children.title": "Children",
		"legal.privacy.section.children.body":
			"AlfyAI is not directed to children, and we do not knowingly collect personal data from them. If you believe a child has been using AlfyAI, contact us and we will delete the account and its data.",

		"legal.privacy.section.changes.title": "Changes to this policy",
		"legal.privacy.section.changes.body":
			'We may update this policy as AlfyAI\'s features evolve. Changes are reflected in the "Last updated" date above, and the current version is always available at this page. If a change meaningfully reduces your privacy, we will announce it in the app before it takes effect.',

		"legal.privacy.section.contact.title": "Contact us",
		"legal.privacy.section.contact.body":
			"Entity: AlfyAI, a small, independently operated service. This policy is written to describe plainly and accurately what actually happens to your data, rather than as formal legal boilerplate. Questions, requests, or complaints about this policy or your data can be sent to levente@alfydesign.com — a person reads and answers every message.",
	},
	hu: {
		"legal.privacy.title": "Adatvédelmi irányelvek",
		"legal.privacy.lastUpdatedLabel": "Utolsó frissítés",
		"legal.privacy.lastUpdatedDate": "2026. július 9.",
		"legal.privacy.intro":
			'Az AlfyAI ("mi") egy személyes AI-asszisztens. Ez a dokumentum közérthetően leírja, milyen adatokat gyűjt az AlfyAI az alkalmazás egészében — a fiókod, a beszélgetéseid, a fájljaid, a memória, a csatlakoztatott fiókjaid és a használati adatok —, hogyan használjuk fel ezeket, mikor hagyják el az infrastruktúránkat, és milyen eszközeid vannak felettük. Az irányelvek az AlfyAI minden használatára vonatkoznak. Adatvédelmi kérdéseiddel fordulj hozzánk bizalommal a levente@alfydesign.com címen.',

		"legal.privacy.section.dataCollected.title": "Milyen adatokat gyűjtünk",
		"legal.privacy.section.dataCollected.body":
			"Az alábbiak mind a saját fiókodban tárolódnak, minden más felhasználó adataitól elkülönítve.\n" +
			"• Fiókadatok — a neved, az e-mail-címed és a jelszavad. A jelszót kizárólag biztonságos hash formájában tároljuk; magát a jelszót soha nem tároljuk és nem látjuk.\n" +
			"• Munkamenetek és sütik — bejelentkezéskor munkamenet-sütit állítunk be, hogy bejelentkezve maradj. Hirdetési vagy harmadik féltől származó követő sütiket nem használunk.\n" +
			"• Beszélgetések és fájlok — az asszisztenssel folytatott csevegéseid, a feltöltött fájljaid és az asszisztens által neked generált fájlok.\n" +
			"• Memória — tartós tények, amelyeket az AlfyAI rólad tanult meg a válaszok személyre szabásához (lásd lentebb: „Memória és inkognitó beszélgetések”).\n" +
			"• Csatlakoztatott fiókok adatai — ha külső fiókokat kapcsolsz össze, a kéréseid megválaszolása közben belőlük kiolvasott adatok, valamint a kapcsolatok titkosított hitelesítő adatai (lásd lentebb: „Kapcsolatok a többi fiókodhoz”).\n" +
			"• Használati és költségadatok — melyik modell dolgozta fel a kérést, és az mennyi tokenbe vagy dollárba került, hogy üzemeltetni tudjuk a szolgáltatást, és átláthatóak maradjanak a költségei.\n" +
			"• Hibajelentések — ha valami elromlik, korlátozott terjedelmű technikai jelentések (amelyek tartalmazhatják a fiókazonosítódat) kerülnek a hibafigyelő eszközünkbe, hogy diagnosztizálni és javítani tudjuk a problémát.",

		"legal.privacy.section.howWeUse.title":
			"Hogyan használjuk fel az adataidat",
		"legal.privacy.section.howWeUse.body":
			"Az adataidat négy célra használjuk:\n" +
			"• A szolgáltatás nyújtásához — az üzeneteid megválaszolásához, az általad kért eszközök futtatásához, és hogy a beszélgetéseid, fájljaid és kapcsolataid elérhetőek legyenek számodra.\n" +
			"• Személyre szabáshoz — a memória funkció a megtanult dolgok alapján teszi relevánsabbá a válaszokat. Ezt bármikor kikapcsolhatod.\n" +
			"• Az AlfyAI üzemeltetéséhez és fejlesztéséhez — a használati és költségadatokból látjuk, mely modellek futnak és mennyibe kerülnek; a hibajelentések segítenek megtalálni és kijavítani a hibákat.\n" +
			"• A fiókod biztonságához — a munkamenet- és bejelentkezési adatok védik a fiókodhoz való hozzáférést.\n" +
			"Az adataidat nem adjuk el, nem mutatunk neked hirdetéseket, és a beszélgetéseidet nem használjuk AI-modellek tanítására. A személyre szabás kizárólag a memória funkción keresztül történik, amely a saját fiókodban marad.",

		"legal.privacy.section.aiProcessing.title":
			"AI-modellek: helyi és felhőalapú feldolgozás",
		"legal.privacy.section.aiProcessing.body":
			"Az AlfyAI többféle AI-modellt kínál, és te választod ki, melyik kezelje az adott beszélgetést:\n" +
			"• A helyben futó modellek az AlfyAI saját hardverén futnak. Az üzeneteid soha nem hagyják el az infrastruktúránkat.\n" +
			"• A harmadik féltől származó felhőalapú modellek használata opcionális. Ha ilyet választasz, a válaszhoz szükséges tartalom — az üzeneted, a releváns beszélgetési kontextus és (hacsak nincs bekapcsolva a privát, helyi feldolgozás; lásd a Kapcsolatok szakaszt) a releváns csatlakoztatott fiók-adatok — elküldődik az adott modellszolgáltatónak a válasz elkészítéséhez.\n" +
			"Minden modellszolgáltató a saját feltételei szerint dolgozza fel az adatokat. Ahol elérhető, a modellválasztóban az adott modell mellett link mutat a szolgáltató adatvédelmi szabályzatára, így választás előtt megnézheted. Ha mindig csak helyben futó modelleket választasz, a beszélgetéseid teljes egészében a saját hardverünkön kerülnek feldolgozásra.",

		"legal.privacy.section.connections.title": "Kapcsolatok a többi fiókodhoz",
		"legal.privacy.section.connections.body":
			"Csatlakoztathatod a saját külső fiókjaidat — naptár, fájlok, e-mail, fényképek, média (például Plex), helymeghatározás (például OwnTracks) és névjegyek —, hogy az asszisztens dolgozhasson velük a nevedben. A kapcsolatok teljesen opcionálisak: te döntöd el, mely fiókokat csatlakoztatod, és az egyes kapcsolatok mely képességeit engedélyezed.\n" +
			"• Olvasás — az asszisztens csak a kéréseid megválaszolásához olvas egy kapcsolatból.\n" +
			"• Írás — az AlfyAI soha nem módosít egy csatlakoztatott fiókot magától. Minden írás — például egy naptáresemény létrehozása vagy egy e-mail elküldése — csak azután történik meg, hogy kifejezetten átnézted és jóváhagytad az adott műveletet.\n" +
			"• Privát, helyi feldolgozás — előírhatod, hogy egy helyi modell összegezze a csatlakoztatott fiókjaid adatait, mielőtt bármelyik harmadik féltől származó felhőalapú modell látná őket; így a nyers adatok az AlfyAI saját infrastruktúráján maradnak (az összegzés kevesebb részletet tartalmazhat, mint a nyers adat). Amíg ez ki van kapcsolva, az AlfyAI egyszeri figyelmeztetést jelenít meg, mielőtt egy, a csatlakoztatott adataidat felhasználó üzenet először kerülne harmadik féltől származó felhőalapú modellhez, így folytathatod, vagy előbb átválthatsz a privát feldolgozásra.\n" +
			"• Elkülönítés és titkosítás — a kapcsolatok hitelesítő adatai és hozzáférési tokenjei titkosítva tárolódnak (AES-GCM), kizárólag a te fiókodhoz kötődnek, és soha nem osztjuk meg őket más felhasználókkal, sem a fiókodon kívül senkivel.",

		"legal.privacy.section.memory.title": "Memória és inkognitó beszélgetések",
		"legal.privacy.section.memory.body":
			"A válaszok személyre szabásához az AlfyAI a beszélgetéseken átívelően tartós tényeket tanulhat meg rólad — a preferenciáidat, visszatérő kontextust, futó projektjeidet. A memória a fiókodban él, és kizárólag arra szolgál, hogy a saját válaszaid jobbak legyenek. Két eszközöd van:\n" +
			"• A memória kikapcsolása — a Beállításokban, bármikor. Ez szünetelteti az új tanulást, de megtartja a már megjegyzett dolgokat; a megjegyzett tartalmat külön is törölheted (lásd: „Az adataid feletti irányítás és a jogaid”).\n" +
			"• Inkognitó beszélgetések — az inkognitó beszélgetés teljesen normálisan működik, de semmi nem kerül belőle a memóriába, és a használati statisztikákba sem. Elmentődik a fiókodba, hogy később visszanézhesd, de soha nem követjük, és nem használjuk a jövőbeli válaszaid személyre szabásához („elmentve, de nem követve”).",

		"legal.privacy.section.sharing.title":
			"Mikor hagyják el az adataid az AlfyAI-t",
		"legal.privacy.section.sharing.body":
			"Az adataidat soha nem adjuk el, és hirdetési célból soha nem osztjuk meg. Az adataid kizárólag az alábbi esetekben hagyják el az infrastruktúránkat:\n" +
			"• Harmadik féltől származó modellszolgáltatók — csak akkor, ha egy beszélgetéshez harmadik féltől származó felhőalapú modellt választasz, a fent leírtak szerint.\n" +
			"• Webes kutatás — amikor az asszisztens a weben keres neked, a kérésedből képzett keresési lekérdezések keresőszolgáltatásokhoz kerülnek, és a találati nyilvános weboldalakat letöltjük. Magát a beszélgetésedet nem osztjuk meg velük.\n" +
			"• Hibafigyelés — korlátozott terjedelmű technikai hibajelentéseket dolgoz fel a hibafigyelő eszközünk, hogy javítani tudjuk a problémákat.\n" +
			"• A saját csatlakoztatott fiókjaid — az olvasások és a kifejezetten jóváhagyott írások az általad csatlakoztatott szolgáltatásokhoz kerülnek, a te nevedben.\n" +
			"Más címzett nincs: se hirdetési hálózatok, se adatkereskedők, se analitikai viszonteladók.",

		"legal.privacy.section.retention.title": "Meddig őrizzük az adataidat",
		"legal.privacy.section.retention.body":
			"Az adataidat addig őrizzük, amíg a fiókod létezik, hogy az asszisztens folyamatosan dolgozhasson neked — jelenleg nem alkalmazunk rögzített, automatikus lejárati időszakokat. A törlés ehelyett a te kezedben van: bármikor törölheted az adataid egyes részeit vagy a teljes fiókodat az alább leírt eszközökkel, és a törlés azonnal megtörténik, amint a hozzád tartozó futó munkák biztonságosan leálltak. A fiók törlése után csak névtelen, összesített használati és költségadatok maradnak — semmi, ami azonosítani tudna téged.",

		"legal.privacy.section.security.title": "Biztonság",
		"legal.privacy.section.security.body":
			"A jelszavadat kizárólag biztonságos hash formájában tároljuk, a munkamenetek pedig csak HTTP-n keresztül elérhető (HTTP-only) sütiket használnak. A csatlakoztatott fiókjaid hitelesítő adatai és tokenjei AES-GCM titkosítással tárolódnak. Minden felhasználó adatai — beszélgetések, fájlok, memória, kapcsolatok — szigorúan a saját fiókjához kötődnek. Az érzékeny műveletekhez, mint az adataid exportálása, az adatok törlése vagy a fiók törlése, újra meg kell erősítened a jelszavadat. Ésszerű technikai és szervezeti intézkedéseket alkalmazunk az adataid védelmére, de egyetlen online szolgáltatás sem garantálhat teljes biztonságot — kérjük, használj erős, egyedi jelszót.",

		"legal.privacy.section.rights.title":
			"Az adataid feletti irányítás és a jogaid",
		"legal.privacy.section.rights.body":
			"A Beállításokban közvetlen, önkiszolgáló eszközök állnak rendelkezésedre — nem kell hozzájuk ügyfélszolgálati kérés —, és mindenkinek felajánljuk őket, függetlenül attól, hol élsz:\n" +
			"• Exportálás — bármikor letölthetsz egy Fiókadat-archívumot: egy jelszóval megerősített ZIP-fájlt, amely tartalmazza a csevegéseidet, az alkalmazás által kezelt memóriádat, a feltöltött és generált fájljaidat, az analitikai adataidat és a kapcsolódó munkaterületi rekordokat. Személyes áttekintésre készül, ember által olvasható formában — nem gépi importálásra alkalmas biztonsági mentésként.\n" +
			"• A fiókod törlése — a fiók törlése véglegesen eltávolítja a fiókodat és a személyes munkaterületi adataidat, miután a hozzád tartozó futó munkák biztonságosan leálltak. Ezután csak névtelen, összesített használati és költségadatok maradnak meg — soha semmi, ami azonosítani tudna téged.\n" +
			"• Szűkebb adatkörök törlése — a Memória és tudás törlése eltávolítja, amit az asszisztens rólad tanult, a feltöltött tudásoddal együtt; a Munkaterületi adatok törlése visszaállítja a munkaterületedet. Mindkettő a fiókod törlése nélkül működik.\n" +
			"• Mindennapi eszközök — kapcsold ki a memóriát, használj inkognitó beszélgetéseket, válassz helyben futó modelleket, és kapcsold be a privát, helyi feldolgozást a kapcsolatokhoz.\n" +
			"A fiókadataid javításához vagy bármilyen más, az adataiddal kapcsolatos kéréshez írj a levente@alfydesign.com címre.",

		"legal.privacy.section.children.title": "Gyermekek",
		"legal.privacy.section.children.body":
			"Az AlfyAI nem gyermekeknek szól, és tudatosan nem gyűjtünk tőlük személyes adatokat. Ha úgy gondolod, hogy egy gyermek használta az AlfyAI-t, vedd fel velünk a kapcsolatot, és töröljük a fiókot az adataival együtt.",

		"legal.privacy.section.changes.title": "Az irányelvek változásai",
		"legal.privacy.section.changes.body":
			"Az AlfyAI funkcióinak fejlődésével frissíthetjük ezt a dokumentumot. A változásokat a fenti „Utolsó frissítés” dátum jelzi, és az aktuális változat mindig elérhető ezen az oldalon. Ha egy változás érdemben csökkentené az adataid védelmét, még a hatálybalépése előtt bejelentjük az alkalmazásban.",

		"legal.privacy.section.contact.title": "Kapcsolatfelvétel",
		"legal.privacy.section.contact.body":
			"Üzemeltető: AlfyAI, egy kicsi, függetlenül működtetett szolgáltatás. Ez a dokumentum arra törekszik, hogy egyszerűen és pontosan leírja, mi történik valójában az adataiddal — nem formális jogi sablonszöveg. Az irányelvekkel vagy az adataiddal kapcsolatos kérdéseidet, kéréseidet vagy panaszaidat a levente@alfydesign.com címre küldheted — minden üzenetet ember olvas és válaszol meg.",
	},
} as const;

export default legalDict;

// Stable render order for PrivacyPolicy.svelte — keeps the single content
// source authoritative over section ordering (not left to object key order).
// Order: collection → use → AI processing → connections → memory → sharing →
// retention → security → rights → children → changes → contact.
export const PRIVACY_POLICY_SECTIONS = [
	"dataCollected",
	"howWeUse",
	"aiProcessing",
	"connections",
	"memory",
	"sharing",
	"retention",
	"security",
	"rights",
	"children",
	"changes",
	"contact",
] as const;
