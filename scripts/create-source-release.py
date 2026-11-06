#!/usr/bin/env python3
"""Build a source-only, allowlisted local candidate. Never publishes or updates CURRENT."""
from pathlib import Path
import argparse, hashlib, json, tarfile, io, datetime
parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
paths=[root/p for p in ['README.md','LICENSE','.gitignore','app.env.example','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','scripts/ledger-review-workspace.ts','scripts/create-source-release.py','docs/demo-claims.md','docs/judge-runbook.md','docs/public-verification.md','docs/sandbox-setup.md','docs/chatgpt-setup.md','public/brand/refundbrief-return-r.png']]
for folder in ['server','src','shared']:
 paths.extend(p for p in (root/folder).rglob('*') if p.is_file() and p.suffix in ['.ts','.tsx','.css'])
paths.extend(root/'fixtures/judge-policy-conflict'/name for name in ['original-source-packet.json','original-model-output.txt','neutral-fixture.json','transformation-manifest.json'])
paths=sorted(set(paths))
for p in paths:
 if not p.is_file() or p.is_symlink() or root not in p.resolve().parents:raise SystemExit('Missing or unsafe allowlisted path: '+str(p.relative_to(root)))
contents={str(p.relative_to(root)):p.read_bytes() for p in paths}
# Compare actual private credential values without displaying any value.
private_values=[]
env=root/'app.env.local'
if env.exists():
 for line in env.read_text().splitlines():
  key,sep,value=line.partition('=')
  if sep and key.strip() in ['PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','PAYPAL_MERCHANT_ID','REFUNDBRIEF_AI_KEY']:
   value=value.strip().strip('"\'')
   if len(value)>=8:private_values.append(value.encode())
def credentials(obj):
 if isinstance(obj,dict):
  for key,value in obj.items():
   if key.lower() in ['access','refresh','idtoken','access_token','refresh_token','id_token'] and isinstance(value,str) and len(value)>=12:private_values.append(value.encode())
   credentials(value)
 elif isinstance(obj,list):
  for value in obj:credentials(value)
connection=root/'.data/chatgpt.json'
if connection.exists():credentials(json.loads(connection.read_text()))
for name,data in contents.items():
 if any(value in data for value in private_values):raise SystemExit('Private credential match in allowlisted file: '+name)
manifest={'kind':'local source candidate; no publication','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':{name:hashlib.sha256(data).hexdigest() for name,data in contents.items()},'fixtureManifestSha256':hashlib.sha256(contents['fixtures/judge-policy-conflict/transformation-manifest.json']).hexdigest(),'excluded':'Environment secrets, all databases/backups/owner histories, raw account/provider diagnostics, research/reference captures and unrelated evidence. Explicit allowlist only.'}
contents['SOURCE-MANIFEST.json']=(json.dumps(manifest,indent=2)+'\n').encode()
archive=Path(args.output).resolve()
if archive.exists():raise SystemExit('Refusing to overwrite an existing source candidate.')
archive.parent.mkdir(parents=True,exist_ok=True)
with tarfile.open(archive,'w:gz') as tar:
 for name,data in contents.items():
  entry=tarfile.TarInfo('refundbrief/'+name);entry.size=len(data);entry.mode=0o644;entry.mtime=0
  tar.addfile(entry,io.BytesIO(data))
# Review the actual archive, including member types/paths and all hash inputs.
with tarfile.open(archive,'r:gz') as tar:
 if {m.name for m in tar.getmembers()}!={'refundbrief/'+p for p in contents}:raise SystemExit('Archive allowlist mismatch.')
 for m in tar.getmembers():
  if not m.isfile() or tar.extractfile(m).read()!=contents[m.name.removeprefix('refundbrief/')]:raise SystemExit('Archive bytes/type mismatch.')
summary={'archive':archive.name,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'manifest':archive.stem+'.manifest.json','fileCount':len(contents),'privateCredentialComparison':'PASS; no values displayed','status':'candidate; clean archive verification pending'}
manifest_path=archive.with_name(summary['manifest']);manifest_path.write_text(json.dumps({'candidate':summary,'source':manifest},indent=2)+'\n')
print(json.dumps(summary,indent=2))
