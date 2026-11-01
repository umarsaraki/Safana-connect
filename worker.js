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
  return startSession(c,u)});
route("POST","/logout",async c=>{const t=cookie(c.req).sc;if(t)await q(c,"DELETE FROM sessions WHERE token_hash=?",await sha(t)).run();
  return J({ok:true},200,{"Set-Cookie":"sc=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"})});
route("GET","/me",async c=>{const u=need(c);return J({user:me(u),unread:{private:await privUnread(c,u.id)}})});
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
  for(const k of ks)await c.env.MEDIA.delete(k.key);
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
route("POST","/media",async c=>{
  const u=need(c),sc=c.url.searchParams.get("scope"),conv=+(c.url.searchParams.get("conv")||0);
  if(!["public","private","avatar","post","support"].includes(sc))return J({error:"Invalid scope"},400);
  if(sc==="private")await part(c,conv);
  if(+(c.req.headers.get("Content-Length")||0)>4e6)return J({error:"Picture is too large (3 MB maximum)"},413);
  const f=(await c.req.formData()).get("file");
  if(!f||typeof f==="string"||f.size>3e6)return J({error:"Picture is too large (3 MB maximum)"},413);
  const ct=sniff(new Uint8Array(await f.slice(0,12).arrayBuffer()));if(!ct)return J({error:"Use a JPG, PNG or WebP picture"},400);
  const key=`${u.id}/${crypto.randomUUID()}`;
  await c.env.MEDIA.put(key,f.stream(),{httpMetadata:{contentType:ct}});
  await q(c,"INSERT INTO media(key,owner_id,scope,conv_id,created_at) VALUES(?,?,?,?,?)",key,u.id,sc,sc==="private"?conv:null,now()).run();
  return J({key,url:mediaUrl(key)},201)});
route("GET","/media/(.+)",async c=>{
  const key=c.p[0],m=await q(c,"SELECT * FROM media WHERE key=?",key).first();if(!m)return J({error:"Not found"},404);
  if(!["avatar","post"].includes(m.scope)){const u=need(c);let ok=m.scope==="public"||m.owner_id===u.id||(m.scope==="support"&&u.role==="admin");
    if(m.scope==="private")ok=!!await q(c,"SELECT 1 FROM private_conversation_participants WHERE conversation_id=? AND user_id=?",m.conv_id,u.id).first();
    if(!ok)return J({error:"Not found"},404)}
  const o=await c.env.MEDIA.get(key);if(!o)return J({error:"Not found"},404);
  return new Response(o.body,{headers:{"Content-Type":o.httpMetadata?.contentType||"image/jpeg","Cache-Control":"private, max-age=3600","X-Content-Type-Options":"nosniff"}})});

// ---------- public community chat ----------
const PMSG="SELECT m.id,m.body,m.media_key,m.created_at,u.id uid,u.name,u.username,u.avatar_key FROM public_chat_messages m JOIN users u ON u.id=m.sender_id";
const shape=r=>({id:r.id,body:r.body||"",media:mediaUrl(r.media_key),t:r.created_at,from:{id:r.uid,name:r.name,user:r.username,avatar:mediaUrl(r.avatar_key)}});
route("GET","/chat/state",async c=>{
  const u=need(c),r=await q(c,"SELECT s.is_locked,s.locked_at,s.reason,m.name FROM chat_room_settings s LEFT JOIN users m ON m.id=s.locked_by WHERE s.id=1").first();
  const pu=await q(c,"SELECT COUNT(*) n FROM public_chat_messages WHERE sender_id<>?1 AND id>COALESCE((SELECT last_read_id FROM message_read_status WHERE user_id=?1 AND scope='public'),0)",u.id).first();
  const out={room:{locked:!!r.is_locked,by:r.name||"",at:r.locked_at||0,reason:r.reason||""},pubUnread:pu.n,privUnread:await privUnread(c,u.id)};
  if(staff(u))out.logs=(await q(c,"SELECT l.action,l.reason,l.created_at t,m.name by FROM chat_moderation_logs l JOIN users m ON m.id=l.moderator_id ORDER BY l.id DESC LIMIT 20").all()).results;
  return J(out)});
route("GET","/chat/unread",async c=>{const u=need(c);return J({private:await privUnread(c,u.id)})});
route("GET","/chat/public",async c=>{const u=need(c);
  const rs=(await q(c,PMSG+" WHERE m.sender_id NOT IN (SELECT target_id FROM user_relations WHERE user_id=? AND kind IN ('block','mute')) ORDER BY m.id DESC LIMIT 60",u.id).all()).results;
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
  const rs=(await q(c,PRIV+" WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 100",+c.p[0]).all()).results;return J({messages:rs.reverse().map(shape)})});
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
  for(const r of rs){if(r.media_key){await env.MEDIA.delete(r.media_key);await env.DB.prepare("DELETE FROM media WHERE key=?").bind(r.media_key).run()}
    await env.DB.prepare("DELETE FROM support_messages WHERE id=?").bind(r.id).run()}
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()).run()}

route("GET","/ws",async c=>{const u=need(c);if(c.req.headers.get("Upgrade")!=="websocket")return J({error:"Expected WebSocket"},426);
  return hub(c.env).fetch(new Request("https://hub/ws?u="+encodeURIComponent(u.id),c.req))});

export default{
  async fetch(req,env){
    const url=new URL(req.url);
    if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(req);
    if(!["GET","HEAD"].includes(req.method)){const o=req.headers.get("Origin");if(o&&o!==url.origin)return J({error:"Bad origin"},403)}
    const u=await who(req,env);
    for(const[m,re,fn]of routes){if(m!==req.method)continue;const x=re.exec(url.pathname.slice(4));
      if(x){try{return await fn({req,env,u,url,p:x.slice(1)})}catch(e){if(e instanceof Response)return e;console.error(e);return J({error:"Server error"},500)}}}
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
