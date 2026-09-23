const n=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const finitePositive=v=>{const x=n(v,null);return x!==null&&x>0?x:null};

export function calculatePlaceEconomics(place={}, history=[], options={}){
  const rows=history.filter(x=>x.placeId===place.id);
  const historicalSales=rows.reduce((s,x)=>s+(n(x.sales??x.salesCount,0)||0),0);
  const historicalHours=rows.reduce((s,x)=>s+(n(x.hours??x.workHours,0)||0),0);
  const salesPerHour=historicalHours>0?historicalSales/historicalHours:null;
  const expectedSales=finitePositive(place.expectedSales)??finitePositive(place.estimatedSales)??(salesPerHour!==null?salesPerHour*(n(place.expectedHours,8)||8):null);
  const pricePerDay=finitePositive(place.pricePerDay)??finitePositive(place.price);
  const requestedPrice=finitePositive(place.requestedPrice);
  const agreedPrice=finitePositive(place.agreedPrice)??finitePositive(place.negotiatedPrice);
  const effectivePrice=agreedPrice??pricePerDay;
  const travelKm=finitePositive(place.roadDistanceKm)??finitePositive(place.distanceKm);
  const travelMinutes=finitePositive(place.roadTravelMinutes)??finitePositive(place.travelMinutes);
  const costPerKm=finitePositive(options.travelCostPerKm)??finitePositive(place.travelCostPerKm);
  const travelCost=travelKm!==null&&costPerKm!==null?travelKm*2*costPerKm:null;
  const salesValuePerSale=finitePositive(options.salesValuePerSale)??finitePositive(place.salesValuePerSale);
  const expectedSalesValue=expectedSales!==null&&salesValuePerSale!==null?expectedSales*salesValuePerSale:null;
  const estimatedNet=expectedSalesValue!==null?(expectedSalesValue-(effectivePrice??0)-(travelCost??0)):null;
  const investment=(effectivePrice??0)+(travelCost??0);
  const roi=estimatedNet!==null&&investment>0?estimatedNet/investment:null;
  const known={price:effectivePrice!==null,travelCost:travelCost!==null,expectedSales:expectedSales!==null,salesValuePerSale:salesValuePerSale!==null,estimatedNet:estimatedNet!==null,roi:roi!==null};
  return {historicalSales,historicalHours,salesPerHour,expectedSales,pricePerDay,requestedPrice,agreedPrice,effectivePrice,travelKm,travelMinutes,costPerKm,travelCost,expectedSalesValue,estimatedNet,roi,known};
}

export function economicsScore(e={}) {
  const parts=[];
  if(e.expectedSales!==null) parts.push(Math.min(100,e.expectedSales*10));
  if(e.roi!==null) parts.push(Math.max(0,Math.min(100,50+e.roi*25)));
  if(e.estimatedNet!==null) parts.push(e.estimatedNet>=0?Math.min(100,60+e.estimatedNet/10):Math.max(0,60+e.estimatedNet/10));
  if(e.travelKm!==null) parts.push(Math.max(0,100-e.travelKm));
  if(!parts.length)return 50;
  return parts.reduce((a,b)=>a+b,0)/parts.length;
}
