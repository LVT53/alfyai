const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process'),rl=require('node:readline');
const script=fs.readFileSync(__dirname+'/bridge.cjs','utf8');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const child=cp.spawn('ssh',['-o','BatchMode=yes','-o','RequestTTY=no','-o','RemoteCommand=none','alfydesign','cd /home/alfydesign/apps/langflow-chat/current && node -e '+quote(script)],{stdio:['pipe','pipe','inherit']});
let seq=0; const pending=new Map();
rl.createInterface({input:child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line)}catch{return};const p=pending.get(r.id);if(p){pending.delete(r.id);fs.appendFileSync(process.env.ALFYAI_NATIVE_MODEL_TRACE ?? __dirname+'/model-calls.jsonl',JSON.stringify({request:p.body,response:r})+'\n');p.res.writeHead(r.status,{'Content-Type':'application/json'});p.res.end(JSON.stringify(r.body));}});
http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;try{const body=JSON.parse(text),id=++seq;if(['/embed','/rerank','/config'].includes(req.url))body._eval_transport=req.url.slice(1);pending.set(id,{res,body});child.stdin.write(JSON.stringify({id,body})+'\n');}catch(e){res.writeHead(400);res.end(e.message)}}).listen(18891,'127.0.0.1',()=>console.log('Synthetic model proxy ready'));
process.on('SIGTERM',()=>{child.kill();process.exit()});
