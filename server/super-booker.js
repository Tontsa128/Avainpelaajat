import { HttpError, bad, reqStr, isDate, isTime } from './http.js';
import * as store from './store.js';
import { tx } from './db.js';
import { newId } from './util.js';
import { planForSeller } from './ai-planner.js';
import { audit } from './audit.js';

const ROLES=['Admin','Buukkaaja','Esihenkilö'];
const roleOk=r=>ROLES.includes(r);
const minutes=t=>{const [h,m]=String(t).split(':').map(Number);return h*60+m};
const sellerFor=(db,org,id)=>store.getEntityRow(db,org,'sellers',id)?.obj;
const placeFor=(db,org,id)=>store.getEntityRow(db,org,'places',id)?.obj;
const validMerchantStatus=new Set(['uusi','soitettava','neuvottelu','odottaa_vastausta','vahvistettu','ei_sovittu','tauolla']);

function bookingProblems(db,org,b,ignore=''){
  const out=[];
  if(!store.entityExists(db,org,'sellers',b.sellerId)) out.push({code:'seller_missing',message:'Myyjää ei löydy.'});
  if(!store.entityExists(db,org,'places',b.placeId)) out.push({code:'place_missing',message:'Kauppapaikkaa ei löydy.'});
  return out.concat(store.findBookingConflicts(db,org,b,ignore));
}
function defaultShift(seller){return {start:seller.workStart||'10:00',end:seller.workEnd||'18:00'};}
function isoToday(){return new Date().toISOString().slice(0,10);}
function dashboard(db,org,date){
  const sellers=store.listEntity(db,org,'sellers'),places=store.listEntity(db,org,'places'),bookings=store.listEntity(db,org,'bookings');
  const leads=store.listRecords(db,org,'leads');
  const dayBookings=bookings.filter(b=>b.date===date);
  const activeSellerIds=new Set(dayBookings.map(b=>b.sellerId));
  const pendingLeads=leads.filter(l=>!['vahvistettu','lost','poistettu'].includes(l.status));
  const bookedByPlace=new Map();
  for(const b of dayBookings) bookedByPlace.set(b.placeId,(bookedByPlace.get(b.placeId)||0)+1);
  const queue=[];
  for(const l of pendingLeads){
    if(l.nextDate && l.nextDate<=date) queue.push({type:'call',priority:l.nextDate<date?'high':'normal',leadId:l.id,title:'Soita kauppiaalle',name:l.name,city:l.city||'',nextDate:l.nextDate,status:l.status});
    else if(l.status==='odottaa_vastausta') queue.push({type:'followup',priority:'normal',leadId:l.id,title:'Tarkista kauppiaan vastaus',name:l.name,city:l.city||'',nextDate:l.nextDate||'',status:l.status});
  }
  for(const b of dayBookings) if(b.status!=='confirmed') queue.push({type:'booking_confirm',priority:'high',bookingId:b.id,title:'Vahvista varaus',name:b.placeName||'Kauppapaikka',date:b.date,status:b.status});
  const bookedSellerIds=new Set(dayBookings.map(b=>b.sellerId));
  for(const s of sellers) if(!bookedSellerIds.has(s.id)) queue.push({type:'seller_free',priority:'normal',sellerId:s.id,title:'Myyjälle ei ole paikkaa',name:s.name});
  return {
    date,
    kpi:{sellers:sellers.length,working:activeSellerIds.size,free:Math.max(0,sellers.length-activeSellerIds.size),places:places.length,pendingLeads:pendingLeads.length,bookings:dayBookings.length,queue:queue.length},
    sellers:sellers.map(s=>{const bs=dayBookings.filter(b=>b.sellerId===s.id);return {id:s.id,name:s.name,home:s.home||null,radiusKm:s.radiusKm||100,status:bs.length?'varattu':'vapaa',today:bs};}),
    today:dayBookings.map(b=>({...b,sellerName:sellers.find(s=>s.id===b.sellerId)?.name||'—',placeName:places.find(p=>p.id===b.placeId)?.name||'—'})),
    leads:pendingLeads.slice(0,30).map(l=>({id:l.id,name:l.name,city:l.city,status:l.status,next:l.next,nextDate:l.nextDate,price:l.price,phone:l.phone,email:l.email,contactHistory:l.contactHistory||[]})),
    queue:queue.sort((a,b)=>String(b.priority).localeCompare(String(a.priority))),
    placeLoad:places.map(p=>({id:p.id,name:p.name,city:p.city,bookings:bookedByPlace.get(p.id)||0})).sort((a,b)=>b.bookings-a.bookings)
  };
}

