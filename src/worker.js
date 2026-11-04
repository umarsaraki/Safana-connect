// Safana Connect API on Cloudflare: Worker + D1 (database) + R2 (pictures) + Durable Object (realtime).
// Every permission check lives here. The browser is never trusted.
const J=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...h}});
const now=()=>Date.now();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const unhex=h=>new Uint8Array(h.match(/../g).map(x=>parseInt(x,16)));
const rid=p=>p+hex(crypto.getRandomValues(new Uint8Array(12)));
const sha=async t=>hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)));
const pbk=async(pw,salt)=>{const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveBits"]);return hex(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:100000},k,256))};
const same=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
const str=(v,max)=>String(v??"").trim().slice(0,max);
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,UN=/^[a-z0-9_]{3,30}$/;
const body=async r=>{try{const b=await r.json();if(b&&typeof b==="object")return b}catch{}throw J({error:"Invalid request"},400)};
const need=c=>{if(!c.u)throw J({error:"Please log in"},401);return c.u};
const staff=u=>u.role==="admin"||u.role==="chairman";
const normPhone=v=>{let p=String(v||"").replace(/[\s\-().]/g,"");if(/^0\d{10}$/.test(p))p="+234"+p.slice(1);else if(/^234\d{10}$/.test(p))p="+"+p;return /^\+?\d{10,15}$/.test(p)?p:""};
const mediaUrl=k=>k?"/api/media/"+k:"";
const q=(c,sql,...b)=>c.env.DB.prepare(sql).bind(...b);
const pub=u=>({id:u.id,name:u.name,user:u.username,bio:u.bio||"",loc:u.location||"",avatar:mediaUrl(u.avatar_key),cover:mediaUrl(u.cover_key),verified:u.role==="chairman"});
const me=u=>({...pub(u),email:u.email,phone:u.phone||"",role:u.role,settings:JSON.parse(u.settings||"{}")});
const hub=env=>env.HUB.get(env.HUB.idFromName("main"));
const emit=(env,event,to)=>hub(env).fetch("https://hub/emit",{method:"POST",body:JSON.stringify({event,to})}).catch(()=>{});
const blocked=async(c,a,b)=>!!await q(c,"SELECT 1 FROM user_relations WHERE kind='block' AND ((user_id=?1 AND target_id=?2) OR (user_id=?2 AND target_id=?1))",a,b).first();
const ownMedia=async(c,key,uid,scope,conv=0)=>!!await q(c,"SELECT 1 FROM media WHERE key=? AND owner_id=? AND scope=? AND COALESCE(conv_id,0)=?",key,uid,scope,conv).first();
const privUnread=async(c,uid)=>(await q(c,"SELECT COUNT(*) n FROM private_messages m JOIN private_conversation_participants p ON p.conversation_id=m.conversation_id AND p.user_id=?1 WHERE m.sender_id<>?1 AND m.id>p.last_read_id",uid).first()).n;
const part=async(c,id)=>{if(!await q(c,"SELECT 1 FROM private_conversation_participants WHERE conversation_id=? AND user_id=?",id,c.u.id).first())throw J({error:"Not found"},404)};

const routes=[];const route=(m,p,fn)=>routes.push([m,new RegExp("^"+p+"$"),fn]);

async function startSession(c,u,status=200){
  const t=hex(crypto.getRandomValues(new Uint8Array(32))),ua=str(c.req.headers.get("User-Agent"),200),n=now();
  await c.env.DB.batch([
    q(c,"INSERT INTO sessions(token_hash,user_id,user_agent,created_at,expires_at) VALUES(?,?,?,?,?)",await sha(t),u.id,ua,n,n+2592e6),
    q(c,"INSERT INTO login_activity(user_id,user_agent,created_at) VALUES(?,?,?)",u.id,ua,n)]);
  return J({user:me(u)},status,{"Set-Cookie":`sc=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`});
}
const cookie=r=>Object.fromEntries((r.headers.get("Cookie")||"").split(/;\s*/).map(x=>x.split("=")));
async function who(req,env){const t=cookie(req).sc;if(!t)return null;const h=await sha(t);
  const u=await env.DB.prepare("SELECT u.*,s.token_hash th FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'").bind(h,now()).first();return u||null}

// ---------- social: posts, comments, likes, shares, follows, stories, reels, search, requests, projects, banners, admin ----------
const bucket=env=>env.MEDIA||env.MEDIA_BUCKET;
const adm=c=>{const u=need(c);if(u.role!=="admin")throw J({error:"Not allowed"},403);return u};
const J2=a=>JSON.stringify(a);
const UC="u.id,u.name,u.username,u.bio,u.location,u.avatar_key,u.cover_key,u.role,u.status,u.followers_adjust fa,(SELECT COUNT(*) FROM follows f WHERE f.following_id=u.id) fc,(SELECT COUNT(*) FROM follows f WHERE f.follower_id=u.id) gc";
const uo=r=>({id:r.id,name:r.name,user:r.username,bio:r.bio||"",loc:r.location||"",avatar:mediaUrl(r.avatar_key),cover:mediaUrl(r.cover_key),verified:r.role==="chairman",role:r.role,status:r.status,followers:r.fc+(r.fa||0),following:r.gc,isFollowing:!!r.isf});
const usersByIds=async(c,ids)=>{const out={};if(!ids.length)return out;for(const r of(await q(c,`SELECT ${UC},EXISTS(SELECT 1 FROM follows x WHERE x.follower_id=?2 AND x.following_id=u.id) isf FROM users u WHERE u.id IN (SELECT value FROM json_each(?1))`,J2([...new Set(ids)]),c.u?c.u.id:"").all()).results)out[r.id]=uo(r);return out};
const note=async(c,to,text,ref="")=>{if(!to||to===c.u.id)return;await q(c,"INSERT INTO notifications(user_id,kind,message,ref,created_at) VALUES(?,?,?,?,?)",to,"social",text,ref,now()).run();await emit(c.env,{t:"note"},[to])};
const by=(a,k)=>a.reduce((m,x)=>((m[x[k]]=m[x[k]]||[]).push(x),m),{});
const PSEL="SELECT p.id,p.author_id,p.body,p.is_official,p.created_at,p.likes_adjust,p.bg FROM posts p JOIN users a ON a.id=p.author_id";
const BGK=["royal","purple","crimson","emerald","gold","sunset","ocean","midnight","paper","dots","stripes","waves","ornate","apc","pdp","adc","apga"];
const VIS="a.status='active' AND p.author_id NOT IN (SELECT target_id FROM user_relations WHERE user_id=?2 AND kind IN ('block','mute')) AND p.author_id NOT IN (SELECT user_id FROM user_relations WHERE target_id=?2 AND kind='block')";
async function shapePosts(c,rows){
  if(!rows.length)return{posts:[],users:{}};
  const j=J2(rows.map(r=>r.id)),IN="post_id IN (SELECT value FROM json_each(?1))";
  const[md,lk,cm,sh,sv,pv,cl]=(await c.env.DB.batch([
    q(c,`SELECT post_id,media_key,kind FROM post_media WHERE ${IN} ORDER BY id`,j),
    q(c,`SELECT post_id,user_id FROM likes WHERE ${IN} ORDER BY created_at`,j),
    q(c,`SELECT id,post_id,parent_id,author_id,body,created_at FROM comments WHERE ${IN} ORDER BY id`,j),
    q(c,`SELECT post_id,user_id FROM post_shares WHERE ${IN}`,j),
    q(c,`SELECT post_id FROM saved_posts WHERE user_id=?2 AND ${IN}`,j,c.u.id),
    q(c,`SELECT post_id,kind,COUNT(*) n FROM post_views WHERE ${IN} GROUP BY post_id,kind`,j),
    q(c,"SELECT cl.comment_id,cl.user_id FROM comment_likes cl JOIN comments c ON c.id=cl.comment_id WHERE c.post_id IN (SELECT value FROM json_each(?1))",j)])).map(x=>x.results);
  const PV=by(pv,"post_id"),CL=by(cl,"comment_id"),cls=id=>(CL[id]||[]).map(x=>x.user_id);
  const M=by(md,"post_id"),L=by(lk,"post_id"),C=by(cm,"post_id"),S=by(sh,"post_id"),sv_=new Set(sv.map(x=>x.post_id));
  const users=await usersByIds(c,[...rows.map(r=>r.author_id),...lk.map(x=>x.user_id),...cm.map(x=>x.author_id),...sh.map(x=>x.user_id)]);
  return{users,posts:rows.map(r=>{const cs=C[r.id]||[];return{id:r.id,author:r.author_id,body:(r.body||"").trim(),t:r.created_at,official:!!r.is_official,adj:r.likes_adjust,bg:r.bg||"",views:{post:((PV[r.id]||[]).find(v=>v.kind==="post")||{}).n||0,reel:((PV[r.id]||[]).find(v=>v.kind==="reel")||{}).n||0},
    media:(M[r.id]||[]).map(m=>({url:mediaUrl(m.media_key),kind:m.kind})),likes:(L[r.id]||[]).map(x=>x.user_id),shares:(S[r.id]||[]).map(x=>x.user_id),saved:sv_.has(r.id),
    comments:cs.filter(x=>!x.parent_id).map(x=>({id:x.id,a:x.author_id,txt:x.body,t:x.created_at,likes:cls(x.id),rep:cs.filter(y=>y.parent_id===x.id).map(y=>({id:y.id,a:y.author_id,txt:y.body,t:y.created_at,likes:cls(y.id)}))}))}})}}
async function dropPost(c,id){for(const k of(await q(c,"SELECT media_key k FROM post_media WHERE post_id=?",id).all()).results){await bucket(c.env).delete(k.k);await q(c,"DELETE FROM media WHERE key=?",k.k).run()}await q(c,"DELETE FROM posts WHERE id=?",id).run()}
async function convWith(c,uid,t){
  if(t===uid||!await q(c,"SELECT 1 FROM users WHERE id=? AND status='active'",t).first()||await blocked(c,uid,t))return 0;
  const key=[uid,t].sort().join(":");let cv=await q(c,"SELECT id FROM private_conversations WHERE pair_key=?",key).first();
  if(!cv){const r=await q(c,"INSERT INTO private_conversations(pair_key,created_at) VALUES(?,?)",key,now()).run(),id=r.meta.last_row_id;
    await c.env.DB.batch([q(c,"INSERT INTO private_conversation_participants(conversation_id,user_id,created_at) VALUES(?,?,?)",id,uid,now()),q(c,"INSERT INTO private_conversation_participants(conversation_id,user_id,created_at) VALUES(?,?,?)",id,t,now())]);cv={id}}
  return cv.id}
async function sendDM(c,u,t,text){const cv=await convWith(c,u.id,t);if(!cv||!text)return;
  const r=await q(c,"INSERT INTO private_messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)",cv,u.id,text,now()).run();
  await q(c,"UPDATE private_conversation_participants SET last_read_id=? WHERE conversation_id=? AND user_id=?",r.meta.last_row_id,cv,u.id).run();
  await emit(c.env,{t:"priv",conv:cv,msg:shape(await q(c,PRIV+" WHERE m.id=?",r.meta.last_row_id).first())},[u.id,t])}

route("GET","/feed",async c=>{const u=need(c),off=c.url.searchParams.get("official")==="1"?1:0;
  return J(await shapePosts(c,(await q(c,`${PSEL} WHERE p.is_official=?1 AND ${VIS} ORDER BY p.id DESC LIMIT 60`,off,u.id).all()).results))});
route("GET","/saved",async c=>{const u=need(c);
  return J(await shapePosts(c,(await q(c,`${PSEL} JOIN saved_posts s ON s.post_id=p.id WHERE s.user_id=?2 AND ${VIS} ORDER BY s.created_at DESC LIMIT 60`,0,u.id).all()).results))});
route("GET","/reels",async c=>{const u=need(c);
  return J(await shapePosts(c,(await q(c,`${PSEL} WHERE EXISTS(SELECT 1 FROM post_media m WHERE m.post_id=p.id AND m.kind='video') AND ${VIS} ORDER BY RANDOM() LIMIT 20`,0,u.id).all()).results))});
route("GET","/posts/(\\d+)",async c=>{const u=need(c),r=(await q(c,`${PSEL} WHERE p.id=?1 AND ${VIS}`,+c.p[0],u.id).all()).results;
  if(!r.length)return J({error:"Not found"},404);const d=await shapePosts(c,r);return J({post:d.posts[0],users:d.users})});
route("POST","/posts",async c=>{
  const u=need(c),b=await body(c.req),t=str(b.body,2000),keys=(Array.isArray(b.media)?b.media:[]).slice(0,5).map(k=>str(k,120));
  if(!t&&!keys.length)return J({error:"Write something or add a picture or video"},400);
  const bg=b.bg?str(b.bg,20):"";if(bg&&(!BGK.includes(bg)||keys.length||t.length>280))return J({error:"Colourful backgrounds are for short text posts (280 characters)"},400);
  const kinds=[];for(const k of keys){const m=await q(c,"SELECT kind FROM media WHERE key=? AND owner_id=? AND scope='post'",k,u.id).first();if(!m)return J({error:"Invalid attachment"},400);kinds.push(m.kind)}
  if(kinds.includes("video")&&kinds.length>1)return J({error:"Add up to 5 pictures, or one video"},400);
  const off=b.official&&staff(u)?1:0,r=await q(c,"INSERT INTO posts(author_id,body,is_official,bg,created_at) VALUES(?,?,?,?,?)",u.id,t||" ",off,bg||null,now()).run(),id=r.meta.last_row_id;
  if(keys.length)await c.env.DB.batch(keys.map((k,i)=>q(c,"INSERT INTO post_media(post_id,media_key,kind) VALUES(?,?,?)",id,k,kinds[i])));
  if(off){await q(c,"INSERT INTO notifications(user_id,kind,message,created_at) SELECT id,'official',?,? FROM users WHERE status='active' AND id<>?",`New announcement from ${u.name}`,now(),u.id).run();await emit(c.env,{t:"note"})}
  await emit(c.env,{t:"np"});return J({id},201)});
route("DELETE","/posts/(\\d+)",async c=>{const u=need(c),id=+c.p[0],p=await q(c,"SELECT author_id FROM posts WHERE id=?",id).first();
  if(!p)return J({error:"Not found"},404);if(p.author_id!==u.id&&u.role!=="admin")return J({error:"Not allowed"},403);await dropPost(c,id);return J({ok:true})});
route("POST","/posts/(\\d+)/like",async c=>{const u=need(c),id=+c.p[0],p=await q(c,"SELECT author_id FROM posts WHERE id=?",id).first();if(!p)return J({error:"Not found"},404);
  if(await q(c,"SELECT 1 FROM likes WHERE post_id=? AND user_id=?",id,u.id).first())await q(c,"DELETE FROM likes WHERE post_id=? AND user_id=?",id,u.id).run();
  else{await q(c,"INSERT INTO likes(post_id,user_id,created_at) VALUES(?,?,?)",id,u.id,now()).run();await note(c,p.author_id,`${u.name} liked your post.`,`post:${id}`)}
  await emit(c.env,{t:"pu",id});return J({likes:(await q(c,"SELECT user_id FROM likes WHERE post_id=?",id).all()).results.map(x=>x.user_id)})});
route("POST","/posts/(\\d+)/comments",async c=>{
  const u=need(c),id=+c.p[0],b=await body(c.req),t=str(b.body,500),par=b.parent?+b.parent:null;if(!t)return J({error:"Write a comment first"},400);
  const p=await q(c,"SELECT author_id,comments_enabled FROM posts WHERE id=?",id).first();if(!p)return J({error:"Not found"},404);if(!p.comments_enabled)return J({error:"Comments are turned off"},403);
  let pa=null;if(par){pa=await q(c,"SELECT author_id,parent_id FROM comments WHERE id=? AND post_id=?",par,id).first();if(!pa)return J({error:"Not found"},404)}
  await q(c,"INSERT INTO comments(post_id,parent_id,author_id,body,created_at) VALUES(?,?,?,?,?)",id,pa?(pa.parent_id||par):null,u.id,t,now()).run();
  if(pa)await note(c,pa.author_id,`${u.name} replied to your comment.`,`post:${id}:c`);
  if(!pa||pa.author_id!==p.author_id)await note(c,p.author_id,`${u.name} commented on your post.`,`post:${id}:c`);
  for(const m of[...new Set((t.match(/@[a-z0-9_]{3,30}/gi)||[]).map(x=>x.slice(1).toLowerCase()))].slice(0,5)){const x=await q(c,"SELECT id FROM users WHERE username=?",m).first();if(x&&(!pa||x.id!==pa.author_id))await note(c,x.id,`${u.name} mentioned you in a comment.`,`post:${id}:c`)}
  await emit(c.env,{t:"pu",id});return J({ok:true},201)});
route("POST","/posts/(\\d+)/share",async c=>{const u=need(c),id=+c.p[0],b=await body(c.req),p=await q(c,"SELECT author_id FROM posts WHERE id=?",id).first();if(!p)return J({error:"Not found"},404);
  await q(c,"INSERT OR IGNORE INTO post_shares(post_id,user_id,created_at) VALUES(?,?,?)",id,u.id,now()).run();await note(c,p.author_id,`${u.name} shared your post.`,`post:${id}`);
  for(const to of(Array.isArray(b.to)?b.to:[]).slice(0,5))await sendDM(c,u,str(to,60),str(b.link,300));
  await emit(c.env,{t:"pu",id});return J({count:(await q(c,"SELECT COUNT(*) n FROM post_shares WHERE post_id=?",id).first()).n})});
route("POST","/posts/(\\d+)/save",async c=>{const u=need(c),id=+c.p[0];
  if(await q(c,"SELECT 1 FROM saved_posts WHERE user_id=? AND post_id=?",u.id,id).first()){await q(c,"DELETE FROM saved_posts WHERE user_id=? AND post_id=?",u.id,id).run();return J({saved:false})}
  await q(c,"INSERT INTO saved_posts(user_id,post_id,created_at) VALUES(?,?,?)",u.id,id,now()).run();return J({saved:true})});
route("POST","/posts/(\\d+)/report",async c=>{const u=need(c),b=await body(c.req);
  if(!await q(c,"SELECT 1 FROM posts WHERE id=?",+c.p[0]).first())return J({error:"Not found"},404);
  await q(c,"INSERT INTO reports(post_id,reporter_id,reason,created_at) VALUES(?,?,?,?)",+c.p[0],u.id,str(b.reason,300),now()).run();return J({ok:true})});

route("GET","/users/search",async c=>{
  const u=need(c),s=str(c.url.searchParams.get("q"),60).toLowerCase();if(s.length<2)return J({users:[]});
  const rs=(await q(c,`SELECT ${UC},EXISTS(SELECT 1 FROM follows x WHERE x.follower_id=?2 AND x.following_id=u.id) isf FROM users u WHERE u.status='active' AND u.id<>?2 AND (LOWER(u.name) LIKE ?1 OR u.username LIKE ?1 OR u.email=?3 OR u.phone=?4) AND u.id NOT IN (SELECT user_id FROM user_relations WHERE target_id=?2 AND kind='block') AND u.id NOT IN (SELECT target_id FROM user_relations WHERE user_id=?2 AND kind='block') LIMIT 20`,"%"+s.replace(/[%_]/g,"")+"%",u.id,s,normPhone(s)||"-").all()).results;
  return J({users:rs.map(r=>({...uo(r),isFollowing:!!r.isf}))})});
route("GET","/users/([^/]+)",async c=>{
  const u=need(c),t=await q(c,`SELECT ${UC},EXISTS(SELECT 1 FROM follows x WHERE x.follower_id=?2 AND x.following_id=u.id) isf FROM users u WHERE u.id=?1 AND u.status='active'`,c.p[0],u.id).first();
  if(!t||await blocked(c,u.id,t.id))return J({error:"Not found"},404);
  const d=await shapePosts(c,(await q(c,`${PSEL} WHERE p.author_id=?1 AND ${VIS} ORDER BY p.id DESC LIMIT 40`,t.id,u.id).all()).results);
  const pc=(await q(c,"SELECT COUNT(*) n FROM posts WHERE author_id=?",t.id).first()).n;return J({user:{...uo(t),isFollowing:!!t.isf,postsCount:pc},posts:d.posts,users:{...d.users,[t.id]:uo(t)}})});
route("POST","/follow",async c=>{const u=need(c),b=await body(c.req),t=str(b.userId,60);if(t===u.id)return J({error:"Invalid request"},400);
  if(!await q(c,"SELECT 1 FROM users WHERE id=? AND status='active'",t).first()||await blocked(c,u.id,t))return J({error:"Not found"},404);
  if(b.follow){const r=await q(c,"INSERT OR IGNORE INTO follows(follower_id,following_id,created_at) VALUES(?,?,?)",u.id,t,now()).run();if(r.meta.changes)await note(c,t,`${u.name} started following you.`,`user:${u.id}`)}
  else await q(c,"DELETE FROM follows WHERE follower_id=? AND following_id=?",u.id,t).run();return J({ok:true})});
route("GET","/notifications",async c=>{const u=need(c);
  return J({notes:(await q(c,"SELECT id,message txt,ref,is_read r,created_at t FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 60",u.id).all()).results.map(x=>({...x,read:!!x.r}))})});
route("POST","/notifications/read",async c=>{const u=need(c);await q(c,"UPDATE notifications SET is_read=1 WHERE user_id=?",u.id).run();return J({ok:true})});

route("POST","/stories",async c=>{const u=need(c),b=await body(c.req),k=str(b.media,120),m=await q(c,"SELECT kind FROM media WHERE key=? AND owner_id=? AND scope='post'",k,u.id).first();
  if(!m)return J({error:"Invalid attachment"},400);
  await q(c,"INSERT INTO stories(author_id,media_key,kind,caption,created_at) VALUES(?,?,?,?,?)",u.id,k,m.kind,str(b.caption,120),now()).run();return J({ok:true},201)});
route("GET","/stories",async c=>{const u=need(c);
  const rs=(await q(c,`SELECT s.id,s.author_id,s.media_key,s.kind,s.caption,s.created_at,(SELECT COUNT(*) FROM story_views v WHERE v.story_id=s.id) vc,EXISTS(SELECT 1 FROM story_views v WHERE v.story_id=s.id AND v.user_id=?2) sn FROM stories s JOIN users a ON a.id=s.author_id WHERE s.created_at>?3 AND a.status='active' AND (s.author_id=?2 OR s.author_id IN (SELECT following_id FROM follows WHERE follower_id=?2) OR a.role IN ('chairman','admin')) AND s.author_id NOT IN (SELECT target_id FROM user_relations WHERE user_id=?2 AND kind IN ('block','mute')) ORDER BY s.id`,0,u.id,now()-864e5).all()).results;
  const users=await usersByIds(c,rs.map(r=>r.author_id)),g={};for(const r of rs)(g[r.author_id]=g[r.author_id]||[]).push({id:r.id,url:mediaUrl(r.media_key),kind:r.kind,caption:r.caption||"",t:r.created_at,seen:!!r.sn||r.author_id===u.id,views:r.author_id===u.id||u.role==="admin"?r.vc:null});
  return J({users,stories:Object.entries(g).map(([id,items])=>({user:id,items}))})});
route("DELETE","/stories/(\\d+)",async c=>{const u=need(c),s=await q(c,"SELECT author_id,media_key FROM stories WHERE id=?",+c.p[0]).first();if(!s)return J({error:"Not found"},404);
  if(s.author_id!==u.id&&u.role!=="admin")return J({error:"Not allowed"},403);await bucket(c.env).delete(s.media_key);await q(c,"DELETE FROM media WHERE key=?",s.media_key).run();await q(c,"DELETE FROM stories WHERE id=?",+c.p[0]).run();return J({ok:true})});

// requests: resident -> Admin (first review) -> resident fills the full form -> Chairman decides
const rq=(r,u)=>({id:r.id,by:r.applicant_id,name:r.aname,form:r.title,st:r.status,t:r.created_at,img:mediaUrl(r.media_key),data:JSON.parse(r.details||"[]"),full:r.full_form&&(u.role!=="admin"||r.applicant_id===u.id)?JSON.parse(r.full_form):null,hasFull:!!r.full_form});
route("GET","/forms",async c=>{need(c);return J({forms:(await q(c,"SELECT id,name,fields FROM form_templates WHERE is_active=1 ORDER BY id").all()).results.map(f=>({id:f.id,name:f.name,fields:JSON.parse(f.fields||"[]")}))})});
route("GET","/requests",async c=>{const u=need(c);let w=" WHERE r.applicant_id=?1";if(u.role==="admin")w="";else if(u.role==="chairman")w=" WHERE r.full_form IS NOT NULL OR r.applicant_id=?1";
  const rs=(await q(c,"SELECT r.*,a.name aname FROM form_requests r JOIN users a ON a.id=r.applicant_id"+w+" ORDER BY r.id DESC LIMIT 200",...(w?[u.id]:[])).all()).results;return J({requests:rs.map(r=>rq(r,u))})});
route("POST","/requests",async c=>{
  const u=need(c),b=await body(c.req),t=str(b.title,100),d=str(b.description,1000),mk=str(b.media,120);if(!t||!d)return J({error:"Enter what you need and a description"},400);
  if(mk&&!await ownMedia(c,mk,u.id,"post"))return J({error:"Invalid attachment"},400);
  await q(c,"INSERT INTO form_requests(applicant_id,title,details,media_key,created_at) VALUES(?,?,?,?,?)",u.id,str(b.type,40)+": "+t,JSON.stringify([["Need",t],["Description",d],["Phone",str(b.phone,20)],["Ward",str(b.ward,80)]]),mk||null,now()).run();
  await q(c,"INSERT INTO notifications(user_id,kind,message,created_at) SELECT id,'request',?,? FROM users WHERE role='admin' AND status='active'",`New request from ${u.name}`,now()).run();return J({ok:true},201)});
route("POST","/requests/(\\d+)/full",async c=>{
  const u=need(c),b=await body(c.req),r=await q(c,"SELECT * FROM form_requests WHERE id=? AND applicant_id=?",+c.p[0],u.id).first();
  if(!r||r.status!=="Form Ready")return J({error:"This form is not ready"},400);
  const f={name:str(b.name,80),addr:str(b.addr,150),phone:str(b.phone,20),det:str(b.det,2000),img:""},mk=str(b.media,120);
  if(!f.name||!f.addr||!f.phone||!f.det)return J({error:"Complete every field"},400);
  if(mk){if(!await ownMedia(c,mk,u.id,"post"))return J({error:"Invalid attachment"},400);f.img=mediaUrl(mk)}
  await q(c,"UPDATE form_requests SET full_form=?,status='Under Review' WHERE id=?",JSON.stringify(f),r.id).run();
  await q(c,"INSERT INTO notifications(user_id,kind,message,created_at) SELECT id,'request',?,? FROM users WHERE role='chairman' AND status='active'",`New request for review: ${r.title}`,now()).run();return J({ok:true})});
route("POST","/requests/(\\d+)/decide",async c=>{
  const u=need(c),b=await body(c.req),st=str(b.status,20),r=await q(c,"SELECT * FROM form_requests WHERE id=?",+c.p[0]).first();if(!r)return J({error:"Not found"},404);
  const ok=(u.role==="admin"&&r.status==="Pending"&&["Form Ready","Rejected"].includes(st))||(u.role==="chairman"&&r.status==="Under Review"&&["Approved","Rejected"].includes(st));
  if(!ok)return J({error:"Not allowed"},403);
  await q(c,"UPDATE form_requests SET status=?,decided_by=?,decided_at=? WHERE id=?",st,u.id,now(),r.id).run();
  await q(c,"INSERT INTO notifications(user_id,kind,message,created_at) VALUES(?,?,?,?)",r.applicant_id,"request",`${r.title}: ${{"Form Ready":"accepted. Open Request and fill in the full form.",Approved:"approved by the Chairman. You can download it now.",Rejected:"not approved."}[st]}`,now()).run();
  await emit(c.env,{t:"note"},[r.applicant_id]);return J({ok:true})});

const pj=r=>({id:r.id,title:r.title,loc:r.location||"",st:r.status,pr:r.progress,start:r.start_date||"",end:r.end_date||"",d:r.description||"",img:mediaUrl(r.image_key)});
route("GET","/projects",async c=>{need(c);return J({projects:(await q(c,"SELECT * FROM projects ORDER BY id DESC").all()).results.map(pj)})});
route("POST","/projects",async c=>{const u=need(c);if(!staff(u))return J({error:"Not allowed"},403);const b=await body(c.req),t=str(b.title,120);if(!t)return J({error:"Enter a project title"},400);
  const st=["Planned","Ongoing","Completed"].includes(b.status)?b.status:"Planned",mk=str(b.image,120);
  await q(c,"INSERT INTO projects(title,description,location,image_key,status,progress,start_date,end_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",t,str(b.description,500),str(b.location,80),mk||null,st,Math.min(100,Math.max(0,Math.floor(+b.progress||0))),str(b.start,10),str(b.end,10),u.id,now()).run();
  await q(c,"INSERT INTO notifications(user_id,kind,message,created_at) SELECT id,'project',?,? FROM users WHERE status='active' AND id<>?",`New project: ${t}`,now(),u.id).run();return J({ok:true},201)});
route("PATCH","/projects/(\\d+)",async c=>{const u=need(c);if(!staff(u))return J({error:"Not allowed"},403);const b=await body(c.req),s=[],v=[];
  if(b.progress!==undefined){s.push("progress=?");v.push(Math.min(100,Math.max(0,Math.floor(+b.progress||0))))}
  if(["Planned","Ongoing","Completed"].includes(b.status)){s.push("status=?");v.push(b.status)}
  if(b.image){s.push("image_key=?");v.push(str(b.image,120))}
  if(s.length)await c.env.DB.prepare(`UPDATE projects SET ${s.join(",")} WHERE id=?`).bind(...v,+c.p[0]).run();return J({ok:true})});
route("DELETE","/projects/(\\d+)",async c=>{const u=need(c);if(!staff(u))return J({error:"Not allowed"},403);await q(c,"DELETE FROM projects WHERE id=?",+c.p[0]).run();return J({ok:true})});

route("GET","/banners",async c=>{const u=need(c);return J({slides:(await q(c,`SELECT * FROM banner_slides ${u.role==="admin"?"":"WHERE is_enabled=1"} ORDER BY position,id`).all()).results.map(r=>({t:r.title,d:r.description||"",b:r.button_text||"",on:!!r.is_enabled,sec:r.seconds,img:mediaUrl(r.image_key),key:r.image_key||""}))})});
route("PUT","/banners",async c=>{adm(c);const b=await body(c.req),sl=(Array.isArray(b.slides)?b.slides:[]).slice(0,10);
  await c.env.DB.batch([q(c,"DELETE FROM banner_slides"),...sl.map((s,i)=>q(c,"INSERT INTO banner_slides(title,description,button_text,image_key,position,is_enabled,seconds,created_at) VALUES(?,?,?,?,?,?,?,?)",str(s.t,80)||"Slide",str(s.d,200),str(s.b,30),str(s.key,120)||null,i,s.on?1:0,Math.min(20,Math.max(2,Math.floor(+s.sec||5))),now()))]);return J({ok:true})});

// ---------- admin: full access ----------
route("GET","/admin/stats",async c=>{adm(c);const n=async s=>(await q(c,s).first()).n;
  return J({users:await n("SELECT COUNT(*) n FROM users"),posts:await n("SELECT COUNT(*) n FROM posts"),reports:await n("SELECT COUNT(*) n FROM reports WHERE resolved=0")+await n("SELECT COUNT(*) n FROM chat_reports WHERE status='open'"),requests:await n("SELECT COUNT(*) n FROM form_requests WHERE status IN ('Pending','Under Review')"),stories:await n("SELECT COUNT(*) n FROM stories")})});
route("GET","/admin/users",async c=>{adm(c);const s="%"+str(c.url.searchParams.get("q"),60).toLowerCase().replace(/[%_]/g,"")+"%";
  return J({users:(await q(c,`SELECT ${UC},u.email,u.phone,u.created_at ca FROM users u WHERE LOWER(u.name) LIKE ?1 OR u.username LIKE ?1 OR LOWER(u.email) LIKE ?1 OR u.phone LIKE ?1 ORDER BY u.created_at DESC LIMIT 100`,s).all()).results.map(r=>({...uo(r),email:r.email,phone:r.phone||"",joined:r.ca,adj:r.fa}))})});
route("PATCH","/admin/users/([^/]+)",async c=>{
  const me_=adm(c),id=c.p[0],b=await body(c.req),t=await q(c,"SELECT id FROM users WHERE id=?",id).first();if(!t)return J({error:"Not found"},404);
  const s=[],v=[],set=(k,x)=>{s.push(k+"=?");v.push(x)};
  if(b.name!==undefined){const n=str(b.name,60);if(!n)return J({error:"Enter a name"},400);set("name",n)}
  if(b.username!==undefined){const x=str(b.username,30).toLowerCase();if(!UN.test(x))return J({error:"Invalid username"},400);set("username",x)}
  if(b.email!==undefined){const x=str(b.email,120).toLowerCase();if(!EMAIL.test(x))return J({error:"Invalid email"},400);set("email",x)}
  if(b.phone!==undefined&&b.phone!==""){const x=normPhone(b.phone);if(!x)return J({error:"Invalid phone"},400);set("phone",x)}
  if(b.bio!==undefined)set("bio",str(b.bio,200));if(b.location!==undefined)set("location",str(b.location,80));
  if(["active","suspended","deactivated"].includes(b.status)&&id!==me_.id)set("status",b.status);
  if(["user","chairman","admin"].includes(b.role)&&id!==me_.id)set("role",b.role);
  if(b.followers!==undefined){const real=(await q(c,"SELECT COUNT(*) n FROM follows WHERE following_id=?",id).first()).n;set("followers_adjust",Math.max(0,Math.floor(+b.followers||0))-real)}
  if(!s.length)return J({ok:true});
  try{await c.env.DB.prepare(`UPDATE users SET ${s.join(",")} WHERE id=?`).bind(...v,id).run()}catch{return J({error:"Username, email or phone already used"},409)}
  if(b.status&&b.status!=="active")await q(c,"DELETE FROM sessions WHERE user_id=?",id).run();return J({ok:true})});
route("DELETE","/admin/users/([^/]+)",async c=>{const u=adm(c),id=c.p[0];if(id===u.id)return J({error:"You cannot delete yourself"},400);
  for(const k of(await q(c,"SELECT key FROM media WHERE owner_id=?",id).all()).results)await bucket(c.env).delete(k.key);await q(c,"DELETE FROM users WHERE id=?",id).run();return J({ok:true})});
route("GET","/admin/posts",async c=>{adm(c);const s="%"+str(c.url.searchParams.get("q"),60).toLowerCase().replace(/[%_]/g,"")+"%";
  return J(await shapePosts(c,(await q(c,`${PSEL} WHERE LOWER(p.body) LIKE ?1 OR LOWER(a.name) LIKE ?1 OR a.username LIKE ?1 ORDER BY p.id DESC LIMIT 100`,s).all()).results))});
route("PATCH","/admin/posts/(\\d+)",async c=>{adm(c);const b=await body(c.req),s=[],v=[];
  if(b.body!==undefined){const t=str(b.body,2000);if(!t)return J({error:"Post text cannot be empty"},400);s.push("body=?");v.push(t)}
  if(b.likes_adjust!==undefined){s.push("likes_adjust=?");v.push(Math.max(0,Math.floor(+b.likes_adjust||0)))}
  if(s.length)await c.env.DB.prepare(`UPDATE posts SET ${s.join(",")} WHERE id=?`).bind(...v,+c.p[0]).run();return J({ok:true})});
route("GET","/admin/reports",async c=>{adm(c);
  const rs=(await q(c,"SELECT r.id,r.post_id,r.reason,r.created_at t,rp.name rname,p.body,p.author_id,a.name aname,a.username auser,(SELECT COUNT(*) FROM reports x WHERE x.post_id=r.post_id AND x.resolved=0) n FROM reports r LEFT JOIN users rp ON rp.id=r.reporter_id LEFT JOIN posts p ON p.id=r.post_id LEFT JOIN users a ON a.id=p.author_id WHERE r.resolved=0 ORDER BY n DESC,r.id DESC LIMIT 100").all()).results;
  return J({reports:rs,chat:(await q(c,"SELECT id,reported_user_id,body,reason,created_at t FROM chat_reports WHERE status='open' ORDER BY id DESC LIMIT 50").all()).results})});
route("POST","/admin/reports/(\\d+)/resolve",async c=>{adm(c);const b=await body(c.req),r=await q(c,"SELECT r.post_id,p.author_id FROM reports r LEFT JOIN posts p ON p.id=r.post_id WHERE r.id=?",+c.p[0]).first();if(!r)return J({error:"Not found"},404);
  if(b.action==="delete_post"&&r.post_id)await dropPost(c,r.post_id);
  else{if(b.action==="suspend_user"&&r.author_id){await q(c,"UPDATE users SET status='suspended' WHERE id=?",r.author_id).run();await q(c,"DELETE FROM sessions WHERE user_id=?",r.author_id).run()}
    await q(c,"UPDATE reports SET resolved=1 WHERE post_id IS ? OR id=?",r.post_id,+c.p[0]).run()}
  return J({ok:true})});
route("POST","/admin/broadcast",async c=>{adm(c);const m=str((await body(c.req)).message,200);if(!m)return J({error:"Write a message first"},400);
  await q(c,"INSERT INTO notifications(user_id,kind,message,created_at) SELECT id,'broadcast',?,? FROM users WHERE status='active'",m,now()).run();await emit(c.env,{t:"note"});return J({ok:true})});


route("POST","/notifications/(\\d+)/read",async c=>{const u=need(c);await q(c,"UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?",+c.p[0],u.id).run();return J({ok:true})});
route("POST","/comments/(\\d+)/like",async c=>{const u=need(c),id=+c.p[0],cm=await q(c,"SELECT author_id,post_id FROM comments WHERE id=?",id).first();if(!cm)return J({error:"Not found"},404);
  if(await q(c,"SELECT 1 FROM comment_likes WHERE comment_id=? AND user_id=?",id,u.id).first())await q(c,"DELETE FROM comment_likes WHERE comment_id=? AND user_id=?",id,u.id).run();
  else{await q(c,"INSERT INTO comment_likes(comment_id,user_id,created_at) VALUES(?,?,?)",id,u.id,now()).run();await note(c,cm.author_id,`${u.name} liked your comment.`,`post:${cm.post_id}:c`)}
  await emit(c.env,{t:"pu",id:cm.post_id});return J({likes:(await q(c,"SELECT user_id FROM comment_likes WHERE comment_id=?",id).all()).results.map(x=>x.user_id)})});
route("DELETE","/comments/(\\d+)",async c=>{const u=need(c),cm=await q(c,"SELECT c.author_id,c.post_id,p.author_id pa FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?",+c.p[0]).first();if(!cm)return J({error:"Not found"},404);
  if(cm.author_id!==u.id&&cm.pa!==u.id&&u.role!=="admin")return J({error:"Not allowed"},403);await q(c,"DELETE FROM comments WHERE id=?",+c.p[0]).run();await emit(c.env,{t:"pu",id:cm.post_id});return J({ok:true})});
route("POST","/views",async c=>{const u=need(c),b=await body(c.req),st=[];
  for(const[list,kind]of[[b.posts,"post"],[b.reels,"reel"]])for(const id of(Array.isArray(list)?list:[]).slice(0,10)){const pid=Math.floor(+id);if(pid>0)st.push(q(c,"INSERT OR IGNORE INTO post_views(post_id,user_id,kind,created_at) SELECT p.id,?2,?3,?4 FROM posts p WHERE p.id=?1 AND p.author_id<>?2",pid,u.id,kind,now()))}
  if(st.length)await c.env.DB.batch(st);return J({ok:true})});
route("POST","/stories/(\\d+)/view",async c=>{const u=need(c);await q(c,"INSERT OR IGNORE INTO story_views(story_id,user_id,created_at) SELECT s.id,?2,?3 FROM stories s WHERE s.id=?1 AND s.author_id<>?2 AND s.created_at>?4",+c.p[0],u.id,now(),now()-864e5).run();return J({ok:true})});
route("GET","/stories/(\\d+)/viewers",async c=>{const u=need(c),s=await q(c,"SELECT author_id FROM stories WHERE id=?",+c.p[0]).first();if(!s)return J({error:"Not found"},404);if(s.author_id!==u.id&&u.role!=="admin")return J({error:"Not allowed"},403);
  const rs=(await q(c,"SELECT user_id,created_at t FROM story_views WHERE story_id=? ORDER BY created_at DESC LIMIT 200",+c.p[0]).all()).results,users=await usersByIds(c,rs.map(r=>r.user_id));
  return J({viewers:rs.map(r=>({user:users[r.user_id],t:r.t})).filter(x=>x.user)})});
route("GET","/users/([^/]+)/connections",async c=>{const u=need(c),id=c.p[0],fo=c.url.searchParams.get("type")==="following";
  const ids=(await q(c,fo?"SELECT following_id uid FROM follows WHERE follower_id=?1 ORDER BY created_at DESC LIMIT 200":"SELECT follower_id uid FROM follows WHERE following_id=?1 ORDER BY created_at DESC LIMIT 200",id).all()).results.map(r=>r.uid),users=await usersByIds(c,ids);
  return J({users:ids.map(i=>users[i]).filter(x=>x&&x.status==="active")})});

// ---------- account ----------
route("POST","/register",async c=>{
  const b=await body(c.req),name=str(b.name,60),un=str(b.username,30).toLowerCase(),em=str(b.email,120).toLowerCase(),ph=normPhone(b.phone),pw=String(b.password||"");
  if(!name)return J({error:"Enter your full name"},400);
  if(!UN.test(un))return J({error:"Username: 3 to 30 letters, numbers or underscore"},400);
  if(!EMAIL.test(em))return J({error:"Enter a valid email address"},400);
  if(!ph)return J({error:"Enter a valid phone number"},400);
  if(pw.length<8||pw.length>72)return J({error:"Password must have 8 to 72 characters"},400);
  if(b.agreed!==true)return J({error:"Please agree to the Terms and Privacy Policy"},400);
  if(await q(c,"SELECT 1 FROM users WHERE username=?1 OR email=?2 OR phone=?3",un,em,ph).first())return J({error:"Username, email or phone number already used"},409);
  let role="user";
  for(const[r,e]of[["admin",c.env.ADMIN_EMAIL],["chairman",c.env.CHAIRMAN_EMAIL]])
    if(e&&em===e.toLowerCase()&&!await q(c,"SELECT 1 FROM users WHERE role=?",r).first())role=r; // only the first account with that email gets the role
  const salt=crypto.getRandomValues(new Uint8Array(16)),id=rid("usr_");
  await q(c,"INSERT INTO users(id,name,username,email,phone,pass_salt,pass_hash,role,created_at) VALUES(?,?,?,?,?,?,?,?,?)",id,name,un,em,ph,hex(salt),await pbk(pw,salt),role,now()).run();
  return startSession(c,await q(c,"SELECT * FROM users WHERE id=?",id).first(),201)});
route("POST","/login",async c=>{
  const b=await body(c.req),l=str(b.login,120).toLowerCase(),pw=String(b.password||"");
  const u=await q(c,"SELECT * FROM users WHERE username=?1 OR email=?1 OR (?2<>'' AND phone=?2)",l,normPhone(b.login)).first(),bad=J({error:"Wrong username, email or password"},401);
  if(!u)return bad;
  if(u.locked_until>now())return J({error:"Too many attempts. Try again in a few minutes."},429);
  if(u.status==="suspended")return J({error:"This account is suspended. Contact support."},403);
  if(!same(await pbk(pw,unhex(u.pass_salt)),u.pass_hash)){
    const f=u.fail_count+1;await q(c,"UPDATE users SET fail_count=?,locked_until=? WHERE id=?",f>=5?0:f,f>=5?now()+9e5:0,u.id).run();return bad}
  await q(c,"UPDATE users SET fail_count=0,locked_until=0,status='active' WHERE id=?",u.id).run(); // logging in reactivates a deactivated account
  const ae=(c.env.ADMIN_EMAIL||"").trim().toLowerCase(),ce=(c.env.CHAIRMAN_EMAIL||"").trim().toLowerCase(); // the account with the configured email holds that role, even if it registered before the email was configured
  const want=ae&&u.email===ae?"admin":ce&&u.email===ce&&u.role!=="admin"?"chairman":u.role;
  if(want!==u.role){await q(c,"UPDATE users SET role=? WHERE id=?",want,u.id).run();u.role=want}
  return startSession(c,u)});
route("POST","/logout",async c=>{const t=cookie(c.req).sc;if(t)await q(c,"DELETE FROM sessions WHERE token_hash=?",await sha(t)).run();
  return J({ok:true},200,{"Set-Cookie":"sc=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"})});
route("GET","/me",async c=>{const u=need(c),n=await q(c,"SELECT (SELECT COUNT(*) FROM follows WHERE following_id=?1) f,(SELECT COUNT(*) FROM follows WHERE follower_id=?1) g",u.id).first();
  return J({user:{...me(u),followers:n.f+(u.followers_adjust||0),following:n.g},unread:{private:await privUnread(c,u.id)}})});
route("PUT","/settings",async c=>{const u=need(c),b=await body(c.req),s=JSON.stringify(b.settings||{});if(s.length>8000)return J({error:"Settings too large"},400);
  await q(c,"UPDATE users SET settings=? WHERE id=?",s,u.id).run();return J({ok:true})});
route("PATCH","/account",async c=>{
  const u=need(c),b=await body(c.req),s=[],v=[],set=(col,val)=>{s.push(col+"=?");v.push(val)};
  if(b.name!==undefined){const n=str(b.name,60);if(!n)return J({error:"Enter a name"},400);set("name",n)}
  if(b.username!==undefined){const x=str(b.username,30).toLowerCase();if(!UN.test(x))return J({error:"Username: 3 to 30 letters, numbers or underscore"},400);set("username",x)}
  if(b.email!==undefined){const x=str(b.email,120).toLowerCase();if(!EMAIL.test(x))return J({error:"Enter a valid email"},400);set("email",x)}
  if(b.phone!==undefined){const x=normPhone(b.phone);if(!x)return J({error:"Enter a valid phone number"},400);set("phone",x)}
  if(b.bio!==undefined)set("bio",str(b.bio,200));
  if(b.location!==undefined)set("location",str(b.location,80));
  for(const k of["avatar","cover"])if(b[k+"_key"]){const kk=str(b[k+"_key"],120);if(!await ownMedia(c,kk,u.id,"avatar"))return J({error:"Invalid picture"},400);set(k+"_key",kk)}
  if(!s.length)return J({ok:true});
  try{await c.env.DB.prepare(`UPDATE users SET ${s.join(",")} WHERE id=?`).bind(...v,u.id).run()}catch{return J({error:"Username, email or phone number already used"},409)}
  return J({ok:true})});
route("POST","/account/password",async c=>{
  const u=need(c),b=await body(c.req),n=String(b.new||"");
  if(n.length<8||n.length>72)return J({error:"Use 8 to 72 characters"},400);
  if(!same(await pbk(String(b.old||""),unhex(u.pass_salt)),u.pass_hash))return J({error:"Current password is wrong"},403);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  await c.env.DB.batch([q(c,"UPDATE users SET pass_salt=?,pass_hash=? WHERE id=?",hex(salt),await pbk(n,salt),u.id),q(c,"DELETE FROM sessions WHERE user_id=? AND token_hash<>?",u.id,u.th)]);
  return J({ok:true})});
route("GET","/sessions",async c=>{const u=need(c);
  const s=(await q(c,"SELECT token_hash,user_agent ua,created_at t FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC",u.id,now()).all()).results.map(x=>({ua:x.ua,t:x.t,current:x.token_hash===u.th}));
  const l=(await q(c,"SELECT user_agent ua,created_at t FROM login_activity WHERE user_id=? ORDER BY id DESC LIMIT 10",u.id).all()).results;return J({sessions:s,logins:l})});
route("POST","/sessions/logout-others",async c=>{const u=need(c);await q(c,"DELETE FROM sessions WHERE user_id=? AND token_hash<>?",u.id,u.th).run();return J({ok:true})});
route("POST","/account/deactivate",async c=>{const u=need(c);await c.env.DB.batch([q(c,"UPDATE users SET status='deactivated' WHERE id=?",u.id),q(c,"DELETE FROM sessions WHERE user_id=?",u.id)]);
  return J({ok:true},200,{"Set-Cookie":"sc=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"})});
route("POST","/account/delete",async c=>{
  const u=need(c),b=await body(c.req);
  if(!same(await pbk(String(b.password||""),unhex(u.pass_salt)),u.pass_hash))return J({error:"Password is wrong"},403);
  const ks=(await q(c,"SELECT key FROM media WHERE owner_id=?",u.id).all()).results;
  for(const k of ks)await bucket(c.env).delete(k.key);
  await q(c,"DELETE FROM users WHERE id=?",u.id).run(); // foreign keys remove sessions, messages, follows and the rest
  return J({ok:true},200,{"Set-Cookie":"sc=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"})});
route("GET","/users/([^/]+)",async c=>{const u=need(c),t=await q(c,"SELECT * FROM users WHERE id=? AND status='active'",c.p[0]).first();
  if(!t||await blocked(c,u.id,t.id))return J({error:"Not found"},404);return J({user:pub(t)})});
route("POST","/relations",async c=>{
  const u=need(c),b=await body(c.req),k=str(b.kind,10),t=str(b.target,60);
  if(!["block","mute","restrict"].includes(k)||t===u.id)return J({error:"Invalid request"},400);
  if(b.add)await q(c,"INSERT OR IGNORE INTO user_relations(user_id,target_id,kind,created_at) VALUES(?,?,?,?)",u.id,t,k,now()).run();
  else await q(c,"DELETE FROM user_relations WHERE user_id=? AND target_id=? AND kind=?",u.id,t,k).run();
  return J({ok:true})});

// ---------- pictures (R2) ----------
const sniff=s=>(s[0]===0xFF&&s[1]===0xD8&&s[2]===0xFF)?"image/jpeg":(s[0]===0x89&&s[1]===0x50&&s[2]===0x4E&&s[3]===0x47)?"image/png":(s[0]===0x52&&s[1]===0x49&&s[8]===0x57&&s[9]===0x45)?"image/webp":"";
async function mp4Seconds(f){const parts=[f.slice(0,1e6)];if(f.size>1e6)parts.push(f.slice(Math.max(1e6,f.size-1e6)));
  for(const p of parts){const u=new Uint8Array(await p.arrayBuffer()),i=new TextDecoder("latin1").decode(u).indexOf("mvhd");if(i<0)continue;
    const v=new DataView(u.buffer),ver=u[i+4],ts=v.getUint32(i+(ver?24:16)),du=ver?Number(v.getBigUint64(i+28)):v.getUint32(i+20);return ts?du/ts:0}return 0}
route("POST","/media",async c=>{
  const u=need(c),sc=c.url.searchParams.get("scope"),conv=+(c.url.searchParams.get("conv")||0);
  if(!["public","private","avatar","post","support"].includes(sc))return J({error:"Invalid scope"},400);
  if(sc==="private")await part(c,conv);
  if(+(c.req.headers.get("Content-Length")||0)>16e6)return J({error:"File is too large"},413);
  const f=(await c.req.formData()).get("file");if(!f||typeof f==="string")return J({error:"No file"},400);
  const head=new Uint8Array(await f.slice(0,12).arrayBuffer());let ct=sniff(head),kind="image";
  if(!ct&&head[4]===0x66&&head[5]===0x74&&head[6]===0x79&&head[7]===0x70){ct="video/mp4";kind="video"}
  if(!ct)return J({error:"Use a JPG, PNG or WebP picture, or an MP4 video"},400);
  if(kind==="image"&&f.size>3e6)return J({error:"Picture is too large (3 MB maximum)"},413);
  if(kind==="video"){if(sc!=="post"||f.size>15e6)return J({error:"Video must be an MP4 under 15 MB"},413);
    const d=await mp4Seconds(f);if(!d)return J({error:"Could not read the video length"},400);if(d>30.5)return J({error:"Video must be 30 seconds or shorter"},400)}
  const key=`${u.id}/${crypto.randomUUID()}`;
  await bucket(c.env).put(key,await f.arrayBuffer(),{httpMetadata:{contentType:ct}});
  await q(c,"INSERT INTO media(key,owner_id,scope,conv_id,kind,created_at) VALUES(?,?,?,?,?,?)",key,u.id,sc,sc==="private"?conv:null,kind,now()).run();
  return J({key,url:mediaUrl(key),kind},201)});
route("GET","/media/(.+)",async c=>{
  const key=c.p[0],m=await q(c,"SELECT * FROM media WHERE key=?",key).first();if(!m)return J({error:"Not found"},404);
  if(!["avatar","post"].includes(m.scope)){const u=need(c);let ok=m.scope==="public"||m.owner_id===u.id||(m.scope==="support"&&u.role==="admin");
    if(m.scope==="private")ok=!!await q(c,"SELECT 1 FROM private_conversation_participants WHERE conversation_id=? AND user_id=?",m.conv_id,u.id).first();
    if(!ok)return J({error:"Not found"},404)}
  const R2=bucket(c.env),h=await R2.head(key);if(!h)return J({error:"Not found"},404);
  const base={"Content-Type":h.httpMetadata?.contentType||"image/jpeg","Cache-Control":"public, max-age=86400","X-Content-Type-Options":"nosniff","Accept-Ranges":"bytes"};
  const rg=/^bytes=(\d*)-(\d*)$/.exec(c.req.headers.get("Range")||"");
  if(rg&&(rg[1]||rg[2])){let a=rg[1]?+rg[1]:Math.max(0,h.size-+rg[2]),e=rg[1]&&rg[2]?Math.min(+rg[2],h.size-1):h.size-1;
    if(a>e||a>=h.size)return new Response(null,{status:416,headers:{"Content-Range":`bytes */${h.size}`}});
    const o=await R2.get(key,{range:{offset:a,length:e-a+1}});return new Response(o.body,{status:206,headers:{...base,"Content-Range":`bytes ${a}-${e}/${h.size}`,"Content-Length":String(e-a+1)}})}
  const o=await R2.get(key);return new Response(o.body,{headers:{...base,"Content-Length":String(h.size)}})});

// ---------- public community chat ----------
const PMSG="SELECT m.id,m.body,m.media_key,m.created_at,u.id uid,u.name,u.username,u.avatar_key FROM public_chat_messages m JOIN users u ON u.id=m.sender_id";
const shape=r=>({id:r.id,body:r.body||"",media:mediaUrl(r.media_key),t:r.created_at,from:{id:r.uid,name:r.name,user:r.username,avatar:mediaUrl(r.avatar_key)}});
route("GET","/chat/state",async c=>{
  const u=need(c),r=await q(c,"SELECT s.is_locked,s.locked_at,s.reason,m.name FROM chat_room_settings s LEFT JOIN users m ON m.id=s.locked_by WHERE s.id=1").first();
  const pu=await q(c,"SELECT COUNT(*) n FROM public_chat_messages WHERE sender_id<>?1 AND created_at>=?2 AND id>COALESCE((SELECT last_read_id FROM message_read_status WHERE user_id=?1 AND scope='public'),0)",u.id,staff(u)?0:u.created_at).first();
  const out={room:{locked:!!r.is_locked,by:r.name||"",at:r.locked_at||0,reason:r.reason||""},pubUnread:pu.n,privUnread:await privUnread(c,u.id)};
  if(staff(u))out.logs=(await q(c,"SELECT l.action,l.reason,l.created_at t,m.name by FROM chat_moderation_logs l JOIN users m ON m.id=l.moderator_id ORDER BY l.id DESC LIMIT 20").all()).results;
  return J(out)});
route("GET","/chat/unread",async c=>{const u=need(c);return J({private:await privUnread(c,u.id)})});
route("GET","/chat/public",async c=>{const u=need(c);
  const rs=(await q(c,PMSG+" WHERE m.sender_id NOT IN (SELECT target_id FROM user_relations WHERE user_id=?1 AND kind IN ('block','mute')) AND m.created_at>=?2 ORDER BY m.id DESC LIMIT 60",u.id,staff(u)?0:u.created_at).all()).results;
  return J({messages:rs.reverse().map(shape)})});
route("POST","/chat/public",async c=>{
  const u=need(c),b=await body(c.req),t=str(b.body,1000),mk=str(b.media,120);
  if(!t&&!mk)return J({error:"Write a message first"},400);
  const room=await q(c,"SELECT is_locked FROM chat_room_settings WHERE id=1").first();
  if(room.is_locked&&!staff(u))return J({error:"Chat is locked. Only Admin and Chairman can send messages right now."},423); // enforced here, not in the browser
  if(mk&&!await ownMedia(c,mk,u.id,"public"))return J({error:"Invalid attachment"},400);
  const r=await q(c,"INSERT INTO public_chat_messages(sender_id,body,media_key,created_at) VALUES(?,?,?,?)",u.id,t,mk||null,now()).run();
  const msg=shape(await q(c,PMSG+" WHERE m.id=?",r.meta.last_row_id).first());await emit(c.env,{t:"pub",msg});return J({message:msg})});
route("POST","/chat/public/read",async c=>{const u=need(c);
  await q(c,"INSERT INTO message_read_status(user_id,scope,last_read_id) VALUES(?1,'public',(SELECT COALESCE(MAX(id),0) FROM public_chat_messages)) ON CONFLICT(user_id,scope) DO UPDATE SET last_read_id=excluded.last_read_id",u.id).run();return J({ok:true})});
route("POST","/chat/room",async c=>{
  const u=need(c);if(!staff(u))return J({error:"Not allowed"},403);
  const b=await body(c.req),lock=b.locked?1:0,why=str(b.reason,200);
  await c.env.DB.batch([q(c,"UPDATE chat_room_settings SET is_locked=?,locked_by=?,locked_at=?,reason=? WHERE id=1",lock,u.id,now(),why),
    q(c,"INSERT INTO chat_moderation_logs(action,moderator_id,reason,created_at) VALUES(?,?,?,?)",lock?"lock":"unlock",u.id,why,now())]);
  const room={locked:!!lock,by:u.name,at:now(),reason:why};await emit(c.env,{t:"room",room});return J({room})});

// ---------- private chats (only the two participants; admins and the chairman get no access) ----------
route("GET","/chat/conversations",async c=>{const u=need(c);
  const rs=(await q(c,`SELECT c.id,o.id oid,o.name,o.username,o.avatar_key,
    (SELECT body FROM private_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) lb,
    (SELECT media_key IS NOT NULL FROM private_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) lm,
    (SELECT created_at FROM private_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) lt,
    (SELECT COUNT(*) FROM private_messages m WHERE m.conversation_id=c.id AND m.sender_id<>?1 AND m.id>p.last_read_id) unread,
    EXISTS(SELECT 1 FROM user_relations WHERE kind='block' AND user_id=?1 AND target_id=o.id) ib,
    EXISTS(SELECT 1 FROM user_relations WHERE kind='block' AND user_id=o.id AND target_id=?1) tb
    FROM private_conversation_participants p JOIN private_conversations c ON c.id=p.conversation_id
    JOIN private_conversation_participants q ON q.conversation_id=c.id AND q.user_id<>?1 JOIN users o ON o.id=q.user_id
    WHERE p.user_id=?1 ORDER BY COALESCE(lt,c.created_at) DESC`,u.id).all()).results;
  return J({conversations:rs.map(r=>({id:r.id,other:{id:r.oid,name:r.name,user:r.username,avatar:mediaUrl(r.avatar_key)},last:r.lt?{body:r.lb||"",media:!!r.lm,t:r.lt}:null,unread:r.unread,iBlocked:!!r.ib,theyBlocked:!!r.tb}))})});
route("POST","/chat/conversations",async c=>{
  const u=need(c),b=await body(c.req),t=str(b.userId,60);
  if(t===u.id)return J({error:"You cannot message yourself"},400);
  if(!await q(c,"SELECT 1 FROM users WHERE id=? AND status='active'",t).first())return J({error:"User not found"},404);
  if(await blocked(c,u.id,t))return J({error:"You cannot message this person"},403);
  const key=[u.id,t].sort().join(":");let cv=await q(c,"SELECT id FROM private_conversations WHERE pair_key=?",key).first();
  if(!cv){const r=await q(c,"INSERT INTO private_conversations(pair_key,created_at) VALUES(?,?)",key,now()).run(),id=r.meta.last_row_id;
    await c.env.DB.batch([q(c,"INSERT INTO private_conversation_participants(conversation_id,user_id,created_at) VALUES(?,?,?)",id,u.id,now()),q(c,"INSERT INTO private_conversation_participants(conversation_id,user_id,created_at) VALUES(?,?,?)",id,t,now())]);cv={id}}
  return J({id:cv.id})});
const PRIV="SELECT m.id,m.body,m.media_key,m.created_at,u.id uid,u.name,u.username,u.avatar_key FROM private_messages m JOIN users u ON u.id=m.sender_id";
route("GET","/chat/conversations/(\\d+)/messages",async c=>{need(c);await part(c,+c.p[0]);
  const rs=(await q(c,PRIV+" WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 100",+c.p[0]).all()).results;const o=await q(c,"SELECT last_read_id n FROM private_conversation_participants WHERE conversation_id=? AND user_id<>?",+c.p[0],c.u.id).first();return J({messages:rs.reverse().map(shape),otherRead:o?o.n:0})});
route("POST","/chat/conversations/(\\d+)/messages",async c=>{
  const u=need(c),cv=+c.p[0];await part(c,cv);
  const b=await body(c.req),t=str(b.body,1000),mk=str(b.media,120);
  if(!t&&!mk)return J({error:"Write a message first"},400);
  const o=await q(c,"SELECT user_id FROM private_conversation_participants WHERE conversation_id=? AND user_id<>?",cv,u.id).first();
  if(await blocked(c,u.id,o.user_id))return J({error:"You cannot send messages in this chat"},403);
  if(mk&&!await ownMedia(c,mk,u.id,"private",cv))return J({error:"Invalid attachment"},400);
  const r=await q(c,"INSERT INTO private_messages(conversation_id,sender_id,body,media_key,created_at) VALUES(?,?,?,?,?)",cv,u.id,t,mk||null,now()).run();
  await q(c,"UPDATE private_conversation_participants SET last_read_id=? WHERE conversation_id=? AND user_id=?",r.meta.last_row_id,cv,u.id).run(); // your own messages are never unread
  const msg=shape(await q(c,PRIV+" WHERE m.id=?",r.meta.last_row_id).first());await emit(c.env,{t:"priv",conv:cv,msg},[u.id,o.user_id]);return J({message:msg})});
route("POST","/chat/conversations/(\\d+)/read",async c=>{const u=need(c),cv=+c.p[0];await part(c,cv);
  await q(c,"UPDATE private_conversation_participants SET last_read_id=(SELECT COALESCE(MAX(id),0) FROM private_messages WHERE conversation_id=?1) WHERE conversation_id=?1 AND user_id=?2",cv,u.id).run();
  const o=await q(c,"SELECT user_id FROM private_conversation_participants WHERE conversation_id=? AND user_id<>?",cv,u.id).first(),mine=await q(c,"SELECT last_read_id n FROM private_conversation_participants WHERE conversation_id=? AND user_id=?",cv,u.id).first();
  if(o)await emit(c.env,{t:"read",conv:cv,upTo:mine.n},[o.user_id]);
  return J({privUnread:await privUnread(c,u.id)})});
route("POST","/chat/block",async c=>{
  const u=need(c),b=await body(c.req),t=str(b.userId,60);if(t===u.id)return J({error:"Invalid request"},400);
  if(b.blocked)await q(c,"INSERT OR IGNORE INTO user_relations(user_id,target_id,kind,created_at) VALUES(?,?,'block',?)",u.id,t,now()).run();
  else await q(c,"DELETE FROM user_relations WHERE user_id=? AND target_id=? AND kind='block'",u.id,t).run();
  return J({ok:true})});
route("POST","/chat/report",async c=>{
  const u=need(c),b=await body(c.req),sc=b.scope==="public"?"public":"private",mid=+b.messageId,why=str(b.reason,300);
  const row=sc==="public"?await q(c,"SELECT sender_id,body FROM public_chat_messages WHERE id=?",mid).first()
    :await q(c,"SELECT m.sender_id,m.body FROM private_messages m JOIN private_conversation_participants p ON p.conversation_id=m.conversation_id AND p.user_id=? WHERE m.id=?",u.id,mid).first();
  if(!row||row.sender_id===u.id)return J({error:"Message not found"},404);
  await q(c,"INSERT INTO chat_reports(reporter_id,reported_user_id,scope,message_id,body,reason,created_at) VALUES(?,?,?,?,?,?,?)",u.id,row.sender_id,sc,mid,row.body,why,now()).run();return J({ok:true})});
route("GET","/admin/chat-reports",async c=>{const u=need(c);if(u.role!=="admin")return J({error:"Not allowed"},403); // only the reported message is shared, never the whole chat
  return J({reports:(await q(c,"SELECT id,scope,reported_user_id,body,reason,status,created_at t FROM chat_reports ORDER BY id DESC LIMIT 100").all()).results})});

// ---------- Help & Support: user <-> Admin only, deleted 24 hours after creation ----------
route("GET","/support",async c=>{const u=need(c);
  return J({messages:(await q(c,"SELECT id,is_admin_reply,body,media_key,created_at t FROM support_messages WHERE user_id=? AND created_at>? ORDER BY id",u.id,now()-864e5).all()).results.map(m=>({...m,media:mediaUrl(m.media_key)}))})});
route("POST","/support",async c=>{const u=need(c),b=await body(c.req),t=str(b.body,1000),mk=str(b.media,120);if(!t&&!mk)return J({error:"Write a message first"},400);
  if(mk&&!await ownMedia(c,mk,u.id,"support"))return J({error:"Invalid attachment"},400);
  await q(c,"INSERT INTO support_messages(user_id,sender_id,is_admin_reply,body,media_key,created_at) VALUES(?,?,0,?,?,?)",u.id,u.id,t,mk||null,now()).run();return J({ok:true})});
route("GET","/admin/support",async c=>{const u=need(c);if(u.role!=="admin")return J({error:"Not allowed"},403); // the Chairman is excluded on purpose
  return J({messages:(await q(c,"SELECT s.id,s.user_id,u.name,s.is_admin_reply,s.body,s.media_key,s.created_at t FROM support_messages s JOIN users u ON u.id=s.user_id WHERE s.created_at>? ORDER BY s.id",now()-864e5).all()).results.map(m=>({...m,media:mediaUrl(m.media_key)}))})});
route("POST","/admin/support/([^/]+)",async c=>{const u=need(c);if(u.role!=="admin")return J({error:"Not allowed"},403);
  const b=await body(c.req),t=str(b.body,1000);if(!t)return J({error:"Write a reply first"},400);
  await q(c,"INSERT INTO support_messages(user_id,sender_id,is_admin_reply,body,created_at) VALUES(?,?,1,?,?)",c.p[0],u.id,t,now()).run();return J({ok:true})});
async function cleanup(env){ // run by the cron trigger every minute: permanent deletion of rows and pictures
  const rs=(await env.DB.prepare("SELECT id,media_key FROM support_messages WHERE created_at<? LIMIT 200").bind(now()-864e5).all()).results;
  for(const r of rs){if(r.media_key){await bucket(env).delete(r.media_key);await env.DB.prepare("DELETE FROM media WHERE key=?").bind(r.media_key).run()}
    await env.DB.prepare("DELETE FROM support_messages WHERE id=?").bind(r.id).run()}
  const ss=(await env.DB.prepare("SELECT id,media_key FROM stories WHERE created_at<? LIMIT 100").bind(now()-864e5).all()).results;
  for(const s of ss){await bucket(env).delete(s.media_key);await env.DB.prepare("DELETE FROM media WHERE key=?").bind(s.media_key).run();await env.DB.prepare("DELETE FROM stories WHERE id=?").bind(s.id).run()}
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()).run()}

