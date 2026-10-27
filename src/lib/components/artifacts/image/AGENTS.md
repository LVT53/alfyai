# Image Components

The picture card and panel body of the Image kind (design 5.3-5.10). It plugs into the family's shells (`ArtifactCard.svelte`, `document-workspace/DocumentWorkspace.svelte`, `history/`); it builds no parallel shell. Motion and feel are held to the Document kind's bar (`.superpowers/sdd/MOTION-PARITY.md`).

- **`image-card-view.ts` is the card's one view model**, pure TypeScript fed an `ImageCardView` (server read model) and the component's `$t` and clock. Which takes show (`visibleTakes`: only the server's held automatic retry (origin `auto_retry`) lives in its first take's slot; the model's own retry (origin `retry`) is an ordinary take with its own progress, failure and "Use this"), which one is shown (`shownTake`), the state of a take (`takeState`, with `now` passed in; "starting" shows after `STARTING_SHOWN_AFTER_MS`), the subtitle, the eta words and Before/After availability. Components do not re-derive these; `shouldPollImageCards` calls `hasActiveImageTakes`.
- `failed.unavailable` covers every "cannot reach the picture server" code (`image_server_unreachable`, `image_server_not_configured`), not one. A change reads as words: no "edited ... ago" and no version number (History's fine print only).
- Strings are `artifacts.image.*` in `src/lib/i18n/artifacts.ts`, English and Hungarian; the kind's name is `artifacts.type.image`, the word "Artifact" never reaches the UI. Hungarian "Try again" is "Újrapróbálom" (the retry-button rule in `artifacts.test.ts`).
- Pictures load only from `/api/images/files/<id>` (`imageFileUrl`) with the chat's `conversationId`.

Do not:

- add width/height/top/left animation; animate only transform and opacity, tokens only
- import image components statically into the chat route's first load (lazy, like the other bodies)