export function registerSuperBookerRoutes(router,{db}){
  const guard=ctx=>{if(!roleOk(ctx.role))throw new HttpError(403,'forbidden','Super Buukkaaja vaatii buukkaajan, esihenkilön tai ylläpitäjän roolin.');};

  router.get('/api/super-booker/dashboard',{org:true},ctx=>{guard(ctx);const date=ctx.query.date||isoToday();if(!isDate(date))throw bad('Päivämäärä on virheellinen.');return dashboard(db,ctx.orgId,date);});

  router.post('/api/super-booker/merchant/:id/contact',{org:true},ctx=>{
    guard(ctx);const id=reqStr(ctx.params.id,'id',1,120);const row=store.getRecordRow(db,ctx.orgId,'leads',id);
    if(!row)throw new HttpError(404,'lead_missing','Kauppiaan yhteystietoa ei löydy.');
    const b=ctx.body||{},note=reqStr(b.note,'note',1,2000);
    const history=Array.isArray(row.obj.contactHistory)?row.obj.contactHistory.slice():[];
    history.unshift({id:newId('contact'),at:new Date().toISOString(),type:b.type||'puhelu',note,userId:ctx.user.id});
    const nextDate=b.nextDate?reqStr(b.nextDate,'nextDate',10,10):row.obj.nextDate||'';
    if(nextDate&&!isDate(nextDate))throw bad('Seuraavan yhteydenoton päivämäärä on virheellinen.');
    const status=b.status?reqStr(b.status,'status',1,40):row.obj.status;
    if(status&&!validMerchantStatus.has(status))throw bad('Kauppiaan tila on virheellinen.');
    const obj={...row.obj,contactHistory:history,nextDate,status:status||'soitettava',lastContactAt:new Date().toISOString()};
    store.upsertRecord(db,ctx.orgId,'leads',obj,row.pos);store.bumpRev(db,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'merchant.contact',{leadId:id,status:obj.status});
    return obj;
  });

  router.patch('/api/super-booker/merchant/:id',{org:true},ctx=>{
    guard(ctx);const id=reqStr(ctx.params.id,'id',1,120);const row=store.getRecordRow(db,ctx.orgId,'leads',id);
    if(!row)throw new HttpError(404,'lead_missing','Kauppiaan yhteystietoa ei löydy.');
    const b=ctx.body||{};const obj={...row.obj};
    for(const k of ['name','city','phone','email','next','notes','price','requestedPrice','footTraffic','availableDates'])if(b[k]!==undefined)obj[k]=b[k];
    if(b.status!==undefined){if(!validMerchantStatus.has(String(b.status)))throw bad('Kauppiaan tila on virheellinen.');obj.status=String(b.status);}
    if(b.nextDate!==undefined){if(b.nextDate&&!isDate(String(b.nextDate)))throw bad('Seuraavan yhteydenoton päivämäärä on virheellinen.');obj.nextDate=String(b.nextDate);}
    store.upsertRecord(db,ctx.orgId,'leads',obj,row.pos);store.bumpRev(db,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'merchant.update',{leadId:id});
    return obj;
  });

  router.patch('/api/super-booker/seller/:id/profile',{org:true},ctx=>{
    guard(ctx);const id=reqStr(ctx.params.id,'id',1,120);const row=store.getEntityRow(db,ctx.orgId,'sellers',id);
    if(!row)throw new HttpError(404,'seller_missing','Myyjää ei löydy.');
    const b=ctx.body||{};const allowed=['home','radiusKm','travelMode','maxDailyDrivingMinutes','workDays','workStart','workEnd','breakMinutes','preferredAreas','avoidedAreas','preferredPlaceTypes','minBlockDays','maxBlockDays','maxDaysPerPlace','explorationPercent','absences'];
    const obj={...row.obj};for(const k of allowed)if(b[k]!==undefined)obj[k]=b[k];
    if(obj.radiusKm!==undefined&&(!Number.isFinite(Number(obj.radiusKm))||Number(obj.radiusKm)<1||Number(obj.radiusKm)>500))throw bad('radiusKm pitää olla 1–500.');
    if(obj.workStart&&!isTime(obj.workStart)||obj.workEnd&&!isTime(obj.workEnd))throw bad('Työajan kellonaika on virheellinen.');
    if(obj.workStart&&obj.workEnd&&minutes(obj.workEnd)<=minutes(obj.workStart))throw bad('Työajan päättymisaika pitää olla aloitusta myöhemmin.');
    store.upsertEntity(db,ctx.orgId,'sellers',obj,row.pos);store.bumpRev(db,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'seller.profile.update',{sellerId:id});
    return obj;
  });

  router.post('/api/super-booker/plan',{org:true},ctx=>{
    guard(ctx);const b=ctx.body||{},sellerId=reqStr(b.sellerId,'sellerId',1,120),seller=sellerFor(db,ctx.orgId,sellerId);
    if(!seller)throw new HttpError(404,'seller_missing','Myyjää ei löydy.');
    const ym=String(b.month||'').match(/^(\d{4})-(\d{2})$/);if(!ym)throw bad('Kuukausi pitää antaa muodossa VVVV-KK.');
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
    const created=[],conflicts=[];
    tx(db,()=>{
      for(const raw of b.items){
        const sellerId=reqStr(raw.sellerId,'sellerId',1,120),placeId=reqStr(raw.placeId,'placeId',1,120),date=reqStr(raw.date,'date',10,10);if(!isDate(date))throw bad('Päivämäärä on virheellinen.');
        const seller=sellerFor(db,ctx.orgId,sellerId),place=placeFor(db,ctx.orgId,placeId);if(!seller||!place)throw new HttpError(404,'not_found','Myyjää tai kauppapaikkaa ei löydy.');
        const sh=defaultShift(seller),start=raw.start&&isTime(raw.start)?raw.start:sh.start,end=raw.end&&isTime(raw.end)?raw.end:sh.end;if(minutes(end)<=minutes(start))throw bad('Työvuoron päättymisaika pitää olla aloitusta myöhemmin.');
        const stand=raw.stand||(place.stands?.[0]?.id)||'A';const booking={id:newId('bk'),sellerId,placeId,date,start,end,stand,status:'tentative',campaign:raw.campaign||'',source:'super-buukkaaja-ai'};
        const p=bookingProblems(db,ctx.orgId,booking);if(p.length){conflicts.push({item:raw,conflicts:p});continue;}
        store.upsertEntity(db,ctx.orgId,'bookings',booking,store.nextPos(db,ctx.orgId,'bookings'));created.push(booking);
      }
      if(created.length){store.bumpRev(db,ctx.orgId);audit(db,ctx.orgId,ctx.user.id,'super-booker.approve',{created:created.length,conflicts:conflicts.length});}
    });
    return {ok:true,created,conflicts,createdCount:created.length,conflictCount:conflicts.length};
  });

  router.post('/api/super-booker/replan-day',{org:true},ctx=>{
    guard(ctx);const b=ctx.body||{},sellerId=reqStr(b.sellerId,'sellerId',1,120),date=reqStr(b.date,'date',10,10);if(!isDate(date))throw bad('Päivämäärä on virheellinen.');
    const seller=sellerFor(db,ctx.orgId,sellerId);if(!seller)throw new HttpError(404,'seller_missing','Myyjää ei löydy.');
    const current=store.listEntity(db,ctx.orgId,'bookings').find(x=>x.sellerId===sellerId&&x.date===date);
    const places=store.listEntity(db,ctx.orgId,'places').filter(p=>p.id!==current?.placeId);
    const {year,month}=(()=>{const [y,m]=date.split('-').map(Number);return {year:y,month:m}})();
    const plan=planForSeller({seller,places,bookings:store.listEntity(db,ctx.orgId,'bookings').filter(x=>x.date!==date),salesHistory:store.listRecords(db,ctx.orgId,'time'),year,month,options:{radiusKm:Number(seller.radiusKm||100),minBlockDays:1,maxBlockDays:1,avoidWeekends:false,maxCandidates:10}});
    return {date,sellerId,current:current||null,suggestion:plan.plan.find(x=>x.date===date)||null,candidates:plan.candidates.slice(0,10)};
  });
}
