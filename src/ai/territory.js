export function haversineKm(a,b){
  const R=6371, toRad=v=>v*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const x=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
export function withinRadius(origin,places,radiusKm=100){
  if(!origin||!Number.isFinite(origin.lat)||!Number.isFinite(origin.lon)) return [];
  return places.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)).map(p=>({...p,distanceKm:Number(haversineKm(origin,p).toFixed(1))})).filter(p=>p.distanceKm<=radiusKm).sort((a,b)=>a.distanceKm-b.distanceKm);
}
export function territoryForSeller(seller,places,options={}){
  const radiusKm=Number(options.radiusKm??seller.maxDistanceKm??100);
  return withinRadius({lat:Number(seller.lat??seller.homeLat),lon:Number(seller.lon??seller.homeLon)},places,radiusKm);
}
