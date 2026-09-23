import { calculatePlaceEconomics, economicsScore } from './economics.js';

const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,v));
const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
export function scorePlace(place,{history=[],preferences={}}={}){
  const distance=n(place.distanceKm,100), radius=Math.max(1,n(preferences.radiusKm,100));
  const distanceScore=clamp(100-distance/radius*100);
  const trafficScore=clamp(place.footTrafficScore!==undefined?n(place.footTrafficScore):n(place.trafficScore,0));
  const salesScore=clamp(n(place.salesScore,0));
  const availabilityScore=clamp(place.available===false?0:100);
  const economics=calculatePlaceEconomics(place,history,{travelCostPerKm:preferences.travelCostPerKm,salesValuePerSale:preferences.salesValuePerSale});
  const priceScore=economics.effectivePrice===null?50:clamp(100-(economics.effectivePrice/Math.max(1,n(preferences.priceReference,100)))*100);
  const historyScore=economics.salesPerHour!==null?clamp(economics.salesPerHour*20):50;
  const economicsScoreValue=clamp(economicsScore(economics));
  const w={distance:.16,traffic:.18,sales:.18,availability:.14,price:.06,history:.14,economics:.14,...(preferences.weights||{})};
  const score=clamp(distanceScore*w.distance+trafficScore*w.traffic+salesScore*w.sales+availabilityScore*w.availability+priceScore*w.price+historyScore*w.history+economicsScoreValue*w.economics);
  return {score:Math.round(score),factors:{distanceScore:Math.round(distanceScore),trafficScore:Math.round(trafficScore),salesScore:Math.round(salesScore),availabilityScore:Math.round(availabilityScore),priceScore:Math.round(priceScore),historyScore:Math.round(historyScore),economicsScore:Math.round(economicsScoreValue)},history:{visits:economics.historicalSales>0?history.filter(x=>x.placeId===place.id).length:history.filter(x=>x.placeId===place.id).length,sales:economics.historicalSales,hours:economics.historicalHours,salesPerHour:economics.salesPerHour===null?null:Number(economics.salesPerHour.toFixed(2))},economics};
}
export function rankPlaces(places,context={}){return places.map(p=>({...p,...scorePlace(p,context)})).sort((a,b)=>b.score-a.score);}
