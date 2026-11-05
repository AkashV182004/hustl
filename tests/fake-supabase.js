// Test double for vendor/supabase.js: the parts of the client API that Hustl uses,
// backed by tests/fake-server.mjs in the Node test process (window.__fakeDb, exposed by Playwright).
(() => {
  const call = (op, payload) => (navigator.onLine
    ? window.__fakeDb(op, payload)
    : Promise.resolve({ error: { message: 'TypeError: Failed to fetch' } }));
  const wrap = r => ({ data: r.data === undefined ? null : r.data, error: r.error || null });

  window.supabase = {
    createClient(url, key, opts) {
      const storageKey = (opts && opts.auth && opts.auth.storageKey) || 'sb-auth';
      let session = JSON.parse(localStorage.getItem(storageKey) || 'null');
      const listeners = [];
      const emit = ev => listeners.forEach(fn => fn(ev, session));
      const store = s => { session = s; s ? localStorage.setItem(storageKey, JSON.stringify(s)) : localStorage.removeItem(storageKey); };
      const uid = () => session && session.user.id;

      const auth = {
        async getSession() { return { data: { session }, error: null }; },
        onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
        async signInWithPassword({ email, password }) {
          const r = await call('password', { email, password });
          if (r.error) return { data: {}, error: r.error };
          store({ access_token: 'tok-' + r.user.id, refresh_token: 'ref', user: r.user });
          emit('SIGNED_IN');
          return { data: { session }, error: null };
        },
        async signOut() { store(null); emit('SIGNED_OUT'); return { error: null }; },
      };

      function from(table) {
        const q = { table, op: 'select', filters: [], limit: null };
        const b = {
          select(cols) { if (q.op === 'select') { q.op = 'select'; q.columns = cols; } return b; },
          gt(col, val) { q.filters.push(['gt', col, val]); return b; },
          eq(col, val) { q.filters.push(['eq', col, val]); return b; },
          is(col, val) { q.filters.push(['is', col, val]); return b; },
          in(col, vals) { q.filters.push(['in', col, vals]); return b; },
          order(col, opts) { q.order = { col, ascending: !(opts && opts.ascending === false) }; return b; },
          limit(n) { q.limit = n; return b; },
          upsert(rows) { q.op = 'upsert'; q.rows = rows; return b; },
          insert(row) { q.op = 'insert'; q.row = row; return b; },
          update(values) { q.op = 'update'; q.values = values; return b; },
          delete() { q.op = 'delete'; return b; },
          then(resolve, reject) { return call('query', { ...q, uid: uid() }).then(wrap).then(resolve, reject); },
        };
        return b;
      }
      const rpc = (fn, args = {}) => call('rpc', { fn, args, uid: uid() }).then(wrap);
      // Realtime stand-in: the test server pushes row changes into window.__fakeRealtime (harness.mjs).
      // Like the real thing, nothing arrives while offline; the app catches up with a refresh.
      const subs = [];
      window.__fakeRealtime = ev => {
        if (!navigator.onLine || !session) return;
        subs.forEach(s => {
          if (s.table !== ev.table || (s.event !== '*' && s.event !== ev.eventType)) return;
          if (s.filter && String(ev.new[s.filter[0]]) !== s.filter[1]) return;
          s.cb({ eventType: ev.eventType, table: ev.table, new: ev.new });
        });
      };
      function channel() {
        const mine = [];
        const ch = {
          on(type, o, cb) {
            const f = o.filter && o.filter.match(/^(\w+)=eq\.(.+)$/);
            if (type === 'postgres_changes') mine.push({ table: o.table, event: o.event, filter: f ? [f[1], f[2]] : null, cb });
            return ch;
          },
          subscribe(cb) { subs.push(...mine); if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return ch; },
          _mine: mine,
        };
        return ch;
      }
      function removeChannel(ch) {
        ch._mine.forEach(s => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); });
        return Promise.resolve('ok');
      }
      // Storage: files travel to the test server as base64.
      const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
      const storage = {
        from(bucket) {
          return {
            async upload(path, blob, opts = {}) {
              const r = await call('storage', { action: 'upload', bucket, path, data: await toB64(blob), contentType: opts.contentType || blob.type, uid: uid() });
              return wrap(r);
            },
            async createSignedUrl(path, expiresIn) { return wrap(await call('storage', { action: 'sign', bucket, path, expiresIn, uid: uid() })); },
            async remove(paths) { return wrap(await call('storage', { action: 'remove', bucket, paths, uid: uid() })); },
          };
        },
      };
      return { auth, from, rpc, channel, removeChannel, storage };
    },
  };
})();
