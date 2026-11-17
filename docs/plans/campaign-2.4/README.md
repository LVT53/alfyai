# The AlfyAI 2.4 release campaign

What changed since the 2.3 campaign (published 2026-10-28), told in six cards. The owner chose the cards on 2026-11-16 and publishes the campaign once read aloud is deployed.

1. **Read aloud**: the speaker under a reply, the sentence and word marks, the player, and Read from here.
2. **Six voices, and your own**: a voice per language, plus personal voices made in Settings.
3. **Alfy asks first**.
4. **Videos from your pictures**, with the newer picture model (H3).
5. **Other new features**: editing in the message box, the chat's ruler, Nextcloud files under the reply, permission cards that say what they change, and the Feature Guide.
6. **Smaller changes and speed-ups**: compression and HTTP/2, the time zone, messages that wait out an update, HEIC photos, document search, several pictures at once, and older messages.

## The deck

- **The words:** `deck/slides.json`, in English and Hungarian, in the format `scripts/create-release-campaign.ts` reads.
- **The pictures:** `deck/slides/`, one per card at 1600 by 1000 (desktop, 16:10) and one at 1080 by 1920 (phone, 9:16).
  - They are drawn in Hungarian: a campaign picture has one language.
  - They are drawn with the drawing kit (ADR-0012, amended 2026-11-17): the real controls' keys, Lucide icons and tokens, with grey lines for content.

## Making the pictures again

```bash
npx tsx scripts/campaign-2-4/render.ts pictures
```

- **What it draws:** the deck's pictures, from `scripts/campaign-2-4/pictures/`, whose parts are in `parts/`.
- **How:** on a dev server of its own (port 5640), photographed with Playwright.
- **Options:** `--only read-aloud,voices` limits it to some cards; `--lang en` draws in English.

```bash
npx tsx scripts/campaign-2-4/render.ts cards --out <dir>
```

- **What it photographs:** the app's own campaign window holding the deck, in Hungarian and English, on a 1440 by 900 desktop and a 390 by 844 phone.
- **What it writes:** one sheet per language and device, in `<dir>`.
- **What it reports:** a card whose words scroll inside the window.

A picture follows its control, as the guide's drawings do. If a pictured control changes before the campaign is published, draw the pictures again and replace them in the draft.

## Making the draft

Run this on the server, from the release directory, as the app's user (`deploy/README.md`):

```bash
npx tsx scripts/create-release-campaign.ts --deck <copy of deck> --name "AlfyAI 2.4" --version 2.4.0 --admin-email <admin>
```

Without `--publish`, it writes a draft that only admins see.
