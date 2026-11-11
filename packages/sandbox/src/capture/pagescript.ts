/** Scripts that run inside the page. Kept as strings so they work in every frame. */

/** Reports user input events to the recorder through the exposed binding `__sbxEvent`. */
export const LISTENER_SCRIPT = `(() => {
  if (window.__sbxInstalled) return; window.__sbxInstalled = true;
  const nameOf = (el) => {
    if (!el || !el.getAttribute) return '';
    const lab = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder');
    if (lab) return lab.trim().slice(0, 120);
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim().slice(0, 120);
    if (el.tagName === 'INPUT' && /submit|button/.test(el.type)) return (el.value || '').slice(0, 120);
    return (el.innerText || el.textContent || el.name || el.id || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let s = n.tagName.toLowerCase();
      const sib = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const describe = (el) => {
    const t = el.closest ? (el.closest('a,button,[role=button],[role=link],[role=tab],[role=menuitem],input,select,textarea,label,summary') || el) : el;
    return { tag: t.tagName.toLowerCase(), role: t.getAttribute('role') || undefined, name: nameOf(t), selector: selectorOf(t), href: t.href || undefined, inputType: t.type || undefined };
  };
  const send = (kind, el, value) => { try { window.__sbxEvent(JSON.stringify({ kind, target: describe(el), value, frameUrl: location.href })); } catch (e) {} };
  document.addEventListener('click', (e) => send('click', e.target), true);
  document.addEventListener('change', (e) => {
    const el = e.target; if (!el || !el.tagName) return;
    const secret = el.type === 'password' || /pass|pin|otp|code/i.test(el.name || '');
    send(el.tagName === 'SELECT' ? 'select' : 'type', el, secret ? '' : String(el.value ?? '').slice(0, 500));
  }, true);
  document.addEventListener('submit', (e) => send('submit', e.target), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA') send('key', e.target, 'Enter'); }, true);
})();`;

/** Lists the controls a crawler may consider, with what the UI gate needs to judge each. */
export const CONTROLS_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.tagName === 'INPUT' ? el.value : '') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  const els = document.querySelectorAll('a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],summary');
  let i = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || el.disabled) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const top = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
    const onTop = !top || el.contains(top) || top.contains(el) || r.top > innerHeight || r.bottom < 0;
    if (!onTop) continue;
    const form = el.closest('form');
    const dialog = el.closest('[role=dialog],[role=alertdialog],dialog,.modal');
    const name = nameOf(el);
    const key = el.tagName + '|' + name + '|' + (el.getAttribute('href') || '');
    if (seen.has(key)) continue; seen.add(key);
    el.setAttribute('data-sbx', String(++i));
    out.push({ ref: i, tag: el.tagName.toLowerCase(), name, role: el.getAttribute('role') || undefined, href: el.href || undefined,
      inputType: el.type || undefined, isSubmit: (el.tagName === 'BUTTON' && (el.type === 'submit') && !!form) || el.type === 'submit',
      inForm: !!form, formMethod: form ? (form.getAttribute('method') || 'get') : undefined, dialogText: dialog ? dialog.innerText.slice(0, 400) : undefined });
  }
  return out;
})()`;
