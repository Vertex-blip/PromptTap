import { RemoteStore } from '../src/remote-store.js';
import { createAI } from '../src/ai.js';
import { createService } from '../src/service.js';
import { createBot } from '../src/bot.js';
import { createEdgeHandler } from '../src/edge-handler.js';

let runtimePromise;
let adminPromise;
async function initializeAdmin() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('Runtime configuration unavailable');
  const response = await fetch(`${url}/rest/v1/rpc/prompttap_bootstrap`, {
    method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Runtime configuration unavailable');
  const config = await response.json();
  const store = new RemoteStore({ url, apiKey: serviceKey, secret: config.storeSecret });
  let metaPromise, metaAt = 0;
  const getMeta = () => {
    if (!metaPromise || Date.now() - metaAt > 30000) {
      metaAt = Date.now();
      metaPromise = store.catalogMeta().then(meta => ({ ...meta, aiConfigured: Boolean(config.aiKey && config.aiModel), botConfigured: Boolean(config.token) }))
        .catch(error => { metaPromise = undefined; throw error; });
    }
    return metaPromise;
  };
  return { config, store, getMeta };
}
function loadAdmin() {
  if (!adminPromise) adminPromise = initializeAdmin().catch(error => { adminPromise = undefined; throw error; });
  return adminPromise;
}
async function initialize() {
  const { config, store } = await loadAdmin();
  const catalog = [];
  for (let offset = 0; ; offset += 100) {
    const page = await store.catalogPage(offset, 100);
    catalog.push(...page);
    if (page.length < 100) break;
  }
  const catalogMetadata = await store.catalogMeta();
  const service = createService({ catalog, ai: createAI(config, store), config, catalogMetadata, loadPrompt: id => store.getPrompt(id) });
  const bot = createBot({ token: config.token, miniAppUrl: config.miniAppUrl, service, store });
  await bot.init();
  return { config, store, service, bot };
}

function loadRuntime() {
  if (!runtimePromise) runtimePromise = initialize().catch(error => { runtimePromise = undefined; throw error; });
  return runtimePromise;
}

Deno.serve(createEdgeHandler({ loadRuntime, loadAdmin, allowedOrigin: 'https://vertex-blip.github.io' }));
