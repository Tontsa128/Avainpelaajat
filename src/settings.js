export const DEFAULT_SETTINGS={labourCostH:19,targetPerShift:8,maxShiftH:10,gps:false,travelKmh:60};
export function mergeSettings(s){return {...DEFAULT_SETTINGS,...s};}
