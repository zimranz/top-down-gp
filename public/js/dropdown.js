/* Dropdowns in the game's style. Every <select> stays in the page and keeps working exactly as before (the game reads
   and sets it as usual); a button drawn in the game's style sits on top of it and opens a list that matches the game,
   on computers and on phones (instead of the browser's own white list). */
(function () {
  'use strict';
  const D = document;
  const vDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const iDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let open = null;                 // the list that is open: { sel, list, items, hi }

  function idx(sel) { return iDesc.get.call(sel); }
  /* The button shows the chosen option and copies the size of the text from the select it stands for. */
  function sync(sel) {
    const dd = sel._dd;
    if (!dd) return;
    const o = sel.options[idx(sel)];
    dd.text.textContent = o ? o.textContent : '';
    dd.btn.disabled = sel.disabled;
    dd.wrap.classList.toggle('disabled', sel.disabled);
    const cs = window.getComputedStyle(sel);
    dd.btn.style.fontSize = cs.fontSize;
    dd.btn.style.fontWeight = cs.fontWeight;
    dd.btn.style.paddingLeft = cs.paddingLeft;
    dd.btn.style.borderRadius = cs.borderRadius;
    if (open && open.sel === sel && sel.disabled) close();
  }

  /* Pick option i, as the browser would: the game hears 'input' and 'change'. */
  function choose(sel, i) {
    const o = sel.options[i];
    if (!o || o.disabled) return;
    const changed = idx(sel) !== i;
    iDesc.set.call(sel, i);
    sync(sel);
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function step(sel, from, dir) {
    for (let i = from + dir; i >= 0 && i < sel.options.length; i += dir) if (!sel.options[i].disabled) return i;
    return from;
  }

  function highlight(i, scroll) {
    if (!open) return;
    if (open.items[open.hi]) open.items[open.hi].classList.remove('hi');
    open.hi = i;
    const it = open.items[i];
    if (!it) return;
    it.classList.add('hi');
    if (scroll) {
      const L = open.list;
      if (it.offsetTop < L.scrollTop) L.scrollTop = it.offsetTop - 5;
      else if (it.offsetTop + it.offsetHeight > L.scrollTop + L.clientHeight) L.scrollTop = it.offsetTop + it.offsetHeight - L.clientHeight + 5;
    }
  }

  /* Under the button, or above it when there is more room there; never off the screen (scrolls when long). */
  function place() {
    if (!open) return;
    const r = open.sel._dd.btn.getBoundingClientRect(), L = open.list, vw = window.innerWidth, vh = window.innerHeight;
    L.style.minWidth = Math.round(r.width) + 'px';
    L.style.maxHeight = 'none';
    const natural = L.offsetHeight, below = vh - r.bottom - 10, above = r.top - 10;
    let top, maxH;
    if (Math.max(below, above) < Math.min(natural, 240)) {
      // little room either side (a phone held sideways): in the middle of the screen, over the button
      maxH = vh - 16; top = (vh - Math.min(natural, maxH)) / 2;
    } else if (natural <= below || below >= above) { maxH = Math.max(90, below - 4); top = r.bottom + 4; }
    else { maxH = Math.max(90, above - 4); top = r.top - 4 - Math.min(natural, maxH); }
    L.style.maxHeight = maxH + 'px';
    L.style.top = Math.round(Math.max(6, top)) + 'px';
    let left = r.left;
    const w = L.offsetWidth;
    if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
    L.style.left = Math.round(left) + 'px';
  }

  function openList(sel) {
    close();
    if (sel.disabled || !sel.options.length) return;
    const list = D.createElement('div');
    list.className = 'dd-list';
    list.setAttribute('role', 'listbox');
    const items = [], cur = idx(sel);
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i], it = D.createElement('div');
      it.className = 'dd-item' + (i === cur ? ' sel' : '') + (o.disabled ? ' off' : '');
      it.setAttribute('role', 'option');
      it.setAttribute('aria-selected', i === cur ? 'true' : 'false');
      it.textContent = o.textContent;
      it.addEventListener('click', function () {
        if (o.disabled) return;
        choose(sel, i);
        close();
        sel._dd.btn.focus({ preventScroll: true });
      });
      it.addEventListener('pointermove', function () { if (!o.disabled && open && open.hi !== i) highlight(i, false); });
      list.appendChild(it);
      items.push(it);
    }
    D.body.appendChild(list);
    open = { sel: sel, list: list, items: items, hi: -1 };
    sel._dd.wrap.classList.add('open');
    sel._dd.btn.setAttribute('aria-expanded', 'true');
    place();
    highlight(cur >= 0 ? cur : 0, true);
  }
  function close() {
    if (!open) return;
    const o = open;
    open = null;
    o.list.remove();
    o.sel._dd.wrap.classList.remove('open');
    o.sel._dd.btn.setAttribute('aria-expanded', 'false');
  }

  function onKey(sel, e) {
    const k = e.key;
    let used = true;
    if (open && open.sel === sel) {
      if (k === 'ArrowDown') highlight(step(sel, open.hi, 1), true);
      else if (k === 'ArrowUp') highlight(step(sel, open.hi, -1), true);
      else if (k === 'Home') highlight(step(sel, -1, 1), true);
      else if (k === 'End') highlight(step(sel, sel.options.length, -1), true);
      else if (k === 'Enter' || k === ' ') { choose(sel, open.hi); close(); }
      else if (k === 'Escape') close();
      else if (k === 'Tab') { close(); used = false; }
      else used = false;
    } else {
      if (k === 'Enter' || k === ' ' || (k === 'ArrowDown' && e.altKey) || k === 'F4') openList(sel);
      else if (k === 'ArrowDown' || k === 'ArrowRight') choose(sel, step(sel, idx(sel), 1));
      else if (k === 'ArrowUp' || k === 'ArrowLeft') choose(sel, step(sel, idx(sel), -1));
      else if (k === 'Home') choose(sel, step(sel, -1, 1));
      else if (k === 'End') choose(sel, step(sel, sel.options.length, -1));
      else used = false;
    }
    // the game's own keys (Esc = pause / back, arrows = steering) must not see this press
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  function enhance(sel) {
    if (sel._dd || sel.multiple) return;
    const wrap = D.createElement('span');
    wrap.className = 'dd';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    const btn = D.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const text = D.createElement('span');
    text.className = 'dd-text';
    const arrow = D.createElement('span');
    arrow.className = 'dd-arrow';
    btn.append(text, arrow);
    wrap.appendChild(btn);
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel._dd = { wrap: wrap, btn: btn, text: text };
    // the game sets .value / .selectedIndex directly: keep the button up to date
    Object.defineProperty(sel, 'value', { configurable: true, get: function () { return vDesc.get.call(this); }, set: function (v) { vDesc.set.call(this, v); sync(this); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get: function () { return iDesc.get.call(this); }, set: function (v) { iDesc.set.call(this, v); sync(this); } });
    sel.addEventListener('change', function () { sync(sel); });
    sel.addEventListener('input', function () { sync(sel); });
    sel.addEventListener('focus', function () { btn.focus({ preventScroll: true }); });          // a click on its label
    new MutationObserver(function () { sync(sel); }).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'label', 'selected'] });
    btn.addEventListener('click', function () { if (open && open.sel === sel) close(); else openList(sel); });
    btn.addEventListener('keydown', function (e) { onKey(sel, e); });
    sync(sel);
  }

  // close when clicking anywhere else, when the page scrolls under it, or when the window changes size
  D.addEventListener('pointerdown', function (e) {
    if (!open) return;
    if (open.list.contains(e.target) || open.sel._dd.wrap.contains(e.target)) return;
    close();
  }, true);
  D.addEventListener('scroll', function (e) { if (open && e.target !== open.list && !open.list.contains(e.target)) close(); }, true);
  window.addEventListener('resize', function () { close(); D.querySelectorAll('select').forEach(sync); });
  window.addEventListener('blur', close);
  // phones: text sizes change when the page switches to touch controls
  new MutationObserver(function () { D.querySelectorAll('select').forEach(sync); }).observe(D.body, { attributes: true, attributeFilter: ['class'] });

  D.querySelectorAll('select').forEach(enhance);
  // selects added later
  new MutationObserver(function (list) {
    for (let m = 0; m < list.length; m++) {
      const added = list[m].addedNodes;
      for (let k = 0; k < added.length; k++) {
        const n = added[k];
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'SELECT') enhance(n);
        else if (n.querySelectorAll) n.querySelectorAll('select').forEach(enhance);
      }
    }
  }).observe(D.body, { childList: true, subtree: true });

  window.Dropdown = { closeAll: close, isOpen: function () { return !!open; }, enhance: enhance, sync: sync };
})();
