import crypto from 'node:crypto';
function b64(v){return Buffer.from(v).toString('base64url');}
function ub64(v){return Buffer.from(v,'base64url').toString('utf8');}
export async function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const derived=await new Promise((resolve,reject)=>crypto.scrypt(String(password),salt,64,(e,k)=>e?reject(e):resolve(k)));
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}
export async function verifyPassword(password,stored){
  try{
    const [scheme,salt,hex]=String(stored).split('$');
    if(scheme!=='scrypt'||!salt||!hex)return false;
    const actual=await new Promise((resolve,reject)=>crypto.scrypt(String(password),salt,64,(e,k)=>e?reject(e):resolve(k)));
    return crypto.timingSafeEqual(Buffer.from(hex,'hex'),Buffer.from(actual));
  }catch{return false;}
}
export function signToken(payload,secret,ttlSec=1209600){
  const body=b64(JSON.stringify({...payload,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+ttlSec}));
  const sig=b64(crypto.createHmac('sha256',secret).update(body).digest());
  return body+'.'+sig;
}
export function verifyToken(token,secret){
  try{
    const [body,sig]=String(token).split('.');
    if(!body||!sig)return null;
    const expected=b64(crypto.createHmac('sha256',secret).update(body).digest());
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    const p=JSON.parse(ub64(body));
    if(!p.exp||p.exp<Math.floor(Date.now()/1000))return null;
    return p;
  }catch{return null;}
}
export class RateLimiter{
  constructor(max,windowMs){this.max=max;this.windowMs=windowMs;this.map=new Map();}
  hit(key){const now=Date.now();let a=this.map.get(key)||[];a=a.filter(t=>now-t<this.windowMs);if(a.length>=this.max){this.map.set(key,a);return false;}a.push(now);this.map.set(key,a);return true;}
  reset(key){this.map.delete(key);}
}
