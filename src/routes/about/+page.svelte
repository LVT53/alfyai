<script lang="ts">
import { page } from "$app/state";
import LogoMark from "$lib/components/chat/LogoMark.svelte";
import {
	ArrowRight,
	CalendarDays,
	ContactRound,
	FileText,
	MessagesSquare,
	Search,
} from "@lucide/svelte";

const hu = $derived(page.url.searchParams.get("lang") === "hu");
const copy = $derived(
	hu
		? {
				about: "Az AlfyAI-ról",
				sign: "Belépés",
				title: "Személyes AI-asszisztens",
				intro: "Kérdezz magyarul vagy angolul.",
				example: "Példa",
				ask: "Merre sétáljunk Budapesten?",
				answer: "Menjetek át a Szabadság hídon. Szép a kilátás a Dunára.",
				doc: "Séta a Duna mentén",
				stops: ["Fővám tér", "Szabadság híd", "Gellért tér"],
				tools: ["Beszélgetés", "Kutatás", "Alkotás"],
				descriptions: [
					"Kérdezz egy képről vagy fájlról.",
					"Olvass jelentéseket forrásokkal.",
					"Készíts dokumentumot, képet vagy bemutatót.",
				],
				access: "Google-fiók",
				note: "A kapcsolódás választható. A hozzáférést a Beállításokban bármikor visszavonhatod.",
				cal: "Google Naptár",
				calText: "Alfy megnézheti az eseményeidet és a szabad időpontjaidat.",
				contacts: "Google Névjegyek",
				contactsText: "Alfy kérésedre kikeresi egy ismerősöd elérhetőségét.",
				privacy: "Adatvédelmi tájékoztató",
				examples: "Mire használhatod?",
				open: "AlfyAI megnyitása",
			}
		: {
				about: "About AlfyAI",
				sign: "Sign in",
				title: "Your AI assistant",
				intro: "Ask in English or Hungarian.",
				example: "Example",
				ask: "Where should we walk in Budapest?",
				answer: "Cross Liberty Bridge for a view along the Danube.",
				doc: "A riverside walk",
				stops: ["Fővám tér", "Liberty Bridge", "Gellért tér"],
				tools: ["Ask", "Research", "Create"],
				descriptions: [
					"Ask about a photo or file.",
					"Explore a topic with sources.",
					"Make documents, pictures, and slides.",
				],
				access: "Google access",
				note: "Connecting is optional. Disconnect anytime in Settings.",
				cal: "Google Calendar",
				calText: "Alfy can check your events and free time.",
				contacts: "Google Contacts",
				contactsText: "Alfy can find contact details when you ask.",
				privacy: "Privacy policy",
				examples: "What you can do",
				open: "Open AlfyAI",
			},
);
const icons = [MessagesSquare, Search, FileText];
</script>

<svelte:head>
  <title>{copy.about} — AlfyAI</title>
  <meta name="description" content={copy.intro} />
