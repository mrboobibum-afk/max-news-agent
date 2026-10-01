const MAX_API='https://platform-api2.max.ru';
const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta';
const QWEN_API='https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

const MAX_BOT_TOKEN=Deno.env.get('MAX_BOT_TOKEN')||'';
const GEMINI_API_KEY=Deno.env.get('GEMINI_API_KEY')||'';
const QWEN_API_KEY=Deno.env.get('QWEN_API_KEY')||'';
const TARGET_CHAT_ID=Deno.env.get('TARGET_CHAT_ID')||'';

const AUTO_PIPELINE=(Deno.env.get('AUTO_PIPELINE')||'false').toLowerCase()==='true';
const CRON_SCHEDULE=Deno.env.get('CRON_SCHEDULE')||'*/5 * * * *';

const NORMAL_PUBLISH_INTERVAL_MS=Number(
  Deno.env.get('NORMAL_PUBLISH_INTERVAL_MS')||1800000
);

const URGENT_MIN_GAP_MS=Number(
  Deno.env.get('URGENT_MIN_GAP_MS')||300000
);

const NEWS_HISTORY_TTL_MS=Number(
  Deno.env.get('NEWS_HISTORY_TTL_MS')||2592000000
);

const DEDUP_SIMILARITY=Number(
  Deno.env.get('DEDUP_SIMILARITY')||0.58
);

const CANDIDATES_PER_SCAN=Number(
  Deno.env.get('CANDIDATES_PER_SCAN')||15
);

const MAX_VIDEO_MB=Number(
  Deno.env.get('MAX_VIDEO_MB')||60
);

const MAX_IMAGE_MB=Number(
  Deno.env.get('MAX_IMAGE_MB')||15
);

const API_TIMEOUT_MS=Number(
  Deno.env.get('API_TIMEOUT_MS')||20000
);

const RETRIES=Number(
  Deno.env.get('API_RETRIES')||2
);

const MAX_WEBHOOK_SECRET=
  Deno.env.get('MAX_WEBHOOK_SECRET')||
  (
    MAX_BOT_TOKEN
      ? `factor-${MAX_BOT_TOKEN.slice(0,24)}`
      : ''
  );

const RSS_FEEDS=[
  'https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru'
];

const CATEGORY_EMOJI={
  МИР:'🌍',
  ПОЛИТИКА:'🏛️',
  ЭКОНОМИКА:'📈',
  ФИНАНСЫ:'💰',
  БИЗНЕС:'💼',
  ПРАВО:'⚖️',
  ПРОИСШЕСТВИЯ:'🚨',
  ТЕХНОЛОГИИ:'💻',
  ОБЩЕСТВО:'👥'
};

const STOP=new Set(
  'это этот эта эти также который которая которые после перед между через более менее будет были было есть при для как что его ее их они она ему из на в во и или но а по с со к у за от до не ни же ли да нет год года году сегодня вчера'
  .split(' ')
);

const recentPublished=new Map();

let kv=null;
let maxClient=null;

let maxTls={
  loaded:false,
  root:false,
  sub:false,
  error:null
};

let lastPipeline=null;
let running=false;

try{
  kv=await Deno.openKv();
}catch(e){
  console.error('[KV]',e?.message||e);
}

function json(data,status=200){
  return new Response(
    JSON.stringify(data,null,2),
    {
      status,
      headers:{
        'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store',
        'access-control-allow-origin':'*',
        'access-control-allow-methods':'GET,POST,OPTIONS',
        'access-control-allow-headers':
          'Content-Type,Authorization,X-Max-Bot-Api-Secret'
      }
    }
  );
}

function sleep(ms){
  return new Promise(r=>setTimeout(r,ms));
}

