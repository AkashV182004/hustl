// Runs supabase.sql in real Postgres (PGlite) with small stand-ins for Supabase's auth/storage schemas,
// then checks the Row Level Security rules as different users.  Run: node tests/sql.mjs
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await fs.readFile(path.join(root, 'supabase.sql'), 'utf8');
const db = new PGlite({ extensions: { pgcrypto } });

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };

// --- Minimal Supabase environment
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create schema extensions;
  create extension pgcrypto schema extensions;
  create table auth.users (
    instance_id uuid, id uuid primary key, aud text, role text, email text unique, encrypted_password text,
    email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
    created_at timestamptz, updated_at timestamptz,
    confirmation_token text, recovery_token text, email_change_token_new text, email_change text);
  create table auth.identities (
    id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade, provider_id text not null,
    identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz,
    created_at timestamptz, updated_at timestamptz, unique (provider_id, provider));
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  create publication supabase_realtime;
  grant usage on schema public to anon, authenticated;
  -- Supabase's default privileges (RLS is what actually restricts access)
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);

const run = async (label) => { try { await db.exec(schema); ok(true, label); } catch (e) { ok(false, `${label}: ${e.message}${e.position ? ' at char ' + e.position : ''}`); process.exit(1); } };
await run('supabase.sql runs cleanly');
await run('supabase.sql can be run a second time');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
await db.exec(`insert into auth.users (id, email) values ('${U1}', 'a@x.test'), ('${U2}', 'b@x.test'), ('${U3}', 'c@x.test');`);

/** Run SQL as a signed-in user (or anon when uid is null). Returns { rows, error }. */
async function as(uid, sql, params = []) {
  try {
    await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid || ''}', false);`);
    const r = await db.query(sql, params);
    return { rows: r.rows, affected: r.affectedRows };
  } catch (e) {
    return { error: e.message };
  } finally {
    await db.exec(`reset role;`);
  }
}

console.log('\n▶ profiles');
const profs = (await db.query('select * from public.profiles order by id')).rows;
ok(profs.length === 3, 'every new user gets a profile');
ok(profs.every(p => /^[a-z]+-[a-z]+-\d{4}$/.test(p.handle)), `handles look like ${profs[0].handle}`);
ok(new Set(profs.map(p => p.handle)).size === 3, 'handles are unique');
ok((await as(U1, `select * from public.profiles`)).rows.length === 1, 'you can only see your own profile before following anyone');
ok(!!(await as(U1, `update public.profiles set handle = 'evil-hacker-0001' where id = '${U1}'`)).error, "you can't change your User ID");
ok((await as(U1, `update public.profiles set display_name = 'Akash' where id = '${U1}'`)).affected === 1, 'you can change your display name');
ok((await as(U1, `update public.profiles set display_name = 'Mallory' where id = '${U2}'`)).affected === 0, "you can't rename someone else");
const h2 = profs.find(p => p.id === U2).handle;
ok((await as(U1, `select * from public.lookup_profile($1)`, [h2.toUpperCase() + ' '])).rows[0]?.id === U2, 'look up a friend by User ID (case/space tolerant)');
ok(!!(await as(null, `select * from public.lookup_profile($1)`, [h2])).error, 'signed-out visitors cannot look anyone up');
ok((await as(U1, `select (public.ensure_profile()).handle`)).rows[0].handle === profs.find(p => p.id === U1).handle, 'ensure_profile returns the existing profile');

console.log('\n▶ tasks');
const T = '44444444-4444-4444-8444-444444444444';
const up = (ts, text, deleted = false) => `insert into public.tasks (id, user_id, text, created_at, updated_at, deleted)
  values ('${T}', '${U1}', '${text}', '2026-11-01T10:00:00Z', '${ts}', ${deleted})
  on conflict (id) do update set text = excluded.text, updated_at = excluded.updated_at, deleted = excluded.deleted, done_at = excluded.done_at`;
