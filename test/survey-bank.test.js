const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SurveyBank,questions}=require('../src/survey-bank');
const {validatePackage,BUILTIN_GAME}=require('../src/game');
const seeds=require('../data/survey-seeds.json');
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feud-bank-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('120 valid prepared surveys are disjoint from each other and fixed test questions',()=>{
  assert.equal(seeds.length,12);assert.ok(seeds.every(validatePackage));
  const all=[...questions(BUILTIN_GAME),...seeds.flatMap(questions)];
  assert.equal(new Set(all).size,130);
});
test('consumed packs never return after restarts or exhaustion; reservations are saved before use',t=>{
  const dir=directory(t),seen=new Set();
  for(let i=0;i<12;i++){
    const bank=new SurveyBank({directory:dir});assert.equal(bank.count(),12-i);
    for(const q of questions(bank.take())){assert.equal(seen.has(q),false);seen.add(q);}
    assert.equal(JSON.parse(fs.readFileSync(bank.file)).used.length,i+1);
  }
  assert.equal(seen.size,120);
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
