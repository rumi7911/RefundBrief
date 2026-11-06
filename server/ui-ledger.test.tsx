import { act, create } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import { LedgerPanel } from '../src/components/LedgerPanel';
const issue={id:'policy',recordId:'row1',version:1,origin:'model' as const,caseRevision:1,briefVersion:1,title:'Which policy applied?',why:'Thirty hours lies between thresholds',material:true,missing:['Accepted version'],relations:[{sourceId:'a',quote:'48 hours',offset:0,role:'supports' as const,sourceHash:'hash',sourceTitle:'Policy A',caseRevision:1},{sourceId:'b',quote:'24 hours',offset:0,role:'conflicts' as const,sourceHash:'hash2',sourceTitle:'Policy B',caseRevision:1}],review:null};
test('owner sees competing passages, unknown acceptance and an unsaved review',async()=>{
 const save=vi.fn();let view:ReturnType<typeof create>;
 await act(async()=>{view=create(<LedgerPanel detail={{id:'c',revision:1,briefVersion:1,sources:[],ledger:{enabled:true,version:1,issues:[issue],history:[issue],stale:false}} as any} busy={false} onSaveIssue={vi.fn()} onReview={save} onGenerate={vi.fn()} aiEnabled={false} onFocusCitation={vi.fn()}/>);});
 const json=JSON.stringify(view!.toJSON());expect(json).toContain('48 hours');expect(json).toContain('24 hours');expect(json).toContain('Accepted version');
 const button=view!.root.findAllByType('button').find(b=>b.props['data-save-review']);expect(button?.props.disabled).toBe(true);
 expect(save).not.toHaveBeenCalled();await act(async()=>view!.unmount());
});

test('an issue-editor save failure preserves the typed question for recovery',async()=>{
 let view:ReturnType<typeof create>;const save=vi.fn().mockResolvedValue(false);
 await act(async()=>{view=create(<LedgerPanel detail={{id:'c',revision:1,briefVersion:1,sources:[],ledger:{enabled:true,version:1,issues:[issue],history:[issue],stale:false}} as any} busy={false} onSaveIssue={save} onReview={vi.fn()} onGenerate={vi.fn()} aiEnabled={false} onFocusCitation={vi.fn()}/>);});
 await act(async()=>view!.root.findAllByType('button').find(b=>b.children.some(c=>typeof c==='string'&&c.includes('Add an issue')))!.props.onClick());
 await act(async()=>{view!.root.findAllByType('input').find(n=>n.props.maxLength===200)!.props.onChange({target:{value:'Owner question must survive'}});view!.root.findAllByType('textarea').find(n=>n.props.maxLength===800)!.props.onChange({target:{value:'A material missing record'}});});
 await act(async()=>view!.root.findAllByType('button').find(b=>b.children.includes('Save issue version'))!.props.onClick());
 expect(view!.root.findAllByProps({role:'dialog'})).toHaveLength(1);expect(JSON.stringify(view!.toJSON())).toContain('Owner question must survive');await act(async()=>view!.unmount());
});

test('a prepared approval stays on the refund confirmation path after refresh',async()=>{
 const {DecisionPanel}=await import('../src/components/DecisionPanel');let view:ReturnType<typeof create>;
 await act(async()=>{view=create(<DecisionPanel detail={{id:'c',isSample:true,revision:1,briefVersion:1,operations:[],approval:{token:'t',amountFormatted:'1.00',purpose:'QA',expiresAt:'2026-11-05T00:00:00Z'},ledger:{enabled:true,version:2,issues:[{...issue,review:{interpretation:'Unknown',disposition:'unresolved'}}],stale:false},brief:{stale:false}} as any} busy={false} onPrepare={vi.fn()} onConfirm={vi.fn()} onReconcile={vi.fn()} onRecordDecision={vi.fn()}/>);});
 expect(view!.root.findByProps({id:'outcome'}).props.value).toBe('refund');expect(JSON.stringify(view!.toJSON())).toContain('Confirm simulated refund');await act(async()=>view!.unmount());
});

test('current relations are neutral and conclusion can select any passage; historical labels remain explicit',async()=>{
 let view:ReturnType<typeof create>;
 const legacy={...issue,review:{id:'old',issueRecordId:'row1',createdAt:'2026-11-03',interpretation:'Old rationale',disposition:'evidence_resolved',consideredRelations:[0,1],resolvedBy:0}};
 await act(async()=>{view=create(<LedgerPanel detail={{id:'c',revision:1,briefVersion:1,sources:[],ledger:{enabled:true,version:1,reviewContractVersion:2,issues:[issue],history:[legacy],reviews:[legacy.review],stale:false}} as any} busy={false} onSaveIssue={vi.fn()} onReview={vi.fn()} onGenerate={vi.fn()} aiEnabled={false} onFocusCitation={vi.fn()}/>);});
 const json=JSON.stringify(view!.toJSON());expect(json).toContain('Linked source passage');expect(json).not.toContain('Proposed conflicts');expect(json).toContain('Historical contract 1');
 const option=view!.root.findAllByType('option').find(n=>n.props.value==='evidence_resolved')!;expect(option.props.disabled).toBe(false);
 await act(async()=>view!.root.findByType('select').props.onChange({target:{value:'evidence_resolved'}}));
 expect(view!.root.findAllByType('select')[1].findAllByType('option')).toHaveLength(3);
 await act(async()=>view!.root.findByProps({'aria-label':'Edit selected issue'}).props.onClick());
 expect(JSON.stringify(view!.toJSON())).not.toContain('Proposed relationship to the issue');await act(async()=>view!.unmount());
});

test('unsaved review survives issue switches but cannot cross ledger epochs or cases',async()=>{
 let view:ReturnType<typeof create>;const other={...issue,id:'other',recordId:'row2',title:'Other issue'};
 const detail=(id='c',version=1)=>({id,revision:1,briefVersion:1,sources:[],ledger:{enabled:true,version,issues:[issue,other],history:[],stale:false}} as any);
 const render=(d:any)=><LedgerPanel detail={d} busy={false} onSaveIssue={vi.fn()} onReview={vi.fn()} onGenerate={vi.fn()} aiEnabled={false} onFocusCitation={vi.fn()}/>;
 await act(async()=>{view=create(render(detail()));});
 await act(async()=>view!.root.findAllByType('textarea')[0].props.onChange({target:{value:'Unsaved reasoning'}}));
 await act(async()=>view!.root.findAllByType('button').filter(b=>b.props.className?.includes('review-item'))[1].props.onClick());
 await act(async()=>view!.root.findAllByType('button').filter(b=>b.props.className?.includes('review-item'))[0].props.onClick());
 expect(view!.root.findAllByType('textarea')[0].props.value).toBe('Unsaved reasoning');
 await act(async()=>view!.update(render(detail('c',2))));expect(view!.root.findAllByType('textarea')[0].props.value).toBe('');
 await act(async()=>view!.root.findAllByType('textarea')[0].props.onChange({target:{value:'Case c only'}}));
 await act(async()=>view!.update(render(detail('different',2))));expect(view!.root.findAllByType('textarea')[0].props.value).toBe('');
 await act(async()=>view!.unmount());
});
