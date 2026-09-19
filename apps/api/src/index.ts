import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { registerEpleTools } from './eple-tools.js';
import { treasuryContext } from './treasury.js';
import { isAccountingCsv, parseAccountingCsv } from './accounting.js';

const { Pool } = pg;
const app = Fastify({ logger: true });
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_SHEETS = 20;
const VERSION = '0.0.36';
const PCIF_BASE_URL = String(process.env.PCIF_BASE_URL || '').replace(/\/$/, '');
const PCIF_API_KEY = String(process.env.PCIF_API_KEY || '');
const PCIF_CACHE_MINUTES = Math.max(1, Number(process.env.PCIF_CACHE_MINUTES || 10));
const uaiOf = (...values: unknown[]) => {
  for (const value of values) {
    const match = String(value ?? '').toUpperCase().match(/\b0?([0-9]{7}[A-Z])\b/);
    if (match) return match[0];
  }
  return null;
};

const consistencyNorm=(value:unknown)=>String(value??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const DOMAIN_ALIASES:Record<string,string[]>={
  'Budget':['budget','execution budgetaire','prevision budgetaire'],
  'Fournisseurs':['depenses','depense','achats','achat','fournisseurs','fournisseur'],
  'Comptabilité générale':['comptabilite generale','comptabilite','operations comptables'],
  'Santé financière':['sante financiere','analyse financiere','situation financiere','fonds de roulement'],
  'Trésorerie':['tresorerie','disponibilites','banque','compte 5151']
};
function pcifDomainFor(vigieDomain:string,domains:any[]){
  const aliases=DOMAIN_ALIASES[vigieDomain]||[vigieDomain];
  const wanted=aliases.map(consistencyNorm);
  return domains.find((d:any)=>{
    const label=consistencyNorm(d.label);
    return wanted.some(x=>label===x||label.includes(x)||x.includes(label));
  })||null;
}
function masteryConsistency(establishment:any,pcif:any){
  const domains=Array.isArray(pcif?.raw_payload?.domains)?pcif.raw_payload.domains:[];
  const vigieDomains=[...new Set((establishment.signals||[]).map((s:any)=>s.domain).filter(Boolean))] as string[];
  return vigieDomains.map(domain=>{
    const signals=(establishment.signals||[]).filter((s:any)=>s.domain===domain&&['watch','alert'].includes(s.level));
    const p=pcifDomainFor(domain,domains);
    if(!p)return {vigieDomain:domain,pcifDomain:null,status:'NOT_MAPPABLE',signals:signals.length,alerts:signals.filter((s:any)=>s.level==='alert').length,reasons:['Aucun domaine PCIF rapprochable automatiquement.']};
    const completion=Number(p.completion||0), mastery=p.mastery==null?null:Number(p.mastery);
    let status='COHERENT',reasons:string[]=[];
    if(completion<50){status='PCIF_INSUFFICIENT';reasons=[`Diagnostic PCIF renseigné à ${completion} % sur ce domaine.`]}
    else if(signals.length&&mastery!=null&&mastery>=75){status='REVIEW';reasons=[`Maîtrise PCIF déclarée à ${mastery} % et ${signals.length} signal${signals.length>1?'aux':' '} Vigie actif${signals.length>1?'s':''}.`]}
    else if(signals.length){reasons=['Les observations Vigie sont cohérentes avec un niveau de maîtrise PCIF qui appelle déjà une vigilance.']}
    else reasons=['Aucun signal Vigie significatif sur ce domaine.'];
    return {vigieDomain:domain,pcifDomain:p.label,status,signals:signals.length,alerts:signals.filter((s:any)=>s.level==='alert').length,mastery,completion,reasons};
  });
}

async function syncPcifSummaries(uais: string[]) {
  const wanted = [...new Set(uais.filter(Boolean))];
  if (!PCIF_BASE_URL || !PCIF_API_KEY || !wanted.length) return { configured:false, synced:0, skipped:wanted.length };
  const response = await fetch(`${PCIF_BASE_URL}/api/integrations/vigie/summaries`, {
    method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${PCIF_API_KEY}`},
    body:JSON.stringify({uais:wanted}), signal:AbortSignal.timeout(6000)
  });
  if (!response.ok) throw new Error(`PCIF Académie : HTTP ${response.status}`);
  const payload:any = await response.json();
  const summaries:any[] = Array.isArray(payload) ? payload : (payload.summaries || payload.establishments || []);
  let synced=0;
  for (const x of summaries) {
    const uai=uaiOf(x.uai,x.establishment?.uai); if(!uai) continue;
    const campaign=x.campaign||{}, mastery=x.mastery||{}, risks=x.risks||{}, actions=x.actions||{};
    await pool.query(`insert into pcif_context(establishment_key,uai,campaign_label,campaign_status,mastery_level,mastery_scale,completion,answered,total,open_actions,major_risks,overdue_actions,trend,attention,source_url,raw_payload,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,now())
      on conflict(establishment_key) do update set uai=excluded.uai,campaign_label=excluded.campaign_label,campaign_status=excluded.campaign_status,mastery_level=excluded.mastery_level,mastery_scale=excluded.mastery_scale,completion=excluded.completion,answered=excluded.answered,total=excluded.total,open_actions=excluded.open_actions,major_risks=excluded.major_risks,overdue_actions=excluded.overdue_actions,trend=excluded.trend,attention=excluded.attention,source_url=excluded.source_url,raw_payload=excluded.raw_payload,updated_at=now()`,
      [uai,uai,campaign.label||campaign.id||x.campaign_label||null,campaign.status||null,mastery.level??x.mastery_level??null,mastery.scale||'PERCENT',mastery.completion??0,mastery.answered??0,mastery.total??0,actions.open??x.open_actions??0,risks.major??x.major_risks??0,actions.overdue??x.overdue_actions??0,mastery.trend??x.trend??null,JSON.stringify(x.attention||[]),x.sourceUrl||x.source_url||`${PCIF_BASE_URL}/`,JSON.stringify(x)]);
    synced++;
  }
  return {configured:true,synced,received:summaries.length};
}


await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE, files: 1 } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://vigie:vigie@127.0.0.1:5432/vigie' });
type AuthUser={id:number;email:string;firstName:string;lastName:string;globalRole:'ADMIN'|'USER';agencies:{id:number;name:string;role:string}[]};
const SESSION_COOKIE='vigie_session';
const SESSION_DAYS=Math.max(1,Number(process.env.VIGIE_SESSION_DAYS||1));
const cookieValue=(header:string|undefined,name:string)=>{for(const part of String(header||'').split(';')){const [k,...v]=part.trim().split('=');if(k===name)return decodeURIComponent(v.join('='));}return null};
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const passwordHash=(password:string)=>{const salt=randomBytes(16);const key=scryptSync(password,salt,64);return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`};
const passwordOk=(password:string,stored:string)=>{try{const [,saltHex,keyHex]=stored.split('$');const expected=Buffer.from(keyHex,'hex'),actual=scryptSync(password,Buffer.from(saltHex,'hex'),expected.length);return expected.length===actual.length&&timingSafeEqual(expected,actual)}catch{return false}};
async function userPayload(id:number):Promise<AuthUser|null>{const u=(await pool.query('select id,email,first_name,last_name,global_role,is_active from users where id=$1',[id])).rows[0];if(!u||!u.is_active)return null;const agencies=(await pool.query(`select a.id,a.name,r.role from user_agency_roles r join accounting_agencies a on a.id=r.accounting_agency_id where r.user_id=$1 and a.is_active order by a.name`,[id])).rows;return {id:Number(u.id),email:u.email,firstName:u.first_name||'',lastName:u.last_name||'',globalRole:u.global_role,agencies:agencies.map((a:any)=>({id:Number(a.id),name:a.name,role:a.role}))}};
async function authenticate(req:any){const raw=cookieValue(req.headers.cookie,SESSION_COOKIE);if(!raw)return null;const row=(await pool.query(`select s.user_id from auth_sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at>now() and u.is_active`,[tokenHash(raw)])).rows[0];if(!row)return null;await pool.query('update auth_sessions set last_seen_at=now() where token_hash=$1',[tokenHash(raw)]);return userPayload(Number(row.user_id))}
function setSessionCookie(reply:any,token:string,maxAge:number){reply.header('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Secure`)}
async function audit(req:any,action:string,establishmentId:number|null=null,detail:any={}){try{await pool.query('insert into audit_log(user_id,action,establishment_id,detail,ip_address) values($1,$2,$3,$4,$5)',[req.user?.id||null,action,establishmentId,JSON.stringify(detail),req.ip])}catch(e){app.log.warn({e},'Audit non bloquant impossible')}}
async function bootstrapAdmin(){const n=Number((await pool.query('select count(*) n from users')).rows[0].n);if(n)return;const email=String(process.env.VIGIE_ADMIN_EMAIL||'').trim().toLowerCase(),password=String(process.env.VIGIE_ADMIN_PASSWORD||'');if(!email||password.length<12){app.log.error('Aucun utilisateur Vigie. Définissez VIGIE_ADMIN_EMAIL et VIGIE_ADMIN_PASSWORD (12 caractères minimum), puis redémarrez.');return}await pool.query(`insert into users(email,first_name,last_name,password_hash,global_role) values($1,'Administrateur','Vigie',$2,'ADMIN')`,[email,passwordHash(password)]);app.log.warn({email},'Compte administrateur initial créé. Retirez VIGIE_ADMIN_PASSWORD de /etc/vigie.env après la première connexion.');}
await bootstrapAdmin();

app.post('/api/auth/login',async(req:any,reply:any)=>{const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');const u=(await pool.query('select id,password_hash,is_active from users where lower(email)=$1',[email])).rows[0];if(!u||!u.is_active||!passwordOk(password,u.password_hash)){await new Promise(r=>setTimeout(r,250));return reply.code(401).send({error:'Identifiants incorrects.'})}const token=randomBytes(32).toString('base64url'),maxAge=SESSION_DAYS*86400;await pool.query('delete from auth_sessions where expires_at<=now()');await pool.query(`insert into auth_sessions(user_id,token_hash,expires_at,user_agent,ip_address) values($1,$2,now()+($3||' seconds')::interval,$4,$5)`,[u.id,tokenHash(token),String(maxAge),req.headers['user-agent']||null,req.ip]);await pool.query('update users set last_login_at=now() where id=$1',[u.id]);setSessionCookie(reply,token,maxAge);req.user=await userPayload(Number(u.id));await audit(req,'LOGIN');return {ok:true,user:req.user}});
app.post('/api/auth/logout',async(req:any,reply:any)=>{const raw=cookieValue(req.headers.cookie,SESSION_COOKIE);if(raw)await pool.query('delete from auth_sessions where token_hash=$1',[tokenHash(raw)]);setSessionCookie(reply,'',0);return {ok:true}});
app.get('/api/auth/me',async(req:any,reply:any)=>{const user=await authenticate(req);return user?{user}:reply.code(401).send({error:'Authentification requise.'})});

app.addHook('onRequest',async(req:any,reply:any)=>{if(!req.url.startsWith('/api/')||req.url.startsWith('/api/auth/'))return;const user=await authenticate(req);if(!user)return reply.code(401).send({error:'Authentification requise.'});req.user=user});
registerEpleTools(app, pool, VERSION);
const isAdmin=(req:any)=>req.user?.globalRole==='ADMIN';
async function allowedEstablishments(req:any){if(isAdmin(req))return (await pool.query('select id,uai,name,opale_entity,accounting_agency_id from establishments where is_active')).rows;return (await pool.query(`select distinct e.id,e.uai,e.name,e.opale_entity,e.accounting_agency_id from establishments e join user_agency_roles r on r.accounting_agency_id=e.accounting_agency_id where r.user_id=$1 and e.is_active`,[req.user.id])).rows}
async function requireEstablishment(req:any,reply:any,ets:string){const allowed=await allowedEstablishments(req);const e=allowed.find((x:any)=>String(x.opale_entity||'').toUpperCase()===ets.toUpperCase()||String(x.uai||'').toUpperCase()===ets.toUpperCase());if(!e){reply.code(403).send({error:'Cet établissement ne fait pas partie de votre périmètre Vigie.'});return null}return e}


const num = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
function pick(row: Record<string, unknown>, names: string[]) {
  const map = Object.fromEntries(Object.keys(row).map(k => [norm(k), k]));
  for (const n of names) { const k = map[norm(n)]; if (k) return row[k]; }
  return undefined;
}
function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? '';
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map(x => x.text ?? '').join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('error' in v) return String(v.error);
  }
  return String(v);
}
function rowsToObjects(matrix: unknown[][]) {
  if (matrix.length < 2) throw new Error('Le fichier ne contient aucune ligne exploitable.');
  const headers = matrix[0].map(v => String(v ?? '').trim());
  return matrix.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h || `col_${i + 1}`, values[i] ?? ''])));
}
function decodeLis(buf: Buffer) {
  // Les exports .lis observés sont du JSON-like Op@le encodé Windows-1252.
  // Certains intitulés contiennent des guillemets non échappés : on ne dépend donc
  // volontairement pas de JSON.parse pour extraire les objets de comptes.
  const utf = buf.toString('utf8');
  return utf.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(buf) : utf;
}
function lisString(objectText: string, key: string) {
  const marker = `"${key}":`;
  const pos = objectText.indexOf(marker);
  if (pos < 0) return '';
  let i = pos + marker.length;
  while (/\s/.test(objectText[i] || '')) i++;
  if (objectText[i] !== '"') return '';
  i++;
  const endMarkers = ['priorDebit','priorCredit','periodDebit','periodCredit','balanceDebit','balanceCredit'];
  let end = objectText.length;
  for (const next of endMarkers) {
    const p = objectText.indexOf(`, "${next}":`, i);
    if (p >= 0 && p < end) end = p;
  }
  let value = objectText.slice(i, end).trim();
  if (value.endsWith('"')) value = value.slice(0, -1);
  return value.replace(/\\"/g, '"');
}
function lisNumber(objectText: string, key: string) {
  const m = objectText.match(new RegExp(`"${key}"\\s*:\\s*(-?[0-9]+(?:[.,][0-9]+)?)`));
  return m ? num(m[1]) : 0;
}
function parseLis(buf: Buffer) {
  const text = decodeLis(buf);
  // L'extension .lis est utilisée par Op@le pour plusieurs types d'exports.
  // Vigie n'accepte ici que la balance générale native.
  if (!text.includes('entitiesTrialBalance') || !text.includes('accountsTrialBalance')) {
    if (/^DATASHEET=/m.test(text) || /^DATASEPCHAR=/m.test(text)) {
      throw new Error("Fichier .lis Op@le reconnu, mais ce n'est pas une balance générale. Exportez la balance générale (entitiesTrialBalance/accountsTrialBalance).");
    }
    throw new Error("Fichier .lis non reconnu comme balance générale Op@le.");
  }
  const entity = text.match(/"entity"\s*:\s*"([^"]+)"/)?.[1] || '';
  const entityLabel = text.match(/"entityLabel"\s*:\s*"([^"]+)"/)?.[1] || '';
  const objects = text.match(/\{\s*"account"\s*:\s*"[^"]+"[\s\S]*?\}(?=\s*,|\s*\])/g) || [];
  const rows = objects.map((o, i) => {
    const account = o.match(/"account"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\s/g, '') || '';
    const label = lisString(o, 'accountTitle');
    const priorDebit = lisNumber(o, 'priorDebit');
    const priorCredit = lisNumber(o, 'priorCredit');
    const periodDebit = lisNumber(o, 'periodDebit');
    const periodCredit = lisNumber(o, 'periodCredit');
    const balanceDebit = lisNumber(o, 'balanceDebit');
    const balanceCredit = lisNumber(o, 'balanceCredit');
    return {line:i+1, account, label, priorDebit, priorCredit, periodDebit, periodCredit, debit:balanceDebit, credit:balanceCredit, net:balanceDebit-balanceCredit};
  }).filter(x => /^\d{2,}/.test(x.account));
  if (!rows.length) throw new Error('Export .lis non reconnu : aucune ligne de balance Op@le détectée.');
  return {sheet:'Op@le .lis', sourceRows:objects.length, rows, entity, entityLabel, format:'lis'};
}
async function parseInput(buf: Buffer, filename: string) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'lis') return parseLis(buf);
  if (ext === 'xls') throw new Error('Le format .xls n’est pas accepté. Utilisez de préférence l’export Op@le .lis, ou enregistrez le fichier en .xlsx/.csv.');
  if (!['xlsx', 'csv'].includes(ext || '')) throw new Error('Format non accepté. Format recommandé : .lis Op@le. Formats compatibles : .xlsx et .csv.');
  let sheet = 'CSV'; let rawRows: Record<string, unknown>[] = [];
  if (ext === 'csv') {
    rawRows = parseCsv(buf, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true });
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    if (wb.worksheets.length > MAX_SHEETS) throw new Error(`Classeur refusé : plus de ${MAX_SHEETS} feuilles.`);
    const ws = wb.worksheets.find(w => w.actualRowCount > 1) || wb.worksheets[0];
    if (!ws) throw new Error('Le classeur ne contient aucune feuille exploitable.');
    sheet = ws.name;
    const matrix: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, row => matrix.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellValue)));
    rawRows = rowsToObjects(matrix);
  }
  if (rawRows.length > MAX_ROWS) throw new Error(`Fichier refusé : plus de ${MAX_ROWS.toLocaleString('fr-FR')} lignes.`);
  if (!rawRows.length) throw new Error('Le fichier ne contient aucune ligne exploitable.');
  const parsed = rawRows.map((r, i) => {
    const account = String(pick(r, ['compte','numero compte','n° compte','num compte','compte general']) ?? '').replace(/\s/g, '');
    const label = String(pick(r, ['libelle','libellé','libelle compte','intitule','intitulé']) ?? '');
    let debit = num(pick(r, ['solde debiteur','solde débiteur','debit','débit']));
    let credit = num(pick(r, ['solde crediteur','solde créditeur','credit','crédit']));
    const balance = pick(r, ['solde','solde final']);
    if (balance !== undefined && !debit && !credit) { const b = num(balance); debit = Math.max(b, 0); credit = Math.max(-b, 0); }
    return { line:i+2, account, label, priorDebit:0, priorCredit:0, periodDebit:0, periodCredit:0, debit, credit, net:debit-credit };
  }).filter(x => /^\d{2,}/.test(x.account));
  if (!parsed.length) throw new Error('Colonnes non reconnues. Utilisez de préférence l’export natif Op@le .lis.');
  return {sheet, sourceRows:rawRows.length, rows:parsed, entity:'', entityLabel:'', format:ext};
}

