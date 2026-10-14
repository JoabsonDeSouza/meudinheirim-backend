import { Prisma } from '../../../generated/prisma/client.js';
import { InvoiceStatus, TransactionType } from '../../../generated/prisma/enums.js';
import { BadRequestError, NotFoundError, VersionConflictError } from '../../../shared/errors/index.js';
import { decimalToMinorUnits, minorUnitsToDecimal, type Currency, type MoneyDto } from '../../../shared/money/index.js';
import { appendSyncChange, findMutationReplay, payloadHash, saveMutationReceipt } from '../../../shared/sync/idempotency.js';
import { transitionInvoiceStatus, type InvoiceLifecycleState } from '../domain/invoice-state.js';
import { invoiceCloseResultSchema, invoicePaymentResultSchema, invoiceRefundResultSchema, type CloseInvoiceInput, type PayInvoiceV1Input, type RefundInvoiceV1Input } from '../invoice-lifecycle.schema.js';
import { prisma } from '../../../shared/db/prisma.js';

function supportedCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Currency is not supported');
  return value;
}

function amountDto(amount: Prisma.Decimal, currency: Currency): MoneyDto {
  return { minorUnits: decimalToMinorUnits(amount, currency), currency };
}

function requireInvoiceState(status: InvoiceStatus): InvoiceLifecycleState {
  return status;
}

async function lockAccountRows(tx: Prisma.TransactionClient, accountIds: readonly string[]): Promise<void> {
  for (const id of [...accountIds].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-version:${id}`}))`;
  }
}

async function invoiceForHousehold(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  householdId: string,
): Promise<Prisma.CreditCardInvoiceGetPayload<{ include: { card: true } }>> {
  const invoice = await tx.creditCardInvoice.findFirst({
    where: { id: invoiceId, householdId },
    include: { card: true },
  });
  if (!invoice) throw new NotFoundError('Invoice');
  return invoice;
}

export async function closeInvoiceV1(
  invoiceId: string,
  householdId: string,
  userId: string,
  input: CloseInvoiceInput,
): Promise<ReturnType<typeof invoiceCloseResultSchema.parse>> {
  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'invoice.close', invoiceId, householdId, input }),
  };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, invoiceCloseResultSchema);
    if (replay !== null) return replay;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-lifecycle:${invoiceId}`}))`;
    const lockedReplay = await findMutationReplay(tx, identity, invoiceCloseResultSchema);
    if (lockedReplay !== null) return lockedReplay;
    const invoice = await invoiceForHousehold(tx, invoiceId, householdId);
    if (invoice.version !== input.expectedVersion) throw new VersionConflictError();
    const nextStatus = transitionInvoiceStatus(requireInvoiceState(invoice.status), 'close');
    const now = new Date();
    const updated = await tx.creditCardInvoice.updateMany({
      where: { id: invoice.id, householdId, status: InvoiceStatus.OPEN, version: input.expectedVersion },
      data: { status: nextStatus, closedAt: now, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new VersionConflictError();
    const result = invoiceCloseResultSchema.parse({
      invoiceId: invoice.id,
      status: nextStatus,
      version: input.expectedVersion + 1,
      closedAt: now.toISOString(),
    });
    await saveMutationReceipt(tx, identity, 'invoice', invoice.id, result);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'invoice',
      entityId: invoice.id,
      version: result.version,
      payload: { ...result, totalAmount: amountDto(invoice.totalAmount, supportedCurrency(invoice.currency)) },
    });
    return result;
  });
}

