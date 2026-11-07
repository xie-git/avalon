const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
const browser=await chromium.launch({headless:true,...(process.env.AVALON_CHROMIUM ? {executablePath: process.env.AVALON_CHROMIUM} : {}),args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:390,height:844}});
const serve=route=>{
 const url=new URL(route.request().url());let f= url.pathname==='/'?'templates/player.html':url.pathname==='/host'?'templates/host.html':url.pathname.slice(1);
 if(url.pathname.endsWith('socket.io.min.js'))return route.fulfill({contentType:'text/javascript',body:'window.io=()=>({on(){},emit(){},connected:true});'});
 f=path.join(root,f);
 if(!fs.existsSync(f))return route.fulfill({status:204,body:''});
 let body=fs.readFileSync(f);if(f.endsWith('.html'))body=body.toString().replace(/\{\{.*?\}\}/g,'false');
 route.fulfill({body,contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.html')?'text/html':'application/octet-stream'});
};
await context.route('http://avalon.test/**',serve);
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://avalon.test/');await page.waitForTimeout(100);
assert.equal(await page.locator('html').getAttribute('lang'),'en');
await page.selectOption('#entry-language','zh-CN');
await page.evaluate(()=>{
 myRole='Merlin';myTeam='good';myName='Merlin';myPlayerId='p0';gameCode='FAIL';isHost=true;
 document.getElementById('lobby-code-display').textContent=gameCode;
 presencePlayers=[{player_id:'p0',name:'Merlin',connected:true,ready:true},{player_id:'p1',name:'Evil',connected:true,ready:false}];
 window._nightInfoPending={sees_label:'Agents of evil',sees:['Evil']};
});
async function audit(label){
 await page.waitForTimeout(30);
 const missing=await page.evaluate(()=>{
 const a=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
 while(n=w.nextNode())if(!n.parentElement.closest('script,style,[data-i18n-skip],.presence-player-name,.final-role-player,.r-name,.cinematic-vote-name,.identity-avatar-name')&&/[A-Za-z]{2}/.test(n.data))a.push(n.data.trim());
 return a;});
 assert.deepEqual(missing.filter(text=>/[A-Za-z]{2}/.test(text.replace(/\b(?:Merlin|Evil)\b/g,''))),[],label+' contains untranslated UI');
}
await audit('entry');
await page.evaluate(()=>{renderLobbyPlayers(presencePlayers);showScreen('screen-lobby');});await audit('lobby');
await page.evaluate(()=>showRoleCard('Merlin','good'));await audit('role');
assert.equal(await page.locator('#btn-settings').isVisible(),true);
await page.evaluate(()=>showNightInfo({sees_label:'Agents of evil',sees:['Evil']}));await audit('night');
await page.evaluate(()=>{populateRoleOverlay();});await audit('reminder');
await page.evaluate(()=>{isHost=false;});
await page.evaluate(()=>showDiscussion({mission_num:4,mission_size:3,leader_name:'Merlin',duration_seconds:60}));await audit('discussion');
assert.equal(await page.locator('#btn-settings').isVisible(),true);
await page.click('#btn-settings');
assert.equal(await page.locator('#settings-game-actions').isVisible(),false);
assert.equal(await page.locator('#phone-language').isVisible(),true);
await page.click('#btn-close-settings');
await page.evaluate(()=>showProposalScreen({mission_num:4,mission_size:3,leader_name:'Merlin',leader_id:'p0',players:presencePlayers}));await audit('proposal');
await page.evaluate(()=>showVoteScreen({leader_name:'Merlin',team:['Merlin','Evil']}));await audit('vote');
await page.evaluate(()=>showVoteReveal({approved:true,votes:{Merlin:'approve',Evil:'reject'},approve_count:1,reject_count:1}));await audit('vote-reveal');
await page.evaluate(()=>showMissionScreen({team:['Merlin','Evil'],team_ids:['p0','p1']}));await audit('quest-intro');
await page.evaluate(()=>showMissionCardReveal({cards_shuffled:['success','fail']},true));await audit('quest-cards');
await page.evaluate(()=>showMissionOutcome({passed:false,fail_count:1,success_count:1,team:['Merlin','Evil']},true,true));await audit('quest-outcome');
await page.evaluate(()=>showAssassinScreen({assassin_name:'Evil',assassin_id:'p1',targets:presencePlayers}));await audit('assassin');
await page.evaluate(()=>{
 const summary={winner:'good',win_reason:'assassination_failed',roles:{Merlin:{role:'Merlin',team:'good'},Evil:{role:'Assassin',team:'evil'}},players:presencePlayers,player_order:['Merlin','Evil'],mission_results:['pass','pass','pass'],mission_history:[{mission_num:1,passed:true,leader_name:'Merlin',team:['Merlin','Evil'],success_count:2,fail_count:0}],proposal_history:[],final_word:{message:'The Assassin missed. All that menace, straight into the scenery. And scene.'}};
 showGameOver(summary);renderRematchStatus({total_count:2,ready_count:1,ready_names:['Merlin']});
 addChatBubble('Merlin','Settings',false,0,null,true,false,'player');
 addChatBubble('Court Narrator','Fresh game, fresh loyalties, same suspicious eye contact. And scene.',false,null,null,true,false,'narrator');
});await audit('finale');
assert.equal(await page.locator('#chat-history-list [data-i18n-skip]').last().textContent(),'Settings');
assert.match(await page.locator('#chat-history-list .narrator').innerText(),/宫廷史官/);
assert.equal(await page.locator('#lobby-code-display').textContent(),'FAIL');
const lines=JSON.parse(require('child_process').execFileSync('python3',['-c',`import json; from narrator import COPY_BANKS, DOUBLE_ACT_FOLLOWUPS; print(json.dumps([x.format(player='Merlin',leader='Evil') for bank in COPY_BANKS.values() for x in bank]+[x for bank in DOUBLE_ACT_FOLLOWUPS.values() for x in bank]))`],{cwd:root,encoding:'utf8'}));
assert.equal(lines.length,1916);
const missingNarrator=await page.evaluate(lines=>lines.filter(line=>AvalonI18n.t(line)===line),lines);
assert.deepEqual(missingNarrator,[],'Every narrator delivery must translate');
await page.click('#btn-settings');
await page.selectOption('#phone-language','en');
assert.equal(await page.locator('#entry-language').inputValue(),'en');
await page.selectOption('#phone-language','zh-CN');
await page.click('#btn-close-settings');

await page.evaluate(()=>AvalonI18n.setLanguage('en'));await page.waitForTimeout(30);
assert.equal(await page.locator('#game-over-result-player').textContent(),'GOOD WINS');
assert.match(await page.locator('#chat-history-list .narrator').innerText(),/Fresh game/);
assert.equal(await page.locator('#chat-history-list [data-i18n-skip]').last().textContent(),'Settings');
await page.evaluate(()=>AvalonI18n.setLanguage('zh-CN'));
await page.reload();await page.waitForTimeout(30);assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
await page.goto('http://avalon.test/host');await page.waitForTimeout(30);assert.equal(await page.locator('html').getAttribute('lang'),'en');await page.click('#btn-display-settings');await page.selectOption('#display-language','zh-CN');
await page.evaluate(()=>{renderLobbyPlayers([{player_id:'p0',name:'Merlin',connected:true,ready:true},{player_id:'p1',name:'Evil',connected:false,ready:false}]);renderNightPending(['Merlin']);});await audit('host-lobby');
await page.keyboard.press('Escape');
assert.equal(await page.locator('#display-settings').isVisible(),false);
await page.goto('http://avalon.test/');
assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
await page.goto('http://avalon.test/host');
assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
const second=await browser.newContext();
await second.route('http://avalon.test/**',serve);
const separate=await second.newPage();
await separate.goto('http://avalon.test/');

assert.equal(await separate.locator('html').getAttribute('lang'),'en');
assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
await second.close();
assert.deepEqual(errors,[],'Browser must not raise script errors');
console.log('Language browser checks passed: independent preferences, all game phases, 1,916 narrator lines, names/chat, immediate switching, and persistence.');
await browser.close();})().catch(error=>{console.error(error);process.exit(1);});
