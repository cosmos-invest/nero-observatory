import process from 'node:process';
import { chromium } from 'playwright-core';

const DASHBOARD_URL='https://note.com/dashboard';
const TIME_ZONE='Asia/Tokyo';

function cookieValue(raw=''){
  let text=raw.trim().replace(/^cookie:\s*/i,'');
  if((text.startsWith('"')&&text.endsWith('"'))||(text.startsWith("'")&&text.endsWith("'"))) text=text.slice(1,-1).trim();
  if(!text.includes('_note_session_v5=')) return text;
  const pair=text.split(';').map(v=>v.trim()).find(v=>v.startsWith('_note_session_v5='));
  return pair?pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g,''):'';
}

function scan(obj,path='',out=[],depth=0){
  if(obj==null||depth>18) return out;
  if(Array.isArray(obj)){ for(let i=0;i<obj.length;i++) scan(obj[i],`${path}[${i}]`,out,depth+1); return out; }
  if(typeof obj!=='object') return out;
  for(const [k,v] of Object.entries(obj)){
    const p=path? `${path}.${k}`:k;
    if(/sales|revenue|earning|amount|purchase/i.test(k) && (typeof v==='number'||typeof v==='string'||typeof v==='boolean'||v===null)){
      out.push({path:p,value:v});
    }
    if(v&&typeof v==='object') scan(v,p,out,depth+1);
  }
  return out;
}

const cookie=cookieValue(process.env.NOTE_SESSION_COOKIE??'');
if(!cookie) throw new Error('NOTE_SESSION_COOKIE is required');

const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
  const context=await browser.newContext({locale:'ja-JP',timezoneId:TIME_ZONE});
  await context.addCookies([{name:'_note_session_v5',value:cookie,domain:'.note.com',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();
  const seen=new Set();

  page.on('response',async(response)=>{
    const req=response.request();
    let body;
    try{ body=req.postDataJSON(); }catch{return;}
    if(!body?.operationName) return;
    let json;
    try{ json=await response.json(); }catch{return;}
    const matches=scan(json).filter((x,i,a)=>a.findIndex(y=>y.path===x.path&&y.value===x.value)===i).slice(0,100);
    if(!matches.length) return;
    const key=body.operationName+JSON.stringify(matches);
    if(seen.has(key)) return;
    seen.add(key);
    console.log(JSON.stringify({operationName:body.operationName,variables:body.variables,matches},null,2));
  });

  await page.goto(DASHBOARD_URL,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(9000);
  if(/login|signin/.test(page.url())) throw new Error('note session redirected to login');

  const metricButton=page.getByRole('button',{name:/インプレッション/}).first();
  if(await metricButton.count()){
    await metricButton.click();
    const salesOption=page.getByText('売上',{exact:true}).last();
    if(await salesOption.count()){
      await salesOption.click();
      await page.waitForTimeout(6000);
    }
  }

  console.log(JSON.stringify({ok:true,captures_with_sales_fields:seen.size}));
}finally{
  await browser.close();
}
