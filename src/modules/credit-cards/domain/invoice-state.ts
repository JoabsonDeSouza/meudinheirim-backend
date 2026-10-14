import { InvalidInvoiceTransitionError } from '../../../shared/errors/index.js';

export type InvoiceLifecycleState = 'OPEN' | 'CLOSED' | 'PAID';
export type InvoiceLifecycleAction = 'close' | 'pay' | 'refund';

export function transitionInvoiceStatus(
  current: InvoiceLifecycleState,
  action: InvoiceLifecycleAction,
): InvoiceLifecycleState {
  if (current === 'OPEN' && action === 'close') return 'CLOSED';
  if (current === 'CLOSED' && action === 'pay') return 'PAID';
  if ((current === 'PAID' || current === 'CLOSED') && action === 'refund') return 'CLOSED';
  throw new InvalidInvoiceTransitionError(current, action);
}
