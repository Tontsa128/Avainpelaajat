export const ENTITY_KINDS=['sellers','places','bookings'];
export const RECORD_KINDS=['leads','campaigns','needs','time','bulletin','incidents','swaps','notifications'];
const PREFIX={sellers:'sel',places:'pl',bookings:'bk',leads:'lead',campaigns:'camp',needs:'need',time:'time',bulletin:'note',incidents:'inc',swaps:'swap',notifications:'ntf'};
export const prefixOf=k=>PREFIX[k]||'rec';
const rowObj=r=>r?({...r,obj:JSON.parse(r.data)}):null;
export function entityExists(db,org,kind,id){return !!db.prepare('SELECT 1 FROM entities WHERE org_id=? AND kind=? AND id=?').get(org,kind,id);}
export function getEntityRow(db,org,kind,id){return rowObj(db.prepare('SELECT id,pos,data FROM entities WHERE org_id=? AND kind=? AND id=?').get(org,kind,id));}
export function listEntity(db,org,kind,q={}){
  let rows=db.prepare('SELECT id,pos,data FROM entities WHERE org_id=? AND kind=? ORDER BY pos,id').all(org,kind);
  let items=rows.map(r=>JSON.parse(r.data));
  if(kind==='bookings'){if(q.from)items=items.filter(x=>x.date>=q.from);if(q.to)items=items.filter(x=>x.date<=q.to);}
  return items;
}
export function upsertEntity(db,org,kind,obj,pos=0){db.prepare('INSERT INTO entities(org_id,kind,id,pos,data) VALUES(?,?,?,?,?) ON CONFLICT(org_id,kind,id) DO UPDATE SET pos=excluded.pos,data=excluded.data').run(org,kind,obj.id,pos,JSON.stringify(obj));}
export function deleteEntity(db,org,kind,id){return db.prepare('DELETE FROM entities WHERE org_id=? AND kind=? AND id=?').run(org,kind,id).changes>0;}
export function getRecordRow(db,org,kind,id){return rowObj(db.prepare('SELECT id,pos,data FROM records WHERE org_id=? AND kind=? AND id=?').get(org,kind,id));}
export function listRecords(db,org,kind){return db.prepare('SELECT data FROM records WHERE org_id=? AND kind=? ORDER BY pos,id').all(org,kind).map(r=>JSON.parse(r.data));}
export function upsertRecord(db,org,kind,obj,pos=0){db.prepare('INSERT INTO records(org_id,kind,id,pos,data) VALUES(?,?,?,?,?) ON CONFLICT(org_id,kind,id) DO UPDATE SET pos=excluded.pos,data=excluded.data').run(org,kind,obj.id,pos,JSON.stringify(obj));}
export function deleteRecord(db,org,kind,id){return db.prepare('DELETE FROM records WHERE org_id=? AND kind=? AND id=?').run(org,kind,id).changes>0;}
export function nextPos(db,org,kind){const t=db.prepare('SELECT COALESCE(MAX(pos),0)+1 p FROM entities WHERE org_id=? AND kind=?').get(org,kind);return t.p;}
export function prevPos(db,org,kind){const t=db.prepare('SELECT COALESCE(MIN(pos),0)-1 p FROM records WHERE org_id=? AND kind=?').get(org,kind);return t.p;}
export function replaceCollection(db,org,kind,items){
  const table=ENTITY_KINDS.includes(kind)?'entities':'records';const old=db.prepare(`SELECT id,data FROM ${table} WHERE org_id=? AND kind=?`).all(org,kind);const oldMap=new Map(old.map(r=>[r.id,r.data]));const inMap=new Map(items.map((x,i)=>[x.id,{x,i}]));
  let added=0,updated=0,removed=0;const del=db.prepare(`DELETE FROM ${table} WHERE org_id=? AND kind=? AND id=?`);for(const r of old){if(!inMap.has(r.id)){del.run(org,kind,r.id);removed++;}}
  const up=db.prepare(`INSERT INTO ${table}(org_id,kind,id,pos,data) VALUES(?,?,?,?,?) ON CONFLICT(org_id,kind,id) DO UPDATE SET pos=excluded.pos,data=excluded.data`);
  for(const [id,v] of inMap){const oldData=oldMap.get(id);if(!oldData)added++;else if(oldData!==JSON.stringify(v.x))updated++;up.run(org,kind,id,v.i,JSON.stringify(v.x));}
  return {added,updated,removed,changedIds:items.map(x=>x.id)};
}
export function countBookingsFor(db,org,type,id){const field=type==='seller'?'sellerId':'placeId';return db.prepare('SELECT COUNT(*) n FROM entities WHERE org_id=? AND kind=? AND json_extract(data,?)=?').get(org,'bookings','$.'+field,id).n;}
export function findBookingConflicts(db,org,b,ignoreId=''){
  const rows=listEntity(db,org,'bookings');const toMin=t=>{const [h,m]=String(t).split(':').map(Number);return h*60+m;};const a1=toMin(b.start),a2=toMin(b.end);const out=[];
  for(const x of rows){if(x.id===ignoreId||x.date!==b.date)continue;const overlap=a1<toMin(x.end)&&toMin(x.start)<a2;if(!overlap)continue;
    if(x.sellerId===b.sellerId)out.push({code:'seller_overlap',message:'Myyjällä on päällekkäinen varaus.',bookingId:x.id});
    if(x.placeId===b.placeId&&(x.stand===b.stand||!x.stand||!b.stand))out.push({code:'place_overlap',message:'Kauppapaikalla on päällekkäinen varaus.',bookingId:x.id});
  } return out;
}
export function bumpRev(db,org){db.prepare('UPDATE organizations SET rev=rev+1 WHERE id=?').run(org);}
