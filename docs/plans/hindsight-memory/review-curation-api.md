# Independent curation and Memory API checkpoint

**Request changes for Tasks 3 and 5.** Seven independent synthetic SQLite/job-engine probes reproduced four kinds of incorrect outcome: an acknowledged Remove could return, a rejected Edit could later take effect, a successful mutation could lack the requested user-visible result, and a queued composer note could cross a privacy transition. Each probe below exercised production services, the existing queue, a fresh fixture database and controlled native/model responses. They establish application behavior for those responses. Native semantic reliability still requires its own acceptance run.

## Findings

1. **P1 · Replay applies a rejected Edit.** In `src/lib/server/services/memory-profile/curation-runner.ts:457–485`, every saved plan whose source IDs match is replayable. A plan is written before semantic validation at lines 289–316. Probe 1 rejected the initial proposal and its one repair, observed the Edit operation as failed, re-extracted the source under new IDs, and saw its proposed purple kayak enter the accepted list. The original operation still reported failed. Persist the successful publication outcome with the action itself and replay only authoritative Edit/source-edit outcomes. Keep rejected drafts outside replay, including after job pruning. A Remove has its own earlier durable exclusion boundary.

2. **P1 · A failed Remove planner releases exclusion on re-extraction.** `curation-actions.ts:244–256` records exclusion only for the current raw ID/text fingerprints. `curation-runner.ts:485` skips the action if its plan is missing. Probe 2 acknowledged Remove, forced a planner outage, then re-extracted the same source under new native IDs. Both the green kayak and the unrelated bicycle reappeared. Keep the known source family held against replacement fingerprints until the exclusion is reconciled, while continuing to admit already-verified independent facts. A transport/model outage currently becomes terminal under `delivery-runner.ts`'s generic nonretryable catch, and resending the same request cannot restart such a cleanup. Classify recoverable preparation failures and support a durable retry after repair of a configuration/outage.

3. **P1 · Replay trusts PATCH acknowledgement without verifying the approved result.** `curation-runner.ts:519–533` saves the source IDs and originals, then acknowledges whatever the later native capture returns. The direct action path has an exact-readback check at line 394. Probe 3 first completed a valid Remove. During re-extraction the replacement native ID returned HTTP success for invalidation and remained live. Replay published the removed fact and marked the source delivery successful. Persist the expected final per-ID replay result and compare it with the settled capture, including absence for invalidations, before updating acknowledgements. For multiple actions, compare the composed final result. A mismatch must keep the previous admissible generation and the exclusion.

4. **P1 · An older running Edit defeats a newer acknowledged Remove.** `curation-actions.ts:176–218,244–256` accepts Remove on the displayed generation while Edit is mutating native facts. `curation-runner.ts:51–74,223–230,423–447` fences the worker and account, but the later action did not change that generation or reserve the target. Probe 4 submitted Remove from inside the older Edit's PATCH. Edit published purple kayak under a new fingerprint. Remove finished stale, still reporting `exclusionAcknowledged: true`, and the live list exposed the kayak. Serialize or fence overlapping intent at admission and publication, including saved-proposal retries. Either refuse the later stale request before acknowledging exclusion or honor its exclusion through the earlier work and reconcile the known target. Unrelated facts must remain admissible.

5. **P1 · Manual Edit validates before extracting a second unverified set of facts.** `curation-runner.ts:296–319,352–394,423–435` checks the pre-existing raw fact proposal, then retains the dated before/after event and acknowledges all newly extracted facts from its document. Probe 6 successfully validated removal of “green” from the old raw facts. The separate native retain emitted “green kayak”, which the application published with operation status applied. This also admits an unchanged claim at the action's new date if the extractor repeats it. Stage the native delta first, include its immutable facts in the same bounded collective check, and withhold the candidate if omission, ownership, or date semantics fail. Preserve the one-plan/one-repair budget and native ownership of extraction.

