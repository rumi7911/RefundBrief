import { useEffect, useRef, type ReactNode } from 'react';

/** Keep keyboard interaction in the active dialog and restore its trigger. */
export function ModalFrame({labelledBy,onClose,busy=false,children,initialFocusId}:{labelledBy:string;onClose:()=>void;busy?:boolean;children:ReactNode;initialFocusId?:string}) {
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(typeof document==='undefined')return;
  const previous=document.activeElement as HTMLElement|null;
  const first=root.current?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)');
  const initial=initialFocusId?document.getElementById(initialFocusId):null;
  (initial??first??root.current)?.focus({preventScroll:true});
  if(initial)root.current?.querySelector('.modal')?.scrollTo(0,0);
  const containFocus=(event:FocusEvent)=>{if(root.current&&!root.current.contains(event.target as Node))root.current.focus();};
  document.addEventListener('focusin',containFocus);
  return ()=>{document.removeEventListener('focusin',containFocus);if(previous?.isConnected)previous.focus();};
 },[]);
 useEffect(()=>{
  if(typeof document==='undefined'||!root.current)return;
  const active=document.activeElement as HTMLElement|null;
  if(!root.current.contains(active)||active?.matches(':disabled'))root.current.focus();
 },[busy]);
 return <div ref={root} className="overlay" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} onKeyDown={event=>{
  if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
  if(event.key!=='Tab')return;
  const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')??[]).filter(el=>el.getClientRects().length>0);
  if(!nodes.length){event.preventDefault();return;}
  const first=nodes[0],last=nodes[nodes.length-1];
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===root.current||document.activeElement?.id===initialFocusId)){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }}>{children}</div>;
}
