# Canvas known-bad answers

Hand-written answers a scorer must fail (decisions.md rulings 25 and 59): they live
under `../responses/` beside the recorded model answers and are served from disk in a
live run too, so a run cannot pass its gate because a model happened to misbehave. Each
is a tool-call envelope (`toolCalls`, `content`, `finishReason`, and the model's read
of the board in `priorSteps`) and each fails for exactly one reason:

| Answer | Case it answers | Must fail for |
|---|---|---|
| `canvas-known-bad-overlap` | arrange-saturday | `overlap:` — the last note is left on top of another |
| `canvas-known-bad-out-of-frame` | arrange-saturday | `frames:` — a note is moved below its frame's edge |
| `canvas-known-bad-invented-op` | remove-and-connect | `schema:` — `delete_node` and `connect` are not ops |
| `canvas-known-bad-removes-more` | remove-and-connect | `removed:` — a second note goes that the request never named |