6. **P1 · Add can acknowledge success with no visible memory.** `curation-runner.ts:395–423` requires one raw fact for Add, accepts zero relevant consolidated observations, and unconditionally completes the operation after publication. Probe 5 retained the old observations plus one new consolidated raw fact with no observation supported by it. Status was applied, reference was null and searching the new wording returned zero rows. Require a verified effect in the accepted observation set. For a split/merge, keep successful multi-row effects distinct from the absence of any effect, and do not invent a detail/history identity.

7. **P1 · A queued /remember loses its originating chat's privacy fence.** `curation-actions.ts:362–396` checks the chat at submission and passes only scope, text and request ID into Add. `curation-runner.ts:236–274` treats the resulting record as standalone. Probe 7 submitted from an empty normal chat, armed Incognito using the existing server mutation before the queue drained, and observed the note text in the outgoing native retain. Empty chats legitimately support that transition, including after a composer command. Persist the originating conversation and scope as mutation eligibility metadata. Recheck them at dispatch and publication, and handle already-sent work on withdrawal. Standalone Add from Knowledge retains its existing independent semantics. This backend sequence is distinct from both fixed UI races below.

8. **P1 · The dedicated model selector accepts a cloud endpoint.** Source-traced. `src/lib/server/services/memory-profile/curation.ts:79–103` checks presence and built-in enablement but delegates the configured ID straight to the generic control sender. `src/routes/(app)/settings/_components/system/AiTasksPage.svelte:317–318` supplies the general model groups. `normal-chat-model/index.ts:490–526` resolves an enabled composite ID to its provider, and `normal-chat-control-model.ts:356–375` uses that endpoint with the memory payload. Choosing an enabled external provider, or changing the endpoint behind a selected binding, therefore sends original memory text there. The default unset and missing composite IDs do fail closed. Enforce the local deployment boundary on the actual resolved endpoint before dispatch and restrict the selector accordingly. Use the existing host-locality decision. Prove local and external synthetic bindings with a recording transport before using real models.

## Read-path and operating observations

- **P2 · A past rejected edit leaves the whole bank showing a failure.** `src/lib/server/services/memory-profile/native-read.ts:190–207` marks the page failed for any failed job in the epoch. Submit a rejected Edit, successfully correct it under a new request, and load the page after both finish. The old failed attempt still determines page status. Distinguish a past action outcome from outstanding background work or cleanup that still needs attention.
- **P2 · Getting 50 rows scans all accepted source records up to 50 times.** `native-read.ts:211–213,231–287` obtains each displayed source count by independently selecting and parsing the whole bank's accepted sources, then reading entire conversations/messages to assemble quotations discarded by the list. This runs synchronously inside the SQLite transaction. Batch the relevant source associations once per page and keep quotation reads in detail, with the same eligibility rules. Measure on a representative bank.
- List/detail/actions/operation routes authenticate the caller and derive the user ID from the session. List/detail scope checks require project ownership. The current-text search operates on published display text; the keyset includes date and native ID, pins a generation and rejects expired snapshots. Source detail requires an owned conversation, a user message in it and exact original text before presenting its quotation. Native users receive 410 for the retired summary, timeline and overview endpoints, with service-level legacy guards too. Exact surviving observation identity limits previous-wording links. `verifiedMemoryHistory` at `native-read.ts:339–373` relies on a live successful delivery-job row, so durable version history after job pruning still requires a durable action outcome. No cross-user access was observed in the reviewed route fixtures.
- The logical editor checks the exact cardinality, uniqueness and membership of proposed IDs. It permits one semantic repair and fails an exhausted check before the initial PATCH. Stable operation UUIDs are sent to the pinned native async retain endpoint. The pin's `hindsight_api/api/http.py:9864–9894` forwards that UUID, `engine/memory_engine.py:23919–23924` resolves a replay, and `api/http.py:2979–3050` defines text updates/invalidations with independent temporal fields. The existing lost-PATCH test confirms a matching live read avoids another PATCH. None of this establishes native end-to-end correctness under receipt expiry, stale partial proposals or changed raw IDs.
- The integration worker's already-submitted dependent-document repair remains a separate open item. Findings 1–6 were exercised on a source with no dependency on another document's stored context.

