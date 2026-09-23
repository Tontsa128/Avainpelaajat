export function assertArray(value,name){if(!Array.isArray(value))throw new TypeError(name+' must be an array');return value;}
export function assertFiniteNumber(value,name){if(!Number.isFinite(Number(value)))throw new TypeError(name+' must be a number');return Number(value);}
