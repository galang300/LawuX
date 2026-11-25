'use strict';
/*
 * Rujuk — SPA vanilla JS dengan hash router.
 * Aturan: SEMUA data dari API (tanpa data contoh), teks pengguna hanya lewat textContent/createTextNode,
 * tidak ada innerHTML, tidak ada inline script (CSP script-src 'self').
 */
(() => {
  // ================================================================ helper DOM aman
  const FORBIDDEN_PROPS = new Set(['html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc']);

  /** Hanya izinkan href http(s), relatif "/" atau hash "#". */
  function safeHref(v) {
    const s = String(v);
    if (s.startsWith('#') || (s.startsWith('/') && !s.startsWith('//'))) return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    } catch { /* */ }
    return '#';
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (FORBIDDEN_PROPS.has(k)) throw new Error(`h(): atribut "${k}" dilarang (gunakan teks).`);
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'value') el.value = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'href') el.setAttribute('href', safeHref(v));
        else if (k === 'style') throw new Error('h(): gunakan class, bukan style (CSP).');
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  // ================================================================ API
  class ApiError extends Error {
    constructor(status, code, message, fields) {
      super(message);
      this.status = status; this.code = code; this.fields = fields || null;
    }
  }

  async function api(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opt); } catch {
      throw new ApiError(0, 'NETWORK', 'Tidak dapat terhubung ke server. Periksa koneksi Anda lalu coba lagi.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* bukan JSON */ }
    if (!res.ok) {
      const e = (data && data.error) || {};
      throw new ApiError(res.status, e.code || `HTTP_${res.status}`, e.message || 'Terjadi kesalahan. Coba lagi.', e.fields);
    }
    return data;
  }

  // ================================================================ state & util
  const state = { me: null, onNewPost: null };
  const CATEGORIES = ['jurnal', 'buku', 'paper', 'dokumen', 'artikel'];
  const CAT_LABEL = { jurnal: 'Jurnal', buku: 'Buku', paper: 'Paper', dokumen: 'Dokumen', artikel: 'Artikel' };

  const cpLen = (s) => [...s].length;

  function parseDate(s) {
    // SQLite datetime('now') = UTC "YYYY-MM-DD HH:MM:SS"
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function relTime(s) {
    const d = parseDate(s);
    if (!d) return '';
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return 'baru saja';
    if (sec < 3600) return `${Math.floor(sec / 60)} mnt`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} jam`;
    if (sec < 7 * 86400) return `${Math.floor(sec / 86400)} hr`;
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const fullTime = (s) => { const d = parseDate(s); return d ? d.toLocaleString('id-ID') : ''; };

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function go(hash) {
    if (location.hash === hash) render(); else location.hash = hash;
  }

  function requireLogin() {
    if (state.me) return true;
    toast('Silakan login terlebih dahulu.');
    go('#/login');
    return false;
  }

  // ================================================================ form helper
  function field(name, labelText, input, hint) {
    const id = `f-${name}-${Math.random().toString(36).slice(2, 8)}`;
    input.id = id;
    input.name = name;
    const err = h('div', { class: 'field-error', id: `${id}-err`, 'aria-live': 'polite' });
    input.setAttribute('aria-describedby', `${id}-err`);
    return h('div', { class: 'field', dataset: { field: name } },
      h('label', { for: id }, labelText), input, hint ? h('div', { class: 'hint' }, hint) : null, err);
  }

  function clearErrors(root) {
    root.querySelectorAll('.field-error').forEach((e) => { e.textContent = ''; });
    root.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
    root.querySelectorAll('.form-alert').forEach((e) => { e.hidden = true; e.replaceChildren(); });
  }

  /** Tampilkan error API: per field di bawah input + kotak error umum. */
  function showError(root, err, { alertEl } = {}) {
    const alert = alertEl || root.querySelector('.form-alert');
    const fields = err.fields || {};
    let unplaced = [];
    for (const [name, msg] of Object.entries(fields)) {
      if (name === 'verdict' || name === 'score') continue;
      const wrap = root.querySelector(`[data-field="${CSS.escape(name)}"]`);
      if (wrap) {
        wrap.querySelector('.field-error').textContent = String(msg);
        const input = wrap.querySelector('input, textarea, select');
        if (input) input.setAttribute('aria-invalid', 'true');
      } else {
        unplaced.push(String(msg));
      }
    }
    if (alert) {
      alert.className = 'alert error form-alert';
      alert.replaceChildren(h('strong', null, err.message), ...unplaced.map((m) => h('div', null, m)));
      alert.hidden = false;
    } else if (unplaced.length || !Object.keys(fields).length) {
      toast(unplaced[0] || err.message);
    }
  }

  const formAlert = () => h('div', { class: 'alert error form-alert', role: 'alert', hidden: true });

  function categorySelect() {
    return h('select', null,
      h('option', { value: '' }, 'Pilih kategori'),
      CATEGORIES.map((c) => h('option', { value: c }, CAT_LABEL[c])));
  }

  async function withBusy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }

  // ================================================================ sub-form sumber (FORM 3b & 3c)
  function pdfSubform(onCreated) {
    const file = h('input', { type: 'file', accept: '.pdf,application/pdf' });
    const cat = categorySelect();
    const title = h('input', { type: 'text', maxlength: 200, placeholder: 'Opsional: otomatis dari PDF' });
    const btn = h('button', { type: 'submit', class: 'btn small' }, 'Upload PDF');
    const alert = formAlert();
    const form = h('form', { class: 'subform', novalidate: true },
      field('file', 'File PDF (maks 10 MB)', file),
      field('category', 'Kategori', cat),
      field('title', 'Judul', title),
      alert, h('div', { class: 'row' }, btn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      const fd = new FormData();
      fd.append('category', cat.value);
      if (title.value.trim()) fd.append('title', title.value);
      if (file.files[0]) fd.append('file', file.files[0]);
      await withBusy(btn, 'Membaca PDF…', async () => {
        try {
          const r = await api('POST', '/api/sources/pdf', fd);
          toast(r.duplicate ? 'Sumber ini sudah ada di pustaka.' : 'Sumber ditambahkan ke pustaka.');
          form.reset();
          onCreated(r.source);
        } catch (err) { showError(form, err); }
      });
    });
    return form;
  }

  function linkSubform(onCreated) {
    const url = h('input', { type: 'url', maxlength: 2048, placeholder: 'https://…', inputmode: 'url' });
    const cat = categorySelect();
    cat.value = 'artikel';
    const title = h('input', { type: 'text', maxlength: 200, placeholder: 'Opsional: otomatis dari halaman' });
    const btn = h('button', { type: 'submit', class: 'btn small' }, 'Tambah link');
    const alert = formAlert();
    const form = h('form', { class: 'subform', novalidate: true },
      field('url', 'Link sumber', url, 'Artikel, jurnal online, berita, atau dokumen. Bukan media sosial.'),
      field('category', 'Kategori', cat),
      field('title', 'Judul', title),
      alert, h('div', { class: 'row' }, btn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      const body = { url: url.value, category: cat.value };
      if (title.value.trim()) body.title = title.value;
      await withBusy(btn, 'Mengambil halaman…', async () => {
        try {
          const r = await api('POST', '/api/sources/link', body);
          toast(r.duplicate ? 'Sumber ini sudah ada di pustaka.' : 'Sumber ditambahkan ke pustaka.');
          form.reset(); cat.value = 'artikel';
          onCreated(r.source);
        } catch (err) { showError(form, err); }
      });
    });
    return form;
  }

  function tabs(defs) {
    const bar = h('div', { class: 'tabs', role: 'tablist' });
    const panels = [];
    const buttons = defs.map((d, i) => {
      const pid = `tp-${Math.random().toString(36).slice(2, 8)}`;
      const panel = h('div', { role: 'tabpanel', id: pid, hidden: i !== 0 }, d.content);
      panels.push(panel);
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(i === 0), 'aria-controls': pid }, d.label);
      b.addEventListener('click', () => select(i));
      return b;
    });
    function select(i) {
      buttons.forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      panels.forEach((p, j) => { p.hidden = i !== j; });
      if (defs[i].onShow) defs[i].onShow();
    }
    append(bar, buttons);
    return { el: h('div', null, bar, panels), buttons, select };
  }

  const sourceLabel = (s) => `${s.kind === 'pdf' ? 'PDF' : 'Link'} · ${s.title}`;

  // ================================================================ composer (FORM 3)
  function composer({ parent = null, onPosted } = {}) {
    const selected = [];
    let library = null;

    const textarea = h('textarea', {
      'aria-label': parent ? 'Isi retweet' : 'Isi tweet',
      placeholder: parent ? 'Tulis tanggapan Anda, didukung sumber Anda sendiri…' : 'Tulis klaim berdasarkan sumber yang Anda lampirkan…',
      rows: 3,
    });
    const counter = h('span', { class: 'counter', 'aria-live': 'polite' }, '0/280');
    const chips = h('div', { class: 'chips', 'aria-label': 'Sumber terlampir' });
    const status = h('div', { role: 'status', 'aria-live': 'polite', hidden: true });
    const libList = h('ul', { class: 'lib-list' });
    const libTabLabel = h('span', null, 'Pustaka saya');
    const contentErr = h('div', { class: 'field-error' });
    const sourceErr = h('div', { class: 'field-error' });

    const attachBtn = h('button', { type: 'button', class: 'btn secondary small', 'aria-expanded': 'false' }, 'Lampirkan sumber');
    const submitBtn = h('button', { type: 'button', class: 'btn' }, parent ? 'Retweet' : 'Tweet');

    function addSource(s) {
      if (selected.some((x) => x.id === s.id)) return;
      if (selected.length >= 3) { toast('Maksimal 3 sumber per tweet.'); return; }
      selected.push(s);
      renderChips();
      if (library && !library.some((x) => x.id === s.id)) library.unshift(s);
      renderLibrary();
    }
    function removeSource(id) {
      const i = selected.findIndex((x) => x.id === id);
      if (i >= 0) selected.splice(i, 1);
      renderChips(); renderLibrary();
    }
    function renderChips() {
      chips.replaceChildren(...selected.map((s) => h('span', { class: 'chip' },
        h('span', { title: s.title }, sourceLabel(s)),
        h('button', { type: 'button', 'aria-label': `Lepas sumber ${s.title}`, onclick: () => removeSource(s.id) }, '×'))));
      sourceErr.textContent = '';
    }
    function renderLibrary() {
      if (!library) return;
      libTabLabel.textContent = `Pustaka saya (${library.length})`;
      if (!library.length) {
        libList.replaceChildren(h('li', { class: 'muted small' }, 'Pustaka masih kosong. Upload PDF atau tambah link dulu.'));
        return;
      }
      libList.replaceChildren(...library.map((s) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = selected.some((x) => x.id === s.id);
        cb.addEventListener('change', () => { if (cb.checked) addSource(s); else removeSource(s.id); cb.checked = selected.some((x) => x.id === s.id); });
        return h('li', null, h('label', null, cb,
          h('span', null, h('span', null, s.title), ' ',
            h('span', { class: 'badge cat' }, `${s.kind === 'pdf' ? 'PDF' : domainOf(s.url)} · ${s.category}`))));
      }));
    }
    async function loadLibrary() {
      if (library) return;
      try {
        library = (await api('GET', '/api/sources')).sources;
        renderLibrary();
      } catch (err) { libList.replaceChildren(h('li', { class: 'field-error' }, err.message)); }
    }

    const t = tabs([
      { label: 'Upload PDF', content: pdfSubform(addSource) },
      { label: 'Tambah link', content: linkSubform(addSource) },
      { label: libTabLabel, content: libList, onShow: loadLibrary },
    ]);
    const panel = h('div', { class: 'panel', hidden: true }, t.el);
    attachBtn.setAttribute('aria-controls', panel.id = `pn-${Math.random().toString(36).slice(2, 8)}`);
    attachBtn.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      attachBtn.setAttribute('aria-expanded', String(open));
      if (open) loadLibrary();
    });

    textarea.addEventListener('input', () => {
      const n = cpLen(textarea.value.trim());
      counter.textContent = `${n}/280`;
      counter.classList.toggle('over', n > 280);
    });

    function setStatus(kind, ...nodes) {
      status.className = `alert ${kind}`;
      status.replaceChildren(...nodes);
      status.hidden = false;
    }

    submitBtn.addEventListener('click', async () => {
      contentErr.textContent = ''; sourceErr.textContent = '';
      textarea.removeAttribute('aria-invalid');
      const body = { content: textarea.value, source_ids: selected.map((s) => s.id) };
      if (parent) body.parent_id = parent.id;
      setStatus('info', h('span', { class: 'spinner-text' }, 'Memeriksa kesesuaian dengan sumber'));
      await withBusy(submitBtn, 'Memeriksa…', async () => {
        try {
          const r = await api('POST', '/api/posts', body);
          status.hidden = true;
          textarea.value = ''; textarea.dispatchEvent(new Event('input'));
          selected.length = 0; renderChips(); renderLibrary();
          panel.hidden = true; attachBtn.setAttribute('aria-expanded', 'false');
          toast(parent ? 'Retweet terbit.' : 'Tweet terbit.');
          if (onPosted) onPosted(r.post);
        } catch (err) {
          if (err.code === 'NOT_SUPPORTED_BY_SOURCE') {
            const f = err.fields || {};
            const score = typeof f.score === 'number' ? `${Math.round(f.score * 100)}%` : '–';
            setStatus('error',
              h('strong', null, 'Tidak sesuai dengan sumber'),
              h('div', null, err.message),
              h('div', null, 'Alasan pemeriksa: ', String(f.content || '')),
              h('div', { class: 'small' }, `Verdict: ${f.verdict || '–'} · skor ${score}`));
            return;
          }
          status.hidden = true;
          const fields = err.fields || {};
          if (fields.content) { contentErr.textContent = fields.content; textarea.setAttribute('aria-invalid', 'true'); }
          if (fields.source_ids) sourceErr.textContent = fields.source_ids;
          if (fields.parent_id) sourceErr.textContent = fields.parent_id;
          if (!fields.content && !fields.source_ids && !fields.parent_id) setStatus('error', h('strong', null, err.message));
          if (err.status === 401) { state.me = null; renderNav(); }
        }
      });
    });

    const quote = parent ? h('div', { class: 'quote' },
      h('div', { class: 'tweet-head' }, h('span', { class: 'name' }, parent.author.display_name),
        h('span', { class: 'meta' }, `@${parent.author.username}`)),
      h('p', { class: 'tweet-body' }, parent.content)) : null;

    return h('div', { class: 'card composer stack' },
      quote, textarea, contentErr, chips, sourceErr,
      h('div', { class: 'row' }, attachBtn, h('span', { class: 'spacer' }), counter, submitBtn),
      panel, status);
  }

  // ================================================================ retweet dialog
  /** Perbarui angka retweet di semua kartu tweet asli yang sedang tampil (angka awal tetap dari server). */
  function bumpRetweetCount(postId, delta) {
    document.querySelectorAll(`button[data-rt-for="${Number(postId)}"]`).forEach((b) => {
      const n = Math.max(0, Number(b.dataset.count) + delta);
      b.dataset.count = String(n);
      b.textContent = `🔁 ${n}`;
      b.setAttribute('aria-label', `Retweet (${n})`);
    });
  }

  function openRetweet(post) {
    if (!requireLogin()) return;
    const dlg = $('#retweet-dialog');
    const body = $('#retweet-body');
    body.replaceChildren(composer({
      parent: post,
      onPosted: (p) => { dlg.close(); bumpRetweetCount(post.id, 1); if (state.onNewPost) state.onNewPost(p); },
    }));
    dlg.showModal();
  }

  // ================================================================ kartu tweet
  function refsBlock(post) {
    const items = post.sources.map((s, i) => {
      const titleEl = s.kind === 'pdf'
        ? h('a', { href: s.file_url, target: '_blank', rel: 'noopener noreferrer', class: 'ref-title' }, s.title)
        : h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'ref-title' }, s.title);
      const meta = s.kind === 'pdf' ? `PDF · ${s.category}` : `${domainOf(s.url)} · ${s.category}`;
      return h('li', null, h('span', { class: 'num' }, String(i + 1)),
        h('span', null, titleEl, ' — ', h('span', { class: 'ref-meta' }, meta)));
    });
    const pct = Math.round(Number(post.verification.score) * 100);
    return h('div', { class: 'refs' },
      h('ol', { 'aria-label': 'Rujukan' }, items),
      h('div', { class: 'stamp', title: `Verdict: ${post.verification.verdict}` }, `${pct}% terverifikasi`));
  }

  function authorHead(post, extra) {
    return h('div', { class: 'tweet-head' },
      h('a', { class: 'name', href: `#/u/${encodeURIComponent(post.author.username)}` }, post.author.display_name),
      h('span', { class: 'meta' }, `@${post.author.username}`),
      h('span', { class: 'meta' }, '·'),
      h('a', { class: 'meta', href: `#/post/${post.id}`, title: fullTime(post.created_at) }, relTime(post.created_at)),
      extra);
  }

  function commentItem(c, onDeleted) {
    const del = state.me && state.me.id === c.author.id
      ? confirmButton('Hapus', async () => {
        await api('DELETE', `/api/comments/${c.id}`);
        toast('Komentar dihapus.');
        onDeleted(c);
      }) : null;
    return h('div', { class: 'comment' },
      h('div', { class: 'tweet-head' },
        h('a', { class: 'name', href: `#/u/${encodeURIComponent(c.author.username)}` }, c.author.display_name),
        h('span', { class: 'meta' }, `@${c.author.username} · ${relTime(c.created_at)}`), h('span', { class: 'spacer' }), del),
      h('div', { class: 'comment-text' }, c.content));
  }

  /** Tombol hapus dua langkah: klik pertama "Klik lagi untuk hapus", klik kedua menjalankan aksi. */
  function confirmButton(label, action) {
    const b = h('button', { type: 'button', class: 'act' }, label);
    let armed = false; let timer;
    b.addEventListener('click', async () => {
      if (!armed) {
        armed = true; b.textContent = 'Klik lagi untuk hapus'; b.classList.add('confirm');
        timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('confirm'); }, 4000);
        return;
      }
      clearTimeout(timer);
      b.disabled = true;
      try { await action(); } catch (err) { toast(err.message); b.disabled = false; armed = false; b.textContent = label; b.classList.remove('confirm'); }
    });
    return b;
  }

  function tweetCard(post, { onDeleted, openComments = false, preloadedComments = null } = {}) {
    const isRetweet = post.kind === 'retweet';
    let quote = null;
    if (isRetweet) {
      quote = post.parent
        ? h('div', { class: 'quote' }, authorHead(post.parent), h('p', { class: 'tweet-body' }, post.parent.content))
        : h('div', { class: 'quote gone' }, 'Tweet asli sudah dihapus.');
    }

    // like
    let liked = post.liked_by_me; let likeCount = post.like_count;
    const likeBtn = h('button', { type: 'button', class: 'act', 'aria-pressed': String(liked) });
    const renderLike = () => {
      likeBtn.setAttribute('aria-pressed', String(liked));
      likeBtn.setAttribute('aria-label', `${liked ? 'Batal suka' : 'Suka'} (${likeCount})`);
      likeBtn.textContent = `♥ ${likeCount}`;
    };
    renderLike();
    likeBtn.addEventListener('click', async () => {
      if (!requireLogin()) return;
      likeBtn.disabled = true;
      try {
        const r = await api(liked ? 'DELETE' : 'POST', `/api/posts/${post.id}/like`);
        liked = r.liked; likeCount = r.like_count; renderLike();
      } catch (err) { toast(err.message); } finally { likeBtn.disabled = false; }
    });

    // komentar
    let commentCount = post.comment_count;
    const commentBtn = h('button', { type: 'button', class: 'act', 'aria-expanded': 'false' });
    const renderCommentBtn = () => {
      commentBtn.textContent = `💬 ${commentCount}`;
      commentBtn.setAttribute('aria-label', `Komentar (${commentCount})`);
    };
    renderCommentBtn();
    const commentList = h('div', { class: 'stack' });
    const commentsBox = h('div', { class: 'comments', hidden: true }, commentList);
    commentBtn.setAttribute('aria-controls', commentsBox.id = `cm-${post.id}-${Math.random().toString(36).slice(2, 6)}`);
    let loaded = false;

    const onCommentDeleted = (c) => {
      commentCount = Math.max(0, commentCount - 1); renderCommentBtn();
      const el = commentList.querySelector(`[data-cid="${c.id}"]`); if (el) el.remove();
      if (!commentList.children.length) commentList.replaceChildren(emptyComments());
    };
    const emptyComments = () => h('div', { class: 'muted small', dataset: { empty: '1' } }, 'Belum ada komentar.');
    const renderComments = (list) => {
      commentList.replaceChildren(...(list.length ? list.map((c) => {
        const el = commentItem(c, onCommentDeleted); el.dataset.cid = String(c.id); return el;
      }) : [emptyComments()]));
    };

    if (state.me) {
      const ta = h('textarea', { 'aria-label': 'Tulis komentar', placeholder: 'Tulis komentar (tanpa sumber)…', maxlength: 600, rows: 1 });
      const err = h('div', { class: 'field-error' });
      const send = h('button', { type: 'button', class: 'btn small' }, 'Kirim');
      send.addEventListener('click', async () => {
        err.textContent = '';
        await withBusy(send, 'Mengirim…', async () => {
          try {
            const r = await api('POST', `/api/posts/${post.id}/comments`, { content: ta.value });
            ta.value = '';
            commentCount = r.comment_count; renderCommentBtn();
            const placeholder = commentList.querySelector('[data-empty]'); if (placeholder) placeholder.remove();
            const el = commentItem(r.comment, onCommentDeleted); el.dataset.cid = String(r.comment.id);
            commentList.appendChild(el);
          } catch (e) { err.textContent = (e.fields && e.fields.content) || e.message; }
        });
      });
      commentsBox.appendChild(h('div', null, h('div', { class: 'comment-form' }, ta, send), err));
    } else {
      commentsBox.appendChild(h('div', { class: 'small muted' }, h('a', { href: '#/login' }, 'Login'), ' untuk berkomentar.'));
    }

    async function toggleComments(forceOpen) {
      const open = forceOpen || commentsBox.hidden;
      commentsBox.hidden = !open;
      commentBtn.setAttribute('aria-expanded', String(open));
      if (open && !loaded) {
        loaded = true;
        if (preloadedComments) { renderComments(preloadedComments); return; }
        commentList.replaceChildren(h('div', { class: 'muted small' }, 'Memuat komentar…'));
        try { renderComments((await api('GET', `/api/posts/${post.id}/comments`)).comments); } catch (e) {
          loaded = false; commentList.replaceChildren(h('div', { class: 'field-error' }, e.message));
        }
      }
    }
    commentBtn.addEventListener('click', () => toggleComments());

    const rtBtn = h('button', { type: 'button', class: 'act', 'aria-label': `Retweet (${post.retweet_count})`, onclick: () => openRetweet(post),
      dataset: { rtFor: String(post.id), count: String(post.retweet_count) } },
      `🔁 ${post.retweet_count}`);

    const card = h('article', { class: 'card tweet', 'aria-label': `Tweet oleh ${post.author.display_name}` });
    const del = state.me && state.me.id === post.author.id
      ? confirmButton('🗑 Hapus', async () => {
        await api('DELETE', `/api/posts/${post.id}`);
        toast('Tweet dihapus.');
        if (post.kind === 'retweet' && post.parent_id) bumpRetweetCount(post.parent_id, -1);
        if (onDeleted) onDeleted(post); else card.remove();
      }) : null;

    append(card, [
      authorHead(post, isRetweet ? h('span', { class: 'meta' }, '· retweet dengan rujukan') : null),
      h('p', { class: 'tweet-body' }, post.content),
      quote,
      refsBlock(post),
      h('details', { class: 'checker' }, h('summary', null, 'Catatan pemeriksa'),
        h('p', null, post.verification.reason),
        h('p', { class: 'small muted' }, `Verdict: ${post.verification.verdict} · skor ${Math.round(post.verification.score * 100)}%`)),
      h('div', { class: 'actions' }, commentBtn, rtBtn, likeBtn, h('span', { class: 'spacer' }), del),
      commentsBox,
    ]);
    if (openComments) toggleComments(true);
    return card;
  }

  // ================================================================ feed
  function feedList({ user = null, emptyText }) {
    const list = h('div', { class: 'feed' });
    const more = h('button', { type: 'button', class: 'btn secondary', hidden: true }, 'Muat lebih banyak');
    const status = h('div', { class: 'muted small', 'aria-live': 'polite' });
    let cursor = null; let count = 0;

    const empty = () => h('div', { class: 'card empty' }, emptyText);
    const onDeleted = (p) => {
      const el = list.querySelector(`[data-pid="${p.id}"]`); if (el) el.remove();
      count -= 1; if (count <= 0 && !cursor) list.replaceChildren(empty());
    };
    const cardFor = (p) => { const c = tweetCard(p, { onDeleted }); c.dataset.pid = String(p.id); return c; };

    async function load() {
      status.textContent = 'Memuat…';
      more.disabled = true;
      try {
        const params = new URLSearchParams();
        if (cursor) params.set('cursor', String(cursor));
        if (user) params.set('user', user);
        const r = await api('GET', `/api/posts${params.toString() ? `?${params}` : ''}`);
        if (!count && !r.posts.length) list.replaceChildren(empty());
        r.posts.forEach((p) => list.appendChild(cardFor(p)));
        count += r.posts.length;
        cursor = r.next_cursor;
        more.hidden = !cursor;
        status.textContent = '';
      } catch (err) {
        status.textContent = err.message;
      } finally { more.disabled = false; }
    }
    more.addEventListener('click', load);
    load();

    return {
      el: h('div', { class: 'stack' }, list, status, h('div', { class: 'row' }, more)),
      prepend(p) {
        const placeholder = list.querySelector('.empty'); if (placeholder) placeholder.remove();
        list.prepend(cardFor(p)); count += 1;
      },
    };
  }

  // ================================================================ halaman
  function viewHome() {
    setTitle('Beranda');
    const feed = feedList({ emptyText: 'Belum ada tweet. Tulis yang pertama, lengkap dengan sumbernya.' });
    state.onNewPost = (p) => feed.prepend(p);
    const parts = [];
    if (state.me) parts.push(composer({ onPosted: (p) => feed.prepend(p) }));
    else {
      parts.push(h('div', { class: 'card row' },
        h('span', null, 'Ingin ikut menulis? Setiap tweet wajib bersumber.'), h('span', { class: 'spacer' }),
        h('a', { class: 'btn small', href: '#/login' }, 'Masuk'), h('a', { class: 'btn secondary small', href: '#/register' }, 'Daftar')));
    }
    parts.push(feed.el);
    return h('div', { class: 'stack' }, parts);
  }

  function viewLogin() {
    setTitle('Masuk');
    if (state.me) { go('#/'); return h('div'); }
    const identifier = h('input', { type: 'text', autocomplete: 'username', maxlength: 254 });
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    const btn = h('button', { type: 'submit', class: 'btn' }, 'Masuk');
    const form = h('form', { novalidate: true },
      field('identifier', 'Username atau email', identifier),
      field('password', 'Password', password),
      formAlert(),
      h('div', { class: 'row' }, btn, h('span', { class: 'spacer' }), h('a', { href: '#/register', class: 'small' }, 'Belum punya akun? Daftar')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clearErrors(form);
      await withBusy(btn, 'Memeriksa…', async () => {
        try {
          const r = await api('POST', '/api/auth/login', { identifier: identifier.value, password: password.value });
          state.me = r.user; renderNav(); toast(`Selamat datang, ${r.user.display_name}.`); go('#/');
        } catch (err) { password.value = ''; showError(form, err); }
      });
    });
    return h('div', { class: 'card auth-card' }, form);
  }

  function viewRegister() {
    setTitle('Daftar');
    if (state.me) { go('#/'); return h('div'); }
    const inputs = {
      username: h('input', { type: 'text', autocomplete: 'username', maxlength: 20 }),
      display_name: h('input', { type: 'text', autocomplete: 'name', maxlength: 50 }),
      email: h('input', { type: 'email', autocomplete: 'email', maxlength: 254 }),
      password: h('input', { type: 'password', autocomplete: 'new-password' }),
      confirm_password: h('input', { type: 'password', autocomplete: 'new-password' }),
    };
    const btn = h('button', { type: 'submit', class: 'btn' }, 'Daftar');
    const form = h('form', { novalidate: true },
      field('username', 'Username', inputs.username, '3–20 karakter: huruf, angka, garis bawah.'),
      field('display_name', 'Nama tampilan', inputs.display_name),
      field('email', 'Email', inputs.email),
      field('password', 'Password', inputs.password, 'Minimal 8 karakter, ada huruf dan angka, tanpa spasi.'),
      field('confirm_password', 'Konfirmasi password', inputs.confirm_password),
      formAlert(),
      h('div', { class: 'row' }, btn, h('span', { class: 'spacer' }), h('a', { href: '#/login', class: 'small' }, 'Sudah punya akun? Masuk')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clearErrors(form);
      const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      await withBusy(btn, 'Mendaftarkan…', async () => {
        try {
          const r = await api('POST', '/api/auth/register', body);
          state.me = r.user; renderNav(); toast('Akun dibuat. Selamat datang di Rujuk.'); go('#/');
        } catch (err) { showError(form, err); }
      });
    });
    return h('div', { class: 'card auth-card' }, form);
  }

  function viewProfile(username) {
    setTitle(`@${username}`);
    const root = h('div', { class: 'stack' }, h('div', { class: 'card muted' }, 'Memuat profil…'));
    (async () => {
      let user;
      try { user = (await api('GET', `/api/users/${encodeURIComponent(username)}`)).user; } catch (err) {
        root.replaceChildren(h('div', { class: 'card empty' }, err.status === 404 ? 'Pengguna tidak ditemukan.' : err.message));
        return;
      }
      setTitle(user.display_name);
      const isMe = state.me && state.me.id === user.id;
      const nameEl = h('h2', null, user.display_name);
      const bioEl = h('p', { class: 'bio' }, user.bio || (isMe ? 'Belum ada bio. Ceritakan sedikit tentang Anda.' : ''));
      const head = h('section', { class: 'card stack profile-head' },
        h('div', null, nameEl, h('div', { class: 'muted' }, `@${user.username} · bergabung ${fullTime(user.created_at).split(',')[0] || ''}`)),
        bioEl,
        h('div', { class: 'stats' },
          h('span', null, h('b', null, String(user.tweet_count)), ' tweet'),
          h('span', null, h('b', null, String(user.retweet_count)), ' retweet'),
          h('span', null, h('b', null, String(user.source_count)), ' sumber')));

      const parts = [head];
      if (isMe) {
        const dn = h('input', { type: 'text', maxlength: 50, value: user.display_name });
        const bio = h('textarea', { maxlength: 160, rows: 3 });
        bio.value = user.bio || '';
        const btn = h('button', { type: 'submit', class: 'btn small' }, 'Simpan profil');
        const form = h('form', { class: 'card stack', novalidate: true },
          h('h2', { class: 'small' }, 'Ubah profil'),
          field('display_name', 'Nama tampilan', dn),
          field('bio', 'Bio (maks 160 karakter)', bio),
          formAlert(), h('div', { class: 'row' }, btn));
        form.addEventListener('submit', async (e) => {
          e.preventDefault(); clearErrors(form);
          await withBusy(btn, 'Menyimpan…', async () => {
            try {
              const r = await api('PATCH', '/api/me', { display_name: dn.value, bio: bio.value });
              state.me = r.user; renderNav();
              nameEl.textContent = r.user.display_name; bioEl.textContent = r.user.bio; setTitle(r.user.display_name);
              toast('Profil disimpan.');
            } catch (err) { showError(form, err); }
          });
        });
        parts.push(form);
      }
      parts.push(feedList({ user: user.username, emptyText: isMe ? 'Anda belum menulis tweet. Mulai dari Beranda.' : 'Pengguna ini belum menulis tweet.' }).el);
      root.replaceChildren(...parts);
    })();
    return root;
  }

  function viewPost(id) {
    setTitle('Tweet');
    const root = h('div', { class: 'stack' }, h('div', { class: 'card muted' }, 'Memuat tweet…'));
    state.onNewPost = () => toast('Retweet terbit. Lihat di Beranda.');
    (async () => {
      try {
        const r = await api('GET', `/api/posts/${encodeURIComponent(id)}`);
        root.replaceChildren(tweetCard(r.post, {
          openComments: true,
          preloadedComments: r.comments,
          onDeleted: () => go('#/'),
        }));
      } catch (err) {
        root.replaceChildren(h('div', { class: 'card empty' }, err.status === 404 ? 'Tweet tidak ditemukan atau sudah dihapus.' : err.message));
      }
    })();
    return root;
  }

  function viewSources() {
    setTitle('Pustaka sumber');
    if (!requireLogin()) return h('div');
    const tbody = h('tbody');
    const table = h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Judul'), h('th', null, 'Kategori'), h('th', null, 'Teks'), h('th', null, 'Ditambahkan'), h('th', null, h('span', { class: 'sr' }, 'Aksi')))),
      tbody));
    const emptyRow = () => h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'Pustaka masih kosong. Upload PDF atau tambah link sebagai sumber tweet Anda.'));

    const row = (s) => {
      const titleEl = s.kind === 'pdf'
        ? h('a', { href: `/api/sources/${s.id}/file`, target: '_blank', rel: 'noopener noreferrer' }, s.title)
        : h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, s.title);
      const tr = h('tr', { dataset: { sid: String(s.id) } },
        h('td', null, h('div', { class: 'cell-text' }, titleEl),
          h('div', { class: 'small muted' }, s.kind === 'pdf' ? `PDF · ${s.original_name || ''}` : domainOf(s.url))),
        h('td', null, h('span', { class: 'badge cat' }, s.category)),
        h('td', { class: 'small' }, `${s.text_length.toLocaleString('id-ID')} karakter · ${s.chunk_count} potongan`),
        h('td', { class: 'small', title: fullTime(s.created_at) }, relTime(s.created_at)),
        h('td', null, confirmButton('Hapus', async () => {
          await api('DELETE', `/api/sources/${s.id}`);
          tr.remove(); toast('Sumber dihapus.');
          if (!tbody.children.length) tbody.appendChild(emptyRow());
        })));
      return tr;
    };
    const onCreated = (s) => {
      if (tbody.querySelector(`[data-sid="${s.id}"]`)) return;
      const placeholder = tbody.querySelector('td[colspan]'); if (placeholder) placeholder.parentElement.remove();
      tbody.prepend(row(s));
    };
    (async () => {
      tbody.replaceChildren(h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'Memuat…')));
      try {
        const { sources } = await api('GET', '/api/sources');
        tbody.replaceChildren(...(sources.length ? sources.map(row) : [emptyRow()]));
      } catch (err) { tbody.replaceChildren(h('tr', null, h('td', { colspan: 5, class: 'field-error' }, err.message))); }
    })();

    const t = tabs([
      { label: 'Upload PDF', content: pdfSubform(onCreated) },
      { label: 'Tambah link', content: linkSubform(onCreated) },
    ]);
    return h('div', { class: 'stack' },
      h('section', { class: 'card' }, t.el),
      h('section', { class: 'card' }, h('h2', { class: 'small' }, 'Sumber saya'), table));
  }

  function viewVerifications() {
    setTitle('Riwayat verifikasi');
    if (!requireLogin()) return h('div');
    const tbody = h('tbody', null, h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'Memuat…')));
    (async () => {
      try {
        const { logs } = await api('GET', '/api/me/verifications');
        if (!logs.length) {
          tbody.replaceChildren(h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'Belum ada percobaan. Tulis tweet bersumber di Beranda.')));
          return;
        }
        tbody.replaceChildren(...logs.map((l) => h('tr', null,
          h('td', null, h('span', { class: `badge ${l.accepted ? 'ok' : 'no'}` }, l.accepted ? 'Terbit' : 'Ditolak'),
            h('div', { class: 'small muted' }, l.kind)),
          h('td', null,
            h('div', { class: 'cell-text' }, l.accepted && l.post_id ? h('a', { href: `#/post/${l.post_id}` }, l.content) : l.content),
            h('div', { class: 'small muted cell-text' }, l.reason)),
          h('td', { class: 'small' }, l.verdict, h('br'), `${Math.round(l.score * 100)}%`),
          h('td', { class: 'small', title: fullTime(l.created_at) }, relTime(l.created_at)))));
      } catch (err) { tbody.replaceChildren(h('tr', null, h('td', { colspan: 4, class: 'field-error' }, err.message))); }
    })();
    return h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Isi & alasan'), h('th', null, 'Verdict'), h('th', null, 'Waktu'))),
      tbody)));
  }

  // ================================================================ navigasi & router
  function setTitle(t) {
    $('#page-title').textContent = t;
    document.title = `${t} — Rujuk`;
  }

  function renderNav() {
    const links = [['#/', 'Beranda']];
    if (state.me) {
      links.push([`#/u/${encodeURIComponent(state.me.username)}`, 'Profil'], ['#/sources', 'Pustaka'], ['#/verifications', 'Riwayat']);
    } else {
      links.push(['#/login', 'Masuk'], ['#/register', 'Daftar']);
    }
    const cur = location.hash || '#/';
    $('#nav').replaceChildren(...links.map(([href, label]) =>
      h('li', null, h('a', { href, 'aria-current': cur === href ? 'page' : false }, label))));

    const box = $('#side-user');
    if (state.me) {
      const out = h('button', { type: 'button', class: 'btn secondary small' }, 'Keluar');
      out.addEventListener('click', async () => {
        try { await api('POST', '/api/auth/logout'); } catch { /* tetap keluar di sisi klien */ }
        state.me = null; renderNav(); toast('Anda sudah keluar.'); go('#/');
      });
      box.replaceChildren(h('div', null, h('div', { class: 'who' }, state.me.display_name), h('div', { class: 'handle' }, `@${state.me.username}`)), out);
    } else {
      box.replaceChildren();
    }
  }

  function render() {
    const hash = location.hash || '#/';
    const view = $('#view');
    state.onNewPost = null;
    let m;
    let node;
    if (hash === '#/' || hash === '#') node = viewHome();
    else if (hash === '#/login') node = viewLogin();
    else if (hash === '#/register') node = viewRegister();
    else if (hash === '#/sources') node = viewSources();
    else if (hash === '#/verifications') node = viewVerifications();
    else if ((m = hash.match(/^#\/u\/([A-Za-z0-9_]{3,20})$/))) node = viewProfile(m[1]);
    else if ((m = hash.match(/^#\/post\/([1-9][0-9]{0,15})$/))) node = viewPost(m[1]);
    else { setTitle('Tidak ditemukan'); node = h('div', { class: 'card empty' }, 'Halaman tidak ditemukan. ', h('a', { href: '#/' }, 'Kembali ke Beranda')); }
    view.replaceChildren(node);
    renderNav();
  }

  // ================================================================ start
  document.addEventListener('DOMContentLoaded', async () => {
    const dlg = $('#retweet-dialog');
    $('#retweet-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => $('#retweet-body').replaceChildren());

    try { state.me = (await api('GET', '/api/auth/me')).user; } catch { state.me = null; }
    window.addEventListener('hashchange', () => { render(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });
    render();
  });
})();
