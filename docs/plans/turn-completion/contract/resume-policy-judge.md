# Scoped resume operation policy judgment

**PASS — the proposed conservative policy safely implements the currently accepted wording. No blocking safety correction to that proposal. Recommend the cheaper structural clarification below instead before implementing resumed dispatch.**

Read `resume-operation-policy.md`, accepted final resume clauses in `spec.md`, and `task-2b-report.md`. Focused checks: email/calendar action schemas and proposal paths, pending-write confirmation owner, IMAP read-only behavior, and artifact patch preconditions. Project memory index/relevant historical completion note were read from the source checkout because this worktree lacks the index. No product/spec edits, tests, agents, remote actions or broad research. This report is specification review, not implementation acceptance.

## Existing proposal

The closed tool-owner read/proposal/mutation map is implementable without inventing a universal semantic operation owner. Unknown actions refuse; prior uncertainty blocks work; recorded results can be reused; mutations without trustworthy distinction refuse. Fingerprints are cache lookup keys, not proof of authorization. These choices satisfy the existing ambiguous-repeat refusal clause.

The concrete owners support the distinction: email `send/trash/flag` and calendar `create_event/update_event/delete_event` stage pending writes, not external commits. `pending-writes.ts` claims the pending row before its executor runs and retains terminal/expiry state. IMAP reads open read-only and do not mark messages seen. Artifact patch schemas/preconditions exist, but their existence alone does not establish semantic new-operation identity for all edits. Reuse must retain/revalidate the actual owner's state; an expired/cancelled proposal must not be represented as a fresh pending authorization.

The conservative policy's limitation is real: a user can request two creations, require an ask before the second, answer yes, and still be refused because creation already occurred in that family. Safety is achieved by refusing some authorized work. That is documented, but it is not necessary to prevent structural harness replay.

## Recommended best course: clarify scope, use existing tool owners

Adopt the user's cheaper alternative as an explicit binding refinement, superseding the blanket semantic ambiguous-repeat clause for genuinely new model choices after human input. Do not claim that it already satisfies that clause unchanged. Task 2B correctly identified a missing universal semantic classifier; do not build one merely to unblock integration.

Suggested binding text:

> An accepted user answer to ask_user authorizes a new segment of the requested work. Retain the exact prior transcript, results and scoped execution ledger as context; they are never executable replay instructions. Harness recovery, retransmission, failover or reconnect must not dispatch a previously recorded operation again. Known execution reuse returns its recorded result or is refused; a new provider call ID or payload hash cannot relabel a replay as new work. Any prior unsettled or uncertain execution blocks new dispatch until safely reconciled, or the segment fails explicitly.
>
> Once admitted as an explicit user-input segment, newly generated calls may execute under the same validated tool, access, domain-precondition and confirmation policies as ordinary requested work. A prior successful operation in the same family does not alone prohibit another operation. Authorization comes from the human-input segment and existing tool/domain policy, not a call ID, fingerprint, or generic model-intent classifier. External write confirmation remains separately required; an ask answer does not execute or confirm a pending write by itself.
>
> Automatic recovery after execution within this new segment remains tools-disabled. No semantic exactly-once guarantee is made across independently generated operations, whether in one ordinary tool loop or across a user-input resume. Existing operation owners still enforce concrete idempotency/preconditions where available.

This permits “Create two docs; ask before the second” → yes → second creation. It also permits new read work after file selection and a new send proposal after an ask, while the actual send remains independently confirmable. A genuinely new model-generated call may have the same arguments as an earlier one; a generic fingerprint cannot decide whether the person intended repetition. Concrete existing domain ownership may identify it as the same operation; otherwise the structural contract does not pretend to resolve that semantic question.

Execution identity must be scoped to the actual registered operation/segment/attempt occurrence, not a globally unique assumption about provider tool-call IDs. Retained transcript callbacks cannot be redispatched as fresh proposals. Reusing a provider ID in a later response is not by itself either authorization or proof of replay.

## Disposition

**Conservative proposal: PASS under current binding wording. Preferred design: the structural clarification above, with no closed mutation-family semantic authorization gate.** Incorporate the clarification before implementing the cheaper alternative so implementers do not inherit contradictory requirements. This is a specification refinement under the user's authorized judge→implementation workflow, not a request for another human approval.

Focused implementation evidence should distinguish: first operation → ask → legitimate second operation; prior execution replay/retransmission never dispatches; prior uncertainty blocks work; automatic failure after resumed execution does not reopen tools; write proposal remains pending until its independent confirmation. Preserve full-context/privacy/capacity rules and durable accounting unchanged. Finite counters establish structural dispatch behavior, not universal semantic exactly-once effects.
