import { Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getIndicator } from '../help/indicators';
import type { IndicatorId } from '../help/indicators';
import type { HelpFormula } from '../help/types';

function InlineFormula({formula}:{formula:HelpFormula}){
  if(formula.expression)return <div className="indicator-info-equation">{formula.expression}</div>;
  return <div className="indicator-info-equation"><span className="indicator-info-fraction"><span>{formula.numerator}</span><span>{formula.denominator}</span></span>{formula.suffix&&<span>{formula.suffix}</span>}</div>;
}

/** Accès ponctuel au même référentiel que l'aide contextuelle. */
export function IndicatorInfo({id,label}:{id:IndicatorId;label?:string}){
  const [open,setOpen]=useState(false),root=useRef<HTMLSpanElement>(null),indicator=getIndicator(id);
  useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(root.current&&!root.current.contains(e.target as Node))setOpen(false)};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close)},[open]);
  return <span className="indicator-info" ref={root}>
    <button type="button" className="indicator-info-trigger" aria-label={`Définition : ${label||indicator.name}`} aria-expanded={open} onClick={e=>{e.stopPropagation();setOpen(v=>!v)}}><Info size={13}/></button>
    {open&&<span className="indicator-info-popover" role="note" onClick={e=>e.stopPropagation()}>
      <span className="indicator-info-title"><b>{indicator.name}</b>{indicator.short&&<em>{indicator.short}</em>}</span>
      <span className="indicator-info-meaning">{indicator.meaning}</span>
      {indicator.formula&&<InlineFormula formula={indicator.formula}/>}
      {indicator.reading&&<span className="indicator-info-reading"><b>Lecture</b>{indicator.reading}</span>}
      {indicator.caution&&<span className="indicator-info-caution"><b>Attention</b>{indicator.caution}</span>}
      {indicator.source&&<small>Référence : {indicator.source}</small>}
    </span>}
  </span>;
}
