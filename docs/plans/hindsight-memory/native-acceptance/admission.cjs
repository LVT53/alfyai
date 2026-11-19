// Real local-model HTTP admission measurements; activity control here is synthetic.
const http=require('node:http');const fs=require('node:fs');const assert=require('node:assert/strict');
let activity={idle:false,active:false};
const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer synthetic-activity'){res.writeHead(401);return res.end()}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...activity,healthy:true,observedAt:Date.now()}));});
const base='http://127.0.0.1:18890/ext/alfyai/inference';const headers={Authorization:'Bearer synthetic-admission','Content-Type':'application/json'};
async function call(){const start=performance.now();const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'qwen3-6-27b',messages:[{role:'user',content:'Synthetic transport check: name three colours, then stop.'}],max_tokens:64,stream:false,chat_template_kwargs:{enable_thinking:false}})});await r.text();return{status:r.status,ms:Math.round(performance.now()-start)}}
async function phase(name,signal){activity=signal;const calls=await Promise.all(Array.from({length:6},call));return{name,signal,calls,counts:calls.reduce((m,c)=>(m[c.status]=(m[c.status]??0)+1,m),{})};}
(async()=>{await new Promise(r=>server.listen(18892,'127.0.0.1',r));const result={scope:'real transport/local model; synthetic activity input, not full chat acceptance',phases:[]};try{
 result.phases.push(await phase('daytime',{idle:false,active:false}));assert.equal(result.phases[0].counts[200],1);assert.equal(result.phases[0].counts[429],5);
 result.phases.push(await phase('explicit idle',{idle:true,active:false}));assert.equal(result.phases[1].counts[200],6);
 result.phases.push(await phase('foreground',{idle:true,active:true}));assert.equal(result.phases[2].counts[200],1);
 await new Promise(r=>server.close(r));result.phases.push(await phase('activity service unavailable',null));assert.equal(result.phases[3].counts[200],1);
 const r=await fetch(base+'/status',{headers});result.metrics=await r.json();assert.equal(result.metrics.peak,6);assert.equal(result.metrics.active,0);result.passed=true;
}finally{server.close();fs.writeFileSync(__dirname+'/admission-results.json',JSON.stringify(result,null,2));}console.log(JSON.stringify(result));})().catch(e=>{server.close();console.error(e);process.exitCode=1});