</svelte:head>
<div class="about" lang={hu ? "hu" : "en"}>
  <header><div class="wrap top"><a href="/about" class="brand"><LogoMark size={35}/>AlfyAI</a>
    <nav aria-label={hu ? "Navigáció" : "Navigation"}><a hreflang={hu ? "en" : "hu"} href={'?lang=' + (hu ? 'en' : 'hu')}>{hu ? "English" : "Magyar"}</a><a class="signin" href="/login">{copy.sign} <ArrowRight size={15}/></a></nav>
  </div></header>
  <main class="wrap">
    <section class="hero"><div class="lead"><h1>{copy.title}</h1><p class="intro">{copy.intro}</p><a class="cta" href="/login">{copy.open}<ArrowRight size={18}/></a></div>
      <figure><figcaption><LogoMark size={22}/>{copy.example}</figcaption>
        <p class="question">{copy.ask}</p><div class="reply"><LogoMark size={26}/><p>{copy.answer}</p></div>
        <div class="document"><FileText size={22}/><div><strong>{copy.doc}</strong><small>{copy.stops.join(" · ")}</small></div></div>
      </figure>
    </section>
    <section class="uses" aria-label={copy.examples}>{#each copy.tools as tool, i (tool)}{@const Icon = icons[i]}<article><Icon size={21} strokeWidth={1.6}/><h2>{tool}</h2><p>{copy.descriptions[i]}</p></article>{/each}</section>
    <section class="access"><div><h2>{copy.access}</h2><p>{copy.note}</p><a href="/privacy">{copy.privacy} <ArrowRight size={15}/></a></div>
      <div class="permissions">{#each [[CalendarDays, copy.cal, copy.calText], [ContactRound, copy.contacts, copy.contactsText]] as item}{@const Icon = item[0] as typeof CalendarDays}<article><Icon size={21}/><div><h3>{item[1]}</h3><p>{item[2]}</p></div></article>{/each}</div>
    </section>
  </main>
  <footer class="wrap"><span>AlfyAI</span><a href="/privacy">{copy.privacy}</a></footer>
</div>

<style>
.about {height:100svh;overflow:auto;background:var(--surface-page);color:var(--text-primary);font-family:var(--font-sans)}
.wrap {width:min(1080px,calc(100% - 48px));margin-inline:auto}
header,footer {border-bottom:1px solid var(--border-default)}
.top,nav,.brand,.signin,.cta,figcaption,.document,.reply,footer,.access a,.permissions article {display:flex;align-items:center}
.top,footer {justify-content:space-between;padding-block:18px}
.brand {gap:8px;font:700 22px var(--font-sans);letter-spacing:-.06em}
nav {gap:24px;font-size:15px}
a {color:inherit;text-decoration:none}
a:hover {text-decoration:underline;text-underline-offset:4px}
a:focus-visible {outline:2px solid var(--focus-ring);outline-offset:4px}
.signin,.cta {gap:10px;border-radius:8px;padding:9px 15px}
.signin {border:1px solid var(--border-default)}
main {display:flex;flex-direction:column}
.hero {display:grid;align-items:center;padding-block:clamp(52px,7vw,96px)}
figcaption {font-size:14px;color:var(--text-muted)}
h1,h2,h3,p,figure {margin:0}
h1 {font-family:var(--font-serif)}
h1,.access h2 {font-weight:400;letter-spacing:-.055em;text-wrap:balance}
h1 {font-size:clamp(44px,5.3vw,76px);line-height:1.08}
.intro {font-size:19px;line-height:1.55;margin:24px 0;max-width:41ch}
.cta {background:var(--text-primary);color:var(--surface-page);width:fit-content}
figure {background:var(--surface-elevated);border:1px solid var(--border-default);border-radius:18px;padding:clamp(20px,3vw,38px);box-shadow:var(--shadow-sm)}
figcaption {gap:7px;margin-bottom:23px}
.question {background:var(--surface-page);padding:14px 18px;border-radius:16px 16px 4px 16px;margin-left:12%;font-size:16px;line-height:1.45}
.reply {align-items:flex-start;gap:8px;margin:22px 0;line-height:1.5}
.reply :global(svg),.permissions :global(svg) {flex-shrink:0}
.document {gap:13px;background:var(--surface-page);border:1px solid var(--border-default);border-left:3px solid var(--accent);border-radius:8px;padding:16px}
.document small {display:block;color:var(--text-muted);margin-top:4px}
.uses {display:grid;grid-template-columns:repeat(3,1fr);gap:40px;padding:28px 0 36px;border-block:1px solid var(--border-default)}
.uses :global(svg),.permissions :global(svg) {color:var(--accent)}
.uses h2 {font:700 25px var(--font-sans);margin:14px 0 8px}
.uses p,.access p {color:var(--text-muted);font-size:16px;line-height:1.55}
.access {display:grid;grid-template-columns:1fr 1fr;gap:clamp(32px,6vw,90px);padding-block:54px}
.access h2 {font-size:clamp(28px,3vw,40px);line-height:1.18;margin-bottom:16px}
.access a {width:fit-content;gap:7px;text-decoration:underline;text-underline-offset:4px;margin-top:16px}
.permissions article {align-items:flex-start;gap:14px;padding:16px 0}
.permissions article+article,footer {border-top:1px solid var(--border-default)}
h3 {font-weight:700;margin-bottom:4px}
footer {color:var(--text-muted);font-size:14px;padding-bottom:24px}
.hero {grid-template-columns:1fr;text-align:center;gap:30px}.intro,.cta {margin-inline:auto}figure {text-align:left;max-width:580px;margin:auto}
@media(max-width:720px){.wrap{width:calc(100% - 36px)}.hero,.access,.uses{grid-template-columns:1fr}.hero{gap:28px;padding-block:40px}.uses{gap:24px}.uses article{display:grid;grid-template-columns:25px 1fr;column-gap:12px}.uses h2{margin:0 0 5px}.uses p{grid-column:2}.access{gap:12px;padding-block:36px}nav{gap:12px}}
</style>
