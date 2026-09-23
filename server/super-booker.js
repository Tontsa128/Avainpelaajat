import { HttpError, bad, reqStr, isDate, isTime } from './http.js';
import * as store from './store.js';
import { tx } from './db.js';
import { newId } from './util.js';
import { planForSeller } from './ai-planner.js';
import { audit } from './routes.js';

const ROLES=['Admin','Buukkaaja','Esihenkilö'];
const roleOk=r=>ROLES.includes(r);
const json=s=>{try{return JSON.parse(s)}catch{return {}}};
const minutes=t=>{const [h,m]=String(t).split(':').map(Number);return h*60+m};
const dateParts=d=>{const [y,m]=String(d).split('-').map(Number);return {year:y,month:m}};
const sellerFor=(db,org,id)=>store.getEntityRow(db,org,'sellers',id)?.obj;
const placeFor=(db,org,id)=>store.getEntityRow(db,org,'places',id)?.obj;

function bookingProblems(db,org,b,ignore=''){
  const out=[];
  if(!store.entityExists(db,org,'sellers',b.sellerId)) out.push({code:'seller_missing',message:'Myyjää ei löydy.'});
  if(!store.entityExists(db,org,'places',b.placeId)) out.push({code:'place_missing',message:'Kauppapaikkaa ei löydy.'});
  for(const x of store.listEntity(db,org,'bookings')){
    if(x.id===ignore||x.date!==b.date||x.sellerId!==b.sellerId) continue;
    if(minutes(b.start)<minutes(x.end)&&minutes(x.start)<minutes(b.end)) out.push({code:'seller',message:'Myyjällä on päällekkäinen varaus.',bookingId:x.id});
  }
  return out;
}

function defaultShift(seller){
  return {start:seller.workStart||'10:00',end:seller.workEnd||'18:00'};
}

function dashboard(db,org,date){
  const sellers=store.listEntity(db,org,'sellers');
  const places=store.listEntity(db,org,'places');
  const bookings=store.listEntity(db,org,'bookings');
  const leads=store.listRecords(db,org,'leads');
  const dayBookings=bookings.filter(b=>b.date===date);
  const activeSellerIds=new Set(dayBookings.map(b=>b.sellerId));
  const pendingLeads=leads.filter(l=>!['vahvistettu','lost','poistettu'].includes(l.status));
  const bookedByPlace=new Map();
  for(const b of dayBookings) bookedByPlace.set(b.placeId,(bookedByPlace.get(b.placeId)||0)+1);
  return {
    date,
    kpi:{sellers:sellers.length,working:activeSellerIds.size,free:Math.max(0,sellers.length-activeSellerIds.size),places:places.length,pendingLeads:pendingLeads.length,bookings:dayBookings.length},
    sellers:sellers.map(s=>{const bs=dayBookings.filter(b=>b.sellerId===s.id);return {id:s.id,name:s.name,home:s.home||null,radiusKm:s.radiusKm||100,status:bs.length?'varattu':'vapaa',today:bs};}),
    today:dayBookings.map(b=>({...b,sellerName:sellers.find(s=>s.id===b.sellerId)?.name||'—',placeName:places.find(p=>p.id===b.placeId)?.name||'—'})),
    leads:pendingLeads.slice(0,20).map(l=>({id:l.id,name:l.name,city:l.city,status:l.status,next:l.next,nextDate:l.nextDate,price:l.price})),
    placeLoad:places.map(p=>({id:p.id,name:p.name,city:p.city,bookings:bookedByPlace.get(p.id)||0})).sort((a,b)=>b.bookings-a.bookings)
  };
}

