import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession,SessionManager,SettingsManager,DefaultResourceLoader,ModelRuntime} from '@earendil-works/pi-coding-agent';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {Type} from 'typebox';

const root=mkdtempSync(join(tmpdir(),'pi-lifecycle-'));
const timeline=[];let calls=0;let compactions=0;let toolRuns=0;let stage='baseline';
const replies=[];
const usage=n=>({input:n-20,output:20,cacheRead:0,cacheWrite:0,totalTokens:n,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const modelConfig={id:'tiny',name:'Tiny mock',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:2000,maxTokens:100};
function extension(pi){
 pi.registerTool({name:'probe',label:'probe',description:'Return synthetic tool output',parameters:Type.Object({}),async execute(){toolRuns++;return {content:[{type:'text',text:'synthetic tool result '+toolRuns+' '+ 'z'.repeat(120)}],details:undefined};}});
 pi.on('session_before_compact',(event,ctx)=>{
  compactions++;assert(compactions<8,'unexpected compaction loop');
  const branch=ctx.sessionManager.getBranch();const latest=branch.filter(e=>e.type==='compaction').at(-1);
  const prepared=ctx.sessionManager.buildSessionProjection();
  const previous=latest?.details?.window??[];
  const cut=latest?branch.findIndex(e=>e.id===latest.details.coveredThrough): -1;
  const sourceIds=new Set(branch.slice(cut+1).filter(e=>e.type!=='compaction').map(e=>e.id));
  const freshUsers=prepared.entries.filter(e=>sourceIds.has(e.sourceEntry.id)).flatMap(e=>e.messages).filter(m=>m.role==='user').map(m=>({role:'user',content:m.content}));
  const retained=[...previous.filter(x=>x.role==='user'),...freshUsers];
  const window=[...retained,{type:'compaction',encrypted_content:'synthetic-'+compactions}];
  timeline.push({event:'compaction-hook',reason:event.reason,stage,checkpoint:compactions,previousCheckpoint:latest?.details?.number??null,retainedUsers:retained.map(x=>x.content)});
  return {compaction:{summary:'MOCK_CHECKPOINT_'+compactions,firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,details:{number:compactions,coveredThrough:branch.at(-1).id,window}}};
 });
 pi.on('context',(event,ctx)=>{
  const branch=ctx.sessionManager.getBranch();const latest=branch.filter(e=>e.type==='compaction').at(-1);if(!latest)return;
  const coveredIndex=branch.findIndex(e=>e.id===latest.details.coveredThrough);
  const ids=new Set(branch.slice(0,coveredIndex+1).map(e=>e.id));
  const covered=new Set(ctx.sessionManager.buildSessionProjection().entries.filter(e=>ids.has(e.sourceEntry.id)).flatMap(e=>e.messages).filter(m=>m.role!=='system').map(m=>JSON.stringify(m)));
  return {messages:event.messages.filter(m=>!covered.has(JSON.stringify(m)))};
 });
 pi.on('before_provider_request',(event,ctx)=>{
  const latest=ctx.sessionManager.getBranch().filter(e=>e.type==='compaction').at(-1);if(!latest)return;
  const anchor='The conversation history before this point was compacted into the following summary:\n\n<summary>\n'+latest.summary+'\n</summary>';
  const index=event.payload.input.findIndex(x=>x.content===anchor);assert(index>=0,'missing mock checkpoint anchor '+JSON.stringify(event.payload));
  return {...event.payload,input:[...event.payload.input.slice(0,index),...latest.details.window,...event.payload.input.slice(index+1)]};
 });
}
function stream(model,context,options){
 const s=new AssistantMessageEventStream();
 (async()=>{try{
  calls++;assert(calls<20,'request loop');
  let payload={input:context.messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='compactionSummary'?'user':m.role,content:m.role==='compactionSummary'?m.summary:(m.role==='user'&&Array.isArray(m.content)?m.content.map(p=>p.text??'').join(''):m.content)}))};
  payload=await options?.onPayload?.(payload,model)??payload;
  const reply=replies.shift();assert(reply,'missing staged reply '+calls);
  timeline.push({event:'provider-request',stage,call:calls,input:payload.input,reportedUsage:reply.tokens});
  assert(!payload.input.some(x=>typeof x.content==='string'&&x.content.startsWith('MOCK_CHECKPOINT_')));
  const content=reply.tool?[{type:'toolCall',id:'call-'+calls,name:'probe',arguments:{}}]:[{type:'text',text:'synthetic answer '+calls}];
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage:usage(reply.tokens),stopReason:reply.tool?'toolUse':'stop',timestamp:Date.now()};
  s.push({type:'start',partial:message});s.push({type:'done',reason:message.stopReason,message});s.end();
 }catch(e){s.end();throw e;}})().catch(e=>{console.error(e);process.exitCode=1;});
 return s;
}
const settings=SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:500,keepRecentTokens:80},retry:{enabled:false},defaultThinkingLevel:'off'});
const runtime=await ModelRuntime.create({authPath:join(root,'synthetic-auth.json'),modelsPath:null,modelsStorePath:join(root,'models-store.json'),refreshOnCreate:false,allowModelNetwork:false});
runtime.registerProvider('mock',{api:'openai-responses',baseUrl:'http://mock.invalid',apiKey:'synthetic',models:[modelConfig],streamSimple:stream});
const model=runtime.getModel('mock','tiny');assert(model);
async function open(manager){
 const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Synthetic test agent.',extensionFactories:[extension],disabledBuiltinExtensions:['mcp','codemode','tool-search']});
 await loader.reload();
 const result=await createAgentSession({cwd:root,agentDir:root,modelRuntime:runtime,model,thinkingLevel:'off',settingsManager:settings,sessionManager:manager,resourceLoader:loader,tools:['probe']});
 assert.equal(result.extensionsResult.errors.length,0,JSON.stringify(result.extensionsResult.errors));
 await result.session.bindExtensions({mode:'print',onError:error=>{throw Error(JSON.stringify(error));}});
 result.session.subscribe(e=>{if(['compaction_start','compaction_end'].includes(e.type))timeline.push({event:e.type,reason:e.reason,error:e.errorMessage,stage});});
 return result.session;
}
const manager=SessionManager.create(root,join(root,'sessions'));
let session=await open(manager);
replies.push({tokens:300});await session.prompt('user A '+ 'a'.repeat(400));
replies.push({tokens:400});await session.prompt('user B '+ 'b'.repeat(400));
stage='manual';await session.compact();assert.equal(compactions,1);
timeline.push({event:'context-usage-after-compaction',usage:session.getContextUsage()});
const firstCheckpointFile=manager.getSessionFile();session.dispose();
stage='reopen-before-first-response';session=await open(SessionManager.open(firstCheckpointFile));
assert.equal(session.getContextUsage().tokens,null);
timeline.push({event:'context-usage-reopened-before-first-response',usage:session.getContextUsage()});
stage='first-continuation';replies.push({tokens:500});await session.prompt('user C');assert.equal(compactions,1,'immediate redundant compaction');
timeline.push({event:'context-usage-after-first-response',usage:session.getContextUsage()});
stage='tool-turns';replies.push({tokens:600,tool:true},{tokens:900,tool:true},{tokens:1700,tool:true},{tokens:500});await session.prompt('user D');
assert.equal(toolRuns,3);assert.equal(compactions,2,'expected threshold compaction during tool loop');
assert.equal(replies.length,0);
const file=firstCheckpointFile;session.dispose();
stage='reopen';const reopened=SessionManager.open(file);session=await open(reopened);
replies.push({tokens:600});await session.prompt('user E');assert.equal(compactions,2,'redundant compaction on reopen');
const requests=timeline.filter(e=>e.event==='provider-request');
for(const request of requests.filter(r=>['first-continuation','tool-turns','reopen'].includes(r.stage))){assert.equal(request.input.filter(x=>x.type==='compaction').length,1);const users=request.input.filter(x=>x.role==='user').map(x=>typeof x.content==='string'?x.content:x.content.map(p=>p.text??'').join(''));assert.equal(new Set(users).size,users.length,'duplicated user history');}
assert.equal(requests.at(-1).input.find(x=>x.type==='compaction').encrypted_content,'synthetic-2');
session.dispose();
console.log(JSON.stringify({piVersion:'1.1.0',root,calls,compactions,toolRuns,timeline},null,2));