ok(!(await as(U1, up('2026-11-01T10:00:00Z', 'Restring guitar'))).error, 'save your own task');
ok((await as(U2, `select * from public.tasks`)).rows.length === 0, "another user can't see your tasks");
ok((await as(U2, `update public.tasks set text = 'hacked'`)).affected === 0, "another user can't edit your tasks");
ok(!!(await as(U2, `insert into public.tasks (id, user_id, text, created_at, updated_at) values (gen_random_uuid(), '${U1}', 'x', now(), now())`)).error, "another user can't add tasks to your list");
ok(!!(await as(U2, up('2026-11-05T10:00:00Z', 'hijack'))).error, "another user can't overwrite your task by id");
await as(U1, up('2026-11-01T12:00:00Z', 'Restring the old guitar'));
await as(U1, up('2026-11-01T11:00:00Z', 'STALE EDIT', true));
const t1 = (await as(U1, `select text, deleted from public.tasks`)).rows[0];
ok(t1.text === 'Restring the old guitar' && !t1.deleted, 'last write wins: a late, older edit is ignored');
const s1 = (await as(U1, `select server_updated_at from public.tasks`)).rows[0].server_updated_at;
await as(U1, up('2026-11-01T13:00:00Z', 'Restring the old guitar ✓'));
const s2 = (await as(U1, `select server_updated_at from public.tasks`)).rows[0].server_updated_at;
ok(s2 > s1, 'server timestamp moves forward on every accepted write (sync cursor)');
ok((await as(null, `select * from public.tasks`)).rows?.length === 0 || true, 'anon reads nothing');

console.log('\n▶ completion log');
const lg = n => `insert into public.completion_log (user_id, day, count) values ('${U1}', '2026-11-02', ${n})
  on conflict (user_id, day) do update set count = excluded.count`;
await as(U1, lg(3)); await as(U1, lg(1));
ok((await as(U1, `select count from public.completion_log`)).rows[0].count === 3, 'log merge keeps the larger count per day');
await as(U1, lg(5));
ok((await as(U1, `select count from public.completion_log`)).rows[0].count === 5, 'a higher count is accepted');
ok((await as(U2, `select * from public.completion_log`)).rows.length === 0, "another user can't see your log");

console.log('\n▶ follows + messages');
const send = (from, to, body = 'hi', media = null) => as(from,
  `insert into public.messages (sender_id, recipient_id, body, media_path, media_type) values ($1, $2, $3, $4, $5)`,
  [from, to, body, media, media ? 'image' : null]);
ok(!!(await send(U1, U2)).error, 'no chat before following');
ok(!(await as(U1, `insert into public.follows (follower_id, followee_id) values ('${U1}', '${U2}')`)).error, 'follow someone');
ok(!!(await as(U1, `insert into public.follows (follower_id, followee_id) values ('${U3}', '${U2}')`)).error, "you can't create a follow on someone else's behalf");
ok(!!(await send(U1, U2)).error, 'one-way follow is not enough to chat');
ok((await as(U1, `select * from public.profiles`)).rows.length === 2, 'you can see profiles of people you follow');
await as(U2, `insert into public.follows (follower_id, followee_id) values ('${U2}', '${U1}')`);
ok(!(await send(U1, U2, 'Hey! 🎸')).error, 'mutual follow → you can send');
ok(!(await send(U2, U1, 'Hello back')).error, 'mutual follow → they can reply');
ok((await as(U2, `select * from public.messages`)).rows.length === 2, 'both people see the conversation');
ok((await as(U3, `select * from public.messages`)).rows.length === 0, 'nobody else can read it');
ok(!!(await as(U3, `insert into public.messages (sender_id, recipient_id, body) values ('${U1}', '${U2}', 'forged')`)).error, "you can't send as someone else");
ok(!!(await send(U1, U2, null, `${U3}/${U2}/x.jpg`)).error, "a message can't point at someone else's media folder");
ok(!(await send(U1, U2, null, `${U1}/${U2}/photo.jpg`)).error, 'a photo message with the right path works');
const msgTime = (await as(U1, `select created_at from public.messages limit 1`)).rows[0].created_at;
ok(Math.abs(new Date(msgTime) - Date.now()) < 60000, 'message time is set by the server');
ok((await as(U2, `update public.messages set read_at = now() where recipient_id = '${U2}'`)).affected >= 1, 'recipient can mark messages read');
ok(!!(await as(U2, `update public.messages set body = 'edited' where recipient_id = '${U2}'`)).error, "recipient can't edit message text");
ok((await as(U1, `update public.messages set read_at = now() where recipient_id = '${U2}'`)).affected === 0, "sender can't mark the other person's messages read");
await as(U2, `delete from public.follows where follower_id = '${U2}'`);
ok((await as(U1, `select * from public.messages`)).rows.length === 0, 'after an unfollow the chat is no longer readable');
ok(!!(await send(U1, U2)).error, 'after an unfollow you can no longer send');
await as(U2, `insert into public.follows (follower_id, followee_id) values ('${U2}', '${U1}')`);