## Acceptance evidence

Five existing suites passed independently under Node 22: 22 tests across bounded curation, curation configuration, curation/engine integration, native reads and Memory HTTP routes. Eight of these are the existing curation integration tests. The reported 35 legacy tests are the implementer's separate compatibility run. Seven additional defect probes passed their assertions about the observed failures. Historical EN/HU prototypes and mocked native responses cannot grade the integrated local extractor, checker, consolidation or answerer. Task 3 still requires the four ported EN/HU lifecycles, the expanded mixed-edit safe rejection, forced re-extraction, restart, newer deliberate assertions and independent semantic grading. Task 5 still requires the integrated browser and real-native contract checks. Ordinary safe rejections are allowable. Accepted collateral loss, acknowledged removals that reappear, and false success block acceptance.

## Separate composer rereview

**Both findings in review-ui-rereview2.md are fixed for the reported interleavings.** `HomeSurface.svelte:984–999` captures the preparation epoch and project across draft creation and the privacy barrier. `MessageInput.svelte:3254–3278` checks Incognito before and after asynchronous preparation and checks component/active conversation identity. The deferred tests in `src/lib/components/home/HomeSurface.test.ts:748–813` exercise the real composer/host path, swap projects while a draft is being created and hold the Incognito PATCH after a normal preparation. Both assert zero note submissions in the refused context. Independent Node 22 run of both complete suites passed **305/305**. jsdom printed its pseudo-element diagnostic. Browser execution and the later server-side queue transition are outside this two-fix disposition.

## Reproduce the seven observed failures

Run from the checkout root using Node 22. The following command extracts this report's exact probe source, loads it with a temporary Vite transform, and invokes only those probes in the repository's existing synthetic integration harness. The application and checked-in tests are untouched. Once fixed, invert the defect assertions when promoting them to permanent regressions.

```sh
python3 - <<'PY'
from pathlib import Path
import json
report = Path('docs/plans/hindsight-memory/review-curation-api.md').read_text()
cases = report.split('<!-- executable-cases -->' + '\n```ts\n', 1)[1].split('\n```', 1)[0]
Path('/tmp/review-curation-cases.ts').write_text(cases)
config = json.dumps(str(Path('vitest.config.ts').resolve()))
Path('/tmp/review-curation.vitest.config.mjs').write_text(
    'import config from ' + config + ";\nimport fs from 'node:fs';\n"
    "export default {...config,plugins:[...config.plugins,{name:'curation-review',enforce:'pre',"
    "transform(code,id){if(id.endsWith('/curation.integration.test.ts'))return code+'\\n'+"
    "fs.readFileSync('/tmp/review-curation-cases.ts','utf8');}}]};\n")
PY
PATH=/opt/homebrew/opt/node@22/bin:$PATH ./node_modules/.bin/vitest run --config /tmp/review-curation.vitest.config.mjs --configLoader runner src/lib/server/services/memory-profile/curation.integration.test.ts -t checkpoint
```

