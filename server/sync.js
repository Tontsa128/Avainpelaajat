import * as store from './store.js';
export function registerSync(router,{db,config},{VALID,READ_DENY,WRITE,SETTINGS_DEFAULT,redact,myyjaMayWrite,bookingProblems,unlinkMissingSellers,audit,jparse}){
  router.post('/api/sync',{org:true},(ctx)=>{
    const b=ctx.body||{};if(!b.changes||typeof b.changes!=='object')throw new Error('changes puuttuu');
    const base=Number(b.baseRev);const org=db.prepare('SELECT rev FROM organizations WHERE id=?').get(ctx.orgId);if(base!==org.rev)throw new (class extends Error{constructor(){super('Toinen käyttäjä on päivittänyt tietoja.');this.status=409;this.code='rev_mismatch';this.details={rev:org.rev};}})();
    const results={};store.ENTITY_KINDS.concat(store.RECORD_KINDS).forEach(k=>{results[k]={added:0,updated:0,removed:0};});
    for(const [kind,ch] of Object.entries(b.changes)){
      if(!store.ENTITY_KINDS.includes(kind)&&!store.RECORD_KINDS.includes(kind))continue;
      for(const x of (ch.upsert||[])){const obj=x.item;if(!obj?.id)continue;if(store.ENTITY_KINDS.includes(kind))store.upsertEntity(db,ctx.orgId,kind,obj,store.nextPos(db,ctx.orgId,kind));else store.upsertRecord(db,ctx.orgId,kind,obj,store.nextPos(db,ctx.orgId,kind));results[k].updated++;}
      for(const id of (ch.delete||[])){if(store.ENTITY_KINDS.includes(kind)?store.deleteEntity(db,ctx.orgId,kind,id):store.deleteRecord(db,ctx.orgId,kind,id))results[k].removed++;}
    }
    store.bumpRev(db,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'sync.apply',results);return {rev:org.rev+1,results};
  });
}
