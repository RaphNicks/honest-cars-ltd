'use strict';

/**
 * A DOM small enough to read — for testing the browser modules without a
 * browser. It supports exactly what those modules touch: attributes and
 * `dataset`, classes, `hidden`, text content, tree navigation (`closest`,
 * `querySelector`), events, and `<template>.content.cloneNode(true)`.
 *
 * It is deliberately not a DOM implementation: there is no layout, no
 * stylesheet, no parsing and no selector engine beyond `[attr]` and a tag name.
 * Anything that needs more than this belongs in a page audit, not here.
 */

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

class Element {
  constructor(tag, { attrs = {}, className = '', dataset = {}, text = '' } = {}) {
    this.tag = tag;
    this.attrs = new Map(Object.entries(attrs));
    this.classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
    this.dataset = { ...dataset };
    this.ownText = text;
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.handlers = new Map();
    this.focused = false;
  }

  get classList() {
    const set = this.classes;
    return {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name);
        else set.delete(name);
        return on;
      },
    };
  }

  get className() {
    return [...this.classes].join(' ');
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }

  /** A real fragment has this, and `cityItem()` uses it to hand back the item. */
  get firstElementChild() {
    return this.children[0] || null;
  }

  get textContent() {
    return [this.ownText, ...this.children.map((child) => child.textContent)].join('');
  }

  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }

  matches(selector) {
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const name = selector.slice(1, -1);
      if (this.attrs.has(name)) return true;
      // data-foo ↔ dataset.foo
      const key = name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
      return Boolean(key) && this.dataset[key] !== undefined;
    }
    return this.tag === selector;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      // A <template>'s children live in its `.content` fragment, not in the
      // document: querying from an ancestor cannot reach them, and code that
      // relies on that (js/area.js does) must not be tripped up by a stub.
      if (node instanceof TemplateElement) return;
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  emit(type, event = {}) {
    const full = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const handler of this.handlers.get(type) || []) handler(full);
    return full;
  }

  focus() {
    this.focused = true;
  }

  cloneNode() {
    const copy = new Element(this.tag, { attrs: Object.fromEntries(this.attrs), className: this.className, dataset: { ...this.dataset } });
    copy.ownText = this.ownText;
    copy.hidden = this.hidden;
    for (const child of this.children) copy.append(child.cloneNode());
    return copy;
  }
}

/** `<template>`: the only part of it the code touches is `.content`. */
class TemplateElement extends Element {
  constructor(...args) {
    super(...args);
    const self = this;
    this.content = {
      cloneNode() {
        const fragment = new Element('fragment');
        for (const child of self.children) fragment.append(child.cloneNode());
        return fragment;
      },
    };
  }
}

module.exports = { Element, TemplateElement };