async function updateAccountBalance(
  tx: Prisma.TransactionClient,
  account: { id: string; householdId: string; version: number; currency: string; type: string; balance: Prisma.Decimal; availableBalance: Prisma.Decimal; totalBalance: Prisma.Decimal },
  expectedVersion: number,
  delta: Prisma.Decimal,
): Promise<{ version: number; currency: Currency; balance: Prisma.Decimal; availableBalance: Prisma.Decimal; totalBalance: Prisma.Decimal }> {
  if (account.version !== expectedVersion) throw new VersionConflictError();
  const update = await tx.account.updateMany({
    where: { id: account.id, householdId: account.householdId, version: expectedVersion },
    data: {
      balance: { increment: delta },
      availableBalance: { increment: delta },
      totalBalance: { increment: delta },
      ...(account.type === 'CREDIT' ? { availableLimit: { decrement: delta } } : {}),
      version: { increment: 1 },
    },
  });
  if (update.count !== 1) throw new VersionConflictError();
  const updated = await tx.account.findUnique({ where: { id: account.id } });
  if (!updated) throw new NotFoundError('Account');
  return {
    version: updated.version,
    currency: supportedCurrency(updated.currency),
    balance: updated.balance,
    availableBalance: updated.availableBalance,
    totalBalance: updated.totalBalance,
  };
}

function accountChangePayload(
  accountId: string,
  version: number,
  currency: Currency,
  balance: Prisma.Decimal,
  availableBalance: Prisma.Decimal,
  totalBalance: Prisma.Decimal,
): Record<string, unknown> {
  return {
    id: accountId,
    version,
    currency,
    balance: amountDto(balance, currency),
    availableBalance: amountDto(availableBalance, currency),
    totalBalance: amountDto(totalBalance, currency),
  };
}

