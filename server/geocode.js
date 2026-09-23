import {HttpError} from './http.js';
export function makeGeocoder(config){
  let last=0;
  return async function geocode(q){
    if(!config.geocoderUrl||config.geocoderUrl==='off')throw new HttpError(503,'geocoder_unavailable','Osoitehaku ei ole käytössä.');
    const wait=Math.max(0,Number(config.geocoderMinIntervalMs||1100)-(Date.now()-last));
    if(wait)await new Promise(r=>setTimeout(r,wait));
    last=Date.now();
    const u=new URL(config.geocoderUrl);u.searchParams.set('q',q);u.searchParams.set('format','json');u.searchParams.set('limit','5');u.searchParams.set('countrycodes','fi');u.searchParams.set('addressdetails','1');
    const r=await fetch(u,{headers:{'user-agent':config.geocoderUserAgent||'AvainpelaajaOS/1.0'}});
    if(!r.ok)throw new HttpError(502,'geocoder_error','Osoitepalvelu vastasi virheellä.');
    const a=await r.json();
    if(!Array.isArray(a)||!a.length)throw new HttpError(404,'not_found','Osoitetta ei löytynyt.');
    const x=a[0];
    return {lat:Number(Number(x.lat).toFixed(5)),lon:Number(Number(x.lon).toFixed(5)),displayName:x.display_name||'',address:x.address||{}};
  };
}
