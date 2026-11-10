# Resumed operation policy clarification

Status: reviewed conservative alternative, NOT SELECTED. The judge recommended the simpler structural policy now binding in spec.md. Retained to explain the rejected restriction; do not implement this family-based semantic gate.

The no-repeat guarantee is structural. A human answer authorizes continued work, but not blind repetition of an earlier effect. No semantic exactly-once claim and no model/prose classifier is introduced.

## One owner and closed operation classes

The normal-chat-tools owner supplies a closed, validated descriptor for each executable app operation, based on actual tool/action schema and existing domain identity. Unknown tools/actions refuse resumed dispatch until registered. Model Run consumes the resulting new/reuse/refuse decision; transports do not infer effects or parse tool prose.

- Read-only operations: the tool owner explicitly declares the exact action read-only. New reads are authorized by resumed user input. An identical previously completed read within the frozen turn may reuse its captured full result. A payload key can find that cache result only after the read-only class grants authority; the key is not proof of new side-effect authorization. Never reuse uncertain results or refetch merely to repair missing capture.
- Staged write proposals: dispatch only creates/returns a pending proposal; actual external commit remains behind its existing independent confirmation and idempotency owner. An existing same proposal is reused by that real owner's stable identity. If this reply already proposed a mutation in that same domain/action family and the new proposal cannot be proved distinct by domain ownership, refuse rather than generate another changed proposal automatically.
- App/sandbox mutations: first explicitly supported operation in a mutation family after human resume is allowed if there is no prior dispatched/completed/uncertain operation in that family. Prior work in that family requires real domain-operation identity/precondition to prove a new operation, or a real idempotent stored-result identity to reuse it. Otherwise refuse. New provider IDs, arbitrary changed text and hashes alone cannot supply that proof.
- Any unresolved prior effect blocks new work as already required by Model Run. Unknown/provider-hosted effects remain uncertain, never fabricated success.

The family map must be explicit at the tool owner and use validated action discriminants, not broad name substring inference. Domain preconditions (such as artifact revision/block identity) may refine the conservative rule only where actual existing validation enforces them. Do not invent a generic semantic operation ID or bypass existing confirmation.

## Required interface examples

1. A turn searches files, asks which file, then the person chooses one: a validated files.read operation is new authorized read work; the initial search is not rerun. A second identical completed read reuses its recorded result.
2. A turn has only read email, asks whether to draft/send a reply, and the person agrees: the first email.send pending proposal is permitted, with actual send still requiring the existing write confirmation. No physical send occurs in recovery/resume.
3. A previous email.send proposal/effect exists and the next model call changes recipient/body under the same unresolved operation family without domain proof: refuse, retaining the prior proposal/result. Do not mistake changed arguments for a new operation.
4. A first artifact creation after a read-only pause may proceed. An earlier creation followed by another ambiguous creation on resume is refused; a genuinely distinct edit may proceed only under the existing artifact revision/precondition owner. Unknown mutation action refuses.

## Deliberate limitation

This fails closed for ambiguous resumed mutations, including some requests a person may have intended as a second operation. Preserve existing results/activity and report explicit incomplete state rather than silently repeat or claim completion. An explicit fresh user turn/retry has its own requested-turn identity. This limitation must be documented in acceptance results, not hidden by an optimistic test. A more permissive cross-domain semantic authorization protocol is separate work, not guessed here.

The judge should decide whether this is consistent with the already accepted new-operation/ambiguous-repeat contract and identify concrete unsafe classes. No implementation is required to pretend the application already has a universal operation-identity interface.
