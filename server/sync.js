import * as store from './store.js';
import {HttpError,isObj,isId} from './http.js';
import {hashStr} from './util.js';

export function registerSync(router,{db,config},{VALID,READ_DENY,WRITE,SETTINGS_DEFAULT,redact,myyjaMayWrite,bookingProblems,unlinkMissingSellers,audit,jparse}){
  router.post('/api/sync',{org:true},(ctx)=>{
    const body=ctx.body||{};
    if(!isObj(body)||!isObj(body.changes))throw new HttpError(400,'bad_request','changes puuttuu.');
    const org=db.prepare('SELECT rev,settings FROM organizations WHERE id=?').get(ctx.orgId);
    const baseRev=body.baseRev===undefined?org.rev:Number(body.baseRev);
    if(!Number.isInteger(baseRev)||baseRev>org.rev)throw new HttpError(409,'rev_mismatch','Työtila-versio on virheellinen.',{rev:org.rev});
    const stale=baseRev<org.rev;
    const applied={},rejected=[];let changed=false;
    const kinds=[...store.ENTITY_KINDS,...store.RECORD_KINDS];

    for(const [kind,ch] of Object.entries(body.changes)){
      if(!kinds.includes(kind))throw new HttpError(400,'bad_request','Tuntematon kokoelma '+kind+'.');
      if(!isObj(ch))throw new HttpError(400,'bad_request','Kokoelman muutokset ovat virheelliset.');
      applied[kind]=applied[kind]||{};

      for(const u of (Array.isArray(ch.upsert)?ch.upsert:[])){
        const obj=u?.item,base=u?.base??null;
        if(!isObj(obj)||!isId(obj.id))throw new HttpError(400,'bad_request','Tietueella ei ole kelvollista id:tä.');
        if(VALID[kind])VALID[kind](obj);
        const existing=store.ENTITY_KINDS.includes(kind)?store.getEntityRow(db,ctx.orgId,kind,obj.id):store.getRecordRow(db,ctx.orgId,kind,obj.id);
        const roles=WRITE[kind]||[];
        if(!roles.includes(ctx.role)||(ctx.role==='Myyjä'&&!myyjaMayWrite(kind,obj,existing?.obj,ctx))){rejected.push({kind,id:obj.id,reason:'forbidden'});continue;}
        if(base===null){if(existing){rejected.push({kind,id:obj.id,reason:'conflict',server:existing.obj});continue;}}
        else if(!existing){rejected.push({kind,id:obj.id,reason:'deleted_by_other'});continue;}
        else if(hashStr(JSON.stringify(existing.obj))!==base){rejected.push({kind,id:obj.id,reason:'conflict',server:existing.obj});continue;}
        if(kind==='bookings'){
          const conflicts=bookingProblems(db,ctx.orgId,obj,obj.id);
          if(conflicts.length){rejected.push({kind,id:obj.id,reason:'booking_conflict',conflicts});continue;}
        }
        if(store.ENTITY_KINDS.includes(kind))store.upsertEntity(db,ctx.orgId,kind,obj,store.nextPos(db,ctx.orgId,kind));
        else store.upsertRecord(db,ctx.orgId,kind,obj,kind==='notifications'?store.prevPos(db,ctx.orgId,kind):store.nextPos(db,ctx.orgId,kind));
        applied[kind][obj.id]=hashStr(JSON.stringify(obj));changed=true;
      }

      for(const d of (Array.isArray(ch.delete)?ch.delete:[])){
        const id=d?.id,base=d?.base;
        if(!isId(id)||typeof base!=='string')throw new HttpError(400,'bad_request','Poistettavan tietueen tunniste tai base on virheellinen.');
        const existing=store.ENTITY_KINDS.includes(kind)?store.getEntityRow(db,ctx.orgId,kind,id):store.getRecordRow(db,ctx.orgId,kind,id);
        const roles=WRITE[kind]||[];
        if(!roles.includes(ctx.role)||(ctx.role==='Myyjä'&&!myyjaMayWrite(kind,{id,...(existing?.obj||{})},existing?.obj,ctx))){rejected.push({kind,id,reason:'forbidden'});continue;}
        if(!existing){applied[kind][id]=null;continue;}
        if(hashStr(JSON.stringify(existing.obj))!==base){rejected.push({kind,id,reason:'conflict',server:existing.obj});continue;}
        const ok=store.ENTITY_KINDS.includes(kind)?store.deleteEntity(db,ctx.orgId,kind,id):store.deleteRecord(db,ctx.orgId,kind,id);
        if(ok){applied[kind][id]=null;changed=true;}
      }
    }

    let settingsResult;
    if(body.settings){
      if(ctx.role!=='Admin')rejected.push({kind:'settings',id:'settings',reason:'forbidden'});
      else{
        const current={...SETTINGS_DEFAULT,...jparse(org.settings,{})};
        if(hashStr(JSON.stringify(current))!==body.settings.base)rejected.push({kind:'settings',id:'settings',reason:'conflict',server:current});
        else{
          const v=body.settings.value||{},clean={};
          for(const k of Object.keys(SETTINGS_DEFAULT)){
            if(v[k]===undefined)clean[k]=current[k];
            else clean[k]=typeof SETTINGS_DEFAULT[k]==='boolean'?!!v[k]:(Number(v[k])||SETTINGS_DEFAULT[k]);
          }
          db.prepare('UPDATE organizations SET settings=? WHERE id=?').run(JSON.stringify(clean),ctx.orgId);
          settingsResult=clean;changed=true;
        }
      }
    }

    let rev=org.rev;
    if(changed){rev=org.rev+1;db.prepare('UPDATE organizations SET rev=? WHERE id=?').run(rev,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'workspace.sync',{applied,rejected});}
    const out={rev,stale,rejected,applied};if(settingsResult)out.settings=settingsResult;return out;
  });
}
