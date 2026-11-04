# Hustl — plan

Offline-first PWA, vanilla HTML/CSS/JS, no build step, hosted on GitHub Pages (relative paths).

## File structure

```
hustl/
├─ index.html               app shell: header, 3 screens (Tasks / Chats / Settings), nav, toasts
├─ styles.css               "Acoustic Vintage" theme, light + "Late night session" dark
├─ config.js                SUPABASE_URL + SUPABASE_ANON_KEY (public anon key only)
├─ app.js                   storage (IndexedDB + localStorage fallback), tasks, streak, UI, install, SW registration
├─ sync.js                  Supabase auth (username + password), outbox queue, push/pull, LWW merge, ON AIR light   (Phase 2)
├─ chat.js                  user IDs, follows, chats, realtime, media upload                            (Phases 3–5)
├─ sw.js                    versioned cache-first service worker + update toast
├─ manifest.webmanifest
├─ supabase.sql             tables, indexes, RLS, storage policies                                      (Phase 2+)
├─ vendor/supabase.js       Supabase JS client UMD bundle, stored locally
├─ fonts/                   Playfair Display, Special Elite, Caveat (.woff2, latin)
├─ icons/                   vinyl icons 192, 512, maskable-512, apple-touch-180, favicon
└─ tests/                   Playwright scripts (dev only, not cached by the SW)
```

## Local data model (IndexedDB database `hustl`, stores below)

| store      | key        | value |
|------------|------------|-------|
| `tasks`    | `id`       | `{ id: uuid, text, created_at, done_at: ISO \| null, updated_at, deleted: bool }` |
| `kv`       | name       | `log` → `{ "YYYY-MM-DD": count }`, `settings` → `{ theme, sound }`, `outbox`, `profile`, `lastSync` … |
| `messages` | `id`       | cached recent chat messages + offline outbox (Phase 4) |

Rules:
- New tasks are sorted to the top (`created_at` desc).
- Complete → `log[localDay(done_at)] += 1`; un-check → `log[localDay(old done_at)] -= 1` (floored at 0).
- Delete / "Clear completed" only sets `deleted = true` (soft delete for sync) and never touches the log.
- Current streak: start at today if `log[today] > 0`, else yesterday; count back while `log[day] > 0`.
- Best streak: longest consecutive run of days with `count > 0`.
- States: **active** (done today) · **at-risk** (streak > 0 but nothing yet today) · **lost** (streak 0).

## Server data model (Supabase, Phases 2–5)

| table            | columns |
|------------------|---------|
| `profiles`       | `id uuid pk → auth.users`, `handle text unique` (e.g. `vinyl-fox-4821`), `display_name`, `created_at` |
| `tasks`          | `id uuid pk`, `user_id`, `text`, `created_at`, `done_at`, `updated_at`, `deleted` |
| `completion_log` | `user_id`, `day date`, `count int`, `updated_at` — pk (`user_id`, `day`) |
| `follows`        | `follower_id`, `followee_id`, `created_at` — pk (`follower_id`, `followee_id`) |
| `messages`       | `id uuid pk`, `sender_id`, `recipient_id`, `body`, `media_path`, `media_type`, `created_at`, `read_at` |
| storage bucket   | `chat-media` (private), paths `{sender}/{recipient}/{uuid}.{ext}`, read through signed URLs |

- Sync: last write wins by `updated_at`; the log is merged by taking the larger count per day.
- `is_mutual(a, b)` SQL helper gates message insert/select and storage read/write in RLS.