<!-- executable-cases -->
```ts
const ckRef = {scope:{kind:"personal" as const}, generation:"g",rowId:"kayak"};
const ckPlan = {forget:[],replace:["green to purple"],preserve:["sister bicycle"]};
const ckProposal = (id:string,target:string,sister="sister")=>({facts:[{id,text:target},{id:sister,text:"sister bicycle"}]});
const ckOkay = {valid:true,issues:[]};
const ckReject = {valid:false,issues:[{id:"sister",problem:"loss"}]};
async function ckRebuild(f:Awaited<ReturnType<typeof setup>>, fixture:Awaited<ReturnType<typeof nativeFixture>>) {
 const {enqueueMemoryDelivery,memoryDeliveryJob}=await import('./delivery-job');
 fixture.setFacts([{id:"new-kayak",text:"green kayak"},{id:"new-sister",text:"sister bicycle"}]);
 await enqueueMemoryDelivery({userId:h.userId,bankId:f.bank.id,epoch:0,kind:"source",sourceId:f.source.id,requestId:"ck-rebuild"});
 await h.engine.drain(memoryDeliveryJob);
 return (await import('./publication')).readPublishedMemory(h.userId,f.bank.id).map(r=>r.text).sort();
}
it("checkpoint failed edit is applied by later re-extraction", async()=>{
 const f=await setup(); const fixture=await nativeFixture(f,[ckPlan,ckProposal("kayak",""),ckReject,ckProposal("kayak",""),ckReject,ckProposal("new-kayak","purple kayak","new-sister"),ckOkay]);
 const a=await import("./curation-actions"); const jobs=await import("./delivery-job");
 const op=await a.submitMemoryAction(h.userId,{kind:"edit",text:"purple kayak",ref:ckRef,requestId:randomUUID()});
 await h.engine.drain(jobs.memoryDeliveryJob); expect(a.getMemoryOperation(h.userId,{id:op.id}).status).toBe("failed");
 expect(await ckRebuild(f,fixture)).toEqual(["purple kayak","sister bicycle"]);
 expect(a.getMemoryOperation(h.userId,{id:op.id}).status).toBe("failed");
});
it("checkpoint acknowledged remove is reversed by new raw IDs when plan missing", async()=>{
 const f=await setup(); const fixture=await nativeFixture(f,[]); const a=await import("./curation-actions"); const jobs=await import("./delivery-job");
 const op=await a.submitMemoryAction(h.userId,{kind:"remove",ref:ckRef,requestId:randomUUID()});
 await h.engine.drain(jobs.memoryDeliveryJob); expect(a.getMemoryOperation(h.userId,{id:op.id})).toMatchObject({status:"failed",exclusionAcknowledged:true});
 expect(await ckRebuild(f,fixture)).toEqual(["green kayak","sister bicycle"]);
});
it("checkpoint replay publishes a different native result from verified proposal", async()=>{
 const f=await setup(); const fixture=await nativeFixture(f,[{forget:["kayak"],replace:[],preserve:["sister"]},ckProposal("kayak",""),ckOkay,ckProposal("new-kayak","","new-sister"),ckOkay]); const a=await import("./curation-actions"); const jobs=await import("./delivery-job");
 const op=await a.submitMemoryAction(h.userId,{kind:"remove",ref:ckRef,requestId:randomUUID()});
 await h.engine.drain(jobs.memoryDeliveryJob); expect(a.getMemoryOperation(h.userId,{id:op.id}).status).toBe("applied");
 const fetcher=fixture.fetcher.getMockImplementation()!;
 fixture.fetcher.mockImplementation(async(u,i)=>i?.method==="PATCH" && String(u).endsWith("/new-kayak") ? new Response("{}") : fetcher(u,i));
 expect(await ckRebuild(f,fixture)).toEqual(["green kayak","sister bicycle"]);
});
it("checkpoint in-flight edit can defeat later acknowledged removal",async()=>{
 const f=await setup(); const a=await import("./curation-actions"); const jobs=await import("./delivery-job"); const fixture=await nativeFixture(f,[ckPlan,ckProposal("kayak","purple kayak"),ckOkay,{forget:["kayak"],replace:[],preserve:["sister"]}]);
 const original=fixture.fetcher.getMockImplementation()!; let removeId="";
 fixture.fetcher.mockImplementation(async(u,i)=>{
   if(!removeId&&i?.method==="PATCH"){removeId=(await a.submitMemoryAction(h.userId,{kind:"remove",ref:ckRef,requestId:randomUUID()})).id;}
   return original(u,i);
 });
 const e=await a.submitMemoryAction(h.userId,{kind:"edit",ref:ckRef,text:"purple kayak",requestId:randomUUID()});
 await h.engine.drain(jobs.memoryDeliveryJob);
 expect(a.getMemoryOperation(h.userId,{id:e.id}).status).toBe("applied");
 expect(a.getMemoryOperation(h.userId,{id:removeId})).toMatchObject({status:"stale",exclusionAcknowledged:true});
 expect((await import("./publication")).readPublishedMemory(h.userId,f.bank.id).map(r=>r.text)).toContain("purple kayak");
});
it("checkpoint add with zero published observations reports applied",async()=>{
 const f=await setup(); const fixture=await nativeFixture(f,[]); const a=await import("./curation-actions"); const jobs=await import("./delivery-job");
 const orig=fixture.fetcher.getMockImplementation()!; let doc="";
 fixture.fetcher.mockImplementation(async(u,i)=>{
 if (String(u).endsWith("/memories")&&i?.method==="POST") doc=JSON.parse(String(i.body)).items[0].document_id;
 if(String(u).includes("/memories/list")){const base=await (await orig(u,i)).json();const items=[...base.items,{id:"new-fact",text:"I paddle",fact_type:"world",document_id:doc,consolidated_at:"2026-11-01"}];return new Response(JSON.stringify({items,total:items.length,offset:0}));}
 return orig(u,i);
 });
 const op=await a.submitMemoryAction(h.userId,{kind:"add",text:"I paddle",scope:{kind:"personal"},requestId:randomUUID()});
 await h.engine.drain(jobs.memoryDeliveryJob);
 expect(a.getMemoryOperation(h.userId,{id:op.id})).toMatchObject({status:"applied",ref:null});
 expect((await import("./native-read")).listMemory(h.userId,{scope:{kind:"personal"},query:"I paddle"}).rows).toHaveLength(0);
});
it("checkpoint later native assertion reintroduces a validated omission",async()=>{
 const f=await setup(); const fixture=await nativeFixture(f,[{forget:["green"],replace:[],preserve:["kayak","sister"]},ckProposal("kayak","kayak"),ckOkay]); const a=await import("./curation-actions"); const jobs=await import("./delivery-job");
 const orig=fixture.fetcher.getMockImplementation()!; let doc="";
 fixture.fetcher.mockImplementation(async(u,i)=>{
 if(String(u).endsWith("/memories")&&i?.method==="POST")doc=JSON.parse(String(i.body)).items[0].document_id;
 if(doc&&String(u).includes("/memories/list")){
 const base=await (await orig(u,i)).json();
 const items=[...base.items,{id:"wrong-native",text:"green kayak",fact_type:"world",document_id:doc,consolidated_at:"2026-11-01"},{id:"wrong-observation",text:"green kayak",fact_type:"observation",source_memory_ids:["wrong-native"]}];
 return new Response(JSON.stringify({items,total:items.length,offset:0}));
 }
 return orig(u,i);
 });
 const op=await a.submitMemoryAction(h.userId,{kind:"edit",text:"kayak",ref:ckRef,requestId:randomUUID()});
 await h.engine.drain(jobs.memoryDeliveryJob); expect(a.getMemoryOperation(h.userId,{id:op.id}).status).toBe("applied");
 expect((await import("./publication")).readPublishedMemory(h.userId,f.bank.id).map(r=>r.text)).toContain("green kayak");
});
it("checkpoint command queued on empty normal chat sends after arming Incognito",async()=>{
 const f=await setup(); const fixture=await nativeFixture(f,[]); const a=await import("./curation-actions"); const jobs=await import("./delivery-job");
 f.db.insert(f.s.conversations).values({id:"draft",userId:h.userId,title:"draft"}).run();
 await a.submitRememberNote(h.userId,{text:"private note",requestId:randomUUID(),conversationId:"draft"});
 const chats=await import("../conversations"); await chats.setConversationMemoryIncognito(h.userId,"draft");
 await h.engine.drain(jobs.memoryDeliveryJob);
 expect(fixture.fetcher.mock.calls.some(([u,i])=>String(u).endsWith("/memories")&&i?.method==="POST"&&JSON.parse(String(i.body)).items[0].content==="private note")).toBe(true);
});
```
