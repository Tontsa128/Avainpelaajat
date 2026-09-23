import test from 'node:test';
import assert from 'node:assert/strict';
import { territoryForSeller } from '../src/ai/territory.js';
import { rankPlaces } from '../src/ai/scoring.js';
import { calculatePlaceEconomics } from '../src/ai/economics.js';
import { monthDays, buildMonthlyPlan } from '../src/ai/calendar.js';

test('AI territory keeps places inside 100 km',()=>{
  const seller={id:'s1',lat:60,lon:24};
  const places=[{id:'near',name:'Near',lat:60.3,lon:24},{id:'far',name:'Far',lat:61.5,lon:24}];
  const out=territoryForSeller(seller,places,{radiusKm:100});
  assert.equal(out.some(x=>x.id==='near'),true); assert.equal(out.some(x=>x.id==='far'),false);
});

test('AI scoring ranks available strong place higher',()=>{
  const places=[{id:'a',name:'A',distanceKm:20,footTrafficScore:90,salesScore:90,available:true},{id:'b',name:'B',distanceKm:90,footTrafficScore:40,salesScore:30,available:true}];
  const out=rankPlaces(places,{preferences:{radiusKm:100}});
  assert.equal(out[0].id,'a'); assert.ok(out[0].score>out[1].score);
});

test('place economics stays explicit when financial inputs are unknown',()=>{
  const e=calculatePlaceEconomics({id:'p1',distanceKm:30,pricePerDay:100},[]);
  assert.equal(e.travelCost,null); assert.equal(e.estimatedNet,null); assert.equal(e.roi,null);
  assert.equal(e.known.price,true); assert.equal(e.known.travelCost,false);
});

test('place economics calculates travel cost and estimated net only from supplied inputs',()=>{
  const e=calculatePlaceEconomics({id:'p1',distanceKm:50,pricePerDay:100,expectedSales:10},[],{travelCostPerKm:0.5,salesValuePerSale:20});
  assert.equal(e.travelCost,50); assert.equal(e.expectedSalesValue,200); assert.equal(e.estimatedNet,50); assert.equal(e.roi,1);
});

test('AI monthly plan creates one-to-two day blocks',()=>{
  const seller={id:'s1'};
  const days=monthDays(2026,10).slice(0,6);
  const places=[{id:'p1',name:'P1',score:90,available:true},{id:'p2',name:'P2',score:80,available:true}];
  const plan=buildMonthlyPlan({seller,days,rankedPlaces:places,maxBlockDays:2});
  assert.equal(plan.length,6);
  for(let i=1;i<plan.length;i++) assert.ok(plan[i].date>plan[i-1].date);
});