function esc(s){
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function cleanText(s){
  return String(s||'')
    .replace(/<[^>]*>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/\s+/g,' ')
    .trim();
}

function norm(s){
  return cleanText(s)
    .toLowerCase()
    .replace(/ё/g,'е')
    .replace(/https?:\/\/\S+/g,' ')
    .replace(/[^a-zа-я0-9]+/gi,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function tokens(s){
  return new Set(
    norm(s)
      .split(' ')
      .map(x=>{
        if(x.length<=4)return x;

        return x.replace(
          /(иями|ами|ями|ого|ему|ому|ыми|ими|ее|ие|ые|ое|ей|ий|ый|ой|ем|им|ым|ом|ам|ям|ах|ях|ов|ев|ы|и|а|я|е|о|у|ю)$/,
          ''
        );
      })
      .filter(
        x=>x.length>=4&&!STOP.has(x)
      )
  );
}

function similarity(a,b){
  if(!a.size||!b.size)return 0;

  let n=0;

  for(const x of a){
    if(b.has(x))n++;
  }

  return n/
    new Set([
      ...a,
      ...b
    ]).size;
}

function fingerprint(item){
  return `${norm(item.title)}|${norm(item.description).slice(0,700)}`
    .slice(0,1800);
}

function compact(item){
  return [
    ...tokens(
      `${item.title} ${item.description||''}`
    )
  ]
    .sort()
    .join(' ');
}

function sourceHost(url){
  try{
    return new URL(url)
      .hostname
      .replace(/^www\./,'');
  }catch{
    return '';
  }
}

function isGoogleHost(url){
  const h=sourceHost(url);

  return (
    /(^|\.)news\.google\./i.test(h)||
    /(^|\.)google\.(com|ru|co\.)/i.test(h)||
    /googleusercontent\.com$/i.test(h)
  );
}

function absoluteUrl(base,u){
  try{
    return new URL(u,base).toString();
  }catch{
    return '';
  }
}

async function initMaxClient(){

  if(maxClient)return maxClient;
  if(maxTls.error)return null;

  try{

    const a=await fetch(
      'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt',
      {
        signal:
          AbortSignal.timeout(10000)
      }
    );

    if(!a.ok){
      throw Error(
        `root CA HTTP ${a.status}`
      );
    }

    const b=await fetch(
      'https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt',
      {
        signal:
          AbortSignal.timeout(10000)
      }
    );

    if(!b.ok){
      throw Error(
        `sub CA HTTP ${b.status}`
      );
    }

    maxTls.root=true;
    maxTls.sub=true;

    maxClient=Deno.createHttpClient({
      caCerts:[
        await a.text(),
        await b.text()
      ]
    });

    maxTls.loaded=true;

    return maxClient;

  }catch(e){

    maxTls.error=
      e?.message||String(e);

    return null;
  }
}

function retryable(s){
  return (
    s===408||
    s===409||
    s===425||
    s===429||
    s>=500
  );
}

async function request(
  url,
  options={},
  cfg={}
){

  let last={
    ok:false,
    status:599,
    data:{
      error:'request failed'
    }
  };

  const retries=
    cfg.retries??RETRIES;

  for(
    let i=0;
    i<=retries;
    i++
  ){

    const controller=
      new AbortController();

    const timer=setTimeout(
      ()=>controller.abort(),
      cfg.timeoutMs??API_TIMEOUT_MS
    );

    try{

      const o={
        ...options,
        signal:controller.signal
      };

      if(cfg.max){

        const client=
          await initMaxClient();

        if(client){
          o.client=client;
        }
      }

      const r=await fetch(
        url,
        o
      );

      const text=
        await r.text();

      let data;

      try{
        data=
          text
            ? JSON.parse(text)
            : null;
      }catch{
        data={
          raw:text
        };
      }

      last={
        ok:r.ok,
        status:r.status,
        statusText:r.statusText,
        data
      };

      if(
        r.ok||
        !retryable(r.status)||
        i===retries
      ){
        return last;
      }

      await sleep(
        Math.min(
          8000,
          1000*2**i
        )
      );

    }catch(e){

      last={
        ok:false,
        status:
          e?.name==='AbortError'
            ? 504
            : 599,
        data:{
          error:
            e?.message||
            String(e)
        }
      };

      if(i<retries){
        await sleep(
          Math.min(
            8000,
            1000*2**i
          )
        );
      }

    }finally{
      clearTimeout(timer);
    }
  }

  return last;
}

async function maxRequest(
  path,
  options={}
){

  if(!MAX_BOT_TOKEN){
    throw Error(
      'MAX_BOT_TOKEN не задан'
    );
  }

  return request(
    `${MAX_API}${
      path.startsWith('/')
        ? path
        : '/'+path
    }`,
    {
      ...options,
      headers:{
        Authorization:
          MAX_BOT_TOKEN.trim(),
        Accept:
          'application/json',
        ...(options.body
          ? {
              'content-type':
                'application/json'
            }
          : {}),
        ...(options.headers||{})
      }
    },
    {
      max:true
    }
  );
}

/* ================= RSS ================= */

function tag(xml,tagName){

  const m=String(xml).match(
    new RegExp(
      `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
      'i'
    )
  );

  return m
    ? cleanText(
        m[1]
          .replace(
            /<!\[CDATA\[|\]\]>/g,
            ''
          )
      )
    : '';
}

function parseRSS(xml,feed){

  const out=[];

  for(
    const raw
    of String(xml)
      .match(
        /<item[\s\S]*?<\/item>/gi
      )||[]
  ){

    const title=
      tag(raw,'title');

    if(!title)continue;

    out.push({
      title,
      link:tag(raw,'link'),
      description:tag(raw,'description'),
      pubDate:tag(raw,'pubDate'),
      source:tag(raw,'source'),
      source_feed:feed
    });
  }

  return out;
}

async function fetchRSS(){

  return Promise.all(
    RSS_FEEDS.map(
      async feed=>{

        const r=
          await request(
            feed,
            {
              headers:{
                'user-agent':
                  'FACTOR-News-Agent/4.0'
              }
            },
            {
              timeoutMs:15000,
              retries:1
            }
          );

        if(!r.ok){
          return{
            feed,
            ok:false,
            error:r.data
          };
        }

        const xml=
          r.data?.raw||'';

        const items=
          parseRSS(
            xml,
            feed
          );

        return{
          feed,
          ok:true,
          count:items.length,
          items:items.slice(0,15)
        };
      }
    )
  );
}

function flatten(feeds){

  return feeds
    .flatMap(
      x=>x.ok?x.items:[]
    )
    .sort(
      (a,b)=>
        (Date.parse(b.pubDate)||0)-
        (Date.parse(a.pubDate)||0)
    );
}

/* ================= AI ================= */

function extractGemini(data){

  return data
    ?.candidates?.[0]
    ?.content?.parts
    ?.map(
      x=>x?.text||''
    )
    .join('')
    .trim()||'';
}

function extractQwen(data){

  return (
    data?.choices?.[0]
      ?.message?.content||
    data?.choices?.[0]
      ?.text||
    ''
  );
}

async function gemini(
  model,
  prompt
){

  return request(
    `${GEMINI_BASE}/models/${
      encodeURIComponent(model)
    }:generateContent?key=${
      encodeURIComponent(
        GEMINI_API_KEY
      )
    }`,
    {
      method:'POST',
      headers:{
        'content-type':
          'application/json'
      },
      body:JSON.stringify({
        contents:[
          {
            parts:[
              {
                text:prompt
              }
            ]
          }
        ],
        generationConfig:{
          temperature:0.15,
          maxOutputTokens:1000
        }
      })
    },
    {
      retries:1
    }
  );
}

async function qwen(
  model,
  prompt
){

  return request(
    QWEN_API,
    {
      method:'POST',
      headers:{
        authorization:
          `Bearer ${QWEN_API_KEY}`,
        'content-type':
          'application/json'
      },
      body:JSON.stringify({
        model,
        messages:[
          {
            role:'system',
            content:
              'Ты редактор новостей. Только подтвержденные факты, без повторов и выдумок.'
          },
          {
            role:'user',
            content:prompt
          }
        ],
        stream:false
      })
    },
    {
      retries:1
    }
  );
}

async function ai(prompt){

  const attempts=[];

  for(
    const model
    of [
      'gemini-2.5-flash',
      'gemini-2.0-flash'
    ]
  ){

    if(!GEMINI_API_KEY)break;

    const r=
      await gemini(
        model,
        prompt
      );

    const text=
      extractGemini(
        r.data
      );

    attempts.push({
      provider:
        'Google Gemini',
      model,
      http_status:
        r.status,
      ok:r.ok
    });

    if(
      r.ok&&
      text
    ){
      return{
        ok:true,
        provider:
          'Google Gemini',
        model,
        text,
        attempts
      };
    }
  }

  for(
    const model
    of [
      'qwen-plus',
      'qwen-turbo'
    ]
  ){

    if(!QWEN_API_KEY)break;

    const r=
      await qwen(
        model,
        prompt
      );

    const text=
      extractQwen(
        r.data
      );

    attempts.push({
      provider:
        'Alibaba Qwen',
      model,
      http_status:
        r.status,
      ok:r.ok
    });

    if(
      r.ok&&
      text
    ){
      return{
        ok:true,
        provider:
          'Alibaba Qwen',
        model,
        text,
        attempts
      };
    }
  }

  return{
    ok:false,
    attempts,
    error:
      'AI не ответил'
  };
}

function parseJSON(text){

  const s=String(text||'')
    .replace(
      /```json/gi,
      ''
    )
    .replace(
      /```/g,
      ''
    )
    .trim();

  try{
    return JSON.parse(s);
  }catch{}

  const a=s.indexOf('{');
  const b=s.lastIndexOf('}');

  if(a>=0&&b>a){

    try{
      return JSON.parse(
        s.slice(a,b+1)
      );
    }catch{}
  }

  return null;
}

function category(item){

  const f=
    (item.source_feed||'')
      .toLowerCase();

  if(
    f.includes('технолог')||
    f.includes('промышлен')||
    f.includes('авто')
  ){
    return 'ТЕХНОЛОГИИ';
  }

  if(
    f.includes('происше')||
    f.includes('катастроф')||
    f.includes('криминал')
  ){
    return 'ПРОИСШЕСТВИЯ';
  }

  if(
    f.includes('финанс')||
    f.includes('эконом')||
    f.includes('бизнес')
  ){
    return 'ЭКОНОМИКА';
  }

  if(
    f.includes('политик')||
    f.includes('право')
  ){
    return 'ПОЛИТИКА';
  }

  return 'МИР';
}

function heuristicUrgent(item){

  return /(взрыв|теракт|террорист|ракета|ракетн|обстрел|землетряс|цунами|эвакуац|захват залож|крушение самол|массовая гибель|погибли|погиб |чрезвычайное положение|военное положение)/i
    .test(
      norm(
        `${item.title} ${item.description}`
      )
    );
}

function normalizeAnalysis(
  x,
  item
){

  const c=
    Object.keys(
      CATEGORY_EMOJI
    ).includes(
      String(
        x?.category||''
      ).toUpperCase()
    )
      ? String(
          x.category
        ).toUpperCase()
      : category(item);

  const p=
    (
      String(
        x?.priority||'normal'
      ).toLowerCase()==='urgent'||
      heuristicUrgent(item)
    )
      ? 'urgent'
      : 'normal';

  return{
    category:c,
    emoji:CATEGORY_EMOJI[c],
    priority:p,

    summary:
      cleanText(
        x?.summary
      )||
      cleanText(
        item.description
      )||
      cleanText(
        item.title
      ),

    facts:
      Array.isArray(x?.facts)
        ? x.facts
            .map(cleanText)
            .filter(Boolean)
            .slice(0,3)
        : [],

    important:
      cleanText(
        x?.important
      ),

    source_name:
      cleanText(
        x?.source_name
      )||
      item.source||
      sourceHost(item.link)||
      'Источник'
  };
}

function analysisPrompt(item){

  return `
Ты редактор новостного канала ФАКТОР.

Верни ТОЛЬКО валидный JSON без markdown.

ЗАГОЛОВОК:
${item.title}

ИСТОЧНИК:
${item.source||''}

ОПИСАНИЕ:
${cleanText(item.description)}

ФОРМАТ:
{
  "category":"МИР|ПОЛИТИКА|ЭКОНОМИКА|ФИНАНСЫ|БИЗНЕС|ПРАВО|ПРОИСШЕСТВИЯ|ТЕХНОЛОГИИ|ОБЩЕСТВО",
  "priority":"urgent|normal",
  "summary":"1-2 предложения без повторения заголовка",
  "facts":["до 3 новых фактов"],
  "important":"одно предложение только если есть реальное значение события",
  "source_name":"источник"
}

ПРАВИЛА:

1. Не выдумывать факты.
2. summary НЕ копирует заголовок.
3. facts НЕ повторяют summary.
4. Максимум 3 факта.
5. Не писать «Ситуация развивается» без подтвержденной причины.
6. Обычный пресс-релиз, анонс, мероприятие или локальное ДТП = normal.
7. urgent только для действительно немедленно значимого события.
8. Писать по-русски.
`.trim();
}

async function analyze(item){

  const r=
    await ai(
      analysisPrompt(item)
    );

  if(!r.ok){
    return{
      ok:false,
      ai:r
    };
  }

  return{
    ok:true,
    analysis:
      normalizeAnalysis(
        parseJSON(r.text)||{},
        item
      ),
    ai:r
  };
}

/* ================= KV / DEDUP ================= */

async function kvGet(key){

  if(!kv)return null;

  try{
    return (
      await kv.get(key)
    )?.value??null;
  }catch{
    return null;
  }
}

async function kvSet(
  key,
  value,
  expireIn=NEWS_HISTORY_TTL_MS
){

  if(!kv)return false;

  try{
    await kv.set(
      key,
      value,
      {
        expireIn
      }
    );

    return true;
  }catch{
    return false;
  }
}

async function history(){

  if(!kv)return[];

  const a=[];

  try{

    for await(
      const e
      of kv.list({
        prefix:[
          'news',
          'published'
        ],
        reverse:true,
        limit:300
      })
    ){

      if(e.value){
        a.push(
          e.value
        );
      }
    }

  }catch{}

  return a;
}

async function channelHistory(
  chatId
){

  if(!chatId)return[];

  try{

    const r=
      await maxRequest(
        `/messages?chat_id=${
          encodeURIComponent(
            chatId
          )
        }&count=50`,
        {
          method:'GET'
        }
      );

    const ms=
      Array.isArray(
        r.data?.messages
      )
        ? r.data.messages
        : [];

    return ms
      .map(m=>{

        const t=
          m?.body?.text||
          m?.text||
          '';

        return{
          link:'',
          title:t,
          fingerprint:'',
          compact_fingerprint:
            [
              ...tokens(t)
            ]
              .sort()
              .join(' ')
        };
      })
      .filter(
        x=>x.compact_fingerprint
      );

  }catch(e){

    console.error(
      '[CHANNEL HISTORY]',
      e?.message||e
    );

    return null;
  }
}

async function duplicate(
  item,
  h
){

  const link=
    String(
      item.link||''
    );

  const fp=
    fingerprint(item);

  const tok=
    tokens(
      `${item.title} ${
        item.description||''
      }`
    );

  for(
    const old
    of h
  ){

    if(
      link&&
      old.link&&
      link===old.link
    ){
      return{
        duplicate:true,
        reason:'same_link'
      };
    }

    if(
      fp&&
      old.fingerprint===fp
    ){
      return{
        duplicate:true,
        reason:'same_fingerprint'
      };
    }

    const ot=
      new Set(
        String(
          old.compact_fingerprint||''
        )
          .split(' ')
          .filter(Boolean)
      );

    const sim=
      similarity(
        tok,
        ot
      );

    if(
      sim>=DEDUP_SIMILARITY
    ){

      return{
        duplicate:true,
        reason:'similar_event',
        similarity:
          +sim.toFixed(3)
      };
    }
  }

  return{
    duplicate:false
  };
}

async function mark(
  item,
  a
){

  await kvSet(
    [
      'news',
      'published',
      `${Date.now()}-${crypto.randomUUID()}`
    ],
    {
      link:item.link,
      title:item.title,
      fingerprint:
        fingerprint(item),
      compact_fingerprint:
        compact(item),
      category:a.category,
      priority:a.priority,
      published_at:
        Date.now()
    }
  );

  recentPublished.set(
    item.link||item.title,
    Date.now()
  );
}

/* ================= MEDIA ================= */

function meta(
  html,
  name
){

  const re=[
    new RegExp(
      `<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i'
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`,
      'i'
    ),

    new RegExp(
      `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i'
    )
  ];

  for(
    const x
    of re
  ){

    const m=
      String(html)
        .match(x);

    if(m?.[1]){
      return cleanText(
        m[1]
      );
    }
  }

  return '';
}

function canonical(html){

  return(
    meta(
      html,
      'og:url'
    )||
    String(html)
      .match(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
      )
      ?. [1]||
    ''
  );
}

function mediaUrls(
  html,
  base
){

  const found=[];

  const push=(
    u,
    type
  )=>{

    const x=
      absoluteUrl(
        base,
        u
      );

    if(
      !x||
      isGoogleHost(x)||
      found.some(
        a=>a.url===x
      )
    ){
      return;
    }

    found.push({
      url:x,
      type
    });
  };

  for(
    const n
    of [
      'og:video',
      'og:video:url',
      'og:video:secure_url',
      'twitter:player:stream'
    ]
  ){

    push(
      meta(
        html,
        n
      ),
      'video'
    );
  }

  for(
    const m
    of String(html)
      .matchAll(
        /<video[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi
      )
  ){

    push(
      m[1],
      'video'
    );
  }

  for(
    const m
    of String(html)
      .matchAll(
        /<source[^>]+src=["']([^"']+)["'][^>]*>/gi
      )
  ){

    push(
      m[1],
      'video'
    );
  }

  for(
    const m
    of String(html)
      .matchAll(
        /"(?:contentUrl|videoUrl)"\s*:\s*"(https?:\/\/[^"]+)"/gi
      )
  ){

    push(
      m[1].replace(
        /\\\//g,
        '/'
      ),
      'video'
    );
  }

  const img=
    meta(
      html,
      'og:image'
    )||
    meta(
      html,
      'twitter:image'
    );

  if(
    img&&
    !isGoogleHost(img)
  ){

    push(
      img,
      'image'
    );
  }

  return found;
}

async function fetchPage(
  url
){

  try{

    const r=
      await fetch(
        url,
        {
          redirect:'follow',
          headers:{
            'user-agent':
              'Mozilla/5.0 (compatible; FACTOR/4.0)'
          },
          signal:
            AbortSignal.timeout(
              12000
            )
        }
      );

    if(!r.ok)return null;

    return{
      html:
        await r.text(),
      finalUrl:
        r.url||url
    };

  }catch{

    return null;
  }
}

async function mediaSize(
  url
){

  try{

    const r=
      await fetch(
        url,
        {
          method:'HEAD',
          redirect:'follow',
          signal:
            AbortSignal.timeout(
              8000
            )
        }
      );

    return{
      ok:r.ok,
      size:Number(
        r.headers.get(
          'content-length'
        )||0
      ),
      type:
        r.headers.get(
          'content-type'
        )||''
    };

  }catch{

    return{
      ok:false,
      size:0,
      type:''
    };
  }
}

async function findMedia(
  item,
  prefer='video'
){

  if(!item.link)return null;

  try{

    let p=
      await fetchPage(
        item.link
      );

    if(!p)return null;

    let urls=
      mediaUrls(
        p.html,
        p.finalUrl||item.link
      );

    const canon=
      absoluteUrl(
        p.finalUrl||item.link,
        canonical(p.html)
      );

    /*
     * Если Google News не отдал оригинальную
     * страницу — идём по canonical.
     */

    if(
      canon&&
      canon!==p.finalUrl&&
      !isGoogleHost(canon)
    ){

      const q=
        await fetchPage(
          canon
        );

      if(q){

        p=q;

        urls=
          mediaUrls(
            q.html,
            q.finalUrl||canon
          );
      }
    }

    const ordered=
      prefer==='image'
        ? [
            ...urls.filter(
              x=>x.type==='image'
            ),
            ...urls.filter(
              x=>x.type==='video'
            )
          ]
        : [
            ...urls.filter(
              x=>x.type==='video'
            ),
            ...urls.filter(
              x=>x.type==='image'
            )
          ];

    for(
      const m
      of ordered
    ){

      const limit=
        m.type==='video'
          ? MAX_VIDEO_MB
          : MAX_IMAGE_MB;

      const size=
        await mediaSize(
          m.url
        );

      if(
        size.size&&
        size.size>
          limit*1024*1024
      ){
        continue;
      }

      return{
        ...m,
        source_url:
          p.finalUrl||
          item.link
      };
    }

    return null;

  }catch(e){

    console.error(
      '[MEDIA]',
      e?.message||e
    );

    return null;
  }
}

/* ================= MAX MEDIA ================= */

async function uploadVideo(
  url
){

  try{

    const info=
      await mediaSize(
        url
      );

    if(
      info.size>
        MAX_VIDEO_MB*
        1024*
        1024
    ){

      return{
        ok:false,
        error:
          'video_too_large'
      };
    }

    const init=
      await maxRequest(
        '/uploads?type=video',
        {
          method:'POST'
        }
      );

    const uploadUrl=
      init.data?.url;

    const token=
      init.data?.token;

    if(
      !init.ok||
      !uploadUrl||
      !token
    ){

      return{
        ok:false,
        error:
          'max_upload_init_failed',
        response:
          init.data
      };
    }

    const src=
      await fetch(
        url,
        {
          redirect:'follow',
          headers:{
            'user-agent':
              'Mozilla/5.0'
          },
          signal:
            AbortSignal.timeout(
              30000
            )
        }
      );

    if(!src.ok){

      return{
        ok:false,
        error:
          `media_http_${src.status}`
      };
    }

    const bytes=
      await src.arrayBuffer();

    if(
      bytes.byteLength>
        MAX_VIDEO_MB*
        1024*
        1024
    ){

      return{
        ok:false,
        error:
          'video_too_large'
      };
    }

    const contentType=
      (
        src.headers.get(
          'content-type'
        )||
        'video/mp4'
      )
      .split(';')[0];

    const form=
      new FormData();

    form.append(
      'data',
      new Blob(
        [bytes],
        {
          type:
            contentType
        }
      ),
      'factor-video.mp4'
    );

    const sent=
      await fetch(
        uploadUrl,
        {
          method:'POST',
          body:form,
          signal:
            AbortSignal.timeout(
              90000
            )
        }
      );

    if(!sent.ok){

      return{
        ok:false,
        error:
          `max_upload_http_${sent.status}`
      };
    }

    /*
     * MAX может ещё обрабатывать
     * загруженное видео.
     */

    await sleep(3000);

    return{
      ok:true,
      token
    };

  }catch(e){

    return{
      ok:false,
      error:
        e?.message||
        String(e)
    };
  }
}

/* ================= PUBLICATION ================= */

function formatTime(){

  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      hour:'2-digit',
      minute:'2-digit',
      hour12:false
    }
  ).format(
    new Date()
  );
}

