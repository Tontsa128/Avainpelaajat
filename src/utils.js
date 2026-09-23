export const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const statusLabel={free:'Vapaa',reserved:'Varattu',working:'Työn alla',problem:'Ongelma'};
export function today(){return new Date().toISOString().slice(0,10);}