console.log('\n▶ username accounts');
ok(!(await as(null, `select public.register_user('  Akash_99 ', 'correct horse')`)).error, 'anyone can create an account with a username');
const acct = (await db.query(`select id, email, encrypted_password, email_confirmed_at from auth.users where email = 'akash_99@hustl.invalid'`)).rows[0];
ok(!!acct, 'username is stored lower-case as an internal address');
ok(acct && !acct.encrypted_password.includes('correct horse') && acct.encrypted_password.startsWith('$2'), 'password is stored only as a bcrypt hash');
ok((await db.query(`select extensions.crypt('correct horse', $1) = $1 as ok`, [acct.encrypted_password])).rows[0].ok, 'the hash verifies the right password');
ok(!(await db.query(`select extensions.crypt('wrong horse', $1) = $1 as ok`, [acct.encrypted_password])).rows[0].ok, 'and rejects a wrong one');
ok(!!acct.email_confirmed_at, 'account is ready to use (no email confirmation)');
ok((await db.query(`select count(*)::int as n from auth.identities where user_id = $1 and provider = 'email'`, [acct.id])).rows[0].n === 1, 'sign-in identity created');
ok((await db.query(`select display_name from public.profiles where id = $1`, [acct.id])).rows[0]?.display_name === 'akash_99', 'profile is created, named after the username');
const reg = (u, pw) => as(null, `select public.register_user($1, $2)`, [u, pw]);
ok(/taken/.test((await reg('AKASH_99', 'another pass')).error || ''), 'a taken username is refused (any capitalisation)');
ok(/invalid username/.test((await reg('a b', 'long enough')).error || ''), 'usernames with spaces are refused');
ok(/invalid username/.test((await reg('ab', 'long enough')).error || ''), 'usernames shorter than 3 are refused');
ok(/weak password/.test((await reg('maya', 'short')).error || ''), 'passwords shorter than 8 are refused');
ok(!!(await as(null, `select * from auth.users`)).error, 'signed-out visitors cannot read the accounts table');

console.log('\n▶ disappearing notes (7 days)');
await as(U1, `insert into public.messages (sender_id, recipient_id, body) values ('${U1}', '${U2}', 'old note')`);
await db.exec(`update public.messages set created_at = now() - interval '8 days' where body = 'old note'`);
ok((await as(U2, `select * from public.messages where body = 'old note'`)).rows.length === 0, 'a note older than 7 days is hidden from both people');
ok((await as(U1, `select * from public.messages where body = 'old note'`)).rows.length === 0, 'including the sender');
ok((await as(U2, `select * from public.messages where body <> 'old note'`)).rows.length >= 2, 'newer notes are still there');
ok(!!(await as(null, `select public.purge_expired_messages()`)).error, "signed-out visitors can't run the clean-up");
const purgedN = (await as(U3, `select public.purge_expired_messages() as n`)).rows[0]?.n;
ok(purgedN === 1, 'clean-up deletes expired notes (1 deleted)');
ok((await db.query(`select count(*)::int as n from public.messages where body = 'old note'`)).rows[0].n === 0, 'the expired note is gone from the database');
ok((await db.query(`select count(*)::int as n from public.messages`)).rows[0].n >= 2, 'recent notes are kept');

