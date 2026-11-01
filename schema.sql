-- Safana Connect database for Cloudflare D1 (SQLite). Times are milliseconds since 1970.
-- Run: wrangler d1 execute safana-connect --remote --file=schema.sql
-- D1 has no row-level policies: every permission check is in src/worker.js.
CREATE TABLE users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, phone TEXT,
  pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','chairman','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated','suspended')),
  bio TEXT DEFAULT '', location TEXT DEFAULT '', avatar_key TEXT, cover_key TEXT, settings TEXT NOT NULL DEFAULT '{}',
  fail_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_users_phone ON users(phone) WHERE phone IS NOT NULL AND phone<>'';
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, user_agent TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE login_activity(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, user_agent TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_login_user ON login_activity(user_id,id DESC);
CREATE TABLE user_relations(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('block','mute','restrict')), created_at INTEGER NOT NULL, PRIMARY KEY(user_id,target_id,kind), CHECK(user_id<>target_id));
CREATE TABLE follows(follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(follower_id,following_id), CHECK(follower_id<>following_id));
CREATE INDEX idx_follows_following ON follows(following_id);
CREATE TABLE follow_requests(follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(follower_id,target_id));
CREATE TABLE media(key TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL CHECK(scope IN ('public','private','avatar','post','support')), conv_id INTEGER, created_at INTEGER NOT NULL);
-- Community content
CREATE TABLE posts(id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  is_official INTEGER NOT NULL DEFAULT 0, comments_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX idx_posts_author ON posts(author_id,created_at DESC); CREATE INDEX idx_posts_time ON posts(created_at DESC);
CREATE TABLE post_media(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, media_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','video')));
CREATE TABLE comments(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500), created_at INTEGER NOT NULL);
CREATE INDEX idx_comments_post ON comments(post_id,created_at);
CREATE TABLE likes(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(post_id,user_id));
CREATE TABLE saved_posts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,post_id));
CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX idx_notes_user ON notifications(user_id,is_read,created_at DESC);
CREATE TABLE reports(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE, reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL, reason TEXT, resolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE activity_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL);
-- Local government
CREATE TABLE form_templates(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, fields TEXT NOT NULL DEFAULT '[]', template_key TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE form_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER REFERENCES form_templates(id), applicant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, details TEXT, media_key TEXT, full_form TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Form Ready','Under Review','Approved','Rejected')),
  decided_by TEXT REFERENCES users(id), decided_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX idx_req_applicant ON form_requests(applicant_id); CREATE INDEX idx_req_status ON form_requests(status,created_at DESC);
CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, location TEXT, image_key TEXT,
  status TEXT NOT NULL DEFAULT 'Planned' CHECK(status IN ('Planned','Ongoing','Completed')), progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  start_date TEXT, end_date TEXT, created_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE TABLE meetings(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, scheduled_at INTEGER, status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','ended')),
  livekit_room TEXT, recording_url TEXT, created_by TEXT REFERENCES users(id), started_at INTEGER, ended_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE meeting_participants(meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at INTEGER NOT NULL, left_at INTEGER, PRIMARY KEY(meeting_id,user_id));
CREATE TABLE banner_slides(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, button_text TEXT, button_link TEXT, image_key TEXT,
  position INTEGER NOT NULL DEFAULT 0, is_enabled INTEGER NOT NULL DEFAULT 1, seconds INTEGER NOT NULL DEFAULT 5 CHECK(seconds BETWEEN 2 AND 20), created_at INTEGER NOT NULL);
-- Help & Support (Admin only). A cron job deletes rows and pictures 24 hours after creation.
CREATE TABLE support_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin_reply INTEGER NOT NULL DEFAULT 0, body TEXT CHECK(length(body)<=1000), media_key TEXT, created_at INTEGER NOT NULL, CHECK(body IS NOT NULL OR media_key IS NOT NULL));
CREATE INDEX idx_support_user ON support_messages(user_id,created_at); CREATE INDEX idx_support_time ON support_messages(created_at);
-- Chat Hub
CREATE TABLE chat_room_settings(id INTEGER PRIMARY KEY CHECK(id=1), is_locked INTEGER NOT NULL DEFAULT 0, locked_by TEXT REFERENCES users(id) ON DELETE SET NULL, locked_at INTEGER, reason TEXT);
INSERT INTO chat_room_settings(id,is_locked) VALUES(1,0);
CREATE TABLE public_chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT CHECK(length(body)<=1000), media_key TEXT, created_at INTEGER NOT NULL, CHECK(body<>'' OR media_key IS NOT NULL));
CREATE INDEX idx_pub_time ON public_chat_messages(id DESC);
CREATE TABLE private_conversations(id INTEGER PRIMARY KEY AUTOINCREMENT, pair_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE private_conversation_participants(conversation_id INTEGER NOT NULL REFERENCES private_conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,user_id));
CREATE INDEX idx_cp_user ON private_conversation_participants(user_id);
CREATE TABLE private_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES private_conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT CHECK(length(body)<=1000), media_key TEXT, created_at INTEGER NOT NULL, CHECK(body<>'' OR media_key IS NOT NULL)); -- no 24-hour deletion here
CREATE INDEX idx_pm_conv ON private_messages(conversation_id,id DESC);
CREATE TABLE message_read_status(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,scope));
CREATE TABLE chat_moderation_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL CHECK(action IN ('lock','unlock')), moderator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT, created_at INTEGER NOT NULL);
CREATE TABLE chat_reports(id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reported_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('public','private')), message_id INTEGER NOT NULL, body TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
INSERT INTO form_templates(name,fields,created_at) VALUES('Certificate of Indigene','["Full name","Ward","Village","Father''s name"]',0),('Business Premises Permit','["Full name","Business name","Business address"]',0),('Introduction Letter','["Full name","Purpose","Ward"]',0);
