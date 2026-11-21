import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Counts the carriers that 17TRACK's public carrier list lacks, for the README's headline: the
// catalog's, and the couriers Ship24's sitemap has a page for that the catalog lacks too.
// A catalog carrier is listed when one of its names, or the domain of one of its pages, is in the
// list. Names are compared without legal forms, generic words and country names, and a Ship24 page,
// known only by its address, is listed when a word of it is in a name, so near misses count as
// listed and the counts stay low.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'docs/reach.json');
const reach = JSON.parse(readFileSync(file, 'utf8'));
const download = async url => {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
};
const script = await download(reach['17TRACK'].list);
const listed = JSON.parse(script.slice(script.indexOf('return [') + 'return '.length, script.lastIndexOf(']') + 1));
const pages = [...new Set([...(await download(reach.Ship24.list)).matchAll(/\/couriers\/([a-z0-9-]+)-tracking<\/loc>/g)].map(match => match[1]))];
if (listed.length < 1000 || pages.length < 500) throw new Error(`17TRACK lists ${listed.length} carriers and Ship24 ${pages.length}; check the lists`);

const GENERIC = /\b(ltd|inc|co|llc|gmbh|ag|sa|sas|srl|spa|bv|ab|as|oy|kft|sro|doo|express|logistics?|logistica|logistique|couriers?|kurier|kurye|posts?|posta|poste|postal|office|group|company|corp|limited|international|intl|delivery|deliveries|shipping|the|services?|transport|transportes|freight|cargo|parcels?|solutions?|worldwide|global)\b/g;
const COUNTRIES = /\b(france|germany|uk|usa|us|spain|italy|poland|china|india|canada|australia|netherlands|belgium|ireland|portugal|japan|korea|greece|turkey|brazil|mexico|estonia|latvia|lithuania|czech|slovakia|hungary|romania|bulgaria|austria|switzerland|sweden|norway|denmark|finland|hong kong|taiwan|singapore|malaysia|thailand|vietnam|philippines|indonesia|chile|argentina|colombia|peru|russia|ukraine|israel|uae|saudi|south africa|new zealand|serbia|croatia|slovenia|cyprus|europe|[a-z]{2})\b/g;
const plain = name => String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[()[\],.&'’/-]/g, ' ');
const core = name => plain(name).replace(COUNTRIES, ' ').replace(GENERIC, ' ');
const keys = name => [plain(name), core(name)].map(key => key.replace(/[^\p{L}\p{N}]/gu, '')).filter(key => key.length >= 3);
const SHARED_HOSTS = /^(google|shopify|myshopify|wixsite|aftership|17track|parcelsapp|ship24|trackingmore|github|amazonaws|cloudfront|azurewebsites|herokuapp)\./;
const domain = url => {
  let host;
  try { host = new URL(/^https?:/.test(url) ? url : `http://${url}`).hostname.replace(/^www\d?\./, ''); } catch { return ''; }
  const labels = host.split('.');
  const registered = labels.slice(/^(com|co|net|org|gov|ac|or|ne|go|gob|edu)$/.test(labels.at(-2)) ? -3 : -2).join('.');
  return SHARED_HOSTS.test(registered) ? '' : registered;
};

const listedNames = listed.flatMap(carrier => [carrier._name, carrier['_name_zh-cn'], carrier['_name_zh-hk']].filter(Boolean));
const names = new Set(listedNames.flatMap(keys));
const domains = new Set(listed.map(carrier => domain(carrier._url ?? '')).filter(Boolean));
const carriers = readdirSync(path.join(root, 'carriers'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => JSON.parse(readFileSync(path.join(root, 'carriers', entry.name, 'carrier.json'), 'utf8')))
  .filter(carrier => carrier.id !== 'unknown');
const catalog = carriers.filter(carrier => ![carrier.displayName, ...carrier.aliases].flatMap(keys).some(key => names.has(key))
  && ![carrier.portal.url, carrier.portal.searchUrl, carrier.portal.helpUrl, carrier.portal.canaryUrl]
    .filter(Boolean).map(url => domain(url.replace(/\{[^}]*\}/g, ''))).some(found => domains.has(found)));
const known = [...listedNames, ...carriers.flatMap(carrier => [carrier.id, carrier.displayName, ...carrier.aliases])].flatMap(keys);
const ship24 = pages.filter(page => !keys(page).some(key => known.includes(key))
  && !core(page).split(/\s+/).filter(word => word.length >= 4).some(word => known.some(key => key.includes(word))));

reach.beyond17TRACK = { catalog: catalog.length, Ship24: ship24.length };
writeFileSync(file, `${JSON.stringify(reach, null, 2)}\n`);
console.log(`17TRACK lists ${listed.length} carriers. It lacks ${catalog.length} of the catalog's ${carriers.length}, and ${ship24.length} of Ship24's ${pages.length} that the catalog lacks too.`);
if (process.argv.includes('--list')) for (const id of [...catalog.map(carrier => carrier.id), ...ship24.map(page => `ship24:${page}`)]) console.log(id);
