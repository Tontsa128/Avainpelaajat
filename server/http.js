export class HttpError extends Error{
  constructor(status,code,message,details){super(message);this.status=status;this.code=code;this.details=details;}
}
export function bad(message){return new HttpError(400,'bad_request',message);}
export function reqStr(v,name,min=1,max=200){if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)throw bad(`Kenttä "${name}" on virheellinen.`);return v.trim();}
export function reqEmail(v){const s=reqStr(v,'email',3,320).toLowerCase();if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s))throw bad('Sähköposti on virheellinen.');return s;}
export function reqPassword(v){return reqStr(v,'password',10,200);}
export function isObj(v){return v&&typeof v==='object'&&!Array.isArray(v);}
export function isId(v){return typeof v==='string'&&/^[A-Za-z0-9_-]{2,120}$/.test(v);}
export function isDate(v){return typeof v==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00Z'));}
export function isTime(v){return typeof v==='string'&&/^([01]\\d|2[0-3]):[0-5]\\d$/.test(v);}
export async function readJson(req,limit){
  let total=0;const chunks=[];
  for await(const c of req){total+=c.length;if(total>limit)throw new HttpError(413,'too_large','Pyyntö on liian suuri.');chunks.push(c);}
  if(!total)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw bad('JSON-runko on virheellinen.');}
}
export function send(res,status,data,headers={}){
  const body=JSON.stringify(data);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),...headers});
  res.end(body);
}
export class Router{
  constructor(){this.routes=[];}
  add(method,pattern,opts,handler){this.routes.push({method,pattern,opts,handler});}
  get(p,o,h){this.add('GET',p,o,h);} post(p,o,h){this.add('POST',p,o,h);} put(p,o,h){this.add('PUT',p,o,h);} patch(p,o,h){this.add('PATCH',p,o,h);} delete(p,o,h){this.add('DELETE',p,o,h);}
  match(method,path){
    let pathMatched=false;
    for(const r of this.routes){
      const keys=[];const re=new RegExp('^'+r.pattern.replace(/:[A-Za-z0-9_]+/g,m=>{keys.push(m.slice(1));return '([^/]+)';})+'$');
      const m=path.match(re);if(!m)continue;pathMatched=true;if(r.method!==method)continue;
      const params={};keys.forEach((k,i)=>params[k]=decodeURIComponent(m[i+1]));return {route:r,params,pathMatched};
    }
    return {route:null,params:{},pathMatched};
  }
}
