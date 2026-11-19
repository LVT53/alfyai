// Read-only configuration; only synthetic inference requests. No remote writes.
const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
process.loadEnvFile('.env');
const Database = require('better-sqlite3');
// Remote configuration lookup ONLY; never imports or executes AlfyAI application code.
// No chat, user, memory or source table is queried, and no writes are permitted.
if (!process.env.DATABASE_PATH) throw Error('Explicit remote configuration DB path required');
const remoteConfigDbPath = require('node:path').resolve(process.env.DATABASE_PATH);
const db = new Database(remoteConfigDbPath, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const records=db.prepare('select p.base_url,p.api_key_encrypted,p.api_key_iv,m.name from providers p join provider_models m on m.provider_id=p.id where m.name = ?').all('qwen3-6-27b');
const cfg=Object.fromEntries(db.prepare("select key,value from admin_config where key like 'TEI_%' or key like 'MEMORY_%'").all().map(x=>[x.key,x.value]));
const setting=k=>cfg[k]??process.env[k]??'';
db.close();
const rows=new Map();
for(const row of records){let key=row.api_key_encrypted;if(row.api_key_iv){const derived=crypto.pbkdf2Sync(process.env.SESSION_SECRET,'alfyai-providers',100000,32,'sha256'),raw=Buffer.from(key,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',derived,Buffer.from(row.api_key_iv,'base64'));decipher.setAuthTag(raw.subarray(-16));key=decipher.update(raw.subarray(0,-16)).toString('utf8')+decipher.final('utf8');}rows.set(row.name,{...row,key});}
readline.createInterface({input:process.stdin}).on('line',async line=>{const req=JSON.parse(line),start=Date.now();try{if(req.body._eval_transport){const kind=req.body._eval_transport;if(kind==='config'){console.log(JSON.stringify({id:req.id,status:200,body:{judge:setting('MEMORY_JUDGE_MODEL'),consolidation:setting('MEMORY_CONSOLIDATION_MODEL'),dryRun:setting('MEMORY_JUDGE_DRY_RUN'),embeddingModel:setting('TEI_EMBEDDER_MODEL'),embeddingConfigured:Boolean(setting('TEI_EMBEDDER_URL')),rerankerConfigured:Boolean(setting('TEI_RERANKER_URL'))},ms:Date.now()-start}));return;}if(!['embed','rerank'].includes(kind))throw Error('invalid transport');const stem=kind==='embed'?'TEI_EMBEDDER':'TEI_RERANKER';const url=setting(stem+'_URL');if(!url)throw Error('TEI not configured');const payload={...req.body};delete payload._eval_transport;const key=process.env[stem+'_API_KEY']||'';const r=await fetch(url.replace(/\/$/,'')+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});console.log(JSON.stringify({id:req.id,status:r.status,body:await r.json(),ms:Date.now()-start}));return;}const row=rows.get(req.body.model);if(!row || row.name!=='qwen3-6-27b')throw Error('Only local model permitted for remaining tests');const payload={...req.body,stream:false};if(row.name==='qwen3-6-27b')payload.chat_template_kwargs={enable_thinking:req.body.chat_template_kwargs?.enable_thinking===true};const r=await fetch(row.base_url.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+row.key},body:JSON.stringify(payload),signal:AbortSignal.timeout(180000)});console.log(JSON.stringify({id:req.id,status:r.status,body:await r.json(),ms:Date.now()-start}));}catch(e){console.log(JSON.stringify({id:req.id,status:500,body:{error:e.message}}));}});
