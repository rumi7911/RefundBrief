export type RelationRole = 'supports' | 'conflicts' | 'context';
export type Disposition = 'unresolved' | 'evidence_resolved' | 'owner_judgement' | 'not_material';
export interface RelationInput { sourceId:string; quote:string; role:RelationRole; offset?:number }
export interface IssueInput { id:string; title:string; why:string; missing:string[]; relations:RelationInput[]; material?:boolean }
export interface EvidenceRelation extends RelationInput { offset:number; sourceHash:string; sourceTitle:string; caseRevision:number }
export interface IssueDefinition { id:string; title:string; why:string; missing:string[]; relations:EvidenceRelation[]; material:boolean }
export interface ReviewInput { interpretation:string; disposition:Disposition; consideredRelations:number[]; resolvedBy?:number|null }
export interface OwnerReview extends ReviewInput { reviewContractVersion?:number; id:string; issueRecordId:string; createdAt:string; resolvedBy:number|null }
export interface LedgerIssue extends IssueDefinition { recordId:string; version:number; origin:'model'|'owner'|'carried'; carriedFrom?:string; caseRevision:number; briefVersion:number; review:OwnerReview|null }
export interface LedgerView { reviewContractVersion?:number; enabled:boolean; version:number; issues:LedgerIssue[]; history:LedgerIssue[]; reviews?:OwnerReview[]; stale:boolean }
export interface LedgerBinding { caseRevision:number; briefVersion:number; ledgerVersion:number }
export interface SnapshotSource { id:string; title:string; text:string; kind?:string; hash:string }
export interface DecisionEvidence { reviewContractVersion?:number; basisHash?:string; caseRevision:number; briefVersion:number; ledgerVersion:number; sources:SnapshotSource[]; issues:LedgerIssue[]; unresolvedIssueIds:string[] }
