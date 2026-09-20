import { AlertTriangle, Building2, CheckCircle2, ChevronRight, CircleAlert, CircleDashed, Coins, Landmark, ReceiptText } from 'lucide-react';
import type { Dashboard, Eple, State } from '../types/dashboard';
import { eur, pct } from '../lib/format';

const LABELS:Record<string,string>={budget:'Budget',financial:'Analyse financière',suppliers:'Fournisseurs',accounting:'Comptabilité générale',treasury:'Trésorerie',clients:'Clients'};
function tone(s:State){return s==='alert'?'alert':s==='watch'?'watch':s==='missing'?'missing':'ok'}
function StateIcon({state}:{state:State}){return state==='alert'?<CircleAlert/>:state==='watch'?<AlertTriangle/>:state==='missing'?<CircleDashed/>:<CheckCircle2/>}
export function AgencyView({dash,onSelect}:{dash:Dashboard;onSelect:(id:string)=>void}){
 const all=dash.establishments||[];
 const domains=Array.from(new Set(all.flatMap(e=>Object.keys(e.states||{}))));
 const alerts=all.reduce((n,e)=>n+(e.signals||[]).filter(s=>s.level==='alert').length,0);
 const watches=all.reduce((n,e)=>n+(e.signals||[]).filter(s=>s.level==='watch').length,0);
 const attentionEple=all.filter(e=>(e.signals||[]).some(s=>s.level==='alert'||s.level==='watch')).length;
 const engagementRows=all.map(e=>({e,rate:Number(e.budgetMetrics?.engagementRate)})).filter((r):r is {e:Eple;rate:number}=>Number.isFinite(r.rate));
 const engagementValues=engagementRows.map(r=>r.rate);
 const engagementMedian=median(engagementValues),engagementMin=engagementValues.length?Math.min(...engagementValues):null,engagementMax=engagementValues.length?Math.max(...engagementValues):null;
 const treasuryRows=all.map(e=>({e,value:Number(e.treasury?.currentBalance)})).filter((r):r is {e:Eple;value:number}=>eHasTreasury(r.e)&&Number.isFinite(r.value));
 const treasuryValues=treasuryRows.map(r=>r.value);
 const treasuryMedian=median(treasuryValues),treasuryMin=treasuryValues.length?Math.min(...treasuryValues):null,treasuryMax=treasuryValues.length?Math.max(...treasuryValues):null;
 const stale=all.filter(e=>(e.staleSources?.length||0)>0);
 const ranked=[...all].sort((a,b)=>score(b)-score(a));
 return <div className="agency-page fade-in">
  <div className="agency-head"><div><span>VUE AGENCE</span><h2>Pilotage du groupement comptable</h2><p>Lecture consolidée, puis accès immédiat aux EPLE qui nécessitent une attention.</p></div><div className="agency-scope"><Building2/><b>{all.length}</b><small>établissements suivis</small></div></div>
  <section className="agency-kpis">
   <article className={attentionEple?'agency-alert-kpi':''}><Building2/><span>EPLE à surveiller</span><b>{attentionEple}</b><small>{all.length?`${attentionEple}/${all.length} EPLE avec au moins une alerte ou vigilance`:'Aucun EPLE'}</small></article>
   <article className={alerts?'agency-alert-kpi':''}><AlertTriangle/><span>Situations à contrôler</span><b>{alerts+watches}</b><small>{alerts} alerte(s) · {watches} vigilance(s)</small></article>
   <article><ReceiptText/><span>Engagement médian</span><b>{engagementMedian==null?'—':pct(engagementMedian)}</b><small>{engagementMedian==null?'Aucune donnée':`Min. ${pct(engagementMin!)} · Max. ${pct(engagementMax!)} · ${engagementValues.length} EPLE`}</small></article>
   <article><Landmark/><span>Trésorerie médiane</span><b>{treasuryMedian==null?'—':eur(treasuryMedian)}</b><small>{treasuryMedian==null?'Aucun solde 5151':`Min. ${eur(treasuryMin!)} · Max. ${eur(treasuryMax!)} · ${treasuryValues.length} EPLE`}</small></article>
   <article className={stale.length?'agency-alert-kpi':''}><Coins/><span>Données à actualiser</span><b>{stale.length}</b><small>{stale.length?`${stale.length}/${all.length} EPLE avec au moins une source périmée`:'Aucune source signalée comme périmée'}</small></article>
  </section>
  <section className="agency-grid">
   <article className="panel agency-matrix"><div className="panel-title"><div><h3>État du portefeuille</h3><p>Une ligne par EPLE, une lecture commune des domaines métier.</p></div></div><div className="agency-table-scroll"><table><thead><tr><th>Établissement</th>{domains.map(d=><th key={d}>{LABELS[d]||d}</th>)}<th>Signaux</th><th/></tr></thead><tbody>{ranked.map(e=><tr key={e.id}><td><b>{e.name}</b><small>{e.uai||'UAI non renseigné'}</small></td>{domains.map(d=>{const s=(e.states?.[d]||'missing') as State;return <td key={d}><span className={`agency-state ${tone(s)}`} title={s}><StateIcon state={s}/></span></td>})}<td><b className={e.signals?.some(s=>s.level==='alert')?'signal-count alert':''}>{e.signals?.length||0}</b></td><td><button onClick={()=>onSelect(e.id)} aria-label={`Ouvrir ${e.name}`}><ChevronRight/></button></td></tr>)}</tbody></table></div></article>
   <article className="panel agency-attention"><div className="panel-title"><div><h3>À regarder en priorité</h3><p>EPLE classés par intensité des signaux, sans créer de score métier.</p></div></div><div className="attention-list">{ranked.filter(e=>score(e)>0).slice(0,7).map(e=><button key={e.id} onClick={()=>onSelect(e.id)}><span className={`attention-dot ${e.signals?.some(s=>s.level==='alert')?'alert':'watch'}`}/><div><b>{e.name}</b><small>{summary(e)}</small></div><ChevronRight/></button>)}{ranked.every(e=>score(e)===0)&&<div className="agency-empty"><CheckCircle2/><b>Aucun signal prioritaire</b><small>Les données disponibles ne font ressortir aucune alerte.</small></div>}</div></article>
  </section>
 </div>
}
function score(e:Eple){return (e.signals||[]).reduce((n,s)=>n+(s.level==='alert'?2:s.level==='watch'?1:0),0)}
function summary(e:Eple){const a=(e.signals||[]).filter(s=>s.level==='alert').length,w=(e.signals||[]).filter(s=>s.level==='watch').length;return `${a} alerte${a>1?'s':''} · ${w} vigilance${w>1?'s':''}`}

function median(values:number[]){if(!values.length)return null;const xs=[...values].sort((a,b)=>a-b),m=Math.floor(xs.length/2);return xs.length%2?xs[m]:(xs[m-1]+xs[m])/2}
function eHasTreasury(e:Eple){return e.treasury?.currentBalance!=null}
