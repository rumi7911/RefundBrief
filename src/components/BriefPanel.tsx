import { useState } from "react";
import { AlertTriangle, ArrowUpRight, FileStack, RefreshCw } from "lucide-react";
import type { BriefDto, SourceDto } from "../types";

type Props = {
  brief: BriefDto | null; sources: SourceDto[]; aiEnabled: boolean; aiReason: string | null;
  exampleAvailable: boolean; busy: boolean; onGenerate: () => void; onLoadExample: () => void;
  onFocusCitation: (sourceId: string, quote: string) => void;
};
export function BriefPanel(props: Props) {
  const { brief } = props;
  const items = brief ? [
    ...brief.data.questions.map((text,i)=>({id:`question-${i}`,title:text,kind:'question' as const,index:i})),
    ...brief.data.uncertainties.map((text,i)=>({id:`uncertainty-${i}`,title:text,kind:'uncertainty' as const,index:i})),
    ...brief.data.timeline.map((t,i)=>({id:`fact-${i}`,title:t.title,kind:'fact' as const,index:i})),
  ] : [];
  const [selected, setSelected] = useState<string | null>(null);
  const current = items.find(item=>item.id===selected) ?? items[0];
  const entry = current?.kind==='fact' ? brief?.data.timeline[current.index] : null;
  return <section className="review-workspace" aria-label="Evidence review">
    <div className="panel review-list">
      <div className="section-heading"><h2>Review items</h2><span className="item-count">{items.length}</span></div>
      <p className="lead">Questions, uncertainties and cited statements.</p>
      <div className="review-items">{items.map((item,i)=><button key={item.id} data-review-item={item.id} className={`review-item${current?.id===item.id?' selected':''}`} aria-pressed={current?.id===item.id} onClick={()=>setSelected(item.id)}>
        <span className="review-number">{i+1}</span><span><strong>{item.title}</strong><small>{item.kind==='fact'?'Cited statement':item.kind==='question'?'Question · inspect original sources':'Uncertainty · owner assessment needed'}</small></span><span aria-hidden>›</span>
      </button>)}</div>
      {!brief && <p className="empty-note">Add your evidence, then generate a brief or load a stored example.</p>}
      <div className="review-tools"><button className="secondary" onClick={props.onGenerate} disabled={props.busy||!props.aiEnabled} title={props.aiReason??undefined}><RefreshCw size={16} aria-hidden/> Generate review brief</button>
      {props.exampleAvailable&&<button className="linkbtn" disabled={props.busy} onClick={props.onLoadExample}><FileStack size={16} aria-hidden/> Load example brief</button>}</div>
      {!props.aiEnabled&&<p className="small muted">{props.aiReason??'Live generation is disabled. Stored examples are not new AI results.'}</p>}
    </div>
    <div className="panel review-inspector" aria-labelledby="brief-h">
      <div className="section-heading"><h2 id="brief-h">{current?.title ?? 'Inspect the evidence'}</h2></div>
      <p className="lead">{brief?.kind==='live'?'AI-generated brief · interpretation needs review':brief?'Stored example · not live AI':'No brief available'}</p>
      {brief?.stale&&<div className="callout" role="status"><AlertTriangle size={18} aria-hidden/>Evidence changed. This brief is historical; refresh before deciding.</div>}
      {entry&&<><p className="statement-detail">{entry.detail}</p>{entry.occurredAt&&<p className="small muted">Reported time: {entry.occurredAt}</p>}
        {entry.citations.map((c,i)=>{const source=props.sources.find(s=>s.id===c.sourceId);return <article className="evidence-excerpt" key={i}><div className="excerpt-heading"><strong>{source?.title??'Source unavailable'}</strong><span className="small muted">{source?.kind}</span></div><blockquote>{c.quote}</blockquote><button className="linkbtn source-open" aria-label={`Open source: ${source?.title ?? "unavailable"}, passage ${i+1}`} onClick={()=>props.onFocusCitation(c.sourceId,c.quote)}>Open source <ArrowUpRight size={16} aria-hidden/></button></article>;})}
      </>}
      {current&&current.kind!=='fact'&&<><div className="callout"><AlertTriangle size={18} aria-hidden/><span>{current.kind==='question'?'No citation was supplied for this question.':'No citation was supplied for this uncertainty.'} Inspect the original sources; the brief does not establish an answer.</span></div><p className="inspector-guidance">Use Source documents below to compare the original records. Record your assessment and any unresolved evidence in your decision reason.</p></>}
      {brief&&<details className="narrative"><summary>Read narrative summary</summary><p>{brief.data.summary}</p><p className="small muted">A quotation match establishes provenance, not whether an interpretation is correct.</p></details>}
      {!brief&&<div className="empty-inspector"><FileStack size={34} aria-hidden/><p>Your selected review item and its source passages will appear here.</p></div>}
    </div>
  </section>;
}
