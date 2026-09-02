const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SurveyBank,questions,similar}=require('../src/survey-bank');
const {validatePackage,BUILTIN_GAME}=require('../src/game');
const seeds=require('../data/survey-seeds.json');
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feud-bank-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('240 valid prepared surveys are disjoint from each other and fixed test questions',()=>{
  assert.equal(seeds.length,24);assert.ok(seeds.every(validatePackage));
  const all=[...questions(BUILTIN_GAME),...seeds.flatMap(questions)];
  assert.equal(new Set(all).size,250);
  assert.equal(new Set(seeds.map(g=>g.id)).size,24);
  for(let i=0;i<all.length;i++)for(const previous of all.slice(0,i))assert.equal(similar(all[i],previous),false,`${all[i]} repeats ${previous}`);
});
test('consumed packs never return after restarts or exhaustion; reservations are saved before use',t=>{
  const dir=directory(t),seen=new Set();
  for(let i=0;i<24;i++){
    const bank=new SurveyBank({directory:dir});assert.equal(bank.count(),24-i);
    for(const q of questions(bank.take())){assert.equal(seen.has(q),false);seen.add(q);}
    assert.equal(JSON.parse(fs.readFileSync(bank.file)).used.length,i+1);
  }
  assert.equal(seen.size,240);
  assert.throws(()=>new SurveyBank({directory:dir}).take(),/All prepared surveys/);
});
test('background refill deduplicates, remembers questions, and never blocks taking a ready game',async t=>{
  let resolve,calls=0,avoided;
  const bank=new SurveyBank({directory:directory(t),seedGames:seeds.slice(0,2),target:2,generate:args=>{calls++;avoided=args.avoidQuestions;return new Promise(r=>resolve=r);}});
  const first=bank.take();const refill=bank.refill();
  assert.equal(bank.refill(),refill,'One refill task at a time');
  assert.ok(questions(first).every(q=>avoided.includes(q)));
  assert.equal(bank.count(),1);bank.take();assert.equal(bank.count(),0,'Ready packs are available during generation');
  // End this run after adding one, so the test can inspect it.
  bank.target=1;resolve(seeds[2]);await refill;
  assert.equal(calls,1);assert.equal(bank.count(),1);assert.equal(bank.data.used.length,2);
  const reloaded=new SurveyBank({directory:bank.directory,seedGames:seeds.slice(0,2)});
  assert.equal(reloaded.count(),1);assert.deepEqual(questions(reloaded.take()),questions(seeds[2]));
});
test('API failure and duplicate generation cannot fall back to the sample game',async t=>{
  const bank=new SurveyBank({directory:directory(t),seedGames:[],target:1,generate:async()=>{throw Error('offline');}});
  await bank.refill();assert.equal(bank.count(),0);
  bank.generate=async()=>structuredClone(BUILTIN_GAME);await bank.refill();assert.equal(bank.count(),0);
  assert.throws(()=>bank.take(),/All prepared surveys/);
});
test('corrupt history is not silently reset and replayed',t=>{
  const dir=directory(t);fs.writeFileSync(path.join(dir,'survey-bank.json'),'broken');
  assert.throws(()=>new SurveyBank({directory:dir}).count(),/Cannot read survey history/);
});


test('upgrading an existing volume adds only the twelve new packs and keeps all usage history',t=>{
  const dir=directory(t),original=new SurveyBank({directory:dir,seedGames:seeds.slice(0,12)});
  for(let i=0;i<5;i++)original.take();
  const used=structuredClone(original.data.used),known=[...original.data.knownQuestions];
  const beforeIds=original.data.available.map(g=>g.id);
  const upgraded=new SurveyBank({directory:dir});
  assert.equal(upgraded.count(),19);
  assert.deepEqual(upgraded.data.used,used);
  assert.ok(known.every(q=>upgraded.data.knownQuestions.includes(q)));
  assert.deepEqual(upgraded.data.available.filter(g=>!beforeIds.includes(g.id)).map(g=>g.id),seeds.slice(12).map(g=>g.id));
  for(const game of used)assert.equal(upgraded.data.available.some(g=>g.id===game.id),false);
  const restarted=new SurveyBank({directory:dir});
  assert.equal(restarted.count(),19,'New packs import only once');
  assert.deepEqual(restarted.data.used,used);
});
