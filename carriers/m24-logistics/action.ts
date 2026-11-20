/**
 * The id of the server action M24's order page calls, read from the client
 * chunks the page loads. The page awaits `(0,Z.vh)(slug)` and reads an empty
 * list as no order. Module `Z` exports `vh` as a reference built from the id by
 * `createServerReference`, directly or through a module that wraps it. Only an
 * id bound that way counts: the same module registers the site's other
 * actions next to it.
 */
import { escapeRegExp } from '../../core/transport/index.js';

/** Shared chunks read per discovery, a batch at a time, after the route's own. */
export const MAX_CHUNKS = 30;
const BATCH = 6;
// A module's body is searched up to the next module, and never past this.
const MAX_MODULE_CHARS = 20_000;

const SCRIPT = /<script\b[^>]*?\bsrc\s*=\s*["']([^"'<>]+)["']/gi;
const CHUNK_PATH = /^\/_next\/static\/chunks\/[\w%.()[\]/-]+\.js$/;
// Next's runtime, React and polyfills hold no route code.
const RUNTIME = /^\/_next\/static\/chunks\/(?:webpack|polyfills|main-app|main|framework)-/;
const ROUTE_PAGE = /^\/_next\/static\/chunks\/app\/.*track-my-order\/.*\/page-[\w]+\.js$/;
// Shared chunks named by their webpack id; the others are vendor bundles.
const SHARED = /^\/_next\/static\/chunks\/\d+-[0-9a-f]+\.js$/;
// `l=await (0,Z.vh)(_);if(!l||0===l.length)`: the order lookup and its empty-list check.
const LOOKUP_CALL = /([\w$]+)\s*=\s*await\s*\(0,\s*([\w$]+)\.([\w$]+)\)\(\s*[\w$]+\s*\)\s*;\s*if\s*\(\s*!\s*\1\s*\|\|\s*0\s*===\s*\1\.length\s*\)/g;
const NEXT_MODULE = /\}\s*,\s*(?:\d+|"[^"]*")\s*:\s*(?:function\s*\(|\([\w$,\s]*\)\s*=>)/;

export interface LookupCall {
  /** The webpack module that exports the action reference. */
  module: string;
  /** The export the page calls. */
  name: string;
}

/** Fetches a chunk's text within the bytes it may have. */
export type ChunkReader = (url: string) => Promise<string>;

/** The page's own client chunks, in the order its script tags load them. */
export function pageChunks(html: string, page: string): string[] {
  const origin = new URL(page).origin;
  const chunks: string[] = [];
  for (const [, src = ''] of html.matchAll(SCRIPT)) {
    let url: URL;
    try {
      url = new URL(src.replace(/&amp;/g, '&'), page);
    } catch {
      continue;
    }
    if (url.origin !== origin || !CHUNK_PATH.test(url.pathname) || RUNTIME.test(url.pathname)) continue;
    if (!chunks.includes(url.href)) chunks.push(url.href);
  }
  return chunks;
}

const pathOf = (url: string) => {
  const path = new URL(url).pathname;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/** A variable's last `name = require(id)` before `end`. */
function requiredModule(source: string, variable: string, end = source.length): string | undefined {
  const declaration = new RegExp(String.raw`(?:^|[^\w$.])${escapeRegExp(variable)}\s*=\s*[\w$]+\(\s*(\d+)\s*\)`, 'g');
  let module: string | undefined;
  for (const match of source.slice(0, end).matchAll(declaration)) module = match[1];
  return module;
}

/** The one order lookup the route's chunk makes, when it makes exactly one. */
export function lookupCall(source: string): LookupCall | undefined {
  const calls = new Map<string, LookupCall>();
  for (const { 2: variable = '', 3: name = '', index } of source.matchAll(LOOKUP_CALL)) {
    const module = requiredModule(source, variable, index);
    if (module !== undefined) calls.set(`${module}:${name}`, { module, name });
  }
  return calls.size === 1 ? [...calls.values()][0] : undefined;
}

/** A webpack module's body, up to where the next module starts. */
function moduleBody(sources: readonly string[], id: string): string | undefined {
  const start = new RegExp(String.raw`(?:^|[{,])\s*${id}\s*:\s*(?:function\s*\([\w$,\s]*\)|\([\w$,\s]*\)\s*=>)\s*\{`);
  for (const source of sources) {
    const match = start.exec(source);
    if (!match) continue;
    const body = source.slice(match.index + match[0].length, match.index + match[0].length + MAX_MODULE_CHARS);
    const next = NEXT_MODULE.exec(body);
    return next ? body.slice(0, next.index) : body;
  }
  return undefined;
}

/**
 * The id the call's export is built from: `undefined` while the module, or the
 * wrapper it builds the reference with, is not among the sources read; `null`
 * when they are and do not build it from an id.
 */
export function actionId(sources: readonly string[], call: LookupCall): string | null | undefined {
  const body = moduleBody(sources, call.module);
  if (body === undefined) return undefined;
  const name = escapeRegExp(call.name);
  const getter = new RegExp(String.raw`[{,]\s*${name}\s*:\s*(?:function\s*\(\s*\)\s*\{\s*return\s+([\w$]+)\s*;?\s*\}|\(\s*\)\s*=>\s*([\w$]+))`).exec(body);
  const local = getter?.[1] ?? getter?.[2];
  if (local === undefined) return null;
  const reference = new RegExp(String.raw`(?:^|[^\w$.])${escapeRegExp(local)}\s*=\s*\(0,\s*([\w$]+)\.([\w$]+)\)\(\s*"([0-9a-f]{40,42})"`).exec(body);
  if (!reference) return null;
  const [, wrapper = '', member, id = ''] = reference;
  if (member === 'createServerReference') return id;
  const wrapperModule = requiredModule(body, wrapper);
  if (wrapperModule === undefined) return null;
  const wrapped = moduleBody(sources, wrapperModule);
  if (wrapped === undefined) return undefined;
  return wrapped.includes('createServerReference') ? id : null;
}

/**
 * The action id the page's chunks bind to the order lookup. The route's page
 * chunk names the module and export it calls; the shared chunks are then read
 * a batch at a time, from the last one the page loads back, until the
 * reference and its wrapper are both found, and never more than `MAX_CHUNKS`.
 */
export async function discoverActionId(html: string, page: string, read: ChunkReader): Promise<string | undefined> {
  const chunks = pageChunks(html, page);
  const route = chunks.find(url => ROUTE_PAGE.test(pathOf(url)));
  if (route === undefined) return undefined;
  const sources = [await read(route)];
  const call = lookupCall(sources[0]!);
  if (!call) return undefined;
  const shared = chunks.filter(url => SHARED.test(pathOf(url))).reverse().slice(0, MAX_CHUNKS);
  for (let at = 0; at < shared.length; at += BATCH) {
    sources.push(...await Promise.all(shared.slice(at, at + BATCH).map(read)));
    const found = actionId(sources, call);
    if (found !== undefined) return found ?? undefined;
  }
  return undefined;
}
