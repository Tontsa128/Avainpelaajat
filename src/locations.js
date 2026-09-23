export function filterLocations(items,q=''){const s=q.trim().toLowerCase();return items.filter(x=>!s||`${x.name} ${x.city} ${x.region||''}`.toLowerCase().includes(s));}
export function locationStatus(place){return place.status||'free';}
