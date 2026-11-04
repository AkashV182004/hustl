/* Hustl — app lock with the device's own fingerprint, face or PIN (WebAuthn platform authenticator).
   Everything stays on this device and works offline. The passkey never leaves the device's secure hardware;
   we only keep its credential ID so we can ask the device to verify you.

   Note: this is a privacy lock screen, not encryption. It stops someone who picks up your phone or laptop
   from opening your list, but the data itself is stored unencrypted in this browser's storage. */
(() => {
  'use strict';
  const KEY = 'hustl:lock';
  const root = document.documentElement;
  const $ = s => document.querySelector(s);
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = v => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} };
  const toast = (msg) => window.Hustl && window.Hustl.toast(msg);

  let cfg = load();            // { credId, after: seconds }
  let hiddenAt = null;
  let busy = false;

  const els = {
    app: $('.app'), screen: $('#lockScreen'), unlock: $('#unlockBtn'), error: $('#lockError'),
    toggle: $('#lockToggle'), note: $('#lockNote'), after: Array.from(document.querySelectorAll('[data-lock-after]')),
  };

  function setLocked(on) {
    root.classList.toggle('locked', on);
    els.app.inert = on;
    if (on) setTimeout(() => els.unlock.focus(), 50);
  }

  async function supported() {
    try {
      return !!(window.PublicKeyCredential && window.isSecureContext
        && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { return false; }
  }

  /** Ask the device to verify the user with the saved passkey. Resolves true, or throws. */
  async function verify() {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: unb64(cfg.credId), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    if (!cred) throw new Error('cancelled');
    // authenticatorData byte 32 holds the flags; bit 2 (UV) means the user was verified (biometric / PIN).
    const flags = new Uint8Array(cred.response.authenticatorData)[32];
    if (!(flags & 0x04)) throw new Error('not-verified');
    return true;
  }

  async function unlock(auto = false) {
    if (busy || !cfg) return;
    busy = true;
    els.error.textContent = '';
    try {
      await verify();
      hiddenAt = null;
      setLocked(false);
    } catch (e) {
      if (!auto) els.error.textContent = e && e.name === 'NotAllowedError'
        ? 'Unlock was cancelled or timed out. Tap Unlock to try again.'
        : "Couldn't verify it's you. Tap Unlock to try again.";
    } finally { busy = false; }
  }

  async function enable() {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { name: 'Hustl' },
        user: { id: rand(16), name: 'Hustl app lock', displayName: 'Hustl app lock' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: 60000,
      },
    });
    cfg = { credId: b64(cred.rawId), after: 60 };
    save(cfg);
  }

  function renderSettings() {
    els.toggle.checked = !!cfg;
    els.after.forEach(b => {
      b.disabled = !cfg;
      b.setAttribute('aria-checked', String(!!cfg && Number(b.dataset.lockAfter) === cfg.after));
    });
  }

  async function onToggle() {
    const want = els.toggle.checked;
    els.toggle.disabled = true;
    try {
      if (want) {
        await enable();
        toast('App lock is on 🔒');
      } else {
        await verify();           // must prove it's you before turning the lock off
        cfg = null; save(null);
        toast('App lock is off');
      }
    } catch (e) {
      toast(want ? "App lock wasn't turned on." : 'App lock is still on.');
    } finally {
      els.toggle.disabled = false;
      renderSettings();
    }
  }

  async function init() {
    els.unlock.addEventListener('click', () => unlock(false));
    els.toggle.addEventListener('change', onToggle);
    els.after.forEach(b => b.addEventListener('click', () => {
      if (!cfg) return;
      cfg.after = Number(b.dataset.lockAfter); save(cfg); renderSettings();
    }));

    document.addEventListener('visibilitychange', () => {
      if (!cfg) return;
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        if (cfg.after === 0) setLocked(true); // hide content before the app-switcher snapshot
      } else if (hiddenAt && Date.now() - hiddenAt >= cfg.after * 1000) {
        setLocked(true);
        if (!isIOS) unlock(true);
      }
    });

    const ok = await supported();
    if (!ok) {
      els.toggle.disabled = !cfg; // still allow turning it off if it was on
      els.note.textContent = window.isSecureContext
        ? "This device or browser doesn't offer fingerprint, face or PIN unlock."
        : 'App lock needs the secure (https) version of the app.';
    }
    renderSettings();

    if (cfg) {
      setLocked(true);
      if (!isIOS) unlock(true); // iOS needs a tap before it shows Face ID / Touch ID
    } else {
      setLocked(false);
    }
  }

  window.HustlLock = { lock: () => setLocked(true), unlock, get enabled() { return !!cfg; } };
  init();
})();
