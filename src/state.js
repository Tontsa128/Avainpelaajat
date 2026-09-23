export function createState(){return {mode:'work',sellers:[],places:[],bookings:[],leads:[],time:[],settings:{},rev:0};}
export function replaceState(state,next){return {...state,...next};}