export async function payInvoiceV1(
  invoiceId: string,
  householdId: string,
  userId: string,
  input: PayInvoiceV1Input,
): Promise<ReturnType<typeof invoicePaymentResultSchema.parse>> {
  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'invoice.pay', invoiceId, householdId, input }),
  };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, invoicePaymentResultSchema);
    if (replay !== null) return replay;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-lifecycle:${invoiceId}`}))`;
    const lockedReplay = await findMutationReplay(tx, identity, invoicePaymentResultSchema);
    if (lockedReplay !== null) return lockedReplay;
    const invoice = await invoiceForHousehold(tx, invoiceId, householdId);
    if (invoice.version !== input.expectedVersion) throw new VersionConflictError();
    transitionInvoiceStatus(requireInvoiceState(invoice.status), 'pay');
    const currency = supportedCurrency(invoice.currency);
    await lockAccountRows(tx, [input.sourceAccountId, invoice.cardAccountId]);
    const [sourceAccount, cardAccount] = await Promise.all([
      tx.account.findFirst({ where: { id: input.sourceAccountId, householdId, isActive: true } }),
      tx.account.findFirst({ where: { id: invoice.cardAccountId, householdId, isActive: true } }),
    ]);
    if (!sourceAccount || !cardAccount) throw new NotFoundError('Account');
    if (sourceAccount.type === 'CREDIT' || cardAccount.type !== 'CREDIT') throw new BadRequestError('Invoice payments require a bank source and credit-card destination');
    if (supportedCurrency(sourceAccount.currency) !== currency || supportedCurrency(cardAccount.currency) !== currency) {
      throw new BadRequestError('Payment currency must match invoice and both accounts');
    }
    if (sourceAccount.version !== input.expectedSourceVersion || cardAccount.version !== input.expectedCardVersion) {
      throw new VersionConflictError();
    }
    const paidAggregate = await tx.invoicePayment.aggregate({
      where: { invoiceId: invoice.id, refundedAt: null },
      _sum: { amount: true },
    });
    const alreadyPaid = paidAggregate._sum.amount ?? new Prisma.Decimal(0);
    const outstanding = invoice.totalAmount.sub(alreadyPaid);
    if (!outstanding.greaterThan(0)) throw new BadRequestError('Invoice has no outstanding balance');
    const amount = input.amount ? minorUnitsToDecimal(input.amount) : outstanding;
    if (input.amount && input.amount.currency !== currency) throw new BadRequestError('Payment currency must match invoice currency');
    if (amount.greaterThan(outstanding)) throw new BadRequestError('Payment exceeds invoice outstanding balance');
    if (sourceAccount.availableBalance.lessThan(amount)) throw new BadRequestError('Insufficient source account balance');

    const sourceUpdated = await updateAccountBalance(tx, sourceAccount, input.expectedSourceVersion, amount.negated());
    const cardUpdated = await updateAccountBalance(tx, cardAccount, input.expectedCardVersion, amount.negated());
    const now = new Date();
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: TransactionType.TRANSFER,
        fromAccountId: sourceAccount.id,
        toAccountId: cardAccount.id,
        categoryName: 'TRANSFER',
        amount,
        date: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
        occurredAt: now,
        timeZone: input.timeZone,
        notes: 'Credit card invoice payment',
        paid: true,
        invoiceId: invoice.id,
        clientMutationId: input.clientMutationId,
      },
    });
    const payment = await tx.invoicePayment.create({
      data: { invoiceId: invoice.id, transactionId: transaction.id, amount },
    });
    const newPaid = alreadyPaid.add(amount);
    const invoiceState = newPaid.greaterThanOrEqualTo(invoice.totalAmount) ? 'PAID' : 'CLOSED';
    const nextStatus = invoiceState === 'PAID'
      ? transitionInvoiceStatus(requireInvoiceState(invoice.status), 'pay')
      : InvoiceStatus.CLOSED;
    const nextInvoiceVersion = input.expectedVersion + 1;
    const invoiceUpdate = await tx.creditCardInvoice.updateMany({
      where: { id: invoice.id, householdId, version: input.expectedVersion, status: InvoiceStatus.CLOSED },
      data: {
        status: nextStatus,
        version: { increment: 1 },
        ...(nextStatus === InvoiceStatus.PAID ? { paidAt: now } : {}),
      },
    });
    if (invoiceUpdate.count !== 1) throw new VersionConflictError();
    const result = invoicePaymentResultSchema.parse({
      invoiceId: invoice.id,
      status: nextStatus,
      version: nextInvoiceVersion,
      paymentId: payment.id,
      transactionId: transaction.id,
      paidAmount: amountDto(amount, currency),
      outstandingAmount: amountDto(outstanding.sub(amount), currency),
    });
    await saveMutationReceipt(tx, identity, 'invoice_payment', transaction.id, result);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: transaction.id,
      version: transaction.version,
      payload: {
        id: transaction.id,
        kind: 'transfer',
        amount: amountDto(amount, currency),
        fromAccountId: sourceAccount.id,
        toAccountId: cardAccount.id,
        invoiceId: invoice.id,
        clientMutationId: input.clientMutationId,
      },
    });
    await appendSyncChange(tx, {
      householdId,
      entityType: 'invoice',
      entityId: invoice.id,
      version: result.version,
      payload: result,
    });
    await appendSyncChange(tx, {
      householdId,
      entityType: 'account',
      entityId: sourceAccount.id,
      version: sourceUpdated.version,
      payload: accountChangePayload(sourceAccount.id, sourceUpdated.version, currency, sourceUpdated.balance, sourceUpdated.availableBalance, sourceUpdated.totalBalance),
    });
    await appendSyncChange(tx, {
      householdId,
      entityType: 'account',
      entityId: cardAccount.id,
      version: cardUpdated.version,
      payload: accountChangePayload(cardAccount.id, cardUpdated.version, currency, cardUpdated.balance, cardUpdated.availableBalance, cardUpdated.totalBalance),
    });
    return result;
  });
}