route("GET","/ws",async c=>{const u=need(c);if(c.req.headers.get("Upgrade")!=="websocket")return J({error:"Expected WebSocket"},426);
  return hub(c.env).fetch(new Request("https://hub/ws?u="+encodeURIComponent(u.id),c.req))});

let schemaReady=null;
async function ensureSchema(env){ // adds anything an older database is missing, so no manual SQL is needed
  const cols=async t=>(await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map(r=>r.name);
  const add=async(t,c,def)=>{if(!(await cols(t)).includes(c))await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`).run()};
  await add("posts","likes_adjust","INTEGER NOT NULL DEFAULT 0");await add("users","followers_adjust","INTEGER NOT NULL DEFAULT 0");await add("media","kind","TEXT NOT NULL DEFAULT 'image'");await add("posts","bg","TEXT");await add("notifications","ref","TEXT");
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS post_shares(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(post_id,user_id))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS stories(id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, media_key TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'image', caption TEXT, created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_stories_time ON stories(created_at)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS comment_likes(comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(comment_id,user_id))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS post_views(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('post','reel')), created_at INTEGER NOT NULL, PRIMARY KEY(post_id,user_id,kind))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS story_views(story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(story_id,user_id))").run()}
const ensureReady=env=>{if(!schemaReady)schemaReady=ensureSchema(env).catch(e=>{schemaReady=null;throw e});return schemaReady};
const msg=e=>String(e&&e.message||e).slice(0,140);
async function health(env){const out={database:false,pictures_bucket:!!bucket(env),realtime:!!env.HUB,admin_email_set:!!(env.ADMIN_EMAIL||"").trim(),chairman_email_set:!!(env.CHAIRMAN_EMAIL||"").trim()};
  try{await ensureReady(env);const ti=async t=>(await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map(r=>r.name);
    out.database=true;out.tables=(await env.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").first()).n;
    out.columns_ok=(await ti("posts")).includes("likes_adjust")&&(await ti("users")).includes("followers_adjust")&&(await ti("media")).includes("kind")}catch(e){out.error=msg(e)}
  return J(out)}
export default{
  async fetch(req,env){
    const url=new URL(req.url);
    if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(req);
    if(!["GET","HEAD"].includes(req.method)){const o=req.headers.get("Origin");if(o&&o!==url.origin)return J({error:"Bad origin"},403)}
    if(url.pathname==="/api/health")return health(env);
    let u=null;try{await ensureReady(env);u=await who(req,env)}catch(e){console.error(e);return J({error:"Server error: "+msg(e)},500)}
    for(const[m,re,fn]of routes){if(m!==req.method)continue;const x=re.exec(url.pathname.slice(4));
      if(x){try{return await fn({req,env,u,url,p:x.slice(1)})}catch(e){if(e instanceof Response)return e;console.error(e);return J({error:"Server error: "+msg(e)},500)}}}
    return J({error:"Not found"},404)},
  async scheduled(ev,env,ctx){ctx.waitUntil(cleanup(env))}};

// Durable Object: keeps WebSocket connections and relays events. Reachable only through the Worker above.
export class ChatRoom{
  constructor(state){this.state=state}
  async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==="/ws"){const[c,s]=Object.values(new WebSocketPair());this.state.acceptWebSocket(s,[url.searchParams.get("u")]);return new Response(null,{status:101,webSocket:c})}
    if(url.pathname==="/emit"){const{event,to}=await req.json();
      for(const ws of this.state.getWebSockets())if(!to||this.state.getTags(ws).some(t=>to.includes(t)))try{ws.send(JSON.stringify(event))}catch{}
      return new Response("ok")}
    return new Response("Not found",{status:404})}
  webSocketMessage(){}
  webSocketClose(ws){try{ws.close()}catch{}}}
