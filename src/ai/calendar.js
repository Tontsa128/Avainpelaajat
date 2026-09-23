const iso=d=>d.toISOString().slice(0,10);
const addDays=(s,n)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return iso(d)};
const weekday=d=>new Date(d+'T12:00:00').getDay();
export function monthDays(year,month){const d=new Date(Date.UTC(year,month-1,1)),out=[];while(d.getUTCMonth()===month-1){out.push(d.toISOString().slice(0,10));d.setUTCDate(d.getUTCDate()+1)}return out;}
export function buildMonthlyPlan({seller,days,rankedPlaces,existingBookings=[],minBlockDays=1,maxBlockDays=2,avoidWeekends=false}={}){
  const plan=[];let cursor=0,lastPlaceId=null;const usable=rankedPlaces.filter(p=>p.available!==false);
  while(cursor<days.length){const date=days[cursor];if(avoidWeekends&&[0,6].includes(weekday(date))){cursor++;continue;}if(existingBookings.some(b=>b.sellerId===seller.id&&b.date===date)){cursor++;continue;}const candidate=usable.find(p=>p.id!==lastPlaceId)||usable[0];if(!candidate)break;const block=Math.min(maxBlockDays,Math.max(minBlockDays,days.length-cursor));for(let i=0;i<block&&cursor+i<days.length;i++){const d=days[cursor+i];if(avoidWeekends&&[0,6].includes(weekday(d)))continue;if(existingBookings.some(b=>b.sellerId===seller.id&&b.date===d))continue;plan.push({date:d,sellerId:seller.id,placeId:candidate.id,placeName:candidate.name,status:'ai_suggestion',reason:i===0?'Uusi 1–2 päivän myyntijakso.':'Jatkaa samaa myyntipaikkaa 1–2 päivän jaksona.'});}lastPlaceId=candidate.id;cursor+=block;}
  return plan;
}
export function summarizePlan(plan){const groups=[];for(const item of plan){const last=groups.at(-1);if(last&&last.placeId===item.placeId&&addDays(last.end,1)===item.date){last.end=item.date;last.days++;}else groups.push({placeId:item.placeId,placeName:item.placeName,start:item.date,end:item.date,days:1});}return {items:plan.length,blocks:groups.length,groups};}