export async function refundInvoiceV1(
  invoiceId: string,
  householdId: string,
  userId: string,
  input: RefundInvoiceV1Input,
): Promise<ReturnType<typeof invoiceRefundResultSchema.parse>> {
  const identity = { userId, clientMutationId: input.clientMutationId, hash: payloadHash({ operation: 'invoice.refund', invoiceId, householdId, input }) };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, invoiceRefundResultSchema);
    if (replay !== null) return replay;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-lifecycle:${invoiceId}`}))`;
    const lockedReplay = await findMutationReplay(tx, identity, invoiceRefundResultSchema);
    if (lockedReplay !== null) return lockedReplay;
    const invoice = await invoiceForHousehold(tx, invoiceId, householdId);
    if (invoice.version !== input.expectedVersion) throw new VersionConflictError();
    transitionInvoiceStatus(requireInvoiceState(invoice.status), 'refund');
    const payment = await tx.invoicePayment.findFirst({
      where: { id: input.paymentId, invoiceId: invoice.id, refundedAt: null },
      include: { transaction: { include: { fromAccount: true } } },
    });
    if (!payment || !payment.transaction.fromAccount) throw new NotFoundError('Invoice payment');
    await lockAccountRows(tx, [payment.transaction.fromAccount.id, invoice.cardAccountId]);
    const source = await tx.account.findFirst({
      where: { id: payment.transaction.fromAccount.id, householdId, isActive: true },
    });
    if (!source) throw new NotFoundError('Account');
    const card = await tx.account.findFirst({
      where: { id: invoice.cardAccountId, householdId, isActive: true },
    });
    if (!card) throw new NotFoundError('Account');
    const currency = supportedCurrency(invoice.currency);
    if (source.version !== input.expectedSourceVersion || card.version !== input.expectedCardVersion) throw new VersionConflictError();
    if (supportedCurrency(source.currency) !== currency || supportedCurrency(card.currency) !== currency) throw new BadRequestError('Refund currencies must match invoice currency');
    const amount = payment.amount;
    const sourceUpdated = await updateAccountBalance(tx, source, input.expectedSourceVersion, amount);
    const cardUpdated = await updateAccountBalance(tx, card, input.expectedCardVersion, amount);
    const now = new Date();
    const refundTransaction = await tx.transaction.create({
      data: {
        householdId,
        type: TransactionType.TRANSFER,
        fromAccountId: card.id,
        toAccountId: source.id,
        categoryName: 'TRANSFER',
        amount,
        date: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
        occurredAt: now,
        timeZone: input.timeZone,
        notes: 'Credit card invoice payment refund',
        paid: true,
        invoiceId: invoice.id,
        clientMutationId: input.clientMutationId,
      },
    });
    await tx.invoicePayment.update({
      where: { id: payment.id },
      data: { refundedAt: now, refundTransactionId: refundTransaction.id },
    });
    const remaining = await tx.invoicePayment.aggregate({
      where: { invoiceId: invoice.id, refundedAt: null },
      _sum: { amount: true },
    });
    const paid = remaining._sum.amount ?? new Prisma.Decimal(0);
    const nextStatus = paid.greaterThanOrEqualTo(invoice.totalAmount) ? InvoiceStatus.PAID : InvoiceStatus.CLOSED;
    const nextVersion = input.expectedVersion + 1;
    const updatedInvoice = await tx.creditCardInvoice.updateMany({
      where: { id: invoice.id, householdId, version: input.expectedVersion },
      data: {
        status: nextStatus,
        version: { increment: 1 },
        ...(nextStatus === InvoiceStatus.CLOSED ? { paidAt: null } : {}),
      },
    });
    if (updatedInvoice.count !== 1) throw new VersionConflictError();
    const result = invoiceRefundResultSchema.parse({
      invoiceId: invoice.id,
      status: nextStatus,
      version: nextVersion,
      refundTransactionId: refundTransaction.id,
    });
    await saveMutationReceipt(tx, identity, 'invoice_refund', refundTransaction.id, result);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: refundTransaction.id,
      version: refundTransaction.version,
      payload: { id: refundTransaction.id, kind: 'transfer', amount: amountDto(amount, currency), fromAccountId: card.id, toAccountId: source.id, invoiceId: invoice.id, clientMutationId: input.clientMutationId },
    });
    await appendSyncChange(tx, { householdId, entityType: 'invoice', entityId: invoice.id, version: nextVersion, payload: result });
    await appendSyncChange(tx, {
      householdId,
      entityType: 'account',
      entityId: source.id,
      version: sourceUpdated.version,
      payload: accountChangePayload(source.id, sourceUpdated.version, currency, sourceUpdated.balance, sourceUpdated.availableBalance, sourceUpdated.totalBalance),
    });
    await appendSyncChange(tx, {
      householdId,
      entityType: 'account',
      entityId: card.id,
      version: cardUpdated.version,
      payload: accountChangePayload(card.id, cardUpdated.version, currency, cardUpdated.balance, cardUpdated.availableBalance, cardUpdated.totalBalance),
    });
    return result;
  });
}
