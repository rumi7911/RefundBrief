import { Settings, LayoutGrid, CircleHelp } from "lucide-react";
import type { StatusDto } from "../types";
export function Header(props: {tab:'workspace'|'how'|'settings';onTab:(t:'workspace'|'how'|'settings')=>void;status:StatusDto|null}) {
 return <header className="topbar"><a href="#" className="brand-link" aria-label="RefundBrief cases" onClick={e=>{e.preventDefault();props.onTab('workspace');}}><img src="/brand/refundbrief-return-r.png" alt="RefundBrief" /></a><nav aria-label="Primary">
 <button className={props.tab==='workspace'?'active':''} onClick={()=>props.onTab('workspace')}><LayoutGrid size={16} aria-hidden/> Cases</button>
 <button className={props.tab==='how'?'active':''} onClick={()=>props.onTab('how')}><CircleHelp size={16} aria-hidden/> How it works</button>
 <button className={props.tab==='settings'?'active':''} onClick={()=>props.onTab('settings')}><Settings size={16} aria-hidden/> Settings</button>
 </nav><span className="sandbox-label">{props.status?.demoMode?'Stored AI output · payments simulated':<>PayPal Sandbox{props.status&&!props.status.paypal.configured?' · not connected':''}</>}</span></header>;
}
