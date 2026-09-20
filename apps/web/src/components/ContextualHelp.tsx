import { AlertTriangle, ArrowRight, BookOpen, ChevronRight, Eye, FileSpreadsheet, HelpCircle, Info, X } from 'lucide-react';
import { useState } from 'react';
import { OPALE_HELP_REGISTRY } from '../help/opale';
import { VIEW_HELP } from '../help/views';
import { getIndicator } from '../help/indicators';
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
  const [openIndicators,setOpenIndicators]=useState(false);
  const spec=VIEW_HELP[view];
  if(!spec)return null;
  const tutorialSources=spec.sources.filter(isOpaleSourceId);
  return <>
    <button className="context-help-button" onClick={()=>setOpen(true)}><HelpCircle size={17}/> Aide</button>
    {open&&<div className="help-veil" onClick={()=>setOpen(false)}><aside className="help-drawer" onClick={e=>e.stopPropagation()}>
      <header><div><span>AIDE CONTEXTUELLE</span><h2>{view}</h2></div><button onClick={()=>setOpen(false)} aria-label="Fermer"><X/></button></header>
      <div className="help-body">
        <section className="help-purpose"><Info size={18}/><div><b>À quoi sert cette vue ?</b><p>{spec.purpose}</p></div></section>
        {spec.reading?.length&&<section className="help-learning-section"><h3><Eye size={17}/> Comment la lire ?</h3><ol className="help-reading-steps">{spec.reading.map((item,index)=><li key={index}><i>{index+1}</i><span>{item}</span></li>)}</ol></section>}
        {spec.indicators?.length&&<section className="help-indicators"><div className="help-indicators-toggle-row"><div><h3>Indicateurs et méthodes de calcul</h3><p className="help-section-intro">Définition, formule et clés de lecture des indicateurs utilisés dans cette vue.</p></div><button className="help-source-link help-definitions-toggle" onClick={()=>setOpenIndicators(v=>!v)} aria-expanded={openIndicators}><BookOpen size={15}/>{openIndicators?'Masquer les définitions':'Voir les définitions'}</button></div>{openIndicators&&<div className="help-indicator-list">{spec.indicators.map(id=>{const ind=getIndicator(id);return <article className="help-indicator" key={id}><div className="help-indicator-head"><div><b>{ind.name}</b>{ind.short&&<span>{ind.short}</span>}</div></div><p>{ind.meaning}</p>{ind.formula&&<MathFormula formula={ind.formula}/>} {ind.reading&&<div className="help-reading"><strong>Comment le lire</strong><span>{ind.reading}</span></div>}{ind.caution&&<div className="help-caution"><strong>Point d’attention</strong><span>{ind.caution}</span></div>}{ind.source&&<small className="help-indicator-source">Référence : {ind.source}</small>}</article>})}</div>}</section>}
        {spec.requiredData?.length&&<section className="help-required-data"><div className="help-required-data-head"><FileSpreadsheet size={17}/><div><h3>Données nécessaires</h3><p>Jeux de données mobilisés pour produire les indicateurs de cette vue.</p></div></div><div className="help-required-data-grid">{spec.requiredData.map((item,index)=><div className="help-required-data-item" key={`${item.label}-${index}`}><b>{item.label}</b><span>{item.source}</span>{item.note&&<small>{item.note}</small>}</div>)}</div><p className="help-required-data-rule"><Info size={14}/><span><b>Une donnée absente n’est pas reconstituée par Vigie.</b> Les indicateurs qui en dépendent sont affichés comme indisponibles ou incomplets.</span></p></section>}
        <section className="help-learning-section"><h3><FileSpreadsheet size={17}/> D’où viennent les données ?</h3><div className="help-files">{spec.sources.map((entry,index)=>{
          if(isOpaleSourceId(entry)){
            const source=OPALE_HELP_REGISTRY[entry];
            return <div key={source.id}><FileSpreadsheet size={19}/><div><b>{source.id} — {source.label}</b><small>{source.format}{source.variant ? ` · ${source.variant}` : ''}</small></div>{source.tutorialAvailable&&<button className="help-source-link" onClick={()=>setOpenSource(openSource===source.id?null:source.id)}><BookOpen size={15}/>{openSource===source.id?'Masquer le tutoriel':'Voir le tutoriel'}</button>}</div>;
          }
          return <div key={`${entry.name}-${index}`}><FileSpreadsheet size={19}/><div><b>{entry.name}</b><small>{entry.format}{entry.freshness?` · ${entry.freshness}`:''}</small>{entry.note&&<em>{entry.note}</em>}</div></div>;
        })}</div><p className="help-data-rule">Une donnée absente n’est pas reconstituée par Vigie. Vérifier la date, l’exercice et la source avant toute comparaison.</p></section>
        {spec.vigilance?.length&&<section className="help-learning-section help-vigilance"><h3><AlertTriangle size={17}/> Points de vigilance</h3><ul>{spec.vigilance.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}
        {spec.nextActions?.length&&<section className="help-learning-section help-next-actions"><h3><ArrowRight size={17}/> Que faire ensuite ?</h3><ul>{spec.nextActions.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}
        {tutorialSources.length>0 ? tutorialSources.map(id => openSource===id ? <OpaleGuide key={id} source={OPALE_HELP_REGISTRY[id]}/> : null) : <section className="help-placeholder"><BookOpen size={20}/><div><b>Tutoriel OP@LE</b><p>{spec.notes?.[0]||'Aucun tutoriel OP@LE validé pour cette vue.'}</p></div><ChevronRight size={18}/></section>}
      </div>
    </aside></div>}
  </>;
}
