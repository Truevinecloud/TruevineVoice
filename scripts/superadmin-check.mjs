import { readFileSync } from 'node:fs';
import { fetch } from 'node:fetch';
const creds = JSON.parse(readFileSync('.qa-credentials/org-qa-credentials.json','utf8'));
const info = creds['qa-super-admin@example.invalid'];
const webBase = 'http://localhost:3000/api';
const apiBase = 'http://localhost:3001';
function absorb(res,jar){ const sc=res.headers.getSetCookie?res.headers.getSetCookie():[]; for(const h of sc){const first=h.split(';',1)[0];const i=first.indexOf('=');if(i<=0)continue;const name=first.slice(0,i).trim();const value=first.slice(i+1).trim();if(value.length===0)jar.delete(name);else jar.set(name,value);} }
function cookieHeader(jar){return [...jar.entries()].map(([n,v])=>`${n}=${v}`).join('; ');}
async function ensureCsrf(jar){ if(jar.has('tv_csrf')) return decodeURIComponent(jar.get('tv_csrf')); const res=await fetch(`${webBase}/auth/terms`,{headers:{cookie:cookieHeader(jar)},cache:'no-store'}); absorb(res,jar); return decodeURIComponent(jar.get('tv_csrf')); }
const jar=new Map();
const csrf=await ensureCsrf(jar);
// direct API sign-in
const direct=await fetch(`${apiBase}/auth/sign-in`,{method:'POST',headers:{'content-type':'application/json','x-truevine-csrf':csrf,cookie:cookieHeader(jar)},body:JSON.stringify({email:info.email,password:info.password}),cache:'no-store'});
globalThis.console.log('direct status',direct.status, await direct.text());
// web proxy sign-in
const csrf2=await ensureCsrf(jar);
const proxied=await fetch(`${webBase}/auth/sign-in`,{method:'POST',headers:{'content-type':'application/json','x-truevine-csrf':csrf2,cookie:cookieHeader(jar)},body:JSON.stringify({email:info.email,password:info.password}),cache:'no-store'});
globalThis.console.log('proxied status',proxied.status, await proxied.text());