function publicationText(
  item,
  a
){

  const urgent=
    a.priority==='urgent';

  const head=
    urgent
      ? '🔴 <b>ФАКТОР • ОПЕРАТИВНО</b>'
      : '🟡 <b>ФАКТОР • НОВОСТИ</b>';

  const cat=
    `${a.emoji} <b>${esc(
      a.category
    )}</b>`;

  const title=
    `<b>${esc(
      cleanText(
        item.title
      )
    )}</b>`;

  let s=
    `${head}\n\n`+
    `${cat}\n\n`+
    `${title}\n\n`+
    `<b>КРАТКО</b>\n`+
    `${esc(
      a.summary
    )}`;

  if(a.facts.length){

    s+=
      `\n\n<b>ГЛАВНОЕ</b>\n`+
      a.facts
        .map(
          x=>
            `• ${esc(x)}`
        )
        .join('\n');
  }

  if(a.important){

    s+=
      `\n\n<b>ЧТО ВАЖНО</b>\n`+
      esc(
        a.important
      );
  }

  let src=
    esc(
      a.source_name||
      sourceHost(
        item.link
      )||
      'Источник'
    );

  try{

    const u=
      new URL(
        item.link
      );

    src=
      `<a href="${esc(
        u.toString()
      )}">${src}</a>`;

  }catch{}

  return(
    `${s}\n\n`+
    `🕒 ${formatTime()}\n`+
    `🔗 ${src}`
  ).slice(
    0,
    3950
  );
}

