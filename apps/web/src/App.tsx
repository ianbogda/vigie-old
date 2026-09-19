import { useCallback, useEffect, useState } from 'react';
import './pcif.css';
import './treasury.css';
import { LogOut, BadgeEuro, BookOpenCheck, Building2, CalendarDays, CheckCircle2, Home, Landmark, LineChart, ReceiptText, RefreshCw, ShieldCheck, Upload, UsersRound, WalletCards } from 'lucide-react';
import { api } from './lib/api';
import { dateFr } from './lib/format';
import type { Dashboard, Eple } from './types/dashboard';
import { ImportModal } from './components/ImportModal';
import { HomeView } from './views/HomeView';
import { AgencyView } from './views/AgencyView';
import { EstablishmentsView } from './views/EstablishmentsView';
import { DomainView } from './views/DomainView';
import { LoginView } from './components/LoginView';
import { ContextualHelp } from './components/ContextualHelp';

const NAV=[['Accueil',Home],['Établissements',Building2],['Analyse financière',LineChart],['Budget',ReceiptText],['Dépenses',BadgeEuro],['Recettes',WalletCards],['Trésorerie',Landmark],['Clients',UsersRound],['Fournisseurs',UsersRound],['Comptabilité générale',BookOpenCheck],['Maîtrise des risques',ShieldCheck]] as const;
export default function App(){
 const[user,setUser]=useState<any|undefined>(undefined);
 const[dash,setDash]=useState<Dashboard|null>(null),[selectedId,setSelectedId]=useState('all'),[view,setView]=useState('Accueil'),[modal,setModal]=useState(false),[result,setResult]=useState<any>(null),[openSignal,setOpenSignal]=useState<string|null>(null),[q,setQ]=useState(''),[pcifSyncing,setPcifSyncing]=useState(false);
 const load=useCallback(async()=>{try{setDash(await api.dashboard())}catch(error){console.error('Chargement du cockpit impossible',error)}},[]);
 useEffect(()=>{api.me().then(r=>{setUser(r.user);void load()}).catch(()=>setUser(null))},[load]);
 if(user===undefined)return <div className="loading">Vérification de la session…</div>;
 if(!user)return <LoginView onLogin={u=>{setUser(u);void load()}}/>;
 const all:Eple[]=dash?.establishments||[]; const current=selectedId==='all'?null:all.find(e=>e.id===selectedId)||null;
 async function syncPcif(uai:string){setPcifSyncing(true);try{await api.syncPcif([uai]);await load()}catch(error){console.error('Synchronisation PCIF impossible',error)}finally{setPcifSyncing(false)}}
 async function upload(e:React.FormEvent<HTMLFormElement>){e.preventDefault();setResult({loading:true});try{const form=new FormData(e.currentTarget);const ets=String(form.get('ets')||'');form.delete('ets');const x=await api.importOpale(form,ets);setResult(x);await load()}catch(error){setResult({error:error instanceof Error?error.message:'Erreur inconnue'})}}
 return <div className="shell"><aside className="sidebar"><button className="logo logo-home" type="button" title="Revenir à l’accueil · Toute l’agence" aria-label="VIGIE EPLE — revenir à l’accueil de toute l’agence" onClick={()=>{setSelectedId('all');setView('Accueil')}}><img className="vigie-eye-logo" src="/vigie-eye.svg" alt="" aria-hidden="true"/><div><strong>VIGIE EPLE</strong><small>Observer · Analyser · Anticiper</small></div></button><nav>{NAV.map(([n,I])=><button className={view===n?'active':''} onClick={()=>setView(n)} key={n}><I size={18}/>{n}</button>)}</nav><div className="side-quote">« Anticiper aujourd'hui<br/>pour sécuriser demain »</div><div className="side-user"><b>{[user.firstName,user.lastName].filter(Boolean).join(' ')||user.email}</b><small>{user.globalRole==='ADMIN'?'Administrateur':(user.agencies?.[0]?.role||'Utilisateur')}</small><button onClick={async()=>{await api.logout();setDash(null);setUser(null)}}><LogOut size={14}/> Déconnexion</button></div><small className="version">VIGIE v0.0.49</small></aside>
 <main className="content"><header className="topbar"><div className="est-select"><span>Établissement</span><select value={selectedId} onChange={e=>setSelectedId(e.target.value)}><option value="all">Vue agence · tous les EPLE</option>{all.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></div><div className="situation"><span>Situation au</span><b><CalendarDays size={16}/> {dateFr(current?.freshness||dash?.generatedAt)}</b><small><CheckCircle2 size={14}/> Données historisées</small></div><div className="top-actions">{view!=='Accueil'&&view!=='Établissements'&&<ContextualHelp view={view}/>}<button onClick={()=>void load()} className="btn-soft" aria-label="Actualiser"><RefreshCw size={16}/></button><button onClick={()=>setModal(true)} className="btn-primary-v"><Upload size={16}/> Importer</button></div></header>
 {dash?(view==='Accueil'?(current?<HomeView dash={dash} current={current} openSignal={openSignal} setOpenSignal={setOpenSignal} onPcifSync={syncPcif} pcifSyncing={pcifSyncing}/>:<AgencyView dash={dash} onSelect={id=>setSelectedId(id)}/>):view==='Établissements'?<EstablishmentsView all={all} q={q} setQ={setQ} reload={load} canManage={user.globalRole==='ADMIN'} select={id=>{setSelectedId(id);setView('Accueil')}}/>:<DomainView title={view} current={current} all={all} onSelect={id=>setSelectedId(id)}/>):<div className="loading">Construction du cockpit…</div>}</main>
 {modal&&<ImportModal result={result} onClose={()=>setModal(false)} onSubmit={upload} establishments={all} selectedId={selectedId}/>}</div>
}
