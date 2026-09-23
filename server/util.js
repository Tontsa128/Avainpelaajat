import crypto from 'node:crypto';
export function newId(prefix='id'){return prefix+'_'+crypto.randomUUID().replaceAll('-','');}
export function hashStr(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
export const hashString=hashStr;
export function now(){return Date.now();}
export function clamp(n,min,max){return Math.min(max,Math.max(min,n));}
