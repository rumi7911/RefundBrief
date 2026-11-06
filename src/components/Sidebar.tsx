import { useEffect, useRef, useState } from 'react';
import { Plus, Folder, ChevronRight, X } from 'lucide-react';
import type { CaseSummary } from '../types';
export function Sidebar(props:{demoMode?:boolean;cases:CaseSummary[];activeId:string|null;onSelect:(id:string)=>void;onNew:()=>void}) {
 const [open,setOpen]=useState(false);
 const trigger=useRef<HTMLButtonElement>(null);
 const chooser=useRef<HTMLDivElement>(null);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(open)chooser.current?.querySelector<HTMLButtonElement>('button[aria-current="true"],button')?.focus();},[open]);
 return <aside className="sidebar"><button ref={trigger} className="rail-control" aria-expanded={open} aria-controls="case-chooser" onClick={()=>setOpen(!open)}><span className="rail-icon"><Folder size={22} aria-hidden/></span>Cases</button>{!props.demoMode&&<button className="rail-control" onClick={props.onNew}><span className="rail-icon"><Plus size={22} aria-hidden/></span>New case</button>}
 <div ref={chooser} id="case-chooser" className={`case-chooser${open?' open':''}`} hidden={!open} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}}}><div className="section-heading"><h2>Cases</h2><button className="linkbtn" aria-label="Close case chooser" onClick={close}><X size={18} aria-hidden/></button></div><ul className="caselist">{props.cases.map(c=><li key={c.id}><button className={`caseitem${c.id===props.activeId?' active':''}`} aria-current={c.id===props.activeId?'true':undefined} onClick={()=>{props.onSelect(c.id);close();}}><span><span className="title">{c.title}</span><span className="meta">{c.amountFormatted===null?'Payment unverified':`£${c.amountFormatted}`} · {c.isSample?'Local simulation':'Sandbox case'}</span></span><ChevronRight size={16} aria-hidden/></button></li>)}</ul></div><div className="rail-foot">Owner<br/>workspace</div></aside>;
}
