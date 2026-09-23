export async function pullWorkspace(apiFn,rev){return apiFn(`/api/workspace${rev!=null?`?since=${encodeURIComponent(rev)}`:''}`);}
export function hasChanges(workspace){return !workspace?.unchanged;}