async function publish(
  chatId,
  text,
  media
){

  const body={
    text,
    format:'html',
    notify:true
  };

  if(
    media?.type==='image'
  ){

    body.attachments=[
      {
        type:'image',
        payload:{
          url:
            media.url
        }
      }
    ];
  }

  if(
    media?.type==='video'
  ){

    const up=
      await uploadVideo(
        media.url
      );

    if(!up.ok){

      return{
        ok:false,
        status:0,
        data:{
          error:
            up.error
        }
      };
    }

    body.attachments=[
      {
        type:'video',
        payload:{
          token:
            up.token
        }
      }
    ];
  }

  return maxRequest(
    `/messages?chat_id=${
      encodeURIComponent(
        chatId
      )
    }`,
    {
      method:'POST',
      body:
        JSON.stringify(
          body
        )
    }
  );
}

/* ================= PIPELINE ================= */

function newsKey(item){

  return(
    item.link||
    `${item.title}|${
      item.pubDate||''
    }`
  );
}

function normalOpen(
  last,
  now
){

  return(
    !last||
    now-
      Number(last)
      >=
      NORMAL_PUBLISH_INTERVAL_MS
  );
}

async function runPipeline(){

  if(running){

    return{
      ok:true,
      skipped:true,
      reason:
        'pipeline_already_running'
    };
  }

  running=true;

  const started=
    Date.now();

  try{

    const feeds=
      await fetchRSS();

    const news=
      flatten(
        feeds
      );

    if(!news.length){

      return{
        ok:false,
        error:'RSS пуст'
      };
    }

    let hist=
      await history();

    const ch=
      await channelHistory(
        TARGET_CHAT_ID
      );

    /*
     * Если историю канала получить нельзя,
     * не рискуем отправить повтор.
     */

    if(
      ch===null&&
      hist.length===0
    ){

      return{
        ok:true,
        skipped:true,
        reason:
          'channel_history_unavailable',
        rss_total:
          news.length
      };
    }

    hist=[
      ...hist,
      ...(ch||[])
    ];

    const now=
      Date.now();

    const lastNormal=
      await kvGet([
        'news',
        'state',
        'last_normal_publish'
      ]);

    const lastUrgent=
      await kvGet([
        'news',
        'state',
        'last_urgent_publish'
      ]);

    const nOpen=
      normalOpen(
        lastNormal,
        now
      );

    const uOpen=
      !lastUrgent||
      now-
        Number(lastUrgent)
        >=
        URGENT_MIN_GAP_MS;

    /*
     * Каждые 5 минут сканируем.
     * Но публикуем максимум одну новость.
     */

    const scan=
      nOpen
        ? CANDIDATES_PER_SCAN
        : Math.min(
            5,
            CANDIDATES_PER_SCAN
          );

    const results=[];

    for(
      const item
      of news.slice(
        0,
        scan
      )
    ){

      const key=
        newsKey(item);

      if(
        recentPublished.has(
          key
        )
      ){

        results.push({
          skip:
            'runtime_duplicate',
          item
        });

        continue;
      }

      const d=
        await duplicate(
          item,
          hist
        );

      if(d.duplicate){

        results.push({
          skip:
            d.reason,
          similarity:
            d.similarity||null,
          item
        });

        continue;
      }

      const an=
        await analyze(
          item
        );

      if(!an.ok){

        results.push({
          ok:false,
          stage:'ai',
          item,
          ai:an.ai
        });

        continue;
      }

      const a=
        an.analysis;

      if(
        a.priority==='urgent'&&
        !uOpen
      ){

        results.push({
          skip:
            'urgent_cooldown',
          item
        });

        continue;
      }

      if(
        a.priority!=='urgent'&&
        !nOpen
      ){

        results.push({
          skip:
            'normal_publish_interval',
          item
        });

        continue;
      }

      /*
       * Сначала пытаемся найти видео.
       * Если видео нет — изображение.
       * Google News image отбрасывается.
       */

      const media=
        await findMedia(
          item,
          'video'
        );

      const publicationItem=
        media?.source_url
          ? {
              ...item,
              link:
                media.source_url
            }
          : item;

      const text=
        publicationText(
          publicationItem,
          a
        );

      let pub={
        ok:false,
        media:
          media?.type||
          'none'
      };

      if(
        AUTO_PIPELINE&&
        TARGET_CHAT_ID
      ){

        let r=
          await publish(
            TARGET_CHAT_ID,
            text,
            media
          );

        /*
         * Если видео не прошло:
         * ищем именно картинку.
         */

        if(
          !r.ok&&
          media?.type==='video'
        ){

          const img=
            await findMedia(
              item,
              'image'
            );

          if(
            img?.type==='image'
          ){

            r=
              await publish(
                TARGET_CHAT_ID,
                text,
                img
              );
          }
        }

        /*
         * Если и медиа не прошло —
         * не теряем новость.
         */

        if(
          !r.ok&&
          media
        ){

          r=
            await publish(
              TARGET_CHAT_ID,
              text,
              null
            );
        }

        pub={
          ok:r.ok,
          status:r.status,
          response:r.data,
          media:
            media?.type||
            'none'
        };

        if(r.ok){

          await mark(
            item,
            a
          );

          if(
            a.priority==='urgent'
          ){

            await kvSet(
              [
                'news',
                'state',
                'last_urgent_publish'
              ],
              now,
              86400000
            );

          }else{

            await kvSet(
              [
                'news',
                'state',
                'last_normal_publish'
              ],
              now,
              604800000
            );
          }
        }
      }

      results.push({
        ok:true,
        item,
        priority:
          a.priority,
        media,
        ai:{
          provider:
            an.ai.provider,
          model:
            an.ai.model
        },
        publication:pub,
        text
      });

      if(
        pub.ok||
        !AUTO_PIPELINE
      ){
        break;
      }
    }

    return{
      ok:true,
      duration_ms:
        Date.now()-
        started,
      cron:
        CRON_SCHEDULE,
      normal_interval_minutes:
        Math.round(
          NORMAL_PUBLISH_INTERVAL_MS/
          60000
        ),
      urgent_interval_minutes:
        Math.round(
          URGENT_MIN_GAP_MS/
          60000
        ),
      history_count:
        hist.length,
      rss_total:
        news.length,
      candidates_scanned:
        Math.min(
          news.length,
          scan
        ),
      selected:
        results.filter(
          x=>
            x.publication?.ok
        ).length,
      results
    };

  }finally{

    running=false;
  }
}

