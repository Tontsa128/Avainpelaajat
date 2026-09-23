export function sellerDay(bookings,sellerId,date){return bookings.filter(x=>x.sellerId===sellerId&&x.date===date).sort((a,b)=>a.start.localeCompare(b.start));}
