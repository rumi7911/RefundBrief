import { act, create } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import { BriefPanel } from '../src/components/BriefPanel';

test('selecting an uncited question never attributes a timeline quotation to it', async () => {
  const focus = vi.fn();
  let view: ReturnType<typeof create>;
  await act(async () => { view = create(<BriefPanel brief={{version:1,kind:'example',caseRevision:1,stale:false,data:{summary:'Cancellation review',timeline:[{title:'Cancellation recorded',detail:'Receipt time absent',occurredAt:null,citations:[{sourceId:'s1',quote:'Time unknown',offset:0}]}],uncertainties:[],questions:['Which policy applied?']}}} sources={[{id:'s1',title:'Booking record',kind:'note',text:'Time unknown'}]} aiEnabled={false} aiReason={null} exampleAvailable={false} busy={false} onGenerate={()=>{}} onLoadExample={()=>{}} onFocusCitation={focus} />); });
  const question = view!.root.findAllByType('button').find(b=>b.props['data-review-item']==='question-0');
  expect(question).toBeDefined();
  await act(async()=>question!.props.onClick());
  const output=JSON.stringify(view!.toJSON());
  expect(output).toContain('No citation was supplied for this question.');
  expect(focus).not.toHaveBeenCalled();
  await act(async()=>view!.unmount());
});