/* ================= WEBHOOK ================= */

async function subscriptions(){

  return maxRequest(
    '/subscriptions',
    {
      method:'GET'
    }
  );
}

async function setupWebhook(
  reqUrl
){

  const origin=
    new URL(
      reqUrl
    ).origin;

  const webhook=
    `${origin}/webhook`;

  const r=
    await subscriptions();

  const arr=
    r.data?.subscriptions||
    [];

  for(
    const s
    of arr
  ){

    if(
      s.url&&
      s.url!==webhook
    ){

      await maxRequest(
        `/subscriptions?url=${
          encodeURIComponent(
            s.url
          )
        }`,
        {
          method:'DELETE'
        }
      );
    }
  }

  const body={
    url:webhook,
    update_types:[
      'bot_added',
      'bot_started',
      'bot_stopped',
      'bot_removed',
      'message_created',
      'message_edited',
      'message_removed',
      'user_added',
      'user_removed',
      'bot_admin_permissions_changed'
    ]
  };

  if(
    MAX_WEBHOOK_SECRET
  ){
    body.secret=
      MAX_WEBHOOK_SECRET;
  }

  const c=
    await maxRequest(
      '/subscriptions',
      {
        method:'POST',
        body:
          JSON.stringify(
            body
          )
      }
    );

  return{
    ok:c.ok,
    webhook_url:
      webhook,
    response:
      c.data,
    tls:
      maxTls
  };
}