function parseFrDate(v: unknown) {
  const x=String(v??'').trim(); if(!x)return null;
  const m=x.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m?`${m[3]}-${m[2]}-${m[1]}`:null;
}
function cleanOpaleCsv(v: unknown) {
  let x=String(v??'').trim(); const m=x.match(/^=\("([\s\S]*)"\)$/); if(m)x=m[1]; return x;
}
function parseBudgetLis(buf: Buffer) {
  const text=decodeLis(buf);
  if(!/^DATASHEET=Donnees/m.test(text) || !text.includes(';Budget;') || !text.includes(';Engag')) throw new Error("Ce .lis n'est pas un export Budget Op@le reconnu.");
  const lines=text.split(/\r?\n/).filter(x=>x && !/^(DATASHEET|DATASEPCHAR|ROWMODEL)=/.test(x));
  const rows:any[]=[]; let entity='', establishment='', snapshotDate='';
  for(let i=0;i<lines.length;i++){
    const c=lines[i].split(';');
    const marker=c.findIndex(x=>x==='Budget'); if(marker<5)continue;
    const meta=c.slice(marker-5,marker);
    const vals=c.slice(marker-18,marker-13).map(num);
    entity ||= String(meta[0]||c[0]||''); establishment ||= String(meta[1]||''); snapshotDate ||= parseFrDate(meta[4])||'';
    rows.push({line:i+1,dimensions:c.slice(0,Math.max(0,marker-18)),budget:vals[0],committed:vals[1],accounted:vals[2],inProgress:vals[3],available:vals[4]});
  }
  if(!rows.length)throw new Error('Export Budget Op@le reconnu mais aucune ligne budgétaire exploitable.');
  return {type:'budget',entity,establishment,snapshotDate,rows};
}

async function parseBudgetXlsx(buf:Buffer,contextEntity:string){
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(buf as any);
  const ws=wb.getWorksheet('Donnees');if(!ws)throw new Error("Classeur .xlsx non reconnu : feuille 'Donnees' absente.");
  const headerRow=ws.getRow(2);const headers=Array.from({length:ws.actualColumnCount},(_,i)=>String(cellValue(headerRow.getCell(i+1).value)||'').trim());
  const col=(name:string)=>headers.findIndex(h=>h===name)+1;
  if(col('Etablissement')!==1||col('Compte')<1||col('Montant colonne 1')<1)throw new Error('Classeur .xlsx non reconnu comme export budgétaire Op@le.');
  const metaEntity=String(cellValue(ws.getRow(3).getCell(77).value)||'').trim();
  const uai=String(cellValue(ws.getRow(3).getCell(78).value)||'').trim();
  const snapshotDate=parseFrDate(cellValue(ws.getRow(3).getCell(81).value))||new Date().toISOString().slice(0,10);
  if(metaEntity&&contextEntity&&metaEntity.toUpperCase()!==contextEntity.toUpperCase())throw new Error(`ETS incohérent : le fichier contient ${metaEntity}, alors que l’import est contextualisé sur ${contextEntity}.`);
  const amountLabels=Array.from({length:13},(_,i)=>String(cellValue(ws.getRow(3).getCell(82+i).value)||'').trim());
  const rows:any[]=[];
  for(let r=3;r<=ws.actualRowCount;r++){
    const row=ws.getRow(r),entity=String(cellValue(row.getCell(1).value)||'').trim();if(!entity)continue;
    const cgr=[] as any[],posts=[] as any[];
    for(let level=1;level<=10;level++){const base=2+(level-1)*3,code=String(cellValue(row.getCell(base).value)||'').trim(),label=String(cellValue(row.getCell(base+1).value)||'').trim();if(code)cgr.push({level,code,label:label==='_'?'':label});}
    for(let level=1;level<=10;level++){const base=32+(level-1)*3,code=String(cellValue(row.getCell(base).value)||'').trim(),label=String(cellValue(row.getCell(base+1).value)||'').trim();if(code)posts.push({level,code,label:label==='_'?'':label});}
    const account=String(cellValue(row.getCell(62).value)||'').trim(),accountLabel=String(cellValue(row.getCell(63).value)||'').trim();
    const amounts=Array.from({length:13},(_,i)=>num(cellValue(row.getCell(64+i).value)));
    if(!cgr.length&&!posts.length&&!account&&!amounts.some(Boolean))continue;
    rows.push({line:r,dimensions:{source:'opale-budget-xlsx',uai,cgr,posts,account,accountLabel,amountLabels},budget:amounts[0],committed:amounts[1],accounted:amounts[2],inProgress:amounts[3],available:amounts[4]});
  }
  if(!rows.length)throw new Error('Export Budget Op@le reconnu mais aucune ligne budgétaire exploitable.');
  return {type:'budget',entity:metaEntity||contextEntity,establishment:uai||metaEntity||contextEntity,snapshotDate,rows,sourceRows:ws.actualRowCount-2,format:'opale-budget-xlsx'};
}

function parseOpaleCsv(buf: Buffer) {
  const text=buf.toString('utf8').replace(/^\uFEFF/,'');
  return parseCsv(text,{
    columns:true, delimiter:';', bom:true, skip_empty_lines:true,
    relax_column_count:true, relax_quotes:true, trim:false, group_columns_by_name:true
  }) as any[];
}
function parseFdr(buf: Buffer) {
  const records:any[]=parseOpaleCsv(buf);
  if(!records.length) throw new Error('FDR vide.');
  const keys=Object.keys(records[0]);
  if(!keys.includes('Exercice') || !keys.includes('Montant du FDR') || !keys.includes('Définitif ?')) throw new Error('CSV non reconnu comme FDR Op@le.');
  const rows=records.map((r:any)=>{
    const ex=String(r['Exercice']??'').match(/(20\d{2})/);
    return {exercise:ex?Number(ex[1]):0,amount:num(r['Montant du FDR']),direction:String(r['Sens']??''),isFinal:String(r['Définitif ?']??'').trim().toUpperCase()==='D',establishment:String(r['Ets']??'').trim(),state:String(r['Etat']??'').trim(),sourceModifiedAt:parseFrDate(r['Modifié le'])};
  }).filter((r:any)=>r.exercise>0);
  if(!rows.length) throw new Error('FDR reconnu mais aucun exercice exploitable.');
  const establishment=rows.find((x:any)=>x.establishment)?.establishment||'Établissement non renseigné';
  return {type:'fdr',establishment,snapshotDate:new Date().toISOString().slice(0,10),rows,sourceRows:records.length};
}

