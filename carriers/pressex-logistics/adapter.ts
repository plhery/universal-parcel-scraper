import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { guideOperation, historyOperation, parseHistory, provider, selectGuide, tenant } from './parser.js';

const portal = 'https://plataforma.nuvix.co';
const endpoint = 'https://backend.nuvix.co/ingreso-login';
const guideQuery = `query ${guideOperation}($sufijoUrl: String, $busquedaAnidadaNueva: GenericScalar) {
  ${guideOperation}(sufijoUrl: $sufijoUrl, busquedaAnidadaNueva: $busquedaAnidadaNueva) {
    objects { id numeroGuia entregado activo agencia { sufijoUrl agenciaPadre { sufijoUrl } } }
  }
}`;
const historyQuery = `query ${historyOperation}($pkGuia: ID, $statusEsVisiblePortalWebPublico: Boolean) {
  ${historyOperation}(pkGuia: $pkGuia, statusEsVisiblePortalWebPublico: $statusEsVisiblePortalWebPublico) {
    objects { activo fechaHoraInicial fechaHoraAlterna status { nombre esVisiblePortalWebPublico } }
  }
}`;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,36}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter the PressEx guide number');
    }

    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        async function lookup(operationName: string, query: string, variables: object): Promise<unknown> {
          const { bytes, response } = await fetchBounded(endpoint, {
            method: 'POST', signal, headers: {
              Accept: 'application/json', 'Content-Type': 'application/json', Origin: portal,
              Referer: portal + '/auth/rastreoGuia/' + tenant, 'User-Agent': userAgentOf(environment.userAgent),
            },
            body: JSON.stringify({ operationName, query, variables }),
          }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 400_000, allowHttpStatuses: [403] });
          const text = decodeText(bytes);
          if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Verification)|cf-chl/i.test(text)) {
            throw new ChallengeError(provider, 'PressEx requires verification');
          }
          try {
            const data: unknown = JSON.parse(text);
            return data;
          } catch {
            throw new SchemaError(provider, 'PressEx returned invalid tracking JSON');
          }
        }

        const guide = selectGuide(await lookup(guideOperation, guideQuery, {
          sufijoUrl: tenant,
          busquedaAnidadaNueva: [{ valoresDeBusqueda: [number], camposYFiltros: [{ campo: 'numero_guia', filtro: 'iexact' }] }],
        }), number);
        const history = await lookup(historyOperation, historyQuery, {
          pkGuia: guide.id, statusEsVisiblePortalWebPublico: true,
        });
        return parseHistory(history, guide.delivered);
      },
    }]);
  },
});