async function webhook(
  request
){

  if(
    MAX_WEBHOOK_SECRET&&
    request.headers.get(
      'X-Max-Bot-Api-Secret'
    )!==
    MAX_WEBHOOK_SECRET
  ){

    return json(
      {
        ok:false,
        error:
          'Invalid MAX webhook secret'
      },
      401
    );
  }

  let p;

  try{

    p=
      await request.json();

  }catch{

    return json(
      {
        ok:false,
        error:
          'Invalid JSON'
      },
      400
    );
  }

  const ups=
    Array.isArray(
      p?.updates
    )
      ? p.updates
      : Array.isArray(p)
        ? p
        : [p];

  for(
    const u
    of ups
  ){

    const id=
      u?.chat_id||
      u?.message
        ?.recipient
        ?.chat_id||
      u?.chat
        ?.chat_id||
      u?.chat
        ?.id;

    if(
      id&&
      kv
    ){

      await kv.set(
        [
          'max',
          'chat',
          String(id)
        ],
        {
          chat_id:
            String(id),
          timestamp:
            Date.now()
        },
        {
          expireIn:
            2592000000
        }
      );
    }
  }

  return json({
    ok:true,
    received:true,
    count:
      ups.length
  });
}

/* ================= CRON ================= */

if(AUTO_PIPELINE){

  Deno.cron(
    'FACTOR News automatic pipeline',
    CRON_SCHEDULE,
    {
      backoffSchedule:[
        5000,
        15000,
        60000
      ]
    },
    async()=>{

      lastPipeline=
        await runPipeline();

      console.log(
        '[CRON]',
        JSON.stringify(
          lastPipeline
        )
      );
    }
  );
}

