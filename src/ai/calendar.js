const iso=d=>d.toISOString().slice(0,10);
const addDays=(s,n)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return iso(d)};
const weekday=d=>new Date(d+'T12:00:00').getDay();
export function monthDays(year,month){const d=new Date(Date.UTC(year,month-1,1)),out=[];while(d.getUTCMonth()===month-1){out.push(d.toISOString().slice(0,10));d.setUTCDate(d.getUTCDate()+1)}return out;}
const isUnavailable=(seller,date)=>Array.isArray(seller?.absences)&&seller.absences.some(x=>typeof x==='string'?x===date:(x?.date===date||x?.startDate&&x?.endDate&&date>=x.startDate&&date<=x.endDate));
const workday=(seller,date,avoidWeekends)=>{if(avoidWeekends&&[0,6].includes(weekday(date)))return false;const wd=seller?.workDays;if(Array.isArray(wd)&&wd.length&&!wd.includes(weekday(date)))return false;return !isUnavailable(seller,date)};
export function buildMonthlyPlan({seller,days,rankedPlaces,existingBookings=[],minBlockDays=1,maxBlockDays=2,avoidWeekends=false}={}){
  const plan=[];let cursor=0,lastPlaceId=null;const usable=rankedPlaces.filter(p=>p.available!==false);
  while(cursor<days.length){
    const date=days[cursor];
    if(!workday(seller,date,avoidWeekends)||existingBookings.some(b=>b.sellerId===seller.id&&b.date===date)){cursor++;continue;}
    const candidate=usable.find(p=>p.id!==lastPlaceId)||usable[0];if(!candidate)break;
    let blockDates=[];let probe=cursor;
    while(probe<days.length&&blockDates.length<Math.max(1,maxBlockDays)){
      const d=days[probe];
      if(workday(seller,d,avoidWeekends)&&!existingBookings.some(b=>b.sellerId===seller.id&&b.date===d))blockDates.push(d);
      else if(blockDates.length)break;
      probe++;
    }
    if(blockDates.length<Math.min(1,minBlockDays)){cursor++;continue;}
    for(let i=0;i<blockDates.length;i++)plan.push({date:blockDates[i],sellerId:seller.id,placeId:candidate.id,placeName:candidate.name,score:candidate.score,economics:candidate.economics||null,status:'ai_suggestion',reason:i===0?'Uusi myyntijakso valittu alueen, kysynnän, historian ja talouden perusteella.':'Jatkaa samaa myyntipaikkaa 1–2 päivän jaksona.'});
    lastPlaceId=candidate.id;cursor=probe;
  }
  return plan;
}
export function summarizePlan(plan){const groups=[];for(const item of plan){const last=groups.at(-1);if(last&&last.placeId===item.placeId&&addDays(last.end,1)===item.date){last.end=item.date;last.days++;}else groups.push({placeId:item.placeId,placeName:item.placeName,start:item.date,end:item.date,days:1});}return {items:plan.length,blocks:groups.length,groups};}
