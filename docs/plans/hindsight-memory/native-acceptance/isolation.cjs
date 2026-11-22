// Synthetic native isolation/config/transport check. Integrated app path is a separate suite.
const {createHmac,randomUUID}=require('node:crypto');
const fs=require('node:fs');const assert=require('node:assert/strict');
const config=require('./bank-config.json');
const base='http://127.0.0.1:18890';
const tenants=[randomUUID(),randomUUID()];const bank='synthetic-native-'+randomUUID();
const keys=tenants.map(t=>{const body='synthetic.'+t;return body+'.'+createHmac('sha256',Buffer.from('ab'.repeat(32),'hex')).update(body).digest('hex')});
const evidence={scope:'native transport/config/isolation only; no app acceptance claim',tenants,bank,checks:[],responses:[]};
async function request(tenant,path,method='GET',body){const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+keys[tenant],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={text}};evidence.responses.push({tenant,path,method,status:r.status,data});return{status:r.status,data}}
const route=suffix=>'/v1/default/banks/'+bank+suffix;
async function settle(t){for(let i=0;i<240;i++){const r=await request(t,route('/operations?limit=100'));assert.equal(r.status,200);const ops=r.data.operations??[];assert(!ops.some(o=>o.status==='failed'),'native operation failed');if(ops.every(o=>['completed','cancelled'].includes(o.status)))return;await new Promise(r=>setTimeout(r,500));}throw Error('native settle timeout')}
(async()=>{try{
 for(let t=0;t<2;t++){let r=await request(t,'/ext/alfyai/capabilities');assert.equal(r.status,200);assert.equal(r.data.engine_commit,'9fb28dbd724dc1ce4da7cb4c49008e601db76c5f');assert.equal(r.data.tenant_extension,'AlfyTenant');}
 assert.notEqual(evidence.responses[0].data.tenant_binding,evidence.responses[1].data.tenant_binding);evidence.checks.push('two dynamic tenants attest distinct schema bindings');
 assert.equal((await request(0,route(''),'PUT',{})).status,200);
 assert.equal((await request(0,route('/config'),'PATCH',{updates:config})).status,200);
 assert.equal((await request(1,route('/config'))).status,404);evidence.checks.push('same bank ID inaccessible to another valid tenant before provisioning');
 assert.equal((await request(1,route(''),'PUT',{})).status,200);
 assert.equal((await request(1,route('/config'),'PATCH',{updates:config})).status,200);
 const texts=['I own a silver telescope. My favourite drink is mint tea.','Van egy zöld kajakom. A kedvenc italom a kamillatea.'];
 for(let t=0;t<2;t++){
  const id=randomUUID();const r=await request(t,route('/memories'),'POST',{operation_id:id,async:true,items:[{content:texts[t],timestamp:'2026-11-18T12:00:00Z',document_id:'synthetic-source-'+t,tags:['synthetic'],context:'User-authored synthetic fixture'}]});assert.equal(r.status,200);await settle(t);
  const list=await request(t,route('/memories/list?state=valid&limit=100&offset=0'));assert.equal(list.status,200);assert(list.data.items.length>0);const foreign=t===0?'kajak':'telescope';assert(!JSON.stringify(list.data.items).toLowerCase().includes(foreign));
 }
 evidence.checks.push('same bank ID holds independent EN/HU retained facts');
 const a=(await request(0,route('/memories/list?state=valid&limit=100&offset=0'))).data.items.find(x=>x.fact_type!=='observation');
 assert.equal((await request(1,route('/memories/'+a.id),'PATCH',{text:'unauthorized change'})).status,404);evidence.checks.push('cross-tenant native fact PATCH refused');
 assert.equal((await request(1,route(''),'DELETE')).status,200);
 assert.equal((await request(0,route('/config'))).status,200);evidence.checks.push('other tenant delete does not delete same-ID original bank');
 const r=await fetch(base+route('/config'),{headers:{Authorization:'Bearer forged'}});assert.equal(r.status,401);evidence.checks.push('forged credential refused');
 evidence.passed=true;
}finally{for(let t=0;t<2;t++){const r=await request(t,route(''),'DELETE');assert([200,404].includes(r.status));}fs.writeFileSync(__dirname+'/isolation-results.json',JSON.stringify(evidence,null,2));}console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks}));})().catch(e=>{console.error(e.message);process.exitCode=1});
