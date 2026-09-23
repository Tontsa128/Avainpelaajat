import { territoryForSeller } from '../src/ai/territory.js';
import { rankPlaces } from '../src/ai/scoring.js';
import { monthDays, buildMonthlyPlan, summarizePlan } from '../src/ai/calendar.js';

export function planForSeller({seller,places,bookings=[],salesHistory=[],year,month,options={}}){
  const radiusKm=options.radiusKm??100;
  const candidates=territoryForSeller(seller,places,{radiusKm});
  const ranked=rankPlaces(candidates,{seller,history:salesHistory,preferences:{
    radiusKm,weights:options.weights,travelCostPerKm:options.travelCostPerKm??seller.travelCostPerKm,salesValuePerSale:options.salesValuePerSale??seller.salesValuePerSale,priceReference:options.priceReference??seller.priceReference
  }});
  const days=monthDays(year,month);
  const plan=buildMonthlyPlan({seller,days,rankedPlaces:ranked,existingBookings:bookings,minBlockDays:options.minBlockDays??1,maxBlockDays:options.maxBlockDays??2,avoidWeekends:options.avoidWeekends??false});
  return {sellerId:seller.id,year,month,radiusKm,candidates:ranked.slice(0,options.maxCandidates??50),plan,summary:summarizePlan(plan)};
}
