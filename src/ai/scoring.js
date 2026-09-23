const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,v));
const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
export function scorePlace(place,{history=[],preferences={}}={}){
  const distance=n(place.distanceKm,100), radius=Math.max(1,n(preferences.radiusKm,100));
  const distanceScore=clamp(100-distance/radius*100);
  const trafficScore=clamp(n(place.footTrafficScore,place.trafficScore,0));
  const salesScore=clamp(n(place.salesScore,0));
  const availabilityScore=clamp(place.available===false?0:100);
  const price=n(place.pricePerDay,0), priceScore=price<=0?70:clamp(100-price);
  const rows=history.filter(x=>x.placeId===place.id), sales=rows.reduce((s,x)=>s+n(x.sales),0), hours=rows.reduce((s,x)=>s+n(x.hours),0);
  const rate=hours>0?sales/hours:0, historyScore=rows.length?clamp(rate*20):50;
  const w={distance:.18,traffic:.20,sales:.20,availability:.16,price:.08,history:.18,...(preferences.weights||{})};
  const score=clamp(distanceScore*w.distance+trafficScore*w.traffic+salesScore*w.sales+availabilityScore*w.availability+priceScore*w.price+historyScore*w.history);
  return {score:Math.round(score),factors:{distanceScore:Math.round(distanceScore),trafficScore:Math.round(trafficScore),salesScore:Math.round(salesScore),availabilityScore:Math.round(availabilityScore),priceScore:Math.round(priceScore),historyScore:Math.round(historyScore)},history:{visits:rows.length,sales,hours,salesPerHour:Number(rate.toFixed(2))}};
}
export function rankPlaces(places,context={}){return places.map(p=>({...p,...scorePlace(p,context)})).sort((a,b)=>b.score-a.score);}
