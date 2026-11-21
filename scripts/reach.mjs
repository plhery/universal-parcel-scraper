import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Counts the catalog carriers that 17TRACK's public carrier list lacks, for the README's headline.
// A carrier is listed when one of its names, or the domain of one of its pages, is in the list.
// Names are compared without legal forms, generic words and country names, so a near miss counts
// as listed and the count stays low.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'docs/reach.json');
const reach = JSON.parse(readFileSync(file, 'utf8'));
const aggregator = reach['17TRACK'];
const response = await fetch(aggregator.list);
if (!response.ok) throw new Error(`${aggregator.list} answered ${response.status}`);
const script = await response.text();
const listed = JSON.parse(script.slice(script.indexOf('return [') + 'return '.length, script.lastIndexOf(']') + 1));
if (listed.length < 1000) throw new Error(`17TRACK's list has ${listed.length} carriers; check ${aggregator.list}`);

const GENERIC = /\b(ltd|inc|co|llc|gmbh|ag|sa|sas|srl|spa|bv|ab|as|oy|kft|sro|doo|express|logistics?|logistica|logistique|couriers?|kurier|kurye|posts?|posta|poste|postal|group|company|corp|limited|international|intl|delivery|deliveries|shipping|the|services?|transport|transportes|freight|cargo|parcels?)\b/g;
const COUNTRIES = /\b(france|germany|uk|usa|us|spain|italy|poland|china|india|canada|australia|netherlands|belgium|ireland|portugal|japan|korea|greece|turkey|brazil|mexico|estonia|latvia|lithuania|czech|slovakia|hungary|romania|bulgaria|austria|switzerland|sweden|norway|denmark|finland|hong kong|taiwan|singapore|malaysia|thailand|vietnam|philippines|indonesia|chile|argentina|colombia|peru|russia|ukraine|israel|uae|saudi|south africa|new zealand|serbia|croatia|slovenia|cyprus|global|worldwide|europe|[a-z]{2})\b/g;
const plain = name => String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[()[\],.&'’/-]/g, ' ');
const keys = name => [plain(name).replace(/[^\p{L}\p{N}]/gu, ''), plain(name).replace(COUNTRIES, ' ').replace(GENERIC, ' ').replace(/[^\p{L}\p{N}]/gu, '')]
  .filter(key => key.length >= 3);
const SHARED_HOSTS = /^(google|shopify|myshopify|wixsite|aftership|17track|parcelsapp|ship24|trackingmore|github|amazonaws|cloudfront|azurewebsites|herokuapp)\./;
const domain = url => {
  let host;
  try { host = new URL(/^https?:/.test(url) ? url : `http://${url}`).hostname.replace(/^www\d?\./, ''); } catch { return ''; }
  const labels = host.split('.');
  const registered = labels.slice(/^(com|co|net|org|gov|ac|or|ne|go|gob|edu)$/.test(labels.at(-2)) ? -3 : -2).join('.');
  return SHARED_HOSTS.test(registered) ? '' : registered;
};

const names = new Set(listed.flatMap(carrier => [carrier._name, carrier['_name_zh-cn'], carrier['_name_zh-hk']].filter(Boolean).flatMap(keys)));
const domains = new Set(listed.map(carrier => domain(carrier._url ?? '')).filter(Boolean));
const carriers = readdirSync(path.join(root, 'carriers'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => JSON.parse(readFileSync(path.join(root, 'carriers', entry.name, 'carrier.json'), 'utf8')))
  .filter(carrier => carrier.id !== 'unknown');
const missing = carriers.filter(carrier => ![carrier.displayName, ...carrier.aliases].flatMap(keys).some(key => names.has(key))
  && ![carrier.portal.url, carrier.portal.searchUrl, carrier.portal.helpUrl, carrier.portal.canaryUrl]
    .filter(Boolean).map(url => domain(url.replace(/\{[^}]*\}/g, ''))).some(found => domains.has(found)));

aggregator.catalogNotListed = missing.length;
writeFileSync(file, `${JSON.stringify(reach, null, 2)}\n`);
console.log(`${missing.length} of ${carriers.length} catalog carriers are not in 17TRACK's list of ${listed.length}`);
if (process.argv.includes('--list')) for (const carrier of missing) console.log(`${carrier.id}\t${carrier.displayName}`);
