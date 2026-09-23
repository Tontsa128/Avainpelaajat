export function makeGeocoder(config){
  let last=0;
  return async function geocode(q){
    const wait=Math.max(0,Number(config.geocoderMinIntervalMs||1100)-(Date.now()-last));if(wait)await new Promise(r=>setTimeout(r,wait));last=Date.now();
    if(!config.geocoderUrl)return {items:[]};
    const u=new URL(config.geocoderUrl);u.searchParams.set('q',q);u.searchParams.set('format','json');u.searchParams.set('limit','5');u.searchParams.set('countrycodes','fi');u.searchParams.set('addressdetails','1');
    const r=await fetch(u,{headers:{'user-agent':config.geocoderUserAgent||'AvainpelaajaOS/1.0'}});
    if(!r.ok)throw new Error('Geocoding failed');
    const a=await r.json();return {items:a.map(x=>({displayName:x.display_name,lat:Number(x.lat),lon:Number(x.lon),type:x.type,address:x.address||{}}))};
  };
}
