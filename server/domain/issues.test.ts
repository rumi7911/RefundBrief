import { expect, test } from 'vitest';
import { validateIssues, validateIssueReview } from './issues';
const sources=[{id:'a',title:'Attachment',text:'Notice is 48 hours.'},{id:'b',title:'Website',text:'Notice is 24 hours.'}];
const raw=()=>[{id:'policy',title:'Which policy applied?',why:'Thirty hours falls between the two thresholds.',missing:['Accepted version is absent.'],relations:[{sourceId:'a',quote:'48 hours',role:'supports'},{sourceId:'b',quote:'24 hours',role:'conflicts'}]}];
test('issue relations locate opposing original passages and bind their revision/digests',()=>{
 const [issue]=validateIssues(raw(),sources,4);
 expect(issue.relations[0]).toMatchObject({sourceId:'a',quote:'48 hours',offset:10,caseRevision:4});
 expect(issue.relations[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
 expect(issue.relations.every(r=>r.role==='context')).toBe(true);
});
test('ambiguous repeated quotes require explicit occurrence, including overlapping matches',()=>{
 const duplicated=[{id:'a',title:'Repeated',text:'48 hours / 48 hours'}];
 const x=raw();x[0].relations=[{sourceId:'a',quote:'48 hours',role:'supports'}];
 expect(()=>validateIssues(x,duplicated,1)).toThrow(/ambiguous/i);
 const explicit=structuredClone(x) as any;explicit[0].relations[0].offset=11;
 expect(validateIssues(explicit,duplicated,1)[0].relations[0].offset).toBe(11);
 explicit[0].relations[0].offset=2;expect(()=>validateIssues(explicit,duplicated,1)).toThrow(/offset/i);
});
test('a discretionary reason cannot resolve missing evidence',()=>{
 const [issue]=validateIssues(raw(),sources,4);
 expect(()=>validateIssueReview({interpretation:'Goodwill despite missing terms',disposition:'evidence_resolved',consideredRelations:[0,1]},issue)).toThrow(/passage/i);
 expect(validateIssueReview({interpretation:'Goodwill despite missing terms',disposition:'owner_judgement',consideredRelations:[0,1]},issue).disposition).toBe('owner_judgement');
 expect(validateIssueReview({interpretation:'Accepted attachment found',disposition:'evidence_resolved',consideredRelations:[0,1],resolvedBy:0},issue).resolvedBy).toBe(0);
 expect(validateIssueReview({interpretation:'Owner concludes website applied',disposition:'evidence_resolved',consideredRelations:[0,1],resolvedBy:1},issue).resolvedBy).toBe(1);
 expect(()=>validateIssueReview({interpretation:'Missing consideration',disposition:'evidence_resolved',consideredRelations:[1],resolvedBy:1},issue)).toThrow(/consider/i);
});
test('missing facts have no invented citations and review needs an actual interpretation',()=>{
 const [issue]=validateIssues([{id:'time',title:'Receipt time?',why:'Interval unknown',missing:['Timestamp'],relations:[]}],sources,1);
 expect(issue.relations).toHaveLength(0);
 expect(()=>validateIssueReview({interpretation:' ',disposition:'unresolved',consideredRelations:[]},issue)).toThrow();
 expect(()=>validateIssueReview({interpretation:'No timestamp',disposition:'evidence_resolved',consideredRelations:[]},issue)).toThrow();
});
test('unrecognised or money-instruction fields cannot enter structured issues',()=>{
 expect(()=>validateIssues([{...raw()[0],recommendedAmount:'12.50'}],sources,1)).toThrow();
 expect(()=>validateIssues([{...raw()[0],relations:[{sourceId:'ghost',quote:'48 hours',role:'supports'}]}],sources,1)).toThrow();
 expect(()=>validateIssues([raw()[0],raw()[0]],sources,1)).toThrow(/duplicate/i);
});

test('neutral relation compatibility rejects invalid roles before canonicalisation and rejects client contract metadata',()=>{
 const x=raw() as any; x[0].relations[0].role='verified'; expect(()=>validateIssues(x,sources,1)).toThrow(/role/i);
 const [issue]=validateIssues(raw(),sources,1);
 expect(()=>validateIssueReview({interpretation:'Owner conclusion',disposition:'evidence_resolved',consideredRelations:[0,1],resolvedBy:1,reviewContractVersion:2},issue)).toThrow(/unsupported/i);
});