const cellText=(v:any)=>{if(v==null)return '';if(typeof v==='object'){if('text' in v)return String(v.text??'');if(Array.isArray(v.richText))return v.richText.map((x:any)=>x.text||'').join('');if('result' in v)return String(v.result??'')}return String(v).trim()};
const cellNum=(v:any)=>{if(v==null||v==='')return 0;if(typeof v==='number')return Number.isFinite(v)?v:0;const n=Number(String(v).replace(/\s/g,'').replace(',','.'));return Number.isFinite(n)?n:0};
const normHeader=(v:any)=>cellText(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
async function xlsxData(buf:Buffer){
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(buf as any);
  const ws=wb.getWorksheet('Donnees');if(!ws)throw new Error('Onglet Donnees absent.');
  const rows:any[][]=[];
  ws.eachRow({includeEmpty:false},row=>{
    const values=row.values;
    rows.push(Array.isArray(values)?values.slice(1):Object.values(values??{}));
  });
  return rows;
}
function headerIndex(headers:any[],name:string){const wanted=normHeader(name);return headers.findIndex(x=>normHeader(x)===wanted)}
function findHeaderRow(rows:any[][],required:string[]){return rows.findIndex(r=>required.every(name=>headerIndex(r,name)>=0))}
async function detectFinancialXlsx(buf:Buffer){
  const rows=await xlsxData(buf);
  if(findHeaderRow(rows,['Compte','Solde débit','Solde crédit','Montant débit antérieur'])>=0)return 'EBLC';
  const cons=findHeaderRow(rows,['Etablissement','CGR de niveau 1','Poste de niveau 1','Montant colonne 1']);
  if(cons>=0){
    const h=rows[cons],poste=headerIndex(h,'Poste de niveau 1');
    const first=rows.slice(cons+1).find(r=>cellText(r[poste]));
    const dir=cellText(first?.[poste]).toUpperCase();
    if(dir==='DEP')return 'YCONSDEP';if(dir==='REC')return 'YCONSREC';
  }
  const aged=findHeaderRow(rows,['Etablissement','Pièce','Tiers','Montant en référence colonne 15']);
  if(aged>=0){
    const h=rows[aged],accountCol=headerIndex(h,'Critère de rupture 2');
    const first=rows.slice(aged+1).find(r=>cellText(r[accountCol]));
    const account=cellText(first?.[accountCol]);
    if(/^40/.test(account))return 'YBALAF';
    if(/^4[1-9]/.test(account))return 'YBALAC';
    throw new Error(`Balance âgée reconnue, mais le compte ${account||'non renseigné'} ne permet pas de déterminer clients/fournisseurs.`);
  }
  return null;
}
async function parseFinancialXlsx(buf:Buffer,type:string,contextEntity:string){
  const rows=await xlsxData(buf);
  const required=type==='EBLC'?['Compte','Solde débit','Solde crédit']:type.startsWith('YCONS')?['Etablissement','CGR de niveau 1','Poste de niveau 1','Montant colonne 1']:['Etablissement','Pièce','Tiers','Montant en référence colonne 15'];
  const hi=findHeaderRow(rows,required);if(hi<0)throw new Error(`${type}: en-têtes non reconnus.`);
  const h=rows[hi];const idx=(name:string)=>headerIndex(h,name);const data=rows.slice(hi+1).filter(r=>r.some(v=>cellText(v)));
  if(!data.length)throw new Error(`${type}: aucune ligne exploitable.`);
  const first=data[0];
  if(type==='EBLC'){
    const entity=cellText(first[idx('Etablissement')])||contextEntity;
    const dateText=cellText(first[idx('Date')]);const snapshotDate=parseFrDate(dateText)||new Date().toISOString().slice(0,10);
    // EBLC : le rattachement métier est déterminé par la période demandée dans l'édition,
    // pas par l'exercice technique Op@le depuis lequel l'édition a été lancée.
    const periodStart=cellText(first[idx('Période de début')])||null;
    const periodEnd=cellText(first[idx('Période de fin')])||periodStart;
    const periodYear=Number(((periodEnd||'').match(/20\d{2}/)||[])[0]);
    const exerciseText=cellText(first[idx("Fin d'exercice")])||cellText(first[idx("Début d'exercice")]);
    const technicalExercise=Number((exerciseText.match(/20\d{2}/)||[])[0])||new Date(snapshotDate).getFullYear();
    const exercise=periodYear||technicalExercise;
    const period=periodEnd||periodStart||null;
    return {type,entity,uai:'',snapshotDate,exercise,period,periodStart,periodEnd,technicalExercise,rows:data.map((r,i)=>({line:i+hi+2,account:cellText(r[idx('Compte')]),label:cellText(r[idx('Intitulé réduit du compte')]),priorDebit:cellNum(r[idx('Montant débit antérieur')]),priorCredit:cellNum(r[idx('Montant crédit antérieur')]),periodDebit:cellNum(r[idx('Montant débit')]),periodCredit:cellNum(r[idx('Montant crédit')]),debit:cellNum(r[idx('Solde débit')]),credit:cellNum(r[idx('Solde crédit')])})).filter(x=>/^\d{3,}/.test(x.account))};
  }
  if(type.startsWith('YCONS')){
    const entity=cellText(first[idx('Etablissement si un seul sélectionné')])||cellText(first[idx('Etablissement')])||contextEntity;
    const uai=cellText(first[idx('Intitulé réduit')]);const dateText=cellText(first[idx('Date')]);const snapshotDate=parseFrDate(dateText)||new Date().toISOString().slice(0,10);const exercise=new Date(snapshotDate).getFullYear();
    const account=idx('Compte'), amount=idx('Montant colonne 1');
    return {type,entity,uai,snapshotDate,exercise,period:null,rows:data.map((r,i)=>({line:i+hi+2,direction:type==='YCONSDEP'?'DEP':'REC',section:cellText(r[4]),serviceGroup:cellText(r[7]),service:cellText(r[10]),domain:cellText(r[13]),activity:cellText(r[16]),account:cellText(r[account]),label:cellText(r[account+1]),budget:cellNum(r[amount]),committed:cellNum(r[amount+1]),accounted:cellNum(r[amount+2]),inProgress:cellNum(r[amount+3]),available:cellNum(r[amount+4])})).filter(x=>x.service||x.account)};
  }
  const entity=cellText(first[idx('Etablissement')])||contextEntity;const uai=cellText(first[idx('Libellé réduit établissement')]);const dateText=cellText(first[idx('Date')]);const snapshotDate=parseFrDate(dateText)||new Date().toISOString().slice(0,10);const exercise=new Date(snapshotDate).getFullYear();
  const account=idx('Critère de rupture 2'), accountLabel=idx('Libellé critère de rupture 2'), party=idx('Tiers'), partyLabel=idx('Libellé réduit du tiers'), piece=idx('Pièce'), pieceType=idx('Type de pièce'), amount=idx('Montant en référence colonne 1');
  return {type,entity,uai,snapshotDate,exercise,period:null,rows:data.map((r,i)=>({line:i+hi+2,account:cellText(r[account]),accountLabel:cellText(r[accountLabel]),partyId:cellText(r[party]),partyLabel:cellText(r[partyLabel]),piece:cellText(r[piece]),pieceType:cellText(r[pieceType]),amounts:Array.from({length:15},(_,j)=>cellNum(r[amount+j]))})).filter(x=>x.account||x.piece)};
}

function isYgpie1Csv(buf:Buffer){
  const h=buf.toString('utf8',0,Math.min(buf.length,24000)).replace(/^\uFEFF/,'');
  return h.includes('Pièce;N° éché.;Type;Echéance;Compte;Tiers principal;Solde débit;Solde crédit;Montant débit;Montant crédit;Ets;') && h.includes('Indicateur du solde');
}
function parseYgpie1(buf:Buffer,contextEntity:string){
  const matrix:any[][]=parseCsv(buf.toString('utf8').replace(/^\uFEFF/,''),{delimiter:';',bom:true,skip_empty_lines:true,relax_column_count:true,relax_quotes:true,trim:false});
  if(matrix.length<2)throw new Error('YGPIE1 vide.');
  const headers=matrix[0].map((x:any)=>String(x??'').trim());
  const ix=(name:string)=>headers.indexOf(name), clean=(v:any)=>cleanOpaleCsv(v), money=(v:any)=>num(clean(v));
  const required=['Pièce','Compte','Solde débit','Solde crédit','Ets'];for(const k of required)if(ix(k)<0)throw new Error(`YGPIE1 : colonne ${k} absente.`);
  const rows=matrix.slice(1,MAX_ROWS+1).map((r:any[],i:number)=>({line:i+2,piece:clean(r[ix('Pièce')]),installment:clean(r[ix('N° éché.')]),pieceType:clean(r[ix('Type')]),dueDate:parseFrDate(clean(r[ix('Echéance')])),account:clean(r[ix('Compte')]).replace(/\s/g,''),mainParty:clean(r[ix('Tiers principal')]),debitBalance:money(r[ix('Solde débit')]),creditBalance:money(r[ix('Solde crédit')]),debitAmount:money(r[ix('Montant débit')]),creditAmount:money(r[ix('Montant crédit')]),entity:clean(r[ix('Ets')]),state:clean(r[ix('Etat')]),reference:clean(r[ix('Référence')]),label:clean(r[ix('Libellé')]),movementType:clean(r[ix('Type de mouvement')]),entryNo:clean(r[ix('Ecriture')]),initialDueDate:parseFrDate(clean(r[ix("Date d'échéance initiale")])),valueDate:parseFrDate(clean(r[ix('Date de valeur')])),party:clean(r[ix('Tiers')]),balanceIndicator:clean(r[ix('Indicateur du solde')]),settlementDate:parseFrDate(clean(r[ix('Date de solde')])),createdSourceDate:parseFrDate(clean(r[ix('Créé le')])),modifiedSourceDate:parseFrDate(clean(r[ix('Modifié le')])),raw:Object.fromEntries(headers.map((h,j)=>[`${h||'col'}_${j}`,r[j]??'']))})).filter((x:any)=>x.piece||x.account);
  if(!rows.length)throw new Error('YGPIE1 reconnu mais aucune pièce exploitable.');
  const entities=[...new Set(rows.map((x:any)=>x.entity).filter(Boolean))];if(entities.length>1)throw new Error(`YGPIE1 contient plusieurs ETS (${entities.join(', ')}).`);
  const fileEntity=entities[0]||null;if(!contextEntity)throw new Error('Le contexte ETS est obligatoire pour YGPIE1.');if(fileEntity&&fileEntity!==contextEntity)throw new Error(`ETS incohérent : YGPIE1 contient ${fileEntity}, alors que l’import est contextualisé sur ${contextEntity}.`);
  return {type:'ygpie1',entity:contextEntity,fileEntity,rows,sourceRows:matrix.length-1,snapshotDate:new Date().toISOString().slice(0,10)};
}

function detectCsvType(buf: Buffer) {
  const head=buf.toString('utf8',0,Math.min(buf.length,12000)).replace(/^\uFEFF/,'');
  if(head.includes('Exercice;Montant du FDR;') && head.includes('Définitif ?')) return 'fdr';
  if(head.includes('N° commande') && head.includes('Fournisseur') && head.includes('Prix commandé HT')) return 'clca';
  return 'unknown';
}
function parseClca(buf: Buffer) {
  const records:any[]=parseOpaleCsv(buf);
  if(!records.length)throw new Error('CLCA vide.');
  const keys=Object.keys(records[0]);
  if(!keys.includes('N° commande') || !keys.includes('Fournisseur') || !keys.includes('Prix commandé HT')) throw new Error("CSV non reconnu comme CLCA Op@le.");
  const val=(r:any,k:string)=>{const v=r[k];return cleanOpaleCsv(Array.isArray(v)?v[v.length-1]:v)};
  const rows=records.slice(0,MAX_ROWS).map((r:any,i:number)=>({line:i+2,establishment:val(r,'Etablissement'),orderNumber:val(r,'N° commande'),internalOrderNumber:val(r,'Numéro interne de commande'),subNumber:val(r,'Sous-numéro'),market:val(r,'Marché'),supplier:val(r,'Fournisseur'),orderDate:parseFrDate(val(r,'Date')),currency:val(r,'Devise'),orderLine:val(r,'Ligne'),stage:val(r,'Etape'),article:val(r,'Article'),articleLabel:val(r,'Libellé article'),quantity:num(val(r,'Quantité')),receivedQuantity:num(val(r,'Qté reçue')),receiptDate:parseFrDate(val(r,'Date de réception')),invoicedQuantity:num(val(r,'Qté facturée')),warehouse:val(r,'Dépôt'),expectedDeliveryDate:parseFrDate(val(r,'Date livraison prévue')),purchaseMode:val(r,"Mode d'achat"),receiptBalanceQuantity:num(val(r,'Qté solde réception')),invoiceBalanceQuantity:num(val(r,'Qté solde facture')),orderedPrice:num(val(r,'Prix commandé HT')),receivedPrice:num(val(r,'Prix réceptionné')),invoicePrice:num(val(r,'Prix facture')),invoiceAmount:num(val(r,'Montant facture')),account:val(r,'Compte'),cgrA:val(r,'CGR A'),cgrB:val(r,'CGR B'),creator:val(r,'Créateur'),modifier:val(r,'Modificateur'),raw:r}));
  const establishment=rows.find(x=>x.establishment)?.establishment||'Établissement non renseigné';
  const dates=rows.map(x=>x.orderDate).filter(Boolean).sort();
  return {type:'clca',establishment,snapshotDate:new Date().toISOString().slice(0,10),rows,sourceRows:records.length,rejectedRows:Math.max(0,records.length-rows.length)};
}

function analyse(rows: any[]) {
  const alerts: any[] = [];
  const add = (code:string, level:string, title:string, detail:string, account:string, amount:number) => alerts.push({code,level,title,detail,account,amount});
  for (const r of rows) {
    const a=r.account, abs=Math.abs(r.net); if(abs<0.005) continue;
    if (/^(471|472)/.test(a)) add('CG-ATTENTE','watch','Compte d’attente non soldé',`${a} ${r.label} présente un solde de ${r.net.toFixed(2)} € à examiner.`,a,r.net);
    if (/^585/.test(a)) add('CG-585','alert','Compte 585 non soldé',`Le compte ${a} présente un solde de ${r.net.toFixed(2)} €.`,a,r.net);
    if (/^(401|404)/.test(a) && r.net>0) add('CG-FOURN-SENS','watch','Solde fournisseur de sens inhabituel',`Le compte ${a} présente un solde débiteur de ${r.net.toFixed(2)} €.`,a,r.net);
    if (/^(411|416)/.test(a) && r.net<0) add('CG-CLIENT-SENS','watch','Solde de créance de sens inhabituel',`Le compte ${a} présente un solde créditeur de ${Math.abs(r.net).toFixed(2)} €.`,a,r.net);
  }
  return alerts.sort((a,b)=>(a.level==='alert'?0:1)-(b.level==='alert'?0:1)||Math.abs(b.amount)-Math.abs(a.amount));
}
function budgetTrajectoryTarget(dateValue:any){
  const d=new Date(dateValue||Date.now()); const y=d.getUTCFullYear();
  const points=[[Date.UTC(y,0,1),.05],[Date.UTC(y,2,31),.25],[Date.UTC(y,5,30),.62],[Date.UTC(y,7,31),.78],[Date.UTC(y,10,1),.95],[Date.UTC(y,11,31),1]];
  const t=d.getTime(); if(t<=points[0][0])return points[0][1]; if(t>=points.at(-1)![0])return 1;
  for(let i=1;i<points.length;i++){if(t<=points[i][0]){const[a,va]=points[i-1], [b,vb]=points[i]; return va+(vb-va)*((t-a)/(b-a));}}
  return 1;
}
function budgetSignal(metrics:any,snapshotDate:any){
  const budget=Number(metrics.budget||0), committed=Number(metrics.committed||0), accounted=Number(metrics.accounted||0), available=Number(metrics.available||0);
  if(!budget)return null; const rate=committed/budget, target=budgetTrajectoryTarget(snapshotDate), gap=rate-target;
  const evidence=[{label:'Montant évaluatif',value:budget},{label:'Engagé juridiquement',value:committed},{label:'dont réalisé',value:accounted},{label:'Disponible',value:available},{label:"Taux d'engagement",value:rate,format:'percent'},{label:'Trajectoire attendue',value:target,format:'percent'}];
  if(available<-.01)return {code:'BUD-NEG',level:'alert',domain:'Budget',title:'Disponible budgétaire négatif',detail:`Le disponible ressort à ${available.toFixed(2)} €.`,evidence,condition:'Disponible < 0 €',interpretation:'Les engagements dépassent le montant évaluatif agrégé ; le périmètre doit être vérifié.',source:'Budget Op@le'};
  if(gap<-.10)return {code:'BUD-TRAJECTORY',level:'watch',domain:'Budget',title:"Engagements en retrait sur la trajectoire",detail:`${(rate*100).toFixed(1)} % engagés pour une trajectoire de référence à ${(target*100).toFixed(1)} %.`,evidence,condition:'Écart à la trajectoire < -10 points',interpretation:"Le niveau d'engagement est inférieur à la trajectoire EPLE de référence. Le contexte et les besoins restant à engager sont à examiner.",source:'Budget Op@le'};
  return null;
}
app.get('/health',()=>({ok:true,version:VERSION}));

app.get('/api/imports',async()=>({
 balances:(await pool.query('select id,establishment_name,snapshot_date,source_filename,row_count,created_at from balance_snapshots order by created_at desc limit 20')).rows,
 budgets:(await pool.query('select id,establishment_name,snapshot_date,source_filename,row_count,created_at from budget_snapshots order by created_at desc limit 20')).rows,
 purchases:(await pool.query('select id,establishment_name,snapshot_date,source_filename,row_count,rejected_row_count,created_at from purchase_snapshots order by created_at desc limit 20')).rows,
 fdr:(await pool.query('select id,establishment_name,snapshot_date,source_filename,row_count,created_at from fdr_snapshots order by created_at desc limit 20')).rows,
 accounting:(await pool.query('select id,opale_entity,source_filename,source_format,source_row_count,imported_row_count,added_count,updated_count,unchanged_count,period_from,period_to,created_at from accounting_imports order by created_at desc limit 20')).rows
}));
app.post('/api/import/opale',async(req:any,reply:any)=>{try{
 const requestedEts=String((req.query as any)?.ets||'').trim();if(!requestedEts)return reply.code(400).send({error:'Choisissez un établissement cible avant l’import.'});const targetEstablishment=await requireEstablishment(req,reply,requestedEts);if(!targetEstablishment)return;
 const file=await req.file(); if(!file)return reply.code(400).send({error:'Fichier manquant'}); const buf=await file.toBuffer(); const name=file.filename.toLowerCase(); const client=await pool.connect();
 try{
  if(name.endsWith('.lis') && decodeLis(buf).includes('entitiesTrialBalance')){const p=parseLis(buf); const alerts=analyse(p.rows); await client.query('begin'); const establishment=p.entityLabel||p.entity||'Établissement non renseigné'; const s=(await client.query('insert into balance_snapshots(establishment_name,snapshot_date,source_filename,sheet_name,row_count,source_format,opale_entity,opale_entity_label) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[establishment,new Date().toISOString().slice(0,10),file.filename,p.sheet,p.rows.length,p.format,p.entity,p.entityLabel])).rows[0]; for(const r of p.rows)await client.query('insert into balance_lines(snapshot_id,line_no,account,label,prior_debit,prior_credit,period_debit,period_credit,debit,credit,net) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[s.id,r.line,r.account,r.label,r.priorDebit,r.priorCredit,r.periodDebit,r.periodCredit,r.debit,r.credit,r.net]); for(const a of alerts)await client.query('insert into accounting_alerts(snapshot_id,rule_code,severity,title,detail,account,amount) values($1,$2,$3,$4,$5,$6,$7)',[s.id,a.code,a.level,a.title,a.detail,a.account,a.amount]); await client.query('commit'); return {ok:true,type:'balance',snapshot:s,control:{sourceRows:p.sourceRows,importedRows:p.rows.length,rejectedRows:p.sourceRows-p.rows.length},alerts}}
  if(name.endsWith('.lis') && /^DATASHEET=Donnees/m.test(decodeLis(buf))){const p=parseBudgetLis(buf); await client.query('begin'); const s=(await client.query('insert into budget_snapshots(establishment_name,opale_entity,snapshot_date,source_filename,row_count) values($1,$2,$3,$4,$5) returning *',[p.establishment||p.entity,p.entity,p.snapshotDate||new Date().toISOString().slice(0,10),file.filename,p.rows.length])).rows[0]; for(const r of p.rows)await client.query('insert into budget_lines(snapshot_id,line_no,raw_dimensions,budget,committed,accounted,in_progress,available) values($1,$2,$3,$4,$5,$6,$7,$8)',[s.id,r.line,JSON.stringify(r.dimensions),r.budget,r.committed,r.accounted,r.inProgress,r.available]); await client.query('commit'); return {ok:true,type:'budget',snapshot:s,control:{importedRows:p.rows.length}}}
  if(name.endsWith('.xlsx')){const contextEntity=String(targetEstablishment.opale_entity||requestedEts).trim();const financialType=await detectFinancialXlsx(buf);if(financialType){const p:any=await parseFinancialXlsx(buf,financialType,contextEntity);if(p.entity&&contextEntity&&p.entity.toUpperCase()!==contextEntity.toUpperCase())return reply.code(400).send({error:`Import refusé : le fichier concerne ${p.entity}, établissement sélectionné ${contextEntity}.`});await client.query('begin');const fs=(await client.query('insert into financial_snapshots(establishment_name,opale_entity,source_type,snapshot_date,exercise,period,period_start,period_end,technical_exercise,source_filename,row_count) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[targetEstablishment.name,p.entity||contextEntity,financialType,p.snapshotDate,p.exercise,p.period,p.periodStart||null,p.periodEnd||p.period||null,p.technicalExercise||null,file.filename,p.rows.length])).rows[0];if(financialType==='EBLC'){for(const r of p.rows)await client.query('insert into financial_balance_lines(snapshot_id,line_no,account,label,prior_debit,prior_credit,period_debit,period_credit,debit,credit) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[fs.id,r.line,r.account,r.label,r.priorDebit,r.priorCredit,r.periodDebit,r.periodCredit,r.debit,r.credit])}else if(financialType.startsWith('YCONS')){for(const r of p.rows)await client.query('insert into financial_execution_lines(snapshot_id,line_no,direction,section,service_group,service,domain,activity,account,label,budget,committed,accounted,in_progress,available) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[fs.id,r.line,r.direction,r.section,r.serviceGroup,r.service,r.domain,r.activity,r.account,r.label,r.budget,r.committed,r.accounted,r.inProgress,r.available])}else{for(const r of p.rows)await client.query('insert into financial_aged_lines(snapshot_id,line_no,account,account_label,party_id,party_label,piece,piece_type,before_121,m91_120,m61_90,m46_60,m31_45,m1_30,due,p1_30,p31_45,p46_60,p61_90,p91_120,p121_plus,not_due,total) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)',[fs.id,r.line,r.account,r.accountLabel,r.partyId,r.partyLabel,r.piece,r.pieceType,...r.amounts])}await client.query('commit');return {ok:true,type:financialType.toLowerCase(),snapshot:fs,control:{importedRows:p.rows.length}}}const p=await parseBudgetXlsx(buf,contextEntity);await client.query('begin');const s=(await client.query('insert into budget_snapshots(establishment_name,opale_entity,snapshot_date,source_filename,row_count) values($1,$2,$3,$4,$5) returning *',[targetEstablishment.name||p.establishment,p.entity,p.snapshotDate,file.filename,p.rows.length])).rows[0];for(const r of p.rows)await client.query('insert into budget_lines(snapshot_id,line_no,raw_dimensions,budget,committed,accounted,in_progress,available) values($1,$2,$3,$4,$5,$6,$7,$8)',[s.id,r.line,JSON.stringify(r.dimensions),r.budget,r.committed,r.accounted,r.inProgress,r.available]);await client.query('commit');return {ok:true,type:'budget',snapshot:s,control:{sourceRows:p.sourceRows,importedRows:p.rows.length,format:p.format}}}
  if(name.endsWith('.csv') && isYgpie1Csv(buf)){const contextEntity=String(targetEstablishment.opale_entity||requestedEts).trim();const p=parseYgpie1(buf,contextEntity);await client.query('begin');const snap=(await client.query('insert into ygpie1_snapshots(opale_entity,snapshot_date,source_filename,row_count) values($1,$2,$3,$4) returning *',[p.entity,p.snapshotDate,file.filename,p.rows.length])).rows[0];for(const r of p.rows)await client.query(`insert into ygpie1_pieces(snapshot_id,line_no,piece,installment,piece_type,due_date,account,main_party,debit_balance,credit_balance,debit_amount,credit_amount,opale_entity,state,reference,label,movement_type,entry_no,initial_due_date,value_date,party,balance_indicator,settlement_date,created_source_date,modified_source_date,raw_data) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,[snap.id,r.line,r.piece,r.installment,r.pieceType,r.dueDate,r.account,r.mainParty,r.debitBalance,r.creditBalance,r.debitAmount,r.creditAmount,p.entity,r.state,r.reference,r.label,r.movementType,r.entryNo,r.initialDueDate,r.valueDate,r.party,r.balanceIndicator,r.settlementDate,r.createdSourceDate,r.modifiedSourceDate,JSON.stringify(r.raw)]);await client.query('commit');return {ok:true,type:'ygpie1',snapshot:snap,control:{sourceRows:p.sourceRows,importedRows:p.rows.length,sourceEts:p.fileEntity}}}
  if(name.endsWith('.csv') && isAccountingCsv(buf)){const contextEntity=String(targetEstablishment.opale_entity||requestedEts).trim();const p=parseAccountingCsv(buf,contextEntity);await client.query('begin');const imp=(await client.query('insert into accounting_imports(opale_entity,source_filename,source_format,source_row_count,imported_row_count,period_from,period_to) values($1,$2,$3,$4,$5,$6,$7) returning *',[p.entity,file.filename,p.sourceFormat,p.sourceRows,p.rows.length,p.periodFrom,p.periodTo])).rows[0];let added=0,updated=0,unchanged=0;for(const r of p.rows){const prev=(await client.query('select debit,credit,account_label,movement_kind from accounting_lines where opale_entity=$1 and period_date=$2 and account=$3 and journal=$4',[p.entity,r.periodDate,r.account,r.journal])).rows[0];if(!prev)added++;else if(Number(prev.debit)===r.debit&&Number(prev.credit)===r.credit&&String(prev.account_label||'')===r.accountLabel&&String(prev.movement_kind)===r.movementKind)unchanged++;else updated++;await client.query(`insert into accounting_lines(opale_entity,period,period_date,journal,account,account_label,debit,credit,movement,movement_kind,last_import_id,raw_data) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(opale_entity,period_date,account,journal) do update set period=excluded.period,account_label=excluded.account_label,debit=excluded.debit,credit=excluded.credit,movement=excluded.movement,movement_kind=excluded.movement_kind,last_import_id=excluded.last_import_id,raw_data=excluded.raw_data,updated_at=now()`,[p.entity,r.period,r.periodDate,r.journal,r.account,r.accountLabel,r.debit,r.credit,r.debit-r.credit,r.movementKind,imp.id,JSON.stringify(r.raw)]);}await client.query('update accounting_imports set added_count=$2,updated_count=$3,unchanged_count=$4 where id=$1',[imp.id,added,updated,unchanged]);await client.query('commit');return {ok:true,type:'accounting',import:{...imp,added_count:added,updated_count:updated,unchanged_count:unchanged},control:{sourceRows:p.sourceRows,importedRows:p.rows.length,addedRows:added,updatedRows:updated,unchangedRows:unchanged,rejectedRows:p.sourceRows-p.rows.length,sourceEts:p.fileEntity,etsFromContext:p.entityFromContext}}}
  if(name.endsWith('.csv') && detectCsvType(buf)==='fdr'){const p=parseFdr(buf); await client.query('begin'); const s=(await client.query('insert into fdr_snapshots(establishment_name,snapshot_date,source_filename,row_count) values($1,$2,$3,$4) returning *',[p.establishment,p.snapshotDate,file.filename,p.rows.length])).rows[0]; for(const r of p.rows)await client.query('insert into fdr_lines(snapshot_id,exercise,amount,direction,is_final,establishment,state,source_modified_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[s.id,r.exercise,r.amount,r.direction,r.isFinal,r.establishment,r.state,r.sourceModifiedAt]); await client.query('commit'); return {ok:true,type:'fdr',snapshot:s,control:{sourceRows:p.sourceRows,importedRows:p.rows.length}}}
  if(name.endsWith('.csv') && detectCsvType(buf)==='clca'){const p=parseClca(buf); await client.query('begin'); const s=(await client.query('insert into purchase_snapshots(establishment_name,snapshot_date,source_filename,row_count,rejected_row_count) values($1,$2,$3,$4,$5) returning *',[p.establishment,p.snapshotDate,file.filename,p.rows.length,p.rejectedRows])).rows[0]; for(const r of p.rows)await client.query('insert into purchase_lines(snapshot_id,line_no,establishment,order_number,internal_order_number,sub_number,market,supplier,order_date,currency,order_line,stage,article,article_label,quantity,received_quantity,receipt_date,invoiced_quantity,warehouse,expected_delivery_date,purchase_mode,receipt_balance_quantity,invoice_balance_quantity,ordered_price,received_price,invoice_price,invoice_amount,account,cgr_a,cgr_b,creator,modifier,raw_data) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)',[s.id,r.line,r.establishment,r.orderNumber,r.internalOrderNumber,r.subNumber,r.market,r.supplier,r.orderDate,r.currency,r.orderLine,r.stage,r.article,r.articleLabel,r.quantity,r.receivedQuantity,r.receiptDate,r.invoicedQuantity,r.warehouse,r.expectedDeliveryDate,r.purchaseMode,r.receiptBalanceQuantity,r.invoiceBalanceQuantity,r.orderedPrice,r.receivedPrice,r.invoicePrice,r.invoiceAmount,r.account,r.cgrA,r.cgrB,r.creator,r.modifier,JSON.stringify(r.raw)]); await client.query('commit'); return {ok:true,type:'clca',snapshot:s,control:{sourceRows:p.sourceRows,importedRows:p.rows.length,rejectedRows:p.rejectedRows}}}
  return reply.code(400).send({error:'Type Op@le non reconnu. Formats gérés : balance .lis, budget .lis/.xlsx, EBLC .xlsx, YCONSDEP/YCONSREC .xlsx, YBALAC/YBALAF .xlsx, données comptables Op@le .csv (classes 1 à 8), YGPIE1 .csv, CLCA .csv et FDR .csv.'});
 }catch(e){try{await client.query('rollback')}catch{};throw e}finally{client.release()}
}catch(e:any){req.log.error(e);return reply.code(400).send({error:e.message||'Import impossible'})}});


app.get('/api/financial/:ets',async(req:any,reply:any)=>{try{
 const ets=String(req.params.ets||'').trim();const establishment=await requireEstablishment(req,reply,ets);if(!establishment)return;
 const entity=String(establishment.opale_entity||ets);
 const latest=async(type:string)=>(await pool.query(`select * from financial_snapshots where upper(opale_entity)=upper($1) and source_type=$2 order by case when source_type='EBLC' then exercise end desc nulls last, case when source_type='EBLC' and coalesce(period_end,period) ~ '^(0[1-9]|1[0-2])/20[0-9]{2}$' then split_part(coalesce(period_end,period),'/',1)::int end desc nulls last, snapshot_date desc,created_at desc limit 1`,[entity,type])).rows[0]||null;
 const [eblc,depSnap,recSnap,clientSnap,supplierSnap]=await Promise.all([latest('EBLC'),latest('YCONSDEP'),latest('YCONSREC'),latest('YBALAC'),latest('YBALAF')]);
 const execution=async(snap:any)=>{if(!snap)return null;const q=(await pool.query(`select coalesce(sum(budget),0) budget,coalesce(sum(committed),0) committed,coalesce(sum(accounted),0) accounted,coalesce(sum(in_progress),0) in_progress,coalesce(sum(available),0) available from financial_execution_lines where snapshot_id=$1`,[snap.id])).rows[0];return Object.fromEntries(Object.entries(q).map(([k,v])=>[k,Number(v||0)]))};
 const aged=async(snap:any)=>{if(!snap)return null;const q=(await pool.query(`select coalesce(sum(total),0) total,coalesce(sum(due),0) due,coalesce(sum(before_121),0) old,coalesce(sum(not_due),0) not_due from financial_aged_lines where snapshot_id=$1`,[snap.id])).rows[0];return {snapshotDate:snap.snapshot_date,sourceFilename:snap.source_filename,total:Number(q.total||0),due:Number(q.due||0),old:Number(q.old||0),notDue:Number(q.not_due||0)}};
 const [expenses,revenues,receivables,payables]=await Promise.all([execution(depSnap),execution(recSnap),aged(clientSnap),aged(supplierSnap)]);
 let balance:any=null;if(eblc){const q=(await pool.query(`select
  coalesce(sum(case when account ~ '^[67]' then credit-debit else 0 end),0) result,
  coalesce(sum(case when account like '68%' then debit-credit else 0 end),0) c68,
  coalesce(sum(case when account like '78%' then credit-debit else 0 end),0) c78,
  coalesce(sum(case when account like '675%' then debit-credit else 0 end),0) c675,
  coalesce(sum(case when account like '775%' then credit-debit else 0 end),0) c775,
  coalesce(sum(case when account like '776%' then credit-debit else 0 end),0) c776,
  coalesce(sum(case when account like '777%' then credit-debit else 0 end),0) c777,
  coalesce(sum(case when account like '4%' then debit-credit else 0 end),0) bfr
 from financial_balance_lines where snapshot_id=$1`,[eblc.id])).rows[0];const result=Number(q.result||0),caf=result+Number(q.c68||0)-Number(q.c78||0)+Number(q.c675||0)-Number(q.c775||0)-Number(q.c776||0)-Number(q.c777||0);balance={snapshotDate:eblc.snapshot_date,exercise:eblc.exercise,period:eblc.period,result,caf,cafKind:caf>=0?'CAF':'IAF',cafBreakdown:{result,c68:Number(q.c68||0),c78:Number(q.c78||0),c675:Number(q.c675||0),c775:Number(q.c775||0),c776:Number(q.c776||0),c777:Number(q.c777||0)},bfr:Number(q.bfr||0)}}
 const fdrSnap=(await pool.query(`select * from fdr_snapshots where establishment_name=$1 or establishment_name=$2 order by snapshot_date desc,created_at desc limit 1`,[establishment.name,entity])).rows[0];let fdr:any=null,fdrHistory:any[]=[];if(fdrSnap){fdrHistory=(await pool.query('select exercise,amount,is_final from fdr_lines where snapshot_id=$1 order by exercise',[fdrSnap.id])).rows.map((x:any)=>({...x,amount:Number(x.amount)}));const x=fdrHistory.at(-1);if(x)fdr={...x}}
 // Historique annuel : clôtures EBLC au 31/12 pour les exercices clos ; dernière EBLC disponible pour l'exercice courant.
 // Résultat = crédits nets - débits nets des classes 6 et 7. Trésorerie = solde débiteur net du 5151. BFR = FDR - trésorerie.
 const currentYear=new Date().getFullYear();
 const eblcAnnual=(await pool.query(`select distinct on (exercise) id,exercise,snapshot_date,period,period_start,period_end from financial_snapshots where upper(opale_entity)=upper($1) and source_type='EBLC' and exercise is not null and (exercise=$2 or split_part(coalesce(period_end,period,''),'/',1)='12') order by exercise, case when coalesce(period_end,period) ~ '^(0[1-9]|1[0-2])/20[0-9]{2}$' then split_part(coalesce(period_end,period),'/',1)::int else 0 end desc, snapshot_date desc,created_at desc`,[entity,currentYear])).rows;
 const fdrByYear=new Map(fdrHistory.map((x:any)=>[Number(x.exercise),x]));const indicatorHistory:any[]=[];
 for(const snap of eblcAnnual){const q=(await pool.query(`select
  coalesce(sum(case when account ~ '^[67]' then credit-debit else 0 end),0) result,
  coalesce(sum(case when account like '68%' then debit-credit else 0 end),0) c68,
  coalesce(sum(case when account like '78%' then credit-debit else 0 end),0) c78,
  coalesce(sum(case when account like '675%' then debit-credit else 0 end),0) c675,
  coalesce(sum(case when account like '775%' then credit-debit else 0 end),0) c775,
  coalesce(sum(case when account like '776%' then credit-debit else 0 end),0) c776,
  coalesce(sum(case when account like '777%' then credit-debit else 0 end),0) c777,
  coalesce(sum(case when account='5151' or account like '5151%' then debit-credit else 0 end),0) treasury,
  coalesce(sum(case when account ~ '^(60|61|62|63|64|65)' then debit-credit else 0 end),0) operating_charges
 from financial_balance_lines where snapshot_id=$1`,[snap.id])).rows[0];const year=Number(snap.exercise),f=fdrByYear.get(year),treasury=Number(q.treasury||0),result=Number(q.result||0),caf=result+Number(q.c68||0)-Number(q.c78||0)+Number(q.c675||0)-Number(q.c775||0)-Number(q.c776||0)-Number(q.c777||0),operatingCharges=Number(q.operating_charges||0),fdrAmount=f?Number(f.amount):null,fdrDays=fdrAmount!=null&&operatingCharges>0?(fdrAmount/operatingCharges)*360:null,treasuryDays=operatingCharges>0?(treasury/operatingCharges)*360:null;indicatorHistory.push({exercise:year,snapshotDate:snap.snapshot_date,periodStart:snap.period_start||null,periodEnd:snap.period_end||snap.period||null,isCurrent:year===currentYear,isFinal:year<currentYear&&String(snap.period_end||snap.period||'').startsWith('12/'),fdr:fdrAmount,fdrFinal:f?!!f.is_final:false,fdrDays,operatingCharges,treasury,treasuryDays,result,caf,cafKind:caf>=0?'CAF':'IAF',cafBreakdown:{result,c68:Number(q.c68||0),c78:Number(q.c78||0),c675:Number(q.c675||0),c775:Number(q.c775||0),c776:Number(q.c776||0),c777:Number(q.c777||0)},bfr:fdrAmount==null?null:fdrAmount-treasury})}
 // YFDR peut contenir des exercices pour lesquels aucune EBLC de clôture n'est encore importée : on conserve au moins la courbe FDR.
 for(const x of fdrHistory){const year=Number(x.exercise);if(!indicatorHistory.some((r:any)=>r.exercise===year))indicatorHistory.push({exercise:year,snapshotDate:null,isCurrent:year===currentYear,isFinal:!!x.is_final,fdr:Number(x.amount),fdrFinal:!!x.is_final,fdrDays:null,operatingCharges:null,treasury:null,treasuryDays:null,result:null,caf:null,cafKind:null,bfr:null})}
 indicatorHistory.sort((a:any,b:any)=>a.exercise-b.exercise);
 const executionHistory:any={expenses:[],revenues:[]};
 for(const [sourceType,key] of [['YCONSDEP','expenses'],['YCONSREC','revenues']] as const){
  const snaps=(await pool.query(`select id,exercise,snapshot_date,period,period_end,created_at from financial_snapshots where upper(opale_entity)=upper($1) and source_type=$2 and exercise is not null order by exercise,snapshot_date,created_at`,[entity,sourceType])).rows;
  for(const snap of snaps){const q=(await pool.query(`select coalesce(sum(accounted),0) accounted from financial_execution_lines where snapshot_id=$1`,[snap.id])).rows[0];executionHistory[key].push({exercise:Number(snap.exercise),snapshotDate:snap.snapshot_date,period:snap.period_end||snap.period||null,accounted:Number(q.accounted||0)})}
 }
 return {establishment:{id:establishment.id,name:establishment.name,uai:establishment.uai,opaleEntity:entity},sources:{EBLC:eblc?.snapshot_date||null,YCONSDEP:depSnap?.snapshot_date||null,YCONSREC:recSnap?.snapshot_date||null,YBALAC:clientSnap?.snapshot_date||null,YBALAF:supplierSnap?.snapshot_date||null},executionHistory,expenses,revenues,receivables,payables,balance,fdr,fdrHistory,indicatorHistory,srh:null};
}catch(e:any){req.log.error(e);return reply.code(400).send({error:e.message||'Analyse financière impossible'})}});

app.get('/api/accounting/:ets',async(req:any,reply:any)=>{try{
 const ets=String(req.params.ets||'').trim(),establishment=await requireEstablishment(req,reply,ets);if(!establishment)return;const entity=String(establishment.opale_entity||ets);
 const imp=(await pool.query(`select * from accounting_imports where upper(opale_entity)=upper($1) order by period_to desc nulls last,created_at desc limit 1`,[entity])).rows[0]||null;
 const entries=(await pool.query(`select period,period_date,journal,account,account_label,debit,credit,movement,movement_kind,raw_data from accounting_lines where upper(opale_entity)=upper($1) order by period_date desc,account,journal limit 20000`,[entity])).rows.map((r:any)=>({period:r.period,periodDate:r.period_date,journal:r.journal,account:r.account,accountLabel:r.account_label,debit:Number(r.debit||0),credit:Number(r.credit||0),movement:Number(r.movement||0),movementKind:r.movement_kind,rawData:r.raw_data}));
 const accountMap=new Map<string,any>();for(const r of entries){let a=accountMap.get(r.account);if(!a){a={account:r.account,label:r.accountLabel||'',debit:0,credit:0,balance:0,entryCount:0,lastDate:null,signalCount:0};accountMap.set(r.account,a)}a.debit+=r.debit;a.credit+=r.credit;a.balance+=r.movement;a.entryCount++;if(!a.lastDate||String(r.periodDate)>String(a.lastDate))a.lastDate=r.periodDate}
 let signals:any[]=[];const bal=(await pool.query(`select id from balance_snapshots where upper(coalesce(opale_entity,''))=upper($1) order by snapshot_date desc,created_at desc limit 1`,[entity])).rows[0];if(bal){signals=(await pool.query(`select rule_code code,severity level,title,detail,account,amount from accounting_alerts where snapshot_id=$1 order by case severity when 'alert' then 0 else 1 end,abs(amount) desc`,[bal.id])).rows.map((x:any)=>({...x,amount:Number(x.amount||0)}));for(const x of signals){const a=accountMap.get(x.account);if(a)a.signalCount++}}
 const now=Date.now(),bucket={d30:0,d60:0,d90:0,old:0};for(const r of entries){const d=Math.max(0,Math.floor((now-new Date(r.periodDate).getTime())/86400000));if(d<=30)bucket.d30++;else if(d<=60)bucket.d60++;else if(d<=90)bucket.d90++;else bucket.old++}
 const accounts=[...accountMap.values()].sort((a,b)=>a.account.localeCompare(b.account));
 const ys=(await pool.query(`select * from ygpie1_snapshots where upper(opale_entity)=upper($1) order by created_at desc limit 1`,[entity])).rows[0]||null;let ygpie1:any={available:false,pieces:[],accounts:[],summary:null};
 if(ys){const pieces=(await pool.query(`select line_no,piece,installment,piece_type,due_date,account,main_party,debit_balance,credit_balance,debit_amount,credit_amount,state,reference,label,movement_type,entry_no,initial_due_date,value_date,party,balance_indicator,settlement_date,created_source_date,modified_source_date from ygpie1_pieces where snapshot_id=$1 order by coalesce(due_date,initial_due_date) asc,line_no`,[ys.id])).rows.map((r:any)=>({...r,debitBalance:Number(r.debit_balance||0),creditBalance:Number(r.credit_balance||0),balance:Number(r.debit_balance||0)-Number(r.credit_balance||0),dueDate:r.due_date,initialDueDate:r.initial_due_date,mainParty:r.main_party,pieceType:r.piece_type,entryNo:r.entry_no,movementType:r.movement_type}));const age={d30:0,d60:0,d90:0,old:0},am={d30:0,d60:0,d90:0,old:0};const by=new Map<string,any>();for(const r of pieces){const dt=r.dueDate||r.initialDueDate;const days=dt?Math.max(0,Math.floor((Date.now()-new Date(dt).getTime())/86400000)):0;const k=days<=30?'d30':days<=60?'d60':days<=90?'d90':'old';age[k]++;am[k]+=Math.abs(r.balance);let a=by.get(r.account);if(!a){a={account:r.account,pieceCount:0,debitBalance:0,creditBalance:0,balance:0,oldestDueDate:null,oldOver90:0};by.set(r.account,a)}a.pieceCount++;a.debitBalance+=r.debitBalance;a.creditBalance+=r.creditBalance;a.balance+=r.balance;if(dt&&(!a.oldestDueDate||String(dt)<String(a.oldestDueDate)))a.oldestDueDate=dt;if(days>90)a.oldOver90+=Math.abs(r.balance)}ygpie1={available:true,source:{snapshotDate:ys.snapshot_date,sourceFilename:ys.source_filename,rowCount:ys.row_count},summary:{pieceCount:pieces.length,netBalance:pieces.reduce((n:number,r:any)=>n+r.balance,0),absoluteBalance:pieces.reduce((n:number,r:any)=>n+Math.abs(r.balance),0),ageBuckets:age,ageAmounts:am,accountsCount:by.size},accounts:[...by.values()].sort((a,b)=>Math.abs(b.balance)-Math.abs(a.balance)),pieces};}
 return {establishment:{name:establishment.name,uai:establishment.uai,opaleEntity:entity},source:imp?{periodFrom:imp.period_from,periodTo:imp.period_to,sourceFilename:imp.source_filename,sourceFormat:imp.source_format}:null,summary:{entryCount:entries.length,accountCount:accounts.length,accountsToControl:accounts.filter(a=>a.signalCount).length,oldEntries:bucket.old,ageBuckets:bucket},accounts,entries,signals,ygpie1};
}catch(e:any){req.log.error(e);return reply.code(400).send({error:e.message||'Exploration comptable impossible'})}});

app.get('/api/aged/:ets/:kind',async(req:any,reply:any)=>{try{
 const ets=String(req.params.ets||'').trim(),kind=String(req.params.kind||'').toLowerCase();const establishment=await requireEstablishment(req,reply,ets);if(!establishment)return;if(!['clients','suppliers'].includes(kind))return reply.code(400).send({error:'Vue de balance âgée inconnue.'});
 const entity=String(establishment.opale_entity||ets),sourceType=kind==='clients'?'YBALAC':'YBALAF';const snap=(await pool.query(`select * from financial_snapshots where upper(opale_entity)=upper($1) and source_type=$2 order by snapshot_date desc,created_at desc limit 1`,[entity,sourceType])).rows[0];if(!snap)return {establishment:{name:establishment.name,opaleEntity:entity},sourceType,snapshot:null,summary:null,rows:[]};
 const rows=(await pool.query(`select line_no,account,account_label,party_id,party_label,piece,piece_type,before_121,m91_120,m61_90,m46_60,m31_45,m1_30,due,p1_30,p31_45,p46_60,p61_90,p91_120,p121_plus,not_due,total from financial_aged_lines where snapshot_id=$1 order by abs(total) desc,line_no`,[snap.id])).rows.map((r:any)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,['line_no','account','account_label','party_id','party_label','piece','piece_type'].includes(k)?v:Number(v||0)])));
 const summary=rows.reduce((a:any,r:any)=>({total:a.total+r.total,due:a.due+r.due,old:a.old+r.before_121,notDue:a.notDue+r.not_due}),{total:0,due:0,old:0,notDue:0});return {establishment:{name:establishment.name,opaleEntity:entity},sourceType,snapshot:{id:snap.id,snapshotDate:snap.snapshot_date,sourceFilename:snap.source_filename,rowCount:snap.row_count},summary,rows};
}catch(e:any){req.log.error(e);return reply.code(400).send({error:e.message||'Balance âgée impossible'})}});

app.get('/api/budget/:ets',async(req:any,reply:any)=>{try{
 const ets=String(req.params.ets||'').trim();const establishment=await requireEstablishment(req,reply,ets);if(!establishment)return;
 const entity=String(establishment.opale_entity||ets);const requestedExercise=Number(req.query?.exercise||0)||null;const availableExercises=(await pool.query(`select distinct extract(year from snapshot_date)::int exercise from budget_snapshots where upper(coalesce(opale_entity,''))=upper($1) and snapshot_date is not null order by exercise desc`,[entity])).rows.map((r:any)=>Number(r.exercise));const effectiveExercise=requestedExercise&&availableExercises.includes(requestedExercise)?requestedExercise:(availableExercises[0]??null);const snap=(await pool.query(`select * from budget_snapshots where upper(coalesce(opale_entity,''))=upper($1) and ($2::int is null or extract(year from snapshot_date)::int=$2) order by snapshot_date desc,created_at desc limit 1`,[entity,effectiveExercise])).rows[0];
 if(!snap)return {establishment:{id:establishment.id,uai:establishment.uai,name:establishment.name,opaleEntity:establishment.opale_entity},availableExercises,snapshot:null,summary:null,services:[],rows:[],signals:[]};
 const lines=(await pool.query(`select line_no,raw_dimensions,budget,committed,accounted,in_progress,available from budget_lines where snapshot_id=$1 order by line_no`,[snap.id])).rows;
 const n=(v:any)=>Number(v||0),metric=(xs:any[])=>xs.reduce((a:any,x:any)=>({budget:a.budget+n(x.budget),committed:a.committed+n(x.committed),accounted:a.accounted+n(x.accounted),inProgress:a.inProgress+n(x.in_progress),available:a.available+n(x.available)}),{budget:0,committed:0,accounted:0,inProgress:0,available:0});
 const dims=(x:any)=>typeof x.raw_dimensions==='string'?JSON.parse(x.raw_dimensions):x.raw_dimensions;
 const parsed=lines.map((x:any)=>{const d=dims(x);if(!d||Array.isArray(d))return {...x,dimension:{source:'legacy',cgr:[],posts:[],account:'',accountLabel:''}};return {...x,dimension:d}});
 const direction=(x:any)=>String((x.dimension.posts||[]).find((p:any)=>p.level===2)?.code||'').trim().toUpperCase();
 const dep=parsed.filter((x:any)=>direction(x)==='DEP'),rec=parsed.filter((x:any)=>direction(x)==='REC'),other=parsed.filter((x:any)=>!['DEP','REC'].includes(direction(x)));
 const rawSummary={expenses:metric(dep),revenues:metric(rec),unclassified:metric(other)};
 const positive=(m:any)=>({budget:Math.abs(m.budget),committed:Math.abs(m.committed),accounted:Math.abs(m.accounted),inProgress:Math.abs(m.inProgress),available:Math.abs(m.available)});
 const summary={expenses:positive(rawSummary.expenses),revenues:positive(rawSummary.revenues),unclassified:rawSummary.unclassified};
 const scopeKey=(x:any)=>{const path=x.dimension.cgr||[],l2=path.find((p:any)=>p.level===2),l3=path.find((p:any)=>p.level===3);return {code:String(l3?.code||l2?.code||'AUTRE').trim(),label:String(l3?.label||l2?.label||'Autre').trim(),section:String(l2?.code||'').trim()}};
 const scopesMap=new Map<string,any>();
 for(const x of parsed){const sk=scopeKey(x),dir=direction(x);if(!['DEP','REC'].includes(dir))continue;if(!scopesMap.has(sk.code))scopesMap.set(sk.code,{...sk,dep:[],rec:[]});scopesMap.get(sk.code)[dir==='DEP'?'dep':'rec'].push(x)}
 const scopes=[...scopesMap.values()].map((x:any)=>{const expenses=positive(metric(x.dep)),revenues=positive(metric(x.rec)),balance=revenues.budget-expenses.budget;return {code:x.code,label:x.label,section:x.section,expenses,revenues,balance,financingNeed:Math.max(0,-balance),surplus:Math.max(0,balance)}}).sort((a:any,b:any)=>{const order=(x:string)=>x==='SG'?0:x==='SS'?1:x==='OPECAP'?2:9;return order(a.code)-order(b.code)||a.code.localeCompare(b.code,'fr')});
 const totals={expenses:summary.expenses,revenues:summary.revenues,balance:summary.revenues.budget-summary.expenses.budget};
 const cleanCode=(code:string,parent?:string)=>{let x=String(code||'').replace(/\s+/g,' ').trim();const p=String(parent||'').replace(/\s+/g,' ').trim();if(p&&x.startsWith(p))x=x.slice(p.length).trim();return x||String(code||'').trim()};
 const servicesMap=new Map<string,any>();
 for(const x of parsed){const path=x.dimension.cgr||[];const service=path.find((p:any)=>p.level===4)||path.at(-1);if(!service)continue;const key=String(service.code).trim(),dir=direction(x)||'AUTRE';if(!servicesMap.has(key))servicesMap.set(key,{code:key,label:service.label||key,direction:dir,lines:[]});servicesMap.get(key).lines.push(x)}
 const services=[...servicesMap.values()].map((s:any)=>{const totalsRaw=metric(s.lines),totals=['DEP','REC'].includes(s.direction)?positive(totalsRaw):totalsRaw;const childrenMap=new Map<string,any>();for(const x of s.lines){const path=x.dimension.cgr||[],l5=path.find((p:any)=>p.level===5),l6=path.find((p:any)=>p.level===6);const k5=l5?cleanCode(l5.code,s.code):'Sans domaine';if(!childrenMap.has(k5))childrenMap.set(k5,{code:k5,label:l5?.label||k5,lines:[],activities:new Map()});const c=childrenMap.get(k5);c.lines.push(x);const k6=l6?cleanCode(l6.code,l5?.code):null;if(k6){if(!c.activities.has(k6))c.activities.set(k6,{code:k6,label:l6?.label||k6,lines:[]});c.activities.get(k6).lines.push(x)}}return {...s,...totals,rate:totals.budget?totals.committed/totals.budget:null,children:[...childrenMap.values()].map((c:any)=>({...c,...(['DEP','REC'].includes(s.direction)?positive(metric(c.lines)):metric(c.lines)),activities:[...c.activities.values()].map((a:any)=>({...a,...(['DEP','REC'].includes(s.direction)?positive(metric(a.lines)):metric(a.lines)),lines:undefined})),lines:undefined})),lines:undefined}}).sort((a:any,b:any)=>a.code.localeCompare(b.code,'fr'));
 const budgetServiceOrder=['AP','VE','ALO','PAYE','SRH','OPC'];
 const budgetServices=budgetServiceOrder.map((code:string)=>{
  const xs=parsed.filter((x:any)=>String((x.dimension.cgr||[]).find((p:any)=>p.level===4)?.code||'').trim().toUpperCase()===code);
  if(!xs.length)return null;
  const first=xs[0],path=first.dimension.cgr||[],service=path.find((p:any)=>p.level===4),l2=path.find((p:any)=>p.level===2),l3=path.find((p:any)=>p.level===3);
  const depLines=xs.filter((x:any)=>direction(x)==='DEP'),recLines=xs.filter((x:any)=>direction(x)==='REC');
  const side=(sideLines:any[])=>{
   const m=positive(metric(sideLines));
   const domains=new Map<string,any>();
   for(const x of sideLines){
    const p=x.dimension.cgr||[],d5=p.find((q:any)=>q.level===5),d6=p.find((q:any)=>q.level===6);
    const dcode=cleanCode(String(d5?.code||'Sans domaine'),code);
    if(!domains.has(dcode))domains.set(dcode,{code:dcode,label:String(d5?.label||dcode).trim(),lines:[],activities:new Map()});
    const d=domains.get(dcode);d.lines.push(x);
    if(d6){const acode=cleanCode(String(d6.code||''),String(d5?.code||''));if(!d.activities.has(acode))d.activities.set(acode,{code:acode,label:String(d6.label||acode).trim(),lines:[]});d.activities.get(acode).lines.push(x)}
   }
   return {...m,rate:m.budget?m.accounted/m.budget:null,domains:[...domains.values()].map((d:any)=>{const dm=positive(metric(d.lines));return {code:d.code,label:d.label,...dm,rate:dm.budget?dm.accounted/dm.budget:null,activities:[...d.activities.values()].map((a:any)=>{const am=positive(metric(a.lines));return {code:a.code,label:a.label,...am,rate:am.budget?am.accounted/am.budget:null}})}})};
  };
  const expenses=side(depLines),revenues=side(recLines),balance=revenues.budget-expenses.budget;
  return {code,label:String(service?.label||code).trim(),sectionCode:String(l2?.code||'').trim(),scopeCode:String(l3?.code||'').trim(),section:code==='OPC'?'INVESTMENT':code==='SRH'?'SPECIAL':'OPERATING',expenses,revenues,balance};
 }).filter(Boolean);
 const signals=services.filter((s:any)=>s.direction==='DEP'&&s.budget>0&&s.committed/s.budget>=.85).map((s:any)=>({level:s.committed/s.budget>=1?'alert':'watch',service:s.code,title:`${s.code} : ${(s.committed/s.budget*100).toFixed(0)} % engagé`,detail:`${s.committed.toFixed(2)} € engagés sur ${s.budget.toFixed(2)} €.`}));
 const sourceRows=parsed.map((x:any)=>({lineNo:x.line_no,direction:direction(x)||'AUTRE',cgr:(x.dimension.cgr||[]).map((p:any)=>({level:p.level,code:p.code,label:p.label})),posts:(x.dimension.posts||[]).map((p:any)=>({level:p.level,code:p.code,label:p.label})),account:x.dimension.account||'',accountLabel:x.dimension.accountLabel||'',budget:n(x.budget),committed:n(x.committed),accounted:n(x.accounted),inProgress:n(x.in_progress),available:n(x.available)}));
 return {establishment:{id:establishment.id,uai:establishment.uai,name:establishment.name,opaleEntity:establishment.opale_entity},availableExercises,snapshot:{id:snap.id,date:snap.snapshot_date,filename:snap.source_filename,createdAt:snap.created_at,rowCount:snap.row_count},summary,totals,scopes,services,budgetServices,signals,sourceRows};
}catch(e:any){req.log.error(e);return reply.code(400).send({error:e.message||'Lecture budgétaire impossible'})}});

app.get('/api/analysis', async () => {
 const latestBalance=(await pool.query('select * from balance_snapshots order by snapshot_date desc,created_at desc limit 1')).rows[0]||null;
 const latestBudget=(await pool.query('select * from budget_snapshots order by snapshot_date desc,created_at desc limit 1')).rows[0]||null;
 const latestPurchase=(await pool.query('select * from purchase_snapshots order by snapshot_date desc,created_at desc limit 1')).rows[0]||null;
 const latestFdr=(await pool.query('select * from fdr_snapshots order by snapshot_date desc,created_at desc limit 1')).rows[0]||null;
 const signals:any[]=[]; const metrics:any={};
 if(latestBudget){
  const q=(await pool.query('select coalesce(sum(budget),0) budget,coalesce(sum(committed),0) committed,coalesce(sum(accounted),0) accounted,coalesce(sum(in_progress),0) in_progress,coalesce(sum(available),0) available from budget_lines where snapshot_id=$1',[latestBudget.id])).rows[0];
  Object.assign(metrics,{budget:{...q,snapshotDate:latestBudget.snapshot_date,establishment:latestBudget.establishment_name}});
  const b=Number(q.budget), committed=Number(q.committed), avail=Number(q.available);
  if(b>0){metrics.budget.executionRate=committed/b;metrics.budget.engagementRate=committed/b;metrics.budget.trajectoryTarget=budgetTrajectoryTarget(latestBudget.snapshot_date);const sig=budgetSignal(q,latestBudget.snapshot_date);if(sig)signals.push(sig);}
  metrics.budget.availableRate=b?avail/b:null;
 }
 if(latestPurchase){
  const q=(await pool.query(`select count(*)::int lines,coalesce(sum(abs(invoice_amount)),0) invoiced,coalesce(sum(abs(ordered_price*quantity)),0) ordered,coalesce(sum(case when order_date < current_date-60 and abs(invoice_balance_quantity)>.0001 then 1 else 0 end),0)::int old_uninvoiced,coalesce(sum(case when receipt_date is not null and abs(invoice_balance_quantity)>.0001 then 1 else 0 end),0)::int received_uninvoiced from purchase_lines where snapshot_id=$1`,[latestPurchase.id])).rows[0];
  metrics.purchases={...q,snapshotDate:latestPurchase.snapshot_date,establishment:latestPurchase.establishment_name};
  if(Number(q.old_uninvoiced)>0)signals.push({code:'ACH-OLD',level:'watch',domain:'Achats',title:'Commandes anciennes restant à facturer',detail:`${q.old_uninvoiced} ligne(s) de commande de plus de 60 jours présentent encore un solde de facturation.`,count:Number(q.old_uninvoiced)});
  if(Number(q.received_uninvoiced)>0)signals.push({code:'ACH-REC',level:'watch',domain:'Achats',title:'Réceptions restant à rapprocher de la facturation',detail:`${q.received_uninvoiced} ligne(s) réceptionnée(s) présentent encore un solde de facturation.`,count:Number(q.received_uninvoiced)});
 }
 if(latestBalance){
  const a=(await pool.query("select severity,title,detail,account,amount,rule_code from accounting_alerts where snapshot_id=$1 order by case severity when 'alert' then 0 else 1 end,abs(amount) desc limit 25",[latestBalance.id])).rows;
  metrics.accounting={snapshotDate:latestBalance.snapshot_date,establishment:latestBalance.establishment_name,signalCount:a.length};
  for(const x of a)signals.push({code:x.rule_code,level:x.severity,domain:'Comptabilité générale',title:x.title,detail:x.detail,account:x.account,amount:Number(x.amount)});
 }
 if(latestFdr){
  const f=(await pool.query('select exercise,amount,is_final from fdr_lines where snapshot_id=$1 order by exercise desc',[latestFdr.id])).rows.map((x:any)=>({...x,amount:Number(x.amount)})); metrics.fdr={history:f,snapshotDate:latestFdr.snapshot_date,establishment:latestFdr.establishment_name};
  if(f.length){const cur=f[0],prev=f.find((x:any)=>x.exercise===cur.exercise-1); if(prev){const variation=cur.amount-prev.amount,rate=prev.amount?variation/prev.amount:null; metrics.fdr.variation=variation;metrics.fdr.variationRate=rate;metrics.fdr.comparisonNature=cur.is_final?'definitive':'provisional_vs_definitive'; if(variation<0)signals.push({code:'FDR-DOWN',level:'watch',domain:'Santé financière',title:'Fonds de roulement en diminution',detail:`FDR ${cur.exercise}${cur.is_final?' définitif':' provisoire'} : ${cur.amount.toFixed(2)} € ; ${prev.exercise} : ${prev.amount.toFixed(2)} €. Comparaison à interpréter selon le caractère définitif des situations.`,amount:variation});}}
 }
 const freshness=[['Balance',latestBalance],['Budget',latestBudget],['CLCA',latestPurchase],['FDR',latestFdr]].map(([type,s]:any)=>({type,available:!!s,snapshotDate:s?.snapshot_date||null,establishment:s?.establishment_name||null}));
 const rank:any={alert:0,watch:1,ok:2}; signals.sort((a,b)=>(rank[a.level]??9)-(rank[b.level]??9)||Math.abs(b.amount||0)-Math.abs(a.amount||0));
 return {version:VERSION,generatedAt:new Date().toISOString(),metrics,signals,freshness,method:'Règles déterministes et traçables ; une absence de donnée n’est jamais assimilée à zéro.'};
});


app.get('/api/integrations/pcif/status', async () => ({
  configured:!!(PCIF_BASE_URL&&PCIF_API_KEY), baseUrl:PCIF_BASE_URL||null, cacheMinutes:PCIF_CACHE_MINUTES,
  cached:(await pool.query('select count(*)::int n,max(updated_at) last_sync from pcif_context')).rows[0]
}));
app.post('/api/integrations/pcif/sync', async (req:any, reply:any) => {
  try { const uais=Array.isArray(req.body?.uais)?req.body.uais.map(String):[]; return {ok:true,...await syncPcifSummaries(uais)}; }
  catch(e:any){ req.log.warn(e); return reply.code(502).send({error:e.message||'Synchronisation PCIF impossible'}); }
});

app.get('/api/establishments',async(req:any)=>{if(isAdmin(req))return {establishments:(await pool.query(`select id,uai,name,opale_entity,is_active,accounting_agency_id,created_at,updated_at,archived_at from establishments order by is_active desc,name`)).rows};return {establishments:await allowedEstablishments(req)}});
app.post('/api/establishments',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const b=req.body||{},uai=String(b.uai||'').trim().toUpperCase(),name=String(b.name||'').trim(),opale=String(b.opaleEntity||'').trim().toUpperCase()||null;if(!/^[0-9]{7,8}[A-Z]$/.test(uai))return reply.code(400).send({error:'UAI invalide.'});if(!name)return reply.code(400).send({error:'Le nom est obligatoire.'});try{const q=await pool.query(`insert into establishments(uai,name,opale_entity) values($1,$2,$3) returning *`,[uai,name,opale]);return {ok:true,establishment:q.rows[0]}}catch(e:any){return reply.code(409).send({error:e.code==='23505'?'UAI ou code ETS déjà utilisé.':e.message})}});
app.put('/api/establishments/:id',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const b=req.body||{},name=String(b.name||'').trim(),opale=String(b.opaleEntity||'').trim().toUpperCase()||null;if(!name)return reply.code(400).send({error:'Le nom est obligatoire.'});try{const q=await pool.query(`update establishments set name=$2,opale_entity=$3,is_active=true,archived_at=null,updated_at=now() where id=$1 returning *`,[req.params.id,name,opale]);if(!q.rowCount)return reply.code(404).send({error:'Établissement introuvable.'});return {ok:true,establishment:q.rows[0]}}catch(e:any){return reply.code(409).send({error:e.code==='23505'?'Code ETS déjà utilisé.':e.message})}});
app.post('/api/establishments/:id/restore',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const q=await pool.query(`update establishments set is_active=true,archived_at=null,updated_at=now() where id=$1 returning *`,[req.params.id]);return q.rowCount?{ok:true,establishment:q.rows[0]}:reply.code(404).send({error:'Établissement introuvable.'})});
app.delete('/api/establishments/:id',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const c=await pool.connect();try{await c.query('begin');const e=(await c.query('select * from establishments where id=$1 for update',[req.params.id])).rows[0];if(!e){await c.query('rollback');return reply.code(404).send({error:'Établissement introuvable.'})}const counts=(await c.query(`select (select count(*) from accounting_imports where opale_entity=$1)+(select count(*) from balance_snapshots where opale_entity=$1)+(select count(*) from budget_snapshots where opale_entity=$1)+(select count(*) from pcif_context where uai=$2) n`,[e.opale_entity||'',e.uai])).rows[0];if(Number(counts.n)>0){const q=await c.query(`update establishments set is_active=false,archived_at=now(),updated_at=now() where id=$1 returning *`,[e.id]);await c.query('commit');return {ok:true,mode:'archived',establishment:q.rows[0]}}await c.query('delete from establishments where id=$1',[e.id]);await c.query('commit');return {ok:true,mode:'deleted'}}catch(err:any){await c.query('rollback');return reply.code(400).send({error:err.message})}finally{c.release()}});

app.get('/api/admin/users',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const users=(await pool.query(`select id,email,first_name,last_name,global_role,is_active,last_login_at,created_at from users order by last_name,first_name,email`)).rows;return {users}});
app.post('/api/admin/users',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const b=req.body||{},email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(!email.includes('@'))return reply.code(400).send({error:'Adresse électronique invalide.'});if(password.length<12)return reply.code(400).send({error:'Le mot de passe initial doit contenir au moins 12 caractères.'});try{const q=await pool.query(`insert into users(email,first_name,last_name,password_hash,global_role) values($1,$2,$3,$4,$5) returning id,email,first_name,last_name,global_role,is_active`,[email,String(b.firstName||''),String(b.lastName||''),passwordHash(password),b.globalRole==='ADMIN'?'ADMIN':'USER']);await audit(req,'USER_CREATE',null,{userId:q.rows[0].id,email});return {ok:true,user:q.rows[0]}}catch(e:any){return reply.code(409).send({error:e.code==='23505'?'Cette adresse est déjà utilisée.':e.message})}});
app.put('/api/admin/users/:id/agencies',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});const roles=Array.isArray(req.body?.roles)?req.body.roles:[];const c=await pool.connect();try{await c.query('begin');await c.query('delete from user_agency_roles where user_id=$1',[req.params.id]);for(const r of roles)await c.query('insert into user_agency_roles(user_id,accounting_agency_id,role) values($1,$2,$3)',[req.params.id,Number(r.agencyId),String(r.role)]);await c.query('commit');await audit(req,'USER_SCOPE_UPDATE',null,{userId:req.params.id,roles});return {ok:true}}catch(e:any){await c.query('rollback');return reply.code(400).send({error:e.message})}finally{c.release()}});
app.get('/api/admin/agencies',async(req:any,reply:any)=>{if(!isAdmin(req))return reply.code(403).send({error:'Droit administrateur requis.'});return {agencies:(await pool.query('select id,name,is_active from accounting_agencies order by name')).rows}});

app.get('/api/dashboard', async (req:any) => {
  const allowed=await allowedEstablishments(req);const allowedIds=allowed.map((x:any)=>Number(x.id));
  const [registry,balances,budgets,purchases,fdrs,treasuries,financials] = await Promise.all([
    pool.query(`select id,uai,name,opale_entity,is_active from establishments where id=any($1::bigint[]) order by name`,[allowedIds]),
    pool.query(`select distinct on (coalesce(nullif(opale_entity,''),establishment_name)) id,coalesce(nullif(opale_entity,''),establishment_name) source_key,establishment_name,opale_entity,opale_entity_label,snapshot_date,created_at from balance_snapshots order by coalesce(nullif(opale_entity,''),establishment_name),snapshot_date desc,created_at desc`),
    pool.query(`select distinct on (coalesce(nullif(opale_entity,''),establishment_name)) id,coalesce(nullif(opale_entity,''),establishment_name) source_key,establishment_name,opale_entity,snapshot_date,created_at from budget_snapshots order by coalesce(nullif(opale_entity,''),establishment_name),snapshot_date desc,created_at desc`),
    pool.query(`select distinct on (establishment_name) id,establishment_name source_key,establishment_name,snapshot_date,created_at from purchase_snapshots order by establishment_name,snapshot_date desc,created_at desc`),
    pool.query(`select distinct on (establishment_name) id,establishment_name source_key,establishment_name,snapshot_date,created_at from fdr_snapshots order by establishment_name,snapshot_date desc,created_at desc`),
    pool.query(`select distinct on (opale_entity) id,opale_entity source_key,opale_entity,opale_entity establishment_name,source_format,period_to snapshot_date,period_to,created_at from accounting_imports order by opale_entity,created_at desc`),
    pool.query(`select distinct on (opale_entity) id,opale_entity source_key,opale_entity,opale_entity establishment_name,snapshot_date,created_at from financial_snapshots order by opale_entity,created_at desc`)
  ]);
  const map=new Map<string,any>();
  const archived=new Set(registry.rows.filter((x:any)=>!x.is_active).flatMap((x:any)=>[x.opale_entity,x.uai].filter(Boolean)));
  const ensure=(key:string,name?:string)=>{if(archived.has(key))return null;if(!map.has(key))map.set(key,{key,name:name||key,uai:null,registryId:null,opaleEntity:key,sources:{balance:null,budget:null,purchases:null,fdr:null,treasury:null,financial:null},signals:[]});return map.get(key)};
  for(const x of registry.rows.filter((x:any)=>x.is_active)){const key=x.opale_entity||x.uai;const e=ensure(key,x.name);if(e){e.name=x.name;e.uai=x.uai;e.registryId=x.id;e.opaleEntity=x.opale_entity||null}}
  for(const x of balances.rows){const e=ensure(x.source_key,x.opale_entity_label||x.establishment_name);if(e){e.name=e.registryId?e.name:(x.opale_entity_label||e.name);e.sources.balance=x}}
  for(const x of budgets.rows){const e=ensure(x.source_key,x.establishment_name);if(e)e.sources.budget=x}
  for(const x of purchases.rows){const e=ensure(x.source_key,x.establishment_name);if(e)e.sources.purchases=x}
  for(const x of fdrs.rows){const e=ensure(x.source_key,x.establishment_name);if(e)e.sources.fdr=x}
  for(const x of treasuries.rows){const e=ensure(x.source_key,x.establishment_name);if(e)e.sources.treasury=x}
  for(const x of financials.rows){const e=ensure(x.source_key,x.establishment_name);if(e)e.sources.financial=x}
  const severity=(xs:any[])=>xs.some(x=>x.level==='alert')?'alert':xs.some(x=>x.level==='watch')?'watch':'ok';
  const establishments:any[]=[]; let totalBudget=0,totalAvailable=0,totalAccounted=0,totalCommitted=0,totalInProgress=0;
  for(const e of map.values()){
    const states:any={budget:'missing',financial:'missing',recovery:'missing',suppliers:'missing',accounting:'missing',treasury:'missing'};
    if(e.sources.budget){
      const q=(await pool.query(`select coalesce(sum(budget),0) budget,coalesce(sum(committed),0) committed,coalesce(sum(accounted),0) accounted,coalesce(sum(in_progress),0) in_progress,coalesce(sum(available),0) available from budget_lines where snapshot_id=$1`,[e.sources.budget.id])).rows[0];
      const m={budget:Number(q.budget),committed:Number(q.committed),accounted:Number(q.accounted),inProgress:Number(q.in_progress),available:Number(q.available)}; e.budgetMetrics=m;
      totalBudget+=m.budget;totalAvailable+=m.available;totalAccounted+=m.accounted;totalCommitted+=m.committed;totalInProgress+=m.inProgress;
      const rate=m.budget?m.committed/m.budget:null; e.budgetMetrics.engagementRate=rate;e.budgetMetrics.trajectoryTarget=budgetTrajectoryTarget(e.sources.budget.snapshot_date);
      const bs=budgetSignal(m,e.sources.budget.snapshot_date);if(bs)e.signals.push(bs);
      states.budget=severity(e.signals.filter((x:any)=>x.domain==='Budget'));
    }
    if(e.sources.purchases){
      const q=(await pool.query(`select coalesce(sum(case when order_date < current_date-60 and abs(invoice_balance_quantity)>.0001 then 1 else 0 end),0)::int old_uninvoiced,coalesce(sum(case when receipt_date is not null and abs(invoice_balance_quantity)>.0001 then 1 else 0 end),0)::int received_uninvoiced from purchase_lines where snapshot_id=$1`,[e.sources.purchases.id])).rows[0];
      if(Number(q.old_uninvoiced)>0)e.signals.push({code:'ACH-OLD',level:'watch',domain:'Fournisseurs',title:'Commandes anciennes restant à facturer',detail:`${q.old_uninvoiced} ligne(s) de plus de 60 jours avec solde de facturation.`,count:Number(q.old_uninvoiced)});
      if(Number(q.received_uninvoiced)>0)e.signals.push({code:'ACH-REC',level:'watch',domain:'Fournisseurs',title:'Réceptions restant à rapprocher',detail:`${q.received_uninvoiced} ligne(s) réceptionnée(s) présentent encore un solde de facturation.`,count:Number(q.received_uninvoiced)});
      states.suppliers=severity(e.signals.filter((x:any)=>x.domain==='Fournisseurs'));
    }
    if(e.sources.balance){
      const a=(await pool.query(`select severity,rule_code,title,detail,account,amount from accounting_alerts where snapshot_id=$1 order by case severity when 'alert' then 0 else 1 end,abs(amount) desc limit 20`,[e.sources.balance.id])).rows;
      for(const x of a)e.signals.push({code:x.rule_code,level:x.severity,domain:'Comptabilité générale',title:x.title,detail:x.detail,account:x.account,amount:Number(x.amount),evidence:[{label:'Compte',value:x.account},{label:'Solde net',value:Number(x.amount)}],condition:x.rule_code==='CG-585'?'Solde du compte 585 différent de zéro':'Solde non nul sur un compte surveillé',interpretation:'Signal à examiner et, le cas échéant, à apurer. Il ne préjuge pas à lui seul d’une anomalie.',source:'EBLC / balance Op@le'});
      states.accounting=a.length?severity(a.map((x:any)=>({level:x.severity}))):'ok';
    }
    let trend='stable';
    if(e.sources.fdr){
      const h=(await pool.query(`select exercise,amount,is_final from fdr_lines where snapshot_id=$1 order by exercise desc`,[e.sources.fdr.id])).rows.map((x:any)=>({...x,amount:Number(x.amount)})); e.fdrHistory=h;
      if(h.length){const cur=h[0],prev=h.find((x:any)=>x.exercise===cur.exercise-1);if(prev){const d=cur.amount-prev.amount;trend=d<0?'down':d>0?'up':'stable';if(d<0)e.signals.push({code:'FDR-DOWN',level:'watch',domain:'Santé financière',title:'Fonds de roulement en diminution',detail:`${cur.exercise}${cur.is_final?' définitif':' provisoire'} : ${cur.amount.toFixed(2)} € ; ${prev.exercise} : ${prev.amount.toFixed(2)} €.`,amount:d});}}
      states.financial=severity(e.signals.filter((x:any)=>x.domain==='Santé financière'));
    }
    if(e.sources.treasury){
      e.treasury=await treasuryContext(pool,e.sources.treasury);
      e.signals.push(...(e.treasury?.signals||[]));
      states.treasury=severity(e.signals.filter((x:any)=>x.domain==='Trésorerie'));
    }
    const uai=e.uai||uaiOf(e.sources.balance?.opale_entity_label,e.sources.balance?.establishment_name,e.sources.budget?.establishment_name,e.sources.purchases?.establishment_name,e.sources.fdr?.establishment_name,e.sources.treasury?.establishment_name,e.name);
    const updateDates=Object.values(e.sources).filter(Boolean).map((x:any)=>String(x.created_at||x.snapshot_date||'')).filter(Boolean).sort();
    const freshness=updateDates.length?updateDates[updateDates.length-1]:null;
    const staleSources=Object.entries(e.sources).filter(([,x]:any)=>x&&((Date.now()-new Date(x.snapshot_date).getTime())/86400000)>30).map(([k])=>k);
    e.signals.sort((a:any,b:any)=>(a.level==='alert'?0:1)-(b.level==='alert'?0:1)||Math.abs(b.amount||0)-Math.abs(a.amount||0));
    establishments.push({id:e.key,registryId:e.registryId,opaleEntity:e.opaleEntity,uai,name:e.name,states,trend,freshness,sources:e.sources,staleSources,signals:e.signals,budgetMetrics:e.budgetMetrics||null,fdrHistory:e.fdrHistory||[],treasury:e.treasury||null});
  }
  try{
    const uais=establishments.map((e:any)=>e.uai).filter(Boolean);
    if(PCIF_BASE_URL&&PCIF_API_KEY&&uais.length){
      const stale=(await pool.query(`select count(*)::int n from pcif_context where uai=any($1::text[]) and updated_at > now()-($2||' minutes')::interval`,[uais,String(PCIF_CACHE_MINUTES)])).rows[0].n;
      if(Number(stale)<uais.length){try{await syncPcifSummaries(uais)}catch(err){app.log.warn({err},'Synchronisation PCIF non bloquante impossible')}}
    }
    const pcif=(await pool.query('select establishment_key,uai,campaign_label,campaign_status,mastery_level,mastery_scale,completion,answered,total,open_actions,major_risks,overdue_actions,trend,attention,source_url,raw_payload,updated_at from pcif_context')).rows;
    for(const e of establishments){
      e.pcif=pcif.find((p:any)=>(e.uai&&p.uai===e.uai)||p.establishment_key===e.id)||null;
      if(e.pcif)e.pcif.consistency=masteryConsistency(e,e.pcif);
    }
  }catch(err){app.log.warn({err},'Construction du contexte PCIF impossible')}
  const signals=establishments.flatMap(e=>e.signals.map((s:any)=>({...s,establishment:e.name,establishmentId:e.id}))).sort((a:any,b:any)=>(a.level==='alert'?0:1)-(b.level==='alert'?0:1)||Math.abs(b.amount||0)-Math.abs(a.amount||0));
  const actionRequired=signals.filter((s:any)=>s.level==='alert').length, watch=signals.filter((s:any)=>s.level==='watch').length;
  const stale=establishments.reduce((n,e)=>n+e.staleSources.length,0);
  return {version:VERSION,generatedAt:new Date().toISOString(),kpis:{establishments:establishments.length,actionRequired,watch,stale,totalBudget,totalAvailable,totalAccounted,totalCommitted,totalInProgress},establishments,signals:signals.slice(0,50)};
});

app.get('/api/pcif-context/:establishmentId',async(req:any)=>{try{return {context:(await pool.query('select * from pcif_context where establishment_key=$1',[req.params.establishmentId])).rows[0]||null}}catch{return {context:null}}});
app.post('/api/pcif-context/:establishmentId',async(req:any,reply:any)=>{const b=req.body||{};try{const q=await pool.query(`insert into pcif_context(establishment_key,campaign_label,mastery_level,open_actions,major_risks,source_url,updated_at) values($1,$2,$3,$4,$5,$6,now()) on conflict(establishment_key) do update set campaign_label=excluded.campaign_label,mastery_level=excluded.mastery_level,open_actions=excluded.open_actions,major_risks=excluded.major_risks,source_url=excluded.source_url,updated_at=now() returning *`,[req.params.establishmentId,b.campaignLabel||null,b.masteryLevel??null,b.openActions??0,b.majorRisks??0,b.sourceUrl||null]);return {ok:true,context:q.rows[0]}}catch(e:any){return reply.code(400).send({error:e.message})}});

app.get('/api/snapshots',async()=>({snapshots:(await pool.query('select id, establishment_name, snapshot_date, source_filename, row_count, created_at from balance_snapshots order by snapshot_date desc, created_at desc limit 50')).rows}));
app.get('/api/snapshots/:id', async (req:any, reply) => {
  const snapshot=(await pool.query('select * from balance_snapshots where id=$1',[req.params.id])).rows[0];
  if(!snapshot) return reply.code(404).send({error:'Snapshot introuvable'});
  const alerts=(await pool.query("select * from accounting_alerts where snapshot_id=$1 order by case severity when 'alert' then 0 else 1 end, abs(amount) desc",[req.params.id])).rows;
  return {snapshot,alerts};
});
app.post('/api/import/balance',async(req:any,reply:any)=>{try{
  const file=await req.file(); if(!file)return reply.code(400).send({error:'Fichier manquant'});
  const fields:any=file.fields||{};
  const date=String(fields.snapshotDate?.value||new Date().toISOString().slice(0,10));
  const buf=await file.toBuffer(); const p=await parseInput(buf,file.filename);
  const establishment=String(fields.establishment?.value||p.entityLabel||'Établissement non renseigné');
  const alerts=analyse(p.rows); const client=await pool.connect();
  try{await client.query('begin'); const s=(await client.query('insert into balance_snapshots(establishment_name,snapshot_date,source_filename,sheet_name,row_count,source_format,opale_entity,opale_entity_label) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[establishment,date,file.filename,p.sheet,p.rows.length,p.format,p.entity,p.entityLabel])).rows[0];
    for(const r of p.rows)await client.query('insert into balance_lines(snapshot_id,line_no,account,label,prior_debit,prior_credit,period_debit,period_credit,debit,credit,net) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[s.id,r.line,r.account,r.label,r.priorDebit,r.priorCredit,r.periodDebit,r.periodCredit,r.debit,r.credit,r.net]);
    for(const a of alerts)await client.query('insert into accounting_alerts(snapshot_id,rule_code,severity,title,detail,account,amount) values($1,$2,$3,$4,$5,$6,$7)',[s.id,a.code,a.level,a.title,a.detail,a.account,a.amount]);
    await client.query('commit'); return {ok:true,snapshot:s,control:{sourceRows:p.sourceRows,importedRows:p.rows.length,rejectedRows:p.sourceRows-p.rows.length},alerts};
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
}catch(e:any){req.log.error(e);return reply.code(400).send({error:e.message||'Import impossible'})}});
app.setNotFoundHandler((req, reply) => reply.code(404).send({error:'Route API introuvable',method:req.method,path:req.url,version:VERSION}));
app.listen({port:Number(process.env.PORT||3211),host:'0.0.0.0'});
