// In-memory stand-in for the Supabase backend, used by tests/fake-supabase.js through Playwright.
// It mirrors the rules in supabase.sql (which tests/sql.mjs checks against real Postgres):
// own rows only, last write wins for tasks, larger count wins for the log, profiles visible only to connections,
// messages only within a mutual follow. Realtime events go to every subscribed page (see harness.mjs).
import { randomUUID } from 'node:crypto';

const ADJ = ['vinyl', 'velvet', 'amber', 'mellow', 'groovy', 'golden', 'dusty', 'smoky'];
const NOUN = ['fox', 'owl', 'tiger', 'raven', 'otter', 'lynx', 'sparrow', 'wolf'];
const pick = a => a[Math.floor(Math.random() * a.length)];
const WEEK = 7 * 24 * 60 * 60 * 1000;
const pg = v => (v ? new Date(v).toISOString().replace('Z', '+00:00') : v); // Postgres-style timestamps

export function createFakeServer() {
  const db = { users: new Map(), profiles: new Map(), tasks: new Map(), log: new Map(), notes: new Map(), follows: [], messages: [], files: new Map() };
  const subscribers = new Set();
  const emit = (table, eventType, row) => subscribers.forEach(fn => fn({ table, eventType, new: { ...row } }));
  let clock = 0;
  const tick = () => { clock = Math.max(Date.now(), clock + 1); return new Date(clock).toISOString(); };
  const rls = { error: { code: '42501', message: 'new row violates row-level security policy' } };

  const connected = (uid, other) => db.follows.some(f =>
    (f.follower_id === uid && f.followee_id === other) || (f.followee_id === uid && f.follower_id === other));
  const mutual = (a, b) => db.follows.some(f => f.follower_id === a && f.followee_id === b)
    && db.follows.some(f => f.follower_id === b && f.followee_id === a);
  const match = (row, filters) => filters.every(([op, col, val]) =>
    op === 'eq' ? row[col] === val
      : op === 'in' ? val.includes(row[col])
        : op === 'is' ? (row[col] ?? null) === val
          : op === 'gt' ? new Date(row[col]) > new Date(val) : true);

  function newProfile(uid) {
    let handle;
    do { handle = `${pick(ADJ)}-${pick(NOUN)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`; }
    while ([...db.profiles.values()].some(p => p.handle === handle));
    const [a, n] = handle.split('-');
    db.profiles.set(uid, { id: uid, handle, display_name: `${a[0].toUpperCase()}${a.slice(1)} ${n[0].toUpperCase()}${n.slice(1)}` });
  }

  async function handle(op, p) {
    if (api.down) return { error: { message: "TypeError: Failed to fetch" } };   // tests can make the server unreachable
    if (op === 'rpc' && p.fn === 'register_user') {   // mirrors supabase.sql: username → "<name>@hustl.invalid"
      const u = String(p.args.p_username || '').trim().toLowerCase(), pw = String(p.args.p_password || '');
      if (!/^[a-z0-9_]{3,20}$/.test(u)) return { error: { message: 'invalid username' } };
      if (pw.length < 8) return { error: { message: 'weak password' } };
      const email = u + '@hustl.invalid';
      if (db.users.has(email)) return { error: { message: 'username taken', code: '23505' } };
      const user = { id: randomUUID(), email, password: pw, username: u };
      db.users.set(email, user); newProfile(user.id);
      db.profiles.get(user.id).display_name = u;
      return { data: null };
    }
    if (op === 'password') {
      const u = db.users.get(p.email);
      if (!u || u.password !== p.password) return { error: { message: 'Invalid login credentials' } };
      return { user: { id: u.id, email: u.email, user_metadata: { username: u.username } } };
    }
    const uid = p.uid;
    if (!uid) return { error: { message: 'JWT expired' } };

    if (op === 'rpc') {
      if (p.fn === 'ensure_profile') { if (!db.profiles.has(uid)) newProfile(uid); return { data: { ...db.profiles.get(uid) } }; }
      if (p.fn === 'lookup_profile') {
        const h = String(p.args.p_handle || '').trim().toLowerCase();
        return { data: [...db.profiles.values()].filter(x => x.handle === h).map(x => ({ ...x })) };
      }
      if (p.fn === 'my_expired_media') {
        return { data: [...db.files.entries()].filter(([name, f]) => name.split('/')[0] === uid && Date.parse(f.created_at) < Date.now() - WEEK).map(([name]) => name) };
      }
      if (p.fn === 'purge_expired_messages') {
        const before = db.messages.length;
        db.messages = db.messages.filter(m => Date.parse(m.created_at) > Date.now() - WEEK);
        return { data: before - db.messages.length };
      }
      return { error: { message: 'unknown function' } };
    }

    // Storage bucket "chat-media" (same rules as the storage policies in supabase.sql)
    if (op === 'storage') {
      const [a, b] = String(p.path || '').split('/');
      if (p.action === 'upload') {
        if (a !== uid || !mutual(a, b)) return { error: { statusCode: '403', message: 'new row violates row-level security policy' } };
        if (db.files.has(p.path)) return { error: { statusCode: '409', message: 'The resource already exists' } };
        if (!/^image\/(jpeg|png|webp|gif)$/.test(p.contentType)) return { error: { statusCode: '415', message: 'mime type not supported' } };
        db.files.set(p.path, { data: p.data, contentType: p.contentType, created_at: tick() });
        return { data: { path: p.path } };
      }
      if (p.action === 'sign') {
        const f = db.files.get(p.path);
        const ok = f && (uid === a || uid === b) && mutual(a, b) && Date.parse(f.created_at) > Date.now() - WEEK;
        if (!ok) return { error: { statusCode: '400', message: 'Object not found' } };
        return { data: { signedUrl: `data:${f.contentType};base64,${f.data}` } };
      }
      if (p.action === 'remove') {
        const gone = p.paths.filter(x => x.split('/')[0] === uid && db.files.delete(x));
        return { data: gone.map(name => ({ name })) };
      }
    }

    const { table, filters = [] } = p;
    if (table === 'tasks') {
      if (api.oldSchema && (/priority/.test(p.columns || '') || (p.rows || []).some(r => 'priority' in r))) {
        return { error: { code: 'PGRST204', message: "Could not find the 'priority' column of 'tasks' in the schema cache" } };
      }
      if (p.op === 'select') {
        let rows = [...db.tasks.values()].filter(r => r.user_id === uid && match(r, filters));
        rows.sort((a, b) => a.server_updated_at.localeCompare(b.server_updated_at));
        if (p.limit) rows = rows.slice(0, p.limit);
        return { data: rows.map(r => ({ ...r, created_at: pg(r.created_at), done_at: pg(r.done_at), updated_at: pg(r.updated_at), server_updated_at: pg(r.server_updated_at) })) };
      }
      if (p.op === 'upsert') {
        for (const r of p.rows) {
          const ex = db.tasks.get(r.id);
          if (r.user_id !== uid || (ex && ex.user_id !== uid)) return rls;
          if (ex && new Date(r.updated_at) < new Date(ex.updated_at)) continue; // last write wins
          db.tasks.set(r.id, { ...r, server_updated_at: tick() });
          emit('tasks', 'UPDATE', db.tasks.get(r.id));
        }
        return { data: null };
      }
    }
    // Daily Track notes (supabase.sql "notes" table). api.oldSchema = a database from before that update.
    if (table === 'notes') {
      if (api.oldSchema) return { error: { code: 'PGRST205', message: "Could not find the table 'public.notes' in the schema cache" } };
      if (p.op === 'select') return { data: [...db.notes.values()].filter(r => r.user_id === uid).map(({ kind, body, updated_at }) => ({ kind, body, updated_at: pg(updated_at) })) };
      if (p.op === 'upsert') {
        for (const r of p.rows) {
          if (r.user_id !== uid) return rls;
          if (!['notes', 'reminders'].includes(r.kind) || String(r.body).length > 5000) return { error: { code: '23514', message: 'check constraint' } };
          const k = uid + ':' + r.kind, ex = db.notes.get(k);
          if (ex && new Date(r.updated_at) < new Date(ex.updated_at)) continue;   // last write wins
          db.notes.set(k, { user_id: uid, kind: r.kind, body: r.body, updated_at: r.updated_at });
          emit('notes', 'UPDATE', db.notes.get(k));
        }
        return { data: null };
      }
    }
    if (table === 'completion_log') {
      if (p.op === 'select') return { data: [...db.log.values()].filter(r => r.user_id === uid).map(({ day, count }) => ({ day, count })) };
      if (p.op === 'upsert') {
        for (const r of p.rows) {
          if (r.user_id !== uid) return rls;
          const k = r.user_id + r.day, ex = db.log.get(k);
          db.log.set(k, { ...r, count: Math.max(r.count, ex ? ex.count : 0) });
        }
        return { data: null };
      }
    }
    if (table === 'profiles') {
      if (p.op === 'select') {
        return { data: [...db.profiles.values()].filter(x => (x.id === uid || connected(uid, x.id)) && match(x, filters)).map(x => ({ ...x })) };
      }
      if (p.op === 'update') {
        const keys = Object.keys(p.values);
        if (keys.some(k => k !== 'display_name')) return { error: { code: '42501', message: 'permission denied' } };
        const name = String(p.values.display_name || '').trim();
        if (name.length < 1 || name.length > 40) return { error: { code: '23514', message: 'check constraint' } };
        [...db.profiles.values()].filter(x => x.id === uid && match(x, filters)).forEach(x => { x.display_name = name; });
        return { data: null };
      }
    }
    if (table === 'follows') {
      if (p.op === 'select') return { data: db.follows.filter(f => f.follower_id === uid || f.followee_id === uid).map(f => ({ ...f })) };
      if (p.op === 'insert') {
        const r = p.row;
        if (r.follower_id !== uid) return rls;
        if (r.follower_id === r.followee_id) return { error: { code: '23514', message: 'check constraint' } };
        if (db.follows.some(f => f.follower_id === r.follower_id && f.followee_id === r.followee_id)) return { error: { code: '23505', message: 'duplicate key' } };
        // same limits as supabase.sql: follow at most 50 people, have at most 50 followers
        if (db.follows.filter(f => f.follower_id === r.follower_id).length >= 50) return { error: { code: 'P0001', message: 'follow limit: you can follow up to 50 people' } };
        if (db.follows.filter(f => f.followee_id === r.followee_id).length >= 50) return { error: { code: 'P0001', message: 'follower limit: this person already has 50 followers' } };
        db.follows.push({ follower_id: r.follower_id, followee_id: r.followee_id, created_at: tick() });
        return { data: null };
      }
      if (p.op === 'delete') {
        db.follows = db.follows.filter(f => !(f.follower_id === uid && match(f, filters)));
        return { data: null };
      }
    }
    if (table === 'messages') {
      const fresh = m => Date.parse(m.created_at) > Date.now() - WEEK;   // notes last 7 days
      const visible = m => (m.sender_id === uid || m.recipient_id === uid) && mutual(m.sender_id, m.recipient_id) && fresh(m);
      const out = m => ({ ...m, created_at: pg(m.created_at), read_at: pg(m.read_at) });
      if (p.op === 'select') {
        let rows = db.messages.filter(m => visible(m) && match(m, filters));
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
        if (p.order && p.order.ascending === false) rows.reverse();
        if (p.limit) rows = rows.slice(0, p.limit);
        return { data: rows.map(out) };
      }
      if (p.op === 'insert') {
        const r = p.row;
        if (r.sender_id !== uid || !mutual(r.sender_id, r.recipient_id)) return rls;
        if (r.media_path && !r.media_path.startsWith(`${r.sender_id}/${r.recipient_id}/`)) return rls;
        if (db.messages.some(m => m.id === r.id)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint "messages_pkey"' } };
        const m = { id: r.id, sender_id: r.sender_id, recipient_id: r.recipient_id, body: r.body ?? null,
          media_path: r.media_path ?? null, media_type: r.media_type ?? null, created_at: tick(), read_at: null };
        db.messages.push(m);
        emit('messages', 'INSERT', out(m));
        return { data: null };
      }
      if (p.op === 'update') {
        if (Object.keys(p.values).some(k => k !== 'read_at')) return { error: { code: '42501', message: 'permission denied' } };
        for (const m of db.messages.filter(x => x.recipient_id === uid && mutual(x.sender_id, x.recipient_id) && match(x, filters))) {
          m.read_at = p.values.read_at;
          emit('messages', 'UPDATE', out(m));
        }
        return { data: null };
      }
    }
    return { error: { message: `unsupported query ${table}.${p.op}` } };
  }

  // Test helper: a profile with no account behind it (for filling up follow lists).
  const addPerson = () => { const id = randomUUID(); newProfile(id); return id; };
  const api = { db, handle, addPerson, down: false, oldSchema: false, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); } };
  return api;
}
