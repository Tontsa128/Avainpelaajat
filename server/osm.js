import fs from 'node:fs';
import path from 'node:path';
export const POI_KINDS={shopping_centre:'Kauppakeskus',supermarket:'Supermarket',mall:'Kauppakeskus',department_store:'Tavaratalo',marketplace:'Kauppapaikka'};
function load(){
  try{return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname),'osm-sample.json'),'utf8'));}catch{return [];}
}
const sample=load();
export function queryBbox(db,{west,south,east,north,kinds=[],q='',limit=2000}){let a=sample.filter(x=>x.lat>=south&&x.lat<=north&&x.lon>=west&&x.lon<=east);if(kinds.length)a=a.filter(x=>kinds.includes(x.kind));if(q)a=a.filter(x=>String(x.name).toLowerCase().includes(q.toLowerCase()));return a.slice(0,limit);}
export function queryNear(db,{lat,lon,km=100,kinds=[],limit=200}){const R=6371;const d=(a,b)=>{const p=Math.PI/180;const x=(b.lon-lon)*p,y=(b.lat-lat)*p;const h=Math.sin(y/2)**2+Math.cos(lat*p)*Math.cos(b.lat*p)*Math.sin(x/2)**2;return 2*R*Math.asin(Math.sqrt(h));};let a=sample.map(x=>({...x,distanceKm:d(x,{lat:x.lat,lon:x.lon})})).filter(x=>x.distanceKm<=km);if(kinds.length)a=a.filter(x=>kinds.includes(x.kind));return a.sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,limit);}
export function poiStats(){const counts={};for(const x of sample)counts[x.kind]=(counts[x.kind]||0)+1;return {total:sample.length,counts};}
