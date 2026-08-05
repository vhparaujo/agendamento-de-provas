import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultadoLaunch } from './lti.service';

/**
 * 2 minutos. O resgate acontece no carregamento da pagina do portal, logo apos
 * o redirect — segundos, na pratica. A folga cobre rede ruim e aba aberta com
 * atraso, sem deixar o codigo util por tempo que nao precisa existir.
 */
const TTL_MS = 2 * 60 * 1000;

interface Entrada {
  resultado: ResultadoLaunch;
  expiraEm: number;
}

/**
 * ============================================================================
 * ENTREGA DO TOKEN DO ALUNO AO FRONT — POR CODIGO DE USO UNICO
 * ============================================================================
 * O launch e um POST do Brightspace para NOS; quem precisa do token e o portal,
 * que roda no navegador do aluno. Entre os dois so existe um redirect, e um
 * redirect so carrega URL.
 *
 * **O token nao pode ir na URL** (docs/SEGURANCA-FRONTEND.md, secao 1): URL vai
 * para historico do navegador, log de proxy e header `Referer`. Entao o redirect
 * leva um CODIGO opaco, e o portal troca esse codigo pelo token num POST.
 *
 * O codigo e um UUID v4 (122 bits de aleatoriedade), **de uso unico** e com
 * vida curta — o mesmo desenho do `state` em [LtiStateStore], por isso a forma
 * dos dois arquivos e igual de proposito.
 *
 * LIMITACAO CONHECIDA, identica a do LtiStateStore: armazenamento em memoria,
 * vale para UMA instancia. Com mais de uma replica atras de balanceador, o
 * resgate pode cair na instancia errada e o aluno ve "codigo invalido". Trocar
 * so este arquivo (Redis ou tabela) basta.
 */
@Injectable()
export class LtiCodeStore {
  private readonly logger = new Logger(LtiCodeStore.name);
  private readonly entradas = new Map<string, Entrada>();

  /** Guarda o resultado do launch e devolve o codigo que vai no redirect. */
  criar(resultado: ResultadoLaunch): string {
    this.limpar();

    const codigo = randomUUID();

    this.entradas.set(codigo, { resultado, expiraEm: Date.now() + TTL_MS });

    return codigo;
  }

  /** Consome o codigo: vale no maximo uma vez (protege contra replay). */
  consumir(codigo: string): ResultadoLaunch | undefined {
    const entrada = this.entradas.get(codigo);
    this.entradas.delete(codigo);

    if (!entrada) return undefined;

    if (entrada.expiraEm < Date.now()) {
      this.logger.warn('Codigo de sessao do LTI expirado');
      return undefined;
    }

    return entrada.resultado;
  }

  private limpar(): void {
    const agora = Date.now();

    for (const [codigo, entrada] of this.entradas) {
      if (entrada.expiraEm < agora) this.entradas.delete(codigo);
    }
  }
}
