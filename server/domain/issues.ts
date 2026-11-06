import { createHash } from 'node:crypto';
import type { SourceDoc } from './citations.ts';
import type { IssueDefinition, OwnerReview, ReviewInput } from '../../shared/ledger';

export class IssueError extends Error { code='ISSUE_INVALID'; constructor(message:string,code='ISSUE_INVALID'){super(message);this.code=code;} }
export function sourceDigest(source:SourceDoc & {kind?:string}):string {
 return createHash('sha256').update(JSON.stringify({id:source.id,title:source.title,kind:source.kind??'',text:source.text})).digest('hex');
}
function object(value:unknown,keys:string[],name:string):Record<string,any>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new IssueError(`${name} must be an object.`);
 const x=value as Record<string,any>;
 if(Object.keys(x).some(k=>!keys.includes(k)))throw new IssueError(`${name} contains unsupported fields.`);
 return x;
}
function text(value:unknown,max:number,name:string):string {
 if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new IssueError(`${name} must be nonempty and at most ${max} characters.`);
 return value.trim();
}
export function validateIssues(raw:unknown,sources:SourceDoc[],caseRevision:number):IssueDefinition[]{
 if(!Array.isArray(raw)||raw.length<1||raw.length>8)throw new IssueError('Provide between one and eight focused issues.');
 const ids=new Set<string>();
 return raw.map(value=>{
  const x=object(value,['id','title','why','missing','relations','material'],'Issue');
  const id=text(x.id,80,'Issue id');
  if(!/^[a-zA-Z0-9_-]+$/.test(id)||ids.has(id))throw new IssueError('Issue id is invalid or duplicate.'); ids.add(id);
  if(!Array.isArray(x.missing)||x.missing.length>8)throw new IssueError('Missing facts must be an array of at most eight questions.');
  if(!Array.isArray(x.relations)||x.relations.length>12)throw new IssueError('Issue relations must be an array of at most twelve passages.');
  if(x.material!==undefined&&typeof x.material!=='boolean')throw new IssueError('Materiality must be boolean.');
  const relations=x.relations.map((value:unknown)=>{
   const r=object(value,['sourceId','quote','role','offset'],'Relation');
   const source=sources.find(s=>s.id===r.sourceId);if(!source)throw new IssueError('Relation source is unavailable.');
   if(!['supports','conflicts','context'].includes(r.role))throw new IssueError('Relation role is invalid.');
   if(typeof r.quote!=='string'||!r.quote.trim()||r.quote.length>2000)throw new IssueError('Quote must be nonempty and at most 2000 characters.');
   let offset=source.text.indexOf(r.quote);
   if(r.offset!==undefined){if(!Number.isInteger(r.offset)||r.offset<0||source.text.slice(r.offset,r.offset+r.quote.length)!==r.quote)throw new IssueError('Quote offset does not match the original text.');offset=r.offset;}
   else if(offset>=0&&source.text.indexOf(r.quote,offset+1)>=0)throw new IssueError('Quote is ambiguous; choose its exact occurrence offset.');
   if(offset<0)throw new IssueError('Quote was not found verbatim in the source.');
   return {sourceId:source.id,quote:r.quote,offset,role:'context' as const,sourceHash:sourceDigest(source),sourceTitle:source.title,caseRevision};
  });
  return {id,title:text(x.title,200,'Issue title'),why:text(x.why,800,'Issue importance'),missing:x.missing.map((v:unknown)=>text(v,500,'Missing fact')),relations,material:x.material??true};
 });
}
export function validateIssueReview(raw:unknown,issue:IssueDefinition):ReviewInput & {resolvedBy:number|null}{
 const x=object(raw,['interpretation','disposition','consideredRelations','resolvedBy'],'Review');
 const interpretation=text(x.interpretation,2000,'Interpretation');
 if(!['unresolved','evidence_resolved','owner_judgement','not_material'].includes(x.disposition))throw new IssueError('Choose an owner disposition.');
 if(!Array.isArray(x.consideredRelations)||x.consideredRelations.some((v:unknown)=>!Number.isInteger(v)||Number(v)<0||Number(v)>=issue.relations.length)||new Set(x.consideredRelations).size!==x.consideredRelations.length)throw new IssueError('Considered evidence references are invalid.');
 const resolvedBy=x.resolvedBy??null;
 if(x.disposition==='evidence_resolved'&&(!Number.isInteger(resolvedBy)||!x.consideredRelations.includes(resolvedBy)||!issue.relations[resolvedBy]))throw new IssueError('An owner conclusion requires a specific considered linked passage.');
 if(issue.relations.some((_,i)=>!x.consideredRelations.includes(i)))throw new IssueError('Consider each listed passage before recording a review.');
 if(x.disposition!=='evidence_resolved'&&resolvedBy!==null)throw new IssueError('Only an owner conclusion can name a cited passage.');
 return {interpretation,disposition:x.disposition as OwnerReview['disposition'],consideredRelations:[...x.consideredRelations],resolvedBy};
}