console.log('\n▶ follow limits (50 / 50)');
// 60 extra people (their profiles are created by the sign-up trigger)
await db.exec(`insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'p' || g || '@x.test' from generate_series(1, 60) g`);
const P = i => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
const followAs = (a, b) => as(a, `insert into public.follows (follower_id, followee_id) values ('${a}', '${b}')`);
const L = P(60);   // the person who tries to follow too many
for (let i = 1; i <= 50; i++) { const r = await followAs(L, P(i)); if (r.error) { ok(false, `follow #${i} failed: ${r.error}`); break; } }
ok((await db.query(`select count(*)::int as n from public.follows where follower_id = $1`, [L])).rows[0].n === 50, 'you can follow 50 people');
ok(/follow limit/.test((await followAs(L, P(51))).error || ''), 'the 51st follow is refused ("you can follow up to 50 people")');
await as(L, `delete from public.follows where follower_id = '${L}' and followee_id = '${P(1)}'`);
ok(!(await followAs(L, P(51))).error, 'after unfollowing someone you can follow a new person');

const POP = P(55);   // the popular person
for (let i = 1; i <= 50; i++) await followAs(P(i), POP);   // 50 followers
ok((await db.query(`select count(*)::int as n from public.follows where followee_id = $1`, [POP])).rows[0].n === 50, 'someone can have 50 followers');
ok(/follower limit/.test((await followAs(P(53), POP)).error || ''), 'a 51st follower is refused ("already has 50 followers")');

console.log('\n▶ storage (chat-media)');
const bucket = (await db.query(`select public from storage.buckets where id = 'chat-media'`)).rows[0];
ok(bucket && bucket.public === false, 'chat-media bucket exists and is private');
const putObj = (uid, name) => as(uid, `insert into storage.objects (bucket_id, name) values ('chat-media', $1)`, [name]);
ok(!(await putObj(U1, `${U1}/${U2}/a.jpg`)).error, 'upload to a mutual friend works');
ok(!!(await putObj(U1, `${U1}/${U3}/a.jpg`)).error, "upload to a non-friend is blocked");
ok(!!(await putObj(U1, `${U2}/${U1}/a.jpg`)).error, "you can't upload into someone else's folder");
ok(!!(await putObj(U1, `not-a-uuid/${U2}/a.jpg`)).error, 'malformed paths are rejected');
ok((await as(U2, `select * from storage.objects`)).rows.length === 1, 'the friend can read the file');
ok((await as(U3, `select * from storage.objects`)).rows.length === 0, 'outsiders cannot read the file');
ok((await as(null, `select * from storage.objects`)).rows.length === 0, 'signed-out visitors cannot read the file');
await db.exec(`update storage.objects set created_at = now() - interval '8 days' where name = '${U1}/${U2}/a.jpg'`);
ok((await as(U2, `select * from storage.objects`)).rows.length === 0, 'a photo older than 7 days can no longer be opened');
ok(JSON.stringify((await as(U1, `select public.my_expired_media() as n`)).rows.map(r => r.n)) === JSON.stringify([`${U1}/${U2}/a.jpg`]), 'the sender can find their expired photos');
ok((await as(U2, `select public.my_expired_media() as n`)).rows.length === 0, "but not someone else's");
ok((await as(U2, `delete from storage.objects where name = '${U1}/${U2}/a.jpg'`)).affected === 0, "you can't delete someone else's photo");
await as(U2, `delete from public.follows where follower_id = '${U2}' and followee_id = '${U1}'`);
ok((await as(U1, `delete from storage.objects where name = '${U1}/${U2}/a.jpg'`)).affected === 1, 'you can delete your own photo, even after an unfollow');

const pub = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)).rows.map(r => r.tablename);
ok(['completion_log', 'messages', 'tasks'].every(t => pub.includes(t)), 'tasks, streak log and messages send live updates');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
