import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,renameSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {AgentSession} from './node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js';
import {estimateProjectedContextTokens,estimateTokens} from './node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import {stream,closeOpenAICodexWebSocketSessions,getOpenAICodexWebSocketDebugStats} from '@earendil-works/pi-ai/api/openai-codex-responses';

const results=[];
const root=mkdtempSync(join(tmpdir(),'pi-feasibility-'));
const settings={enabled:true,reserveTokens:200,keepRecentTokens:100};
function threshold(manager,window){return AgentSession.prototype._exceedsCompactionThreshold.call({sessionManager:manager,settingsManager:{getCompactionSettings:()=>settings},model:{contextWindow:window}}, {contextWindow:window},manager.buildSessionProjection());}
function fixture(){const dir=mkdtempSync(join(root,'session-'));return SessionManager.create(dir,dir);}
// Real disk-backed SessionManager and the actual AgentSession scheduler predicate.
for(const kind of ['overestimate','underestimate']){
 const manager=fixture();
 manager.appendMessage({role:'user',content:'small input',timestamp:Date.now()});
 const tail=manager.appendMessage({role:'user',content:kind==='overestimate'?'x'.repeat(12000):'small tail',timestamp:Date.now()});
 const retainedUser=kind==='overestimate'?'small retained input':'x'.repeat(12000);
 const checkpoint=manager.appendCompaction('Remote checkpoint requires extension',tail,4000,{replacementWindow:[{role:'user',content:retainedUser},{type:'compaction',encrypted_content:'synthetic'}]});
 const reopened=SessionManager.open(manager.getSessionFile());
 assert.equal(reopened.getLeafId(),checkpoint);
 const canonical=estimateProjectedContextTokens(reopened.buildSessionProjection(),reopened.getBranch()).tokens;
 const transmittedUserEstimate=estimateTokens({role:'user',content:retainedUser,timestamp:0});
 const decision=threshold(reopened,1000);
 assert.equal(decision,kind==='overestimate');
 assert.equal(transmittedUserEstimate>800,kind==='underestimate');
 results.push({experiment:'accounting',kind,canonicalTokens:canonical,transmittedUserTextEstimate:transmittedUserEstimate,hostShouldCompact:decision,note:'Opaque checkpoint size unknown; this comparison uses only retained user text, not ciphertext length.'});
 // Two evaluations without provider usage demonstrate the predicate doesn't self-correct.
 assert.equal(threshold(reopened,1000),decision);
}
const manager=fixture();
manager.appendMessage({role:'user',content:'persistence fixture',timestamp:Date.now()});
const originalLeaf=manager.getLeafId();
const file=manager.getSessionFile();
const backup=file+'.backup';
renameSync(file,backup);mkdirSync(file);
let failure;
try{manager.appendCompaction('uncommitted checkpoint',originalLeaf,100,{synthetic:true});}catch(e){failure=e;}
assert(failure);assert.notEqual(manager.getLeafId(),originalLeaf);
assert.equal(manager.getLeafEntry().type,'compaction');
const disk=SessionManager.open(backup);
assert.equal(disk.getLeafId(),originalLeaf);
assert.equal(disk.getBranch().some(e=>e.type==='compaction'),false);
results.push({experiment:'persistence',errorCode:failure.code,inMemoryLeafType:manager.getLeafEntry().type,diskContainsCheckpoint:false,note:'Injected EISDIR only inside isolated temp session directory.'});

let sendCalls=0;
const NativeWebSocket=globalThis.WebSocket;
class ObservedWebSocket extends NativeWebSocket { send(data){sendCalls++;return super.send(data);} }
globalThis.WebSocket=ObservedWebSocket;
const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
let received=0;let terminalType='response.completed';
server.on('connection',socket=>socket.on('message',()=>{
 received++;
 const id='resp-'+received;
 socket.send(JSON.stringify({type:'response.created',response:{id,status:'in_progress'}}));
 socket.send(JSON.stringify({type:'response.output_item.done',item:{type:'compaction',id:'cmp-'+received,encrypted_content:'synthetic-checkpoint'}}));
 socket.send(JSON.stringify({type:terminalType,response:{id,status:terminalType==='response.completed'?'completed':'incomplete',output:[],usage:{input_tokens:10,output_tokens:2,total_tokens:12,input_tokens_details:{cached_tokens:0}}}}));
}));
const model={id:'synthetic-model',name:'synthetic',api:'openai-codex-responses',provider:'openai-codex',baseUrl:`http://127.0.0.1:${server.address().port}`,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
const apiKey='synthetic.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.synthetic';
const sessionId='synthetic-websocket-session';
const context={systemPrompt:'synthetic instructions',messages:[{role:'user',content:'test',timestamp:0}]};
async function run(extra={}){const events=[];const raw=[];for await(const e of stream(model,context,{apiKey,sessionId,transport:'websocket-cached',maxRetries:0,timeoutMs:2000,websocketConnectTimeoutMs:2000,onProviderStreamEvent:e=>raw.push(e.type),...extra}))events.push(e);return {errorMessage:events.at(-1)?.error?.errorMessage,terminal:events.at(-1)?.type,stopReason:events.at(-1)?.message?.stopReason??events.at(-1)?.error?.stopReason,raw};}
try{
 const first=await run();assert.equal(first.terminal,'done');assert.equal(received,1);
 terminalType='response.incomplete';const incomplete=await run({sessionId:'synthetic-incomplete-session'});assert(incomplete.raw.includes('response.incomplete'));
 results.push({experiment:'raw-terminal-observation',...incomplete});
 terminalType='response.completed';
 // The original successful session still owns its open cached socket.
 const before=received;
 const beforeSends=sendCalls;
 const controller=new AbortController();
 const aborted=await run({signal:controller.signal,onPayload:body=>{controller.abort();return body;}});
 // Event-loop delivery barrier: the server must receive anything already queued on this local socket.
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(aborted.terminal,'error');
 assert.equal(sendCalls,beforeSends+1);
 assert.equal(received,before+1);
 results.push({experiment:'cached-websocket-abort',socketSendCallsAfterAbort:sendCalls-beforeSends,serverReceivedAfterAbort:received-before,...aborted,debug:getOpenAICodexWebSocketDebugStats(sessionId)});
 // A fresh SSE request cancelled in onPayload should never reach fetch.
 let fetches=0;const priorFetch=globalThis.fetch;globalThis.fetch=async()=>{fetches++;throw Error('unexpected fetch');};
 try{const c=new AbortController();const events=[];for await(const e of stream(model,context,{apiKey,transport:'sse',maxRetries:0,signal:c.signal,onPayload:body=>{c.abort();return body;}}))events.push(e);assert.equal(fetches,0);assert.equal(events.at(-1).type,'error');results.push({experiment:'sse-abort-control',fetches});}finally{globalThis.fetch=priorFetch;}
}finally{closeOpenAICodexWebSocketSessions();for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));globalThis.WebSocket=NativeWebSocket;}
console.log(JSON.stringify({piVersion:'1.1.0',temporaryRoot:root,results},null,2));
