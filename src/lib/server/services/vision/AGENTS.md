# Vision

What the chat model sees of an image. The chat turn's own wiring lives in `chat-turn/`; read its AGENTS.md before adding a model call.

- **Pixels belong to one turn.** They ride in the messages of the turn that needs them (there is no look-at-image tool); afterwards history carries a short description of the image.
- **Every image a model is sent comes out of `prepareImageForModel`** (`prepare-image.ts`: upright, flat, first frame, JPEG), never the stored original, so the budgets hold.
- **Budgets.** An attachment goes at most 1600 px on its long side (about 1,600 tokens), an Immich thumbnail at most 512 px (about 250). Tokens are `ceil(w/32) * ceil(h/32)` (`estimateImageTokens`). A turn carries at most 8 attachment images and 8 thumbnails as pixels.
- **Who receives pixels.** Only a model whose `imageMessageParts` capability is explicitly `true` (the admin's "Can see images" tick). A cloud model gets images only when that model is ticked, and Immich pixels follow `connections/locality.ts` (local summarising and the cloud warning).
- **Failover.** An attempt on a model that cannot see gets no image parts.
- **Profile memory** receives descriptions, never pixels.
