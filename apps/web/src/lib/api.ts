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
  financialFdrAnalysis: (ets:string,exercise:number) => fetch(`/api/financial/${encodeURIComponent(ets)}/fdr-analysis?exercise=${exercise}`).then(json<any>),
  clcaMonthly: (ets:string) => fetch(`/api/clca/${encodeURIComponent(ets)}/monthly`).then(json<any>),
  accounting: (ets:string) => fetch(`/api/accounting/${encodeURIComponent(ets)}`).then(json<any>),
  aged: (ets:string,kind:'clients'|'suppliers',exercise?:number) => fetch(`/api/aged/${encodeURIComponent(ets)}/${kind}${exercise?`?exercise=${exercise}`:''}`).then(json<any>),
  pcifStatus: () => fetch('/api/integrations/pcif/status').then(json<any>),
  syncPcif: (uais: string[]) => fetch('/api/integrations/pcif/sync', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({uais}) }).then(json<any>),
  adminUsers: () => fetch('/api/admin/users').then(json<any>),
  createUser: (body:any) => fetch('/api/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  updateUser: (id:number,body:any) => fetch(`/api/admin/users/${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  resetUserPassword: (id:number,password:string) => fetch(`/api/admin/users/${id}/reset-password`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})}).then(json<any>),
  updateUserAgencies: (id:number,roles:any[]) => fetch(`/api/admin/users/${id}/agencies`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({roles})}).then(json<any>),
  adminAgencies: () => fetch('/api/admin/agencies').then(json<any>),
  createAgency: (name:string) => fetch('/api/admin/agencies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})}).then(json<any>),
  updateAgency: (id:number,body:any) => fetch(`/api/admin/agencies/${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  setEstablishmentAgency: (id:number,agencyId:number|null) => fetch(`/api/admin/establishments/${id}/agency`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agencyId})}).then(json<any>),
  establishments: () => fetch('/api/establishments').then(json<any>),
  createEstablishment: (body:any) => fetch('/api/establishments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  updateEstablishment: (id:number,body:any) => fetch(`/api/establishments/${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(json<any>),
  deleteEstablishment: (id:number) => fetch(`/api/establishments/${id}`,{method:'DELETE'}).then(json<any>),
  restoreEstablishment: (id:number) => fetch(`/api/establishments/${id}/restore`,{method:'POST'}).then(json<any>),
  importOpale: (form: FormData, ets?: string, exercise?: number) => { const q=new URLSearchParams(); if(ets)q.set('ets',ets); if(exercise)q.set('exercise',String(exercise)); return fetch(`/api/import/opale${q.toString()?`?${q}`:''}`,  { method: 'POST', body: form }).then(json<any>) },
};
