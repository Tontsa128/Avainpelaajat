import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const POI_KINDS={shopping_centre:'Kauppakeskus',supermarket:'Supermarket',mall:'Kauppakeskus',department_store:'Tavaratalo',marketplace:'Kauppapaikka'};

function sampleData(){
  try{return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'osm-sample.json'),'utf8'));}catch{return [];}
}

export function parseOverpass(input){
  const src=typeof input==='string'?JSON.parse(input):input;
  const elements=Array.isArray(src?.elements)?src.elements:[];
  return elements.map((e)=>({
    id:String(e.id ?? e.tags?.['ref'] ?? ''),
    name:String(e.tags?.name ?? e.name ?? 'Nimetön paikka'),
    city:String(e.tags?.['addr:city'] ?? e.city ?? ''),
    kind:String(e.tags?.kind || (e.tags?.shop==='mall'?'mall':e.tags?.shop) || e.kind || 'marketplace'),
    lat:Number(e.lat ?? e.center?.lat),
    lon:Number(e.lon ?? e.center?.lon),
    tags:e.tags||{},
    address:String(e.tags?.address || e.tags?.['addr:street'] || ''),
    hours:String(e.tags?.hours || '')
  })).filter(x=>x.id&&Number.isFinite(x.lat)&&Number.isFinite(x.lon));
}

export function replacePois(db,items){
  const tx=db.transaction((rows)=>{
    db.prepare('DELETE FROM pois').run();
    const st=db.prepare('INSERT INTO pois(id,name,city,kind,lat,lon,data) VALUES(?,?,?,?,?,?,?)');
    for(const x of rows)st.run(x.id,x.name||'',x.city||'',x.kind||'marketplace',x.lat,x.lon,JSON.stringify(x));
    return rows.length;
  });
  return tx(items);
}

function allPois(db){
  const rows=db.prepare('SELECT data FROM pois').all();
  return rows.length?rows.map(r=>JSON.parse(r.data)):sampleData();
}

export function queryBbox(db,{west,south,east,north,kinds=[],q='',limit=2000}){
  let a=allPois(db).filter(x=>x.lat>=south&&x.lat<=north&&x.lon>=west&&x.lon<=east);
  if(kinds.length)a=a.filter(x=>kinds.includes(x.kind));
  if(q)a=a.filter(x=>String(x.name).toLowerCase().includes(q.toLowerCase()));
  return a.slice(0,limit);
}

export function queryNear(db,{lat,lon,km=100,kinds=[],limit=200}){
  const R=6371,p=Math.PI/180;
  const distance=(x)=>{const y=(x.lat-lat)*p,z=(x.lon-lon)*p;const h=Math.sin(y/2)**2+Math.cos(lat*p)*Math.cos(x.lat*p)*Math.sin(z/2)**2;return 2*R*Math.asin(Math.sqrt(h));};
  let a=allPois(db).map(x=>({...x,distanceKm:distance(x)})).filter(x=>x.distanceKm<=km);
  if(kinds.length)a=a.filter(x=>kinds.includes(x.kind));
  return a.sort((x,y)=>x.distanceKm-y.distanceKm).slice(0,limit);
}

export function poiStats(db){
  const a=allPois(db),counts={};
  for(const x of a)counts[x.kind]=(counts[x.kind]||0)+1;
  return {total:a.length,counts};
}
