import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const cwd=process.cwd();
const require=createRequire(join(cwd,'package.json'));
const Database=require('better-sqlite3');
const {drizzle}=require('drizzle-orm/better-sqlite3');
const {migrate}=require('drizzle-orm/better-sqlite3/migrator');
const dir=mkdtempSync(join(tmpdir(),'alfyai-synthetic-mirror-'));
const path=join(dir,'source.db');
const db=new Database(path);
try{
 migrate(drizzle(db),{migrationsFolder:'drizzle'});
 db.exec(`
 INSERT INTO users (id,email,password_hash,memory_enabled) VALUES ('owner','Owner@test.invalid','synthetic',1),('other','other@test.invalid','synthetic',1);
 INSERT INTO projects (id,user_id,name) VALUES ('project','owner','synthetic project'), ('other-project','other','excluded project');
 INSERT INTO conversations (id,user_id,title,project_id) VALUES ('c','owner','authorized personal',null),('cp','owner','authorized project','project'),('cx','other','excluded',null);
 INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ('m','c','user','I use a yellow kayak',unixepoch()-100),('mp','cp','user','Project kite is purple',unixepoch()-99);
 INSERT INTO memory_control_intervals (id,user_id,enabled,started_at,epoch) VALUES ('control','owner',1,unixepoch()-200,0);
 INSERT INTO memory_projection_state (id,user_id) VALUES ('p','owner'),('other-p','other');
 INSERT INTO memory_profile_items (id,user_id,projection_state_id,item_key,category,scope_type,scope_id,statement)
 VALUES ('f','owner','p','k','about_you','global','','I use a yellow kayak'),
 ('fp','owner','p','kp','about_you','project','project','Project kite is purple'),
 ('fx','other','other-p','kx','about_you','global','','Other account excluded');
 INSERT INTO memory_profile_item_provenance (id,item_id,user_id,source_type,source_id,label,summary)
 VALUES ('v','f','owner','conversation','c','Conversation','yellow kayak'),
 ('vp','fp','owner','conversation','cp','Conversation','kite is purple');
 `);
 const input={databasePath:path,email:'Owner@test.invalid',userId:'owner',cases:[
 {id:'P',projectId:null,query:'What do I use?'},{id:'W',projectId:'project',query:'Which kite?'}]};
 const child=`
 import {readOwnerLegacyMirror} from './docs/plans/hindsight-memory/paired-migration-rehearsal/owner-legacy-mirror.ts';
 const original = JSON.parse(process.argv[1]);
 try {
   const {results, verifyCheckpoint} = await readOwnerLegacyMirror(original);
   if (original.withdrawAtDispatch) {
     const {default: Database} = await import("better-sqlite3");
     const source = new Database(original.databasePath);
     source.exec("UPDATE users SET memory_enabled=0 WHERE id='owner'");
     source.close();
   }
   verifyCheckpoint();
   console.log(JSON.stringify(results));
 } catch (error) {
   console.log(JSON.stringify({error:error.message}));
 }
 `;
 const run=(opts=input)=> JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',child,JSON.stringify(opts)],{env:{...process.env,DATABASE_PATH:':memory:'},encoding:'utf8'}).trim().split('\n').at(-1));
 const bytes=readFileSync(path);
 const result=run();
 assert.equal(result.length,2,JSON.stringify(result));
 assert.match(result[0].content,/yellow kayak/);
 assert.doesNotMatch(result[0].content,/purple|excluded/);
 assert.match(result[1].content,/kite is purple/);
 assert.match(result[1].content,/yellow kayak/);
 assert.doesNotMatch(result[1].content,/excluded/);
 const syntheticCopy=join(dir,'synthetic-authority.db');
 copyFileSync(path,syntheticCopy);
 const actual=`
 import {getMemoryContext} from './src/lib/server/services/memory-context.ts';
 import {sqlite} from './src/lib/server/db/index.ts';
 const input=JSON.parse(process.argv[1]);
 const out=[];
 for(const [i,test] of input.cases.entries()) {
  sqlite.exec("BEGIN");
  try {
   const result=await getMemoryContext({userId:input.userId, conversationId:i===0?'c':'cp',query:test.query,mode:"persona",includeEvidenceCandidates:false});
   out.push({id:test.id,content:result.content});
  } finally { sqlite.exec("ROLLBACK"); }
 }
 console.log(JSON.stringify(out));
 `;
 const expected=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',actual,JSON.stringify(input)],{env:{...process.env,DATABASE_PATH:syntheticCopy},encoding:'utf8'}).trim().split('\n').at(-1));
 assert.deepEqual(result,expected);
 assert.deepEqual(readFileSync(path),bytes);
 assert.equal(run({...input,userId:'other'}).error,'legacy_provenance_unavailable');
 assert.equal(run({...input,cases:[{id:'x',projectId:'other-project',query:'unknown'}]}).error,'legacy_provenance_unavailable');
 db.exec("UPDATE memory_profile_items SET status='retired' WHERE id='fp'");
 assert.equal(run().error,'legacy_provenance_unavailable');
 db.exec("UPDATE memory_profile_items SET status='active' WHERE id='fp'");
 assert.equal(run({...input,withdrawAtDispatch:true}).error,'legacy_provenance_unavailable');
 db.exec("UPDATE users SET memory_enabled=1 WHERE id='owner'");
 db.exec("UPDATE conversations SET memory_incognito=1 WHERE id='c'");
 assert.equal(run().error,'legacy_provenance_unavailable');
 db.exec("UPDATE conversations SET memory_incognito=0 WHERE id='c'; UPDATE memory_control_intervals SET enabled=0");
 assert.equal(run().error,'legacy_provenance_unavailable');
 db.exec("UPDATE memory_control_intervals SET enabled=1; UPDATE messages SET content='edited away' WHERE id='m'");
 assert.equal(run().error,'legacy_provenance_unavailable');
 console.log('Mirror equals original synthetic persona reader byte-for-byte and confirmed personal and project scoping. Wrong account, foreign project, incognito, known-off, former exclusions, missing quote and change before dispatch were held. Source bytes unchanged.');
} finally {db.close(); rmSync(dir,{recursive:true});}
