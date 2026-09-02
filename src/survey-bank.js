const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BUILTIN_GAME, validatePackage, generateGamePackage } = require('./game');
const { compactBoardLabels } = require('./board-labels');
const seeds = require('../data/survey-seeds.json');
const questions = game => [...game.rounds, game.suddenDeath, ...game.fastMoney].map(q => q.question);
const key = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const words = text => new Set(key(text).split(' ').filter(w => !['name','something','a','an','the','people','person','might','you','your','they','their','that','would','can','do','to','of','in','on','at','for','with','is'].includes(w)).map(w => w.replace(/s$/, '')));
function similar(a,b){
  if(key(a)===key(b))return true;
  const aw=words(a),bw=words(b),common=[...aw].filter(w=>bw.has(w)).length;
  return common>=3 && common/new Set([...aw,...bw]).size>=.75;
}

// One server process owns this volume. Persist reservations before returning a game;
// a crash may consume an unused pack, but cannot return an already reserved one.
class SurveyBank {
  constructor({directory, generate=generateGamePackage, target=12, seedGames=seeds}={}){
    this.directory=directory || process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || (process.env.RAILWAY_ENVIRONMENT_ID?'/data':path.join(__dirname,'../.data'));
    this.file=path.join(this.directory,'survey-bank.json');this.generate=generate;this.target=target;this.seedGames=seedGames;this.refilling=null;this.data=null;
  }
  load(){
    if(this.data)return;
    fs.mkdirSync(this.directory,{recursive:true});
    let data;
    try {data=JSON.parse(fs.readFileSync(this.file,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw new Error(`Cannot read survey history: ${error.message}`);data={version:1,available:[],used:[],knownQuestions:questions(BUILTIN_GAME),seeded:[]};}
    if(data.version!==1||!Array.isArray(data.available)||!Array.isArray(data.used)||!Array.isArray(data.knownQuestions)||!Array.isArray(data.seeded)||!data.available.every(validatePackage))throw new Error('Invalid survey history; refusing to reset it and repeat questions.');
    for(const game of this.seedGames){
      if(data.seeded.includes(game.id))continue;
      data.seeded.push(game.id);
      const list=questions(game);
      if(validatePackage(game)&&!list.some(q=>data.knownQuestions.some(old=>similar(q,old)))){
        data.available.push(structuredClone(game));data.knownQuestions.push(...list);
      }
    }
    // Upgrade labels in existing volume packs without resetting reservations or history.
    data.available.forEach(compactBoardLabels);
    this.save(data);
  }
  save(data){
    const temporary=this.file+'.tmp';
    const fd=fs.openSync(temporary,'w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,this.file);this.data=data;
  }
  count(){this.load();return this.data.available.length;}
  take(){
    this.load();
    if(!this.data.available.length)throw new Error('All prepared surveys have been used. New surveys are being prepared in the background; please try again shortly.');
    const data=structuredClone(this.data),index=crypto.randomInt(data.available.length),[game]=data.available.splice(index,1);
    data.used.push({id:game.id,usedAt:new Date().toISOString(),questions:questions(game)});
    this.save(data);return structuredClone(game);
  }
  refill(){
    if(this.refilling)return this.refilling;
    this.load();
    this.refilling=this.fill().finally(()=>{this.refilling=null;});return this.refilling;
  }
  async fill(){
    // A failed/duplicate batch stops this run. A later scheduled refill retries;
    // never recycle the sample package or spin on repeated generation failures.
    while(this.data.available.length<this.target){
      let game;
      try{game=await this.generate({avoidQuestions:[...this.data.knownQuestions]});}
      catch(error){console.warn('Survey refill postponed:',error.message);break;}
      const list=validatePackage(game)?questions(game):[];
      if(!list.length||list.some((q,i)=>list.slice(0,i).some(old=>similar(q,old)))||list.some(q=>this.data.knownQuestions.some(old=>similar(q,old)))){
        console.warn('Survey refill rejected invalid or repeated questions.');break;
      }
      const data=structuredClone(this.data);
      data.available.push({...compactBoardLabels(game),id:crypto.randomUUID(),source:'AI-generated synthetic home-game surveys'});
      data.knownQuestions.push(...list);this.save(data);
    }
  }
}
module.exports={SurveyBank,questions,similar};