/* ================= HTTP ================= */

Deno.serve(
  async request=>{

    const url=
      new URL(
        request.url
      );

    const path=
      url.pathname;

    if(
      request.method==='OPTIONS'
    ){

      return json({
        ok:true
      });
    }

    try{

      if(
        path==='/'&&
        request.method==='GET'
      ){

        return json({
          ok:true,
          service:
            'MAX NEWS AGENT — ФАКТОР',
          runtime:
            'Deno Deploy',
          auto_pipeline:
            AUTO_PIPELINE,
          cron_schedule:
            CRON_SCHEDULE,
          target_chat_configured:
            !!TARGET_CHAT_ID,
          endpoints:[
            '/check',
            '/tls-test',
            '/rss',
            '/max-test',
            '/subscriptions',
            '/setup-webhook',
            '/pipeline',
            '/pipeline-state',
            '/run',
            '/webhook',
            '/publish-test'
          ]
        });
      }

      if(
        path==='/tls-test'
      ){

        return json({
          ok:
            !!(
              await initMaxClient()
            ),
          tls:
            maxTls
        });
      }

      if(
        path==='/check'
      ){

        return json({
          ok:true,
          service:
            'MAX NEWS AGENT — ФАКТОР',
          runtime:
            'Deno Deploy',
          tls:
            maxTls,
          environment:{
            MAX_BOT_TOKEN:
              !!MAX_BOT_TOKEN,
            GEMINI_API_KEY:
              !!GEMINI_API_KEY,
            QWEN_API_KEY:
              !!QWEN_API_KEY,
            TARGET_CHAT_ID:
              !!TARGET_CHAT_ID,
            AUTO_PIPELINE,
            CRON_SCHEDULE
          }
        });
      }

      if(
        path==='/rss'
      ){

        return json(
          await fetchRSS()
        );
      }

      if(
        path==='/max-test'
      ){

        return json(
          await maxRequest(
            '/me',
            {
              method:'GET'
            }
          )
        );
      }

      if(
        path==='/subscriptions'
      ){

        return json(
          await subscriptions()
        );
      }

      if(
        path==='/setup-webhook'
      ){

        return json(
          await setupWebhook(
            request.url
          )
        );
      }

      if(
        path==='/pipeline'||
        path==='/run'
      ){

        const result=
          await runPipeline();

        lastPipeline=
          result;

        return json(
          result
        );
      }

      if(
        path==='/pipeline-state'
      ){

        const lastNormal=
          await kvGet([
            'news',
            'state',
            'last_normal_publish'
          ]);

        const lastUrgent=
          await kvGet([
            'news',
            'state',
            'last_urgent_publish'
          ]);

        const now=
          Date.now();

        return json({

          ok:true,

          now:
            new Date()
              .toISOString(),

          running,

          cron:
            CRON_SCHEDULE,

          regular:{
            interval_minutes:
              Math.round(
                NORMAL_PUBLISH_INTERVAL_MS/
                60000
              ),
            last:
              lastNormal,
            can_publish:
              normalOpen(
                lastNormal,
                now
              )
          },

          urgent:{
            interval_minutes:
              Math.round(
                URGENT_MIN_GAP_MS/
                60000
              ),
            last:
              lastUrgent,
            can_publish:
              !lastUrgent||
              now-
                Number(lastUrgent)
                >=
                URGENT_MIN_GAP_MS
          },

          media:{
            max_video_mb:
              MAX_VIDEO_MB,
            max_image_mb:
              MAX_IMAGE_MB,
            priority:
              'video -> image -> text'
          },

          dedup:{
            persistent:
              !!kv,
            ttl_days:
              NEWS_HISTORY_TTL_MS/
              86400000,
            max_history_checked:
              300
          },

          last_pipeline:
            lastPipeline
        });
      }

      if(
        path==='/publish-test'
      ){

        const chatId=
          url.searchParams.get(
            'chat_id'
          )||
          TARGET_CHAT_ID;

        return json(
          await maxRequest(
            `/messages?chat_id=${
              encodeURIComponent(
                chatId
              )
            }`,
            {
              method:'POST',
              body:
                JSON.stringify({
                  text:
                    '🔴 <b>ФАКТОР • ТЕСТ</b>\n\n'+
                    '📡 Система публикации работает.\n\n'+
                    `🕒 ${formatTime()}`,
                  format:'html',
                  notify:true
                })
            }
          )
        );
      }

      if(
        path==='/webhook'&&
        request.method==='POST'
      ){

        return webhook(
          request
        );
      }

      return json(
        {
          ok:false,
          error:
            'Endpoint not found',
          path
        },
        404
      );

    }catch(e){

      console.error(
        '[FACTOR ERROR]',
        e
      );

      return json(
        {
          ok:false,
          error:
            e?.message||
            String(e)
        },
        500
      );
    }
  }
);