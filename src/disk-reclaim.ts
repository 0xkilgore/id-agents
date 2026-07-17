import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SCRATCH_CAP_BYTES, SCRATCH_TTL_MS, scratchRoot } from "./scratch-policy.js";

export interface DiskReclaimOptions { env?: NodeJS.ProcessEnv; dryRun?: boolean; nowMs?: number; root?: string; capBytes?: number; ttlMs?: number; homeDir?: string; checkoutRoots?: string[]; }
export interface ReclaimItem { kind: "scratch_ttl" | "scratch_over_cap" | "next_output" | "playwright_cache"; path: string; action: "removed" | "would_remove" | "kept"; reason: string; bytes: number; }
export interface DiskReclaimResult { schema_version: "disk-reclaim.v2"; dry_run: boolean; started_at: string; scratch_root: string; cap_bytes: number; before_bytes: number; after_bytes: number; scanned: number; removed: number; reclaimed_bytes: number; reclaimed_gib: number; items: ReclaimItem[]; }

function stat(p: string) { try { return fs.lstatSync(p); } catch { return null; } }
function size(p: string): number { const s=stat(p); if(!s) return 0; if(!s.isDirectory()||s.isSymbolicLink()) return s.size; let n=s.size; try { for(const e of fs.readdirSync(p)) n+=size(path.join(p,e)); } catch {} return n; }
function inUse(p: string): boolean { const r=spawnSync("/usr/sbin/lsof", ["+D",p], {stdio:"ignore",timeout:15_000}); return r.status===0; }
function remove(p:string,dry:boolean){ if(dry)return true; try{fs.rmSync(p,{recursive:true,force:true});return true}catch{return false} }
function oldestMtime(p:string):number { const s=stat(p); return s?.mtimeMs ?? 0; }
function topLevel(root:string):string[]{ const out:string[]=[]; try{for(const area of fs.readdirSync(root)){const a=path.join(root,area);if(!stat(a)?.isDirectory())continue;for(const e of fs.readdirSync(a))out.push(path.join(a,e));}}catch{}return out; }
function addRemoval(items:ReclaimItem[],kind:ReclaimItem["kind"],p:string,reason:string,dry:boolean){const bytes=size(p);const ok=!inUse(p)&&remove(p,dry);items.push({kind,path:p,action:ok?(dry?"would_remove":"removed"):"kept",reason:ok?reason:"open by a process or removal failed",bytes});return ok?bytes:0;}

export function runSafeDiskReclaim(options: DiskReclaimOptions = {}): DiskReclaimResult {
  const env=options.env??process.env, dry=options.dryRun===true||/^(1|true|yes)$/i.test(env.MANAGER_DISK_RECLAIM_DRY_RUN??"");
  const now=options.nowMs??Date.now(), root=path.resolve(options.root??scratchRoot(env)), cap=options.capBytes??SCRATCH_CAP_BYTES, ttl=options.ttlMs??SCRATCH_TTL_MS;
  fs.mkdirSync(root,{recursive:true,mode:0o700}); const items:ReclaimItem[]=[]; const before=size(root); let current=before;
  const entries=topLevel(root).sort((a,b)=>oldestMtime(a)-oldestMtime(b));
  for(const p of entries) if(now-oldestMtime(p)>ttl) current-=addRemoval(items,"scratch_ttl",p,`untouched for more than ${ttl/3600000}h`,dry);
  if(current>cap) for(const p of entries){if(current<=cap||!stat(p))continue;current-=addRemoval(items,"scratch_over_cap",p,"oldest-first eviction above 30 GiB cap",dry);}
  const nextAge=24*3600000; for(const base of options.checkoutRoots??[]){let dirs:string[]=[];try{dirs=fs.readdirSync(base).map(e=>path.join(base,e,".next"));}catch{}for(const p of dirs){const s=stat(p);if(s?.isDirectory()&&now-s.mtimeMs>nextAge*1000)addRemoval(items,"next_output",p,"non-serving checkout .next older than 24h",dry);}}
  for(const p of [path.join(options.homeDir??os.homedir(),".cache/ms-playwright"),path.join(options.homeDir??os.homedir(),"Library/Caches/ms-playwright")]) if(size(p)>2*1024**3)addRemoval(items,"playwright_cache",p,"Playwright cache exceeded 2 GiB",dry);
  const reclaimed=items.filter(i=>i.action!=="kept").reduce((n,i)=>n+i.bytes,0);
  return {schema_version:"disk-reclaim.v2",dry_run:dry,started_at:new Date(now).toISOString(),scratch_root:root,cap_bytes:cap,before_bytes:before,after_bytes:Math.max(0,before-reclaimed),scanned:entries.length,removed:items.filter(i=>i.action!=="kept").length,reclaimed_bytes:reclaimed,reclaimed_gib:Math.round(reclaimed/1024**3*100)/100,items};
}
