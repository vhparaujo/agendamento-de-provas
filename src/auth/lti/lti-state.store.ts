import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000; // 10 min: tempo de sobra para o OIDC ida e volta

interface Entrada {
  nonce: string;
  expiraEm: number;
}

/**
 * Guarda o par state/nonce entre a iniciacao OIDC e o launch, para que o launch
 * possa provar que veio de um fluxo que NOS iniciamos (state) e que o id_token
 * nao esta sendo reapresentado (nonce, consumido uma unica vez).
 *
 * LIMITACAO CONHECIDA: o armazenamento e em memoria, entao vale para UMA
 * instancia da aplicacao. Se um dia a API rodar com mais de uma replica atras de
 * um balanceador, isto precisa virar Redis (ou uma tabela) — caso contrario o
 * launch pode cair numa instancia que nao conhece o state. Trocar so este
 * arquivo basta; nada mais depende do mecanismo de armazenamento.
 */
@Injectable()
export class LtiStateStore {
  private readonly logger = new Logger(LtiStateStore.name);
  private readonly entradas = new Map<string, Entrada>();

  criar(): { state: string; nonce: string } {
    this.limpar();

    const state = randomUUID();
    const nonce = randomUUID();

    this.entradas.set(state, { nonce, expiraEm: Date.now() + TTL_MS });

    return { state, nonce };
  }

  /** Consome o state: valido no maximo uma vez (protege contra replay). */
  consumir(state: string): string | undefined {
    const entrada = this.entradas.get(state);
    this.entradas.delete(state);

    if (!entrada) return undefined;

    if (entrada.expiraEm < Date.now()) {
      this.logger.warn('State do LTI expirado');
      return undefined;
    }

    return entrada.nonce;
  }

  private limpar(): void {
    const agora = Date.now();

    for (const [state, entrada] of this.entradas) {
      if (entrada.expiraEm < agora) this.entradas.delete(state);
    }
  }
}
