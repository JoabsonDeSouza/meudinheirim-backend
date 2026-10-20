import type { AccountType as Prisma_AccountType } from '../../generated/prisma/enums.js';
import type { RecurrenceFrequency as Prisma_RecurrenceFrequency } from '../../generated/prisma/enums.js';
import type { TransactionType as Prisma_TransactionType } from '../../generated/prisma/enums.js';

import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import { isCategoryOfType, CategoryType, AccountType, TransactionType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { updateBalanceForNormalTransaction, recalculateCreditCardLimit } from '../../shared/services/balance.service.js';
import { calculateNextRunDate } from './recurrence-date.js';
import { currencySchema } from '../../shared/money/index.js';
import { getOrCreateInvoiceForTransaction } from '../credit-cards/domain/invoice-cycle.js';
import type {
  CreateRecurringTransactionInput,
  UpdateRecurringTransactionInput,
  ListRecurringTransactionsQuery,
  ExecuteRecurringTransactionInput,
} from './recurring-transactions.schema.js';

/**
 * Calculate next run date based on frequency
 */
/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Criar uma recorrência NÃO cria transações antecipadamente.
 * Recorrências são apenas REGRAS de geração futura.
 * 
 * Transações reais são criadas APENAS pelo cronjob no dia do vencimento.
 * Isso garante que:
 * - Limite de cartão NÃO é consumido antecipadamente
 * - Saldos NÃO são afetados até a data de vencimento
 * - Sistema financeiro permanece previsível e consistente
 * 
 * Create a new recurring transaction (rule only, no transactions created)
 */
export async function createRecurringTransaction(
  input: CreateRecurringTransactionInput
): Promise<{ amount: number; account: { id: string; name: string; type: Prisma_AccountType; }; id: string; isActive: boolean; createdAt: Date; updatedAt: Date; householdId: string; description: string | null; categoryName: string; accountId: string; startDate: Date; endDate: Date | null; frequency: Prisma_RecurrenceFrequency; nextRunAt: Date; lastRunDate: Date | null; }> {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const {
    accountId,
    categoryName,
    amount,
    description,
    frequency,
    startDate,
    endDate,
    nextRunAt,
    isActive,
  } = input;

  // Verify account belongs to household
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  // Validate custom category exists and belongs to household
  if (isCustomCategoryName(categoryName)) {
    const customId = toCustomCategoryId(categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
  }

  const recurring = await prisma.recurringTransaction.create({
    data: {
      householdId,
      accountId,
      categoryName,
      amount: new Prisma.Decimal(amount),
      description,
      frequency,
      startDate,
      endDate,
      nextRunAt,
      isActive,
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  // REGRA DE NEGÓCIO: Edge case de timing
  // Se a recorrência foi criada com nextRunAt = hoje (ou no passado) e startDate <= hoje,
  // processar imediatamente para não esperar até o próximo cronjob
  // Isso resolve o caso onde o usuário cria uma recorrência depois do horário do cronjob (01:00)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextRunAtDate = new Date(nextRunAt);
  nextRunAtDate.setHours(0, 0, 0, 0);
  
  const startDateNormalized = new Date(startDate);
  startDateNormalized.setHours(0, 0, 0, 0);
  
  const shouldProcessImmediately = 
    isActive && 
    nextRunAtDate <= today && 
    startDateNormalized <= today;

  if (shouldProcessImmediately) {
    try {
      // Verificar se já existe transação para hoje (idempotência)
      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          date: today,
        },
      });

      if (!existingTransaction) {
        // Processar imediatamente
        const isCreditCard = account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        await executeRecurringTransaction(recurring.id, householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        console.log('[RecurringTransaction] Immediate occurrence processed');
      }
    } catch (error) {
      // Não falhar a criação da recorrência se o processamento imediato falhar
      // Log do erro mas continua
      console.error('[RecurringTransaction] Immediate occurrence failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...recurring,
    amount: recurring.amount.toNumber(),
  };
}

/**
 * Get recurring transaction by ID
 */
export async function getRecurringTransaction(recurringId: string): Promise<{ amount: number; account: { id: string; name: string; type: Prisma_AccountType; }; id: string; isActive: boolean; createdAt: Date; updatedAt: Date; householdId: string; description: string | null; categoryName: string; accountId: string; startDate: Date; endDate: Date | null; frequency: Prisma_RecurrenceFrequency; nextRunAt: Date; lastRunDate: Date | null; }> {
  const recurring = await prisma.recurringTransaction.findUnique({
    where: { id: recurringId },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...recurring,
    amount: recurring.amount.toNumber(),
  };
}

/**
 * List recurring transactions for a household
 */
export async function listRecurringTransactions(
  query: ListRecurringTransactionsQuery
): Promise<{ amount: number; account: { id: string; name: string; type: Prisma_AccountType; }; id: string; isActive: boolean; createdAt: Date; updatedAt: Date; householdId: string; description: string | null; categoryName: string; accountId: string; startDate: Date; endDate: Date | null; frequency: Prisma_RecurrenceFrequency; nextRunAt: Date; lastRunDate: Date | null; }[]> {
  const { householdId, isActive } = query;

  const recurring = await prisma.recurringTransaction.findMany({
    where: {
      householdId,
      ...(isActive !== undefined && { isActive }),
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return recurring.map(r => ({
    ...r,
    amount: r.amount.toNumber(),
  }));
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Atualizar uma recorrência NÃO cria transações antecipadamente.
 * Apenas atualiza a REGRA de recorrência.
 * 
 * Transações reais continuam sendo criadas apenas pelo cronjob no dia do vencimento.
 * 
 * Update recurring transaction (rule only, no transactions created)
 */
export async function updateRecurringTransaction(
  recurringId: string,
  householdId: string,
  input: UpdateRecurringTransactionInput
): Promise<{ amount: number; account: { id: string; name: string; type: Prisma_AccountType; }; id: string; isActive: boolean; createdAt: Date; updatedAt: Date; householdId: string; description: string | null; categoryName: string; accountId: string; startDate: Date; endDate: Date | null; frequency: Prisma_RecurrenceFrequency; nextRunAt: Date; lastRunDate: Date | null; }> {
  const existing = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
  });

  if (!existing) {
    throw new NotFoundError('Recurring transaction');
  }

  // Validate new account if provided
  if (input.accountId && input.accountId !== existing.accountId) {
    const account = await prisma.account.findFirst({
      where: { id: input.accountId, householdId, isActive: true },
    });
    if (!account) {
      throw new NotFoundError('Account');
    }
  }

  // Validate custom category exists when updating categoryName
  if (input.categoryName && isCustomCategoryName(input.categoryName)) {
    const customId = toCustomCategoryId(input.categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
  }

  const recurring = await prisma.recurringTransaction.update({
    where: { id: recurringId },
    data: {
      ...(input.accountId && { accountId: input.accountId }),
      ...(input.categoryName && { categoryName: input.categoryName }),
      ...(input.amount !== undefined && { amount: new Prisma.Decimal(input.amount) }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.frequency && { frequency: input.frequency }),
      ...(input.startDate && { startDate: input.startDate }),
      ...(input.endDate !== undefined && { endDate: input.endDate }),
      ...(input.nextRunAt && { nextRunAt: input.nextRunAt }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  // REGRA DE NEGÓCIO: Edge case de timing
  // Se a recorrência foi atualizada com nextRunAt = hoje (ou no passado) e startDate <= hoje,
  // processar imediatamente para não esperar até o próximo cronjob
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextRunAtDate = new Date(recurring.nextRunAt);
  nextRunAtDate.setHours(0, 0, 0, 0);
  
  const startDateNormalized = new Date(recurring.startDate);
  startDateNormalized.setHours(0, 0, 0, 0);
  
  const shouldProcessImmediately = 
    recurring.isActive && 
    nextRunAtDate <= today && 
    startDateNormalized <= today;

  if (shouldProcessImmediately) {
    try {
      // Verificar se já existe transação para hoje (idempotência)
      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          date: today,
        },
      });

      if (!existingTransaction) {
        // Processar imediatamente
        const isCreditCard = recurring.account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        await executeRecurringTransaction(recurring.id, householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        console.log('[RecurringTransaction] Immediate occurrence processed after update');
      }
    } catch (error) {
      // Não falhar a atualização da recorrência se o processamento imediato falhar
      // Log do erro mas continua
      console.error('[RecurringTransaction] Immediate occurrence after update failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...recurring,
    amount: recurring.amount.toNumber(),
  };
}

/**
 * Delete recurring transaction
 */
export async function deleteRecurringTransaction(
  recurringId: string,
  householdId: string
): Promise<{ deleted: boolean; }> {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  await prisma.recurringTransaction.delete({
    where: { id: recurringId },
  });

  return { deleted: true };
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Esta função é chamada APENAS pelo cronjob no dia do vencimento.
 * 
 * Cria uma transação REAL:
 * - Para cartão de crédito: paid: true (consome limite imediatamente)
 * - Para conta bancária: paid: false (pendente para revisão)
 * 
 * Atualiza lastRunDate e nextRunAt.
 * NÃO deve ser chamada manualmente pelo usuário.
 */
export async function executeRecurringTransaction(
  recurringId: string,
  householdId: string,
  input: ExecuteRecurringTransactionInput = {}
): Promise<{ transaction: { account: { id: string; name: string; type: Prisma_AccountType; } | null; } & { id: string; type: Prisma_TransactionType; createdAt: Date; updatedAt: Date; householdId: string; amount: Prisma.Decimal; fromAccountId: string | null; toAccountId: string | null; description: string | null; categoryName: string | null; date: Date; notes: string | null; paid: boolean; installmentId: string | null; installmentNumber: number | null; totalInstallments: number | null; attachmentUrl: string | null; isSplit: boolean; accountId: string | null; relatedEntityId: string | null; recurringTransactionId: string | null; }; nextRunAt: Date; }> {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId, isActive: true },
    include: {
      account: true,
    },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  const requestedDate = input.date || recurring.nextRunAt;
  const transactionDate = new Date(`${requestedDate.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const occurrenceDateKey = transactionDate.toISOString().slice(0, 10);
  const isPaid = input.paid ?? false; // Default: false (pendente)

  let isIncome: boolean;
  if (isCustomCategoryName(recurring.categoryName)) {
    const cat = await prisma.category.findFirst({
      where: { id: toCustomCategoryId(recurring.categoryName)!, householdId },
      select: { type: true },
    });
    isIncome = cat?.type === CategoryType.INCOME;
  } else {
    isIncome = isCategoryOfType(CategoryType.INCOME, recurring.categoryName);
  }

  function calculateBalanceChange(amount: Prisma.Decimal, isInc: boolean, accountType: string): Prisma.Decimal {
    const isCreditCard = accountType === AccountType.CREDIT;
    if (isCreditCard) return isInc ? amount.negated() : amount;
    return isInc ? amount : amount.negated();
  }

  // Determine transaction type
  const transactionType = isIncome ? TransactionType.INCOME : TransactionType.EXPENSE;

  // Create the actual transaction and update next run date
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring-occurrence:${recurring.id}:${occurrenceDateKey}`}))`;

    const existingOccurrence = await tx.recurringOccurrence.findUnique({
      where: {
        recurringTransactionId_occurrenceDate: {
          recurringTransactionId: recurring.id,
          occurrenceDate: transactionDate,
        },
      },
    });
    if (existingOccurrence) {
      const existingTransaction = await tx.transaction.findUnique({
        where: { id: existingOccurrence.transactionId },
        include: { account: { select: { id: true, name: true, type: true } } },
      });
      if (existingTransaction) {
        const currentRecurring = await tx.recurringTransaction.findUnique({ where: { id: recurring.id } });
        return { transaction: existingTransaction, nextRunAt: currentRecurring?.nextRunAt ?? recurring.nextRunAt };
      }
    }

    const invoiceId = recurring.account.type === AccountType.CREDIT
      ? await getOrCreateInvoiceForTransaction(tx, {
          householdId: recurring.account.householdId,
          cardAccountId: recurring.account.id,
          currency: currencySchema.parse(recurring.account.currency),
          closingDay: recurring.account.closingDay,
          dueDay: recurring.account.dueDay,
          occurredAt: transactionDate,
          timeZone: recurring.timeZone,
          amount: recurring.amount,
          transactionType: transactionType === TransactionType.INCOME ? 'INCOME' : 'EXPENSE',
        })
      : null;

    // Create transaction
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: transactionType,
        accountId: recurring.accountId,
        categoryName: recurring.categoryName,
        amount: recurring.amount,
        description: recurring.description || `Recurring: ${recurring.categoryName}`,
        date: transactionDate,
        occurredAt: transactionDate,
        timeZone: recurring.timeZone,
        invoiceId,
        notes: `Auto-generated from recurring transaction: ${recurring.id} on ${new Date().toISOString()}`,
        paid: isPaid,
        recurringTransactionId: recurring.id,
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    await tx.recurringOccurrence.create({
      data: {
        recurringTransactionId: recurring.id,
        occurrenceDate: transactionDate,
        transactionId: transaction.id,
      },
    });

    // REGRA DE NEGÓCIO: Atualizar saldo APENAS se paid: true
    // Para cartão de crédito: consome limite imediatamente
    // Para conta bancária: saldo só é atualizado quando confirmada
    if (isPaid && recurring.account) {
      const amount = recurring.amount;
      const balanceChange = calculateBalanceChange(amount, isIncome, recurring.account.type);
      
      // Use centralized balance update function to ensure consistency
      await updateBalanceForNormalTransaction(tx, recurring.accountId, balanceChange);
      
      // Recalculate credit card limit if it's a credit card
      if (recurring.account.type === AccountType.CREDIT) {
        await recalculateCreditCardLimit(tx, recurring.accountId);
      }
    }

    // Calculate and update next run date
    const nextRunAt = calculateNextRunDate(transactionDate, recurring.frequency);

    // Update lastRunDate and nextRunAt
    await tx.recurringTransaction.update({
      where: { id: recurringId },
      data: { 
        lastRunDate: transactionDate,
        nextRunAt,
      },
    });

    return {
      transaction,
      nextRunAt,
    };
  });

  return result;
}

/**
 * Get recurring transactions that are due (nextRunAt <= today)
 */
export async function getDueRecurringTransactions(householdId: string): Promise<({ account: { id: string; name: string; type: Prisma_AccountType; }; } & { id: string; isActive: boolean; createdAt: Date; updatedAt: Date; householdId: string; amount: Prisma.Decimal; description: string | null; categoryName: string; accountId: string; startDate: Date; endDate: Date | null; frequency: Prisma_RecurrenceFrequency; nextRunAt: Date; lastRunDate: Date | null; })[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = await prisma.recurringTransaction.findMany({
    where: {
      householdId,
      isActive: true,
      nextRunAt: {
        lte: today,
      },
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
  });

  return due;
}
