import { act,create } from 'react-test-renderer';
import { expect,test,vi } from 'vitest';
import { Header } from '../src/components/Header';
import { Sidebar } from '../src/components/Sidebar';
import { SettingsPanel } from '../src/components/SettingsPanel';
test('demo prominently labels stored output and hides provider and real-case controls',async()=>{
 vi.stubGlobal('window',{location:{search:''}});
 const status={demoMode:true,paypal:{configured:false},ai:{enabled:false}} as any;
 let view:ReturnType<typeof create>;await act(async()=>{view=create(<><Header tab="workspace" onTab={vi.fn()} status={status}/><Sidebar cases={[]} activeId={null} onSelect={vi.fn()} onNew={vi.fn()} demoMode/><SettingsPanel status={status} onRefresh={vi.fn()}/></>);});
 const json=JSON.stringify(view!.toJSON());expect(json).toContain('Stored AI output · payments simulated');expect(json).not.toContain('Continue with ChatGPT');expect(json).not.toContain('PAYPAL_CLIENT_SECRET');expect(json).not.toContain('New case');await act(async()=>view!.unmount());vi.unstubAllGlobals();
});

test('disabled generation explains the actual capability reason',async()=>{
 const {BriefPanel}=await import('../src/components/BriefPanel');let view:ReturnType<typeof create>;
 await act(async()=>{view=create(<BriefPanel brief={null} sources={[]} aiEnabled={false} aiReason="Stored AI output · payments simulated. External services disabled in demo." exampleAvailable={false} busy={false} onGenerate={vi.fn()} onLoadExample={vi.fn()} onFocusCitation={vi.fn()}/>);});
 const json=JSON.stringify(view!.toJSON());expect(json).not.toContain('Connect Claude or OpenAI in Settings');await act(async()=>view!.unmount());
});
