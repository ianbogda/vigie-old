import { BookOpen, ChevronRight, FileSpreadsheet, HelpCircle, Info, X } from 'lucide-react';
import { useState } from 'react';
import { OPALE_HELP_REGISTRY } from '../help/opale';
import { VIEW_HELP } from '../help/views';
import type { HelpFormula, OpaleSourceHelp, OpaleSourceId } from '../help/types';

function isOpaleSourceId(value: unknown): value is OpaleSourceId {
  return typeof value === 'string' && value in OPALE_HELP_REGISTRY;
}


function MathFormula({ formula }: { formula: HelpFormula }) {
  if(formula.expression)return <div className="help-equation"><span>{formula.expression}</span></div>;
  return <div className="help-equation"><span className="help-fraction"><span>{formula.numerator}</span><span>{formula.denominator}</span></span>{formula.suffix&&<span className="help-formula-suffix">{formula.suffix}</span>}</div>;
}

function OpaleGuide({ source }: { source: OpaleSourceHelp }) {
  return <div className="help-guide">
    <div className="help-guide-title"><BookOpen size={17}/><div><b>Exporter {source.id} depuis OP@LE</b><small>{source.label}{source.variant ? ` · ${source.variant}` : ''} ({source.format.toLowerCase()})</small></div></div>
    {source.steps.map(step => <section className={`help-step${step.image ? '' : ' compact'}`} key={step.n}>
      <div className="help-step-heading"><i>{step.n}</i><div><b>{step.title}</b><p>{step.description}</p></div></div>
      {step.image && <img src={step.image} alt={`OP@LE — ${step.title}`}/>} 
    </section>)}
    {source.beforeImport && <div className="help-tip"><b>Avant l’import</b><span>{source.beforeImport}</span></div>}
  </div>;
}

export function ContextualHelp({view}:{view:string}) {
  const [open,setOpen]=useState(false);
  const [openSource,setOpenSource]=useState<OpaleSourceId|null>(null);
  const spec=VIEW_HELP[view];
  if(!spec)return null;
  const tutorialSources=spec.sources.filter(isOpaleSourceId);
  return <>
    <button className="context-help-button" onClick={()=>setOpen(true)}><HelpCircle size={17}/> Aide</button>
    {open&&<div className="help-veil" onClick={()=>setOpen(false)}><aside className="help-drawer" onClick={e=>e.stopPropagation()}>
      <header><div><span>AIDE CONTEXTUELLE</span><h2>{view}</h2></div><button onClick={()=>setOpen(false)} aria-label="Fermer"><X/></button></header>
      <div className="help-body">
        <section className="help-purpose"><Info size={18}/><p>{spec.purpose}</p></section>
        {spec.indicators?.length&&<section className="help-indicators"><h3>Comprendre les indicateurs</h3><p className="help-section-intro">Définition, mode de calcul et clés de lecture des indicateurs utilisés dans cette vue.</p><div className="help-indicator-list">{spec.indicators.map(ind=><article className="help-indicator" key={ind.name}><div className="help-indicator-head"><div><b>{ind.name}</b>{ind.short&&<span>{ind.short}</span>}</div></div><p>{ind.meaning}</p>{ind.formula&&<MathFormula formula={ind.formula}/>} {ind.reading&&<div className="help-reading"><strong>Comment le lire</strong><span>{ind.reading}</span></div>}{ind.caution&&<div className="help-caution"><strong>Point d’attention</strong><span>{ind.caution}</span></div>}{ind.source&&<small className="help-indicator-source">Référence : {ind.source}</small>}</article>)}</div></section>}
        <section><h3>Fichier(s) attendu(s)</h3><div className="help-files">{spec.sources.map((entry,index)=>{
          if(isOpaleSourceId(entry)){
            const source=OPALE_HELP_REGISTRY[entry];
            return <div key={source.id}><FileSpreadsheet size={19}/><div><b>{source.id} — {source.label}</b><small>{source.format}{source.variant ? ` · ${source.variant}` : ''}</small></div>{source.tutorialAvailable&&<button className="help-source-link" onClick={()=>setOpenSource(openSource===source.id?null:source.id)}><BookOpen size={15}/>{openSource===source.id?'Masquer':'Voir le tutoriel'}</button>}</div>;
          }
          return <div key={`${entry.name}-${index}`}><FileSpreadsheet size={19}/><div><b>{entry.name}</b><small>{entry.format}</small></div>{entry.note&&<em>{entry.note}</em>}</div>;
        })}</div></section>
        {tutorialSources.length>0 ? tutorialSources.map(id => openSource===id ? <OpaleGuide key={id} source={OPALE_HELP_REGISTRY[id]}/> : null) : <section className="help-placeholder"><BookOpen size={20}/><div><b>Pas-à-pas d’export OP@LE</b><p>{spec.notes?.[0]||'Procédure à documenter.'}</p></div><ChevronRight size={18}/></section>}
      </div>
    </aside></div>}
  </>;
}
