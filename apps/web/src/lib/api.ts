import type { Dashboard } from '../types/dashboard';

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  return body as T;
}
export const api = {
  me: () => fetch('/api/auth/me').then(json<any>),
  login: (email:string,password:string) => fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})}).then(json<any>),
  logout: () => fetch('/api/auth/logout',{method:'POST'}).then(json<any>),
  dashboard: () => fetch('/api/dashboard').then(json<Dashboard>),
  budget: (ets:string,exercise?:number) => fetch(`/api/budget/${encodeURIComponent(ets)}${exercise?`?exercise=${exercise}`:''}`).then(json<any>),
  financial: (ets:string) => fetch(`/api/financial/${encodeURIComponent(ets)}`).then(json<any>),
  clcaMonthly: (ets:string) => fetch(`/api/clca/${encodeURIComponent(ets)}/monthly`).then(json<any>),
  accounting: (ets:string) => fetch(`/api/accounting/${encodeURIComponent(ets)}`).then(json<any>),
  aged: (ets:string,kind:'clients'|'suppliers') => fetch(`/api/aged/${encodeURIComponent(ets)}/${kind}`).then(json<any>),
  pcifStatus: () => fetch('/api/integrations/pcif/status').then(json<any>),
  syncPcif: (uais: string[]) => fetch('/api/integrations/pcif/sync', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({uais}) }).then(json<any>),
  establishments: () => fetch('/api/establishments').then(json<any>),
  createEstablishment: (body:any) => fetch('/api/establishments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  updateEstablishment: (id:number,body:any) => fetch(`/api/establishments/${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  deleteEstablishment: (id:number) => fetch(`/api/establishments/${id}`,{method:'DELETE'}).then(json<any>),
  restoreEstablishment: (id:number) => fetch(`/api/establishments/${id}/restore`,{method:'POST'}).then(json<any>),
  importOpale: (form: FormData, ets?: string, exercise?: number) => { const q=new URLSearchParams(); if(ets)q.set('ets',ets); if(exercise)q.set('exercise',String(exercise)); return fetch(`/api/import/opale${q.toString()?`?${q}`:''}`,  { method: 'POST', body: form }).then(json<any>) },
};