export function registerSuperBookerRoutes(router,{db}){
  const guard=ctx=>{if(!roleOk(ctx.role))throw new HttpError(403,'forbidden','Super Buukkari vaatii buukkaajan, esihenkilön tai ylläpitäjän roolin.');};
  router.get('/api/super-booker/dashboard',{org:true},ctx=>{guard(ctx);const date=ctx.query.date||new Date().toISOString().slice(0,10);if(!isDate(date))throw bad('Päivämäärä on virheellinen.');return dashboard(db,ctx.orgId,date);});

  router.post('/api/super-booker/plan',{org:true},ctx=>{
    guard(ctx);const b=ctx.body||{};const sellerId=reqStr(b.sellerId,'sellerId',1,120);const seller=sellerFor(db,ctx.orgId,sellerId);
    if(!seller)throw new HttpError(404,'seller_missing','Myyjää ei löydy.');
    const ym=String(b.month||'').match(/^(\\d{4})-(\\d{2})$/);if(!ym)throw bad('Kuukausi pitää antaa muodossa VVVV-KK.');
    const year=Number(ym[1]),month=Number(ym[2]);if(month<1||month>12)throw bad('Kuukausi on virheellinen.');
    const places=store.listEntity(db,ctx.orgId,'places'),bookings=store.listEntity(db,ctx.orgId,'bookings');
    const history=store.listRecords(db,ctx.orgId,'time').map(x=>({...x,sales:x.sales??x.salesCount??0,hours:x.hours??x.workHours??0}));
    return planForSeller({seller,places,bookings,salesHistory:history,year,month,options:{
      radiusKm:Number(b.radiusKm||seller.radiusKm||100),minBlockDays:Number(b.minBlockDays||seller.minBlockDays||1),maxBlockDays:Number(b.maxBlockDays||seller.maxBlockDays||2),
      avoidWeekends:b.avoidWeekends!==false,maxCandidates:100
    }});
  });

  router.post('/api/super-booker/approve',{org:true},ctx=>{
    guard(ctx);const b=ctx.body||{};if(!Array.isArray(b.items)||!b.items.length)throw bad('Hyväksyttäviä suunnitelmarivejä ei annettu.');if(b.items.length>100)throw bad('Kerralla voi hyväksyä enintään 100 varausta.');
    const created=[];const conflicts=[];
    tx(db,()=>{
      for(const raw of b.items){
        const sellerId=reqStr(raw.sellerId,'sellerId',1,120),placeId=reqStr(raw.placeId,'placeId',1,120),date=reqStr(raw.date,'date',10,10);
        if(!isDate(date))throw bad('Päivämäärä on virheellinen.');
        const seller=sellerFor(db,ctx.orgId,sellerId),place=placeFor(db,ctx.orgId,placeId);if(!seller||!place)throw new HttpError(404,'not_found','Myyjää tai kauppapaikkaa ei löydy.');
        const sh=defaultShift(seller),start=raw.start&&isTime(raw.start)?raw.start:sh.start,end=raw.end&&isTime(raw.end)?raw.end:sh.end;
        if(minutes(end)<=minutes(start))throw bad('Työvuoron päättymisaika pitää olla aloitusta myöhemmin.');
        const stand=raw.stand||(place.stands?.[0]?.id)||'A';
        const booking={id:newId('bk'),sellerId,placeId,date,start,end,stand,status:'tentative',campaign:raw.campaign||'',source:'super-buukkaaja-ai'};
        const p=bookingProblems(db,ctx.orgId,booking);
        if(p.length){conflicts.push({item:raw,conflicts:p});continue;}
        store.upsertEntity(db,ctx.orgId,'bookings',booking,store.nextPos(db,ctx.orgId,'bookings'));created.push(booking);
      }
      if(created.length){store.bumpRev(db,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'super-booker.approve',{created:created.length,conflicts:conflicts.length});}
    });
    return {ok:true,created,conflicts,createdCount:created.length,conflictCount:conflicts.length};
  });

  router.post('/api/super-booker/replan-day',{org:true},ctx=>{
    guard(ctx);const b=ctx.body||{};const sellerId=reqStr(b.sellerId,'sellerId',1,120),date=reqStr(b.date,'date',10,10);if(!isDate(date))throw bad('Päivämäärä on virheellinen.');
    const seller=sellerFor(db,ctx.orgId,sellerId);if(!seller)throw new HttpError(404,'seller_missing','Myyjää ei löydy.');
    const current=store.listEntity(db,ctx.orgId,'bookings').find(x=>x.sellerId===sellerId&&x.date===date);
    const places=store.listEntity(db,ctx.orgId,'places').filter(p=>p.id!==current?.placeId);
    const {year,month}=dateParts(date),history=store.listRecords(db,ctx.orgId,'time');
    const plan=planForSeller({seller,places,bookings:store.listEntity(db,ctx.orgId,'bookings').filter(x=>x.date!==date),salesHistory:history,year,month,options:{radiusKm:Number(seller.radiusKm||100),minBlockDays:1,maxBlockDays:1,avoidWeekends:false,maxCandidates:10}});
    const alt=plan.plan.find(x=>x.date===date);
    return {date,sellerId,current:current||null,suggestion:alt||null,candidates:plan.candidates.slice(0,10)};
  });
}
