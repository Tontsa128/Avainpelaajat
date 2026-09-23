export function summary(state){return {sellers:state.sellers.length,places:state.places.length,bookings:state.bookings.length,sales:state.sales?.length||0};}
export function toCsv(rows){if(!rows.length)return '';const keys=Object.keys(rows[0]);return [keys.join(';'),...rows.map(r=>keys.map(k=>JSON.stringify(r[k]??'')).join(';'))].join('\n');}
