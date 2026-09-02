const test=require('node:test');
const assert=require('node:assert/strict');
const {ERAS,chooseEra}=require('../src/eras');
test('era selection maps an unbiased two-way random draw to the two presentations',()=>{
  assert.equal(chooseEra(max=>{assert.equal(max,2);return 0}),'dawson');
  assert.equal(chooseEra(()=>1),'harvey');
  assert.equal(ERAS.dawson.name,'Richard Dawson');assert.equal(ERAS.harvey.name,'Steve Harvey');
});
