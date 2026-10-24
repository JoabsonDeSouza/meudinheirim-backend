/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Este script é executado EXCLUSIVAMENTE pelo Cron Job nativo do Railway.
 * NÃO inicia servidor HTTP - apenas processa recorrências e encerra.
 * 
 * Fluxo:
 * 1. Busca recorrências ativas com nextRunAt <= hoje (usando índice otimizado)
 * 2. Para cada recorrência:
 *    - Garante idempotência (não cria duplicações)
 *    - Cria UMA transação correspondente ao período atual
 *    - Se cartão: cria confirmada (paid: true) e consome limite
 *    - Se conta: cria pendente (paid: false) para revisão
 *    - Atualiza lastRunDate e nextRunAt
 *    - Se nextRunAt > endDate: marca como inativa
 * 3. Loga recurrence_id + data processada
 * 4. Encerra processo
 */

// Load environment variables from .env file
import 'dotenv/config';

// Import env to validate environment variables (required for prisma)
// This will validate DATABASE_URL and other required variables
import '../shared/config/env.js';

import { prisma } from '../shared/db/prisma.js';
import { executeRecurringTransaction } from '../modules/recurring-transactions/recurring-transactions.service.js';
import { calculateNextRunDate } from '../modules/recurring-transactions/recurrence-date.js';

/**
 * Process all due recurring transactions
 */
async function processDueRecurringTransactions(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize to start of day

  console.log(`[CronJob] Starting processing at ${today.toISOString().split('T')[0]}`);

  try {
    // REGRA DE NEGÓCIO: Buscar APENAS recorrências com nextRunAt <= hoje
    // Usa índice otimizado em nextRunAt para performance
    const dueRecurring = await prisma.recurringTransaction.findMany({
      where: {
        isActive: true,
        nextRunAt: {
          lte: today, // nextRunAt is today or in the past
        },
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
      },
      orderBy: { nextRunAt: 'asc' },
    });

    if (dueRecurring.length === 0) {
      console.log(`[CronJob] No recurring transactions due on ${today.toISOString().split('T')[0]}`);
      return;
    }

    console.log(`[CronJob] Found ${dueRecurring.length} recurring transaction(s) due today`);

    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const recurring of dueRecurring) {
      try {
        // REGRA DE NEGÓCIO: Idempotência - verificar se transação já existe
        const existingTransaction = await prisma.transaction.findFirst({
          where: {
            householdId: recurring.householdId,
            recurringTransactionId: recurring.id,
            date: today,
          },
        });

        if (existingTransaction) {
          // Transaction already exists - skip (idempotent behavior)
          console.log(
            `[CronJob] ⏭️  Skipping recurring ${recurring.id} - transaction already exists for ${today.toISOString().split('T')[0]}`
          );
          skippedCount++;
          
          // Still update nextRunAt and lastRunDate to prevent reprocessing
          const nextRunAt = calculateNextRunDate(today, recurring.frequency, recurring.anchorDay);
          const occurrenceCount = await prisma.recurringOccurrence.count({
            where: { recurringTransactionId: recurring.id, occurrenceDate: { gte: recurring.effectiveFromDate } },
          });
          const limitReached = recurring.occurrencesLimit !== null
            && recurring.occurrencesCountOffset + occurrenceCount >= recurring.occurrencesLimit;
          const shouldDeactivate = limitReached || recurring.recurrenceMode === 'ONCE'
            || (recurring.endDate && nextRunAt > new Date(recurring.endDate));
          
          await prisma.recurringTransaction.update({
            where: { id: recurring.id },
            data: { 
              nextRunAt,
              lastRunDate: today,
              ...(shouldDeactivate && { isActive: false }),
            },
          });
          continue;
        }

        // Check if today is within the recurring period
        const startDate = new Date(recurring.startDate);
        startDate.setHours(0, 0, 0, 0);
        
        if (today < startDate) {
          // Not yet in the period - skip
          console.log(
            `[CronJob] ⏭️  Skipping recurring ${recurring.id} - startDate is ${startDate.toISOString().split('T')[0]}`
          );
          skippedCount++;
          continue;
        }

        // Scheduler execution creates the occurrence, but never represents payment.
        const result = await executeRecurringTransaction(recurring.id, recurring.householdId, {
          date: today,
          paid: false,
        });

        // Check if nextRunAt exceeds endDate
        const nextRunAt = result.nextRunAt;
          const occurrenceCount = await prisma.recurringOccurrence.count({
            where: { recurringTransactionId: recurring.id, occurrenceDate: { gte: recurring.effectiveFromDate } },
          });
          const limitReached = recurring.occurrencesLimit !== null
            && recurring.occurrencesCountOffset + occurrenceCount >= recurring.occurrencesLimit;
          const shouldDeactivate = limitReached || recurring.recurrenceMode === 'ONCE'
            || (recurring.endDate && nextRunAt > new Date(recurring.endDate));

        // Deactivate if needed (lastRunDate and nextRunAt already updated by executeRecurringTransaction)
        if (shouldDeactivate) {
          await prisma.recurringTransaction.update({
            where: { id: recurring.id },
            data: { isActive: false },
          });
        }

        processedCount++;
        console.log('[CronJob] Recurring transaction processed');
      } catch (error) {
        errorCount += 1;
        console.error('[CronJob] Recurring transaction failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }

    // Log summary
    console.log(
      `[CronJob] Processing finished. Processed: ${processedCount}, Skipped: ${skippedCount}`
    );
    if (errorCount > 0) {
      console.error('[CronJob] Recurring transaction failures', { errorCount });
    }
  } catch (error) {
    console.error('[CronJob] Fatal recurring transaction failure', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error; // Re-throw to exit with error code
  }
}

/**
 * Main entry point for Railway Cron Job
 * This script should be executed directly: node dist/jobs/processRecurrences.js
 */
async function main(): Promise<void> {
  try {
    console.log('[CronJob] Connecting to database...');
    // Database connection is handled by prisma client
    
    await processDueRecurringTransactions();
    
    console.log('[CronJob] ✅ Processing completed successfully');
  } catch (error) {
    console.error('[CronJob] Fatal error', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    process.exit(1);
  } finally {
    // Close database connection
    await prisma.$disconnect();
    console.log('[CronJob] Database connection closed');
    process.exit(0);
  }
}

// Execute if run directly (check if this is the main module)
// In ES modules, import.meta.url contains the file URL
// We check if this file is being executed directly (not imported)
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('processRecurrences')) {
  main();
}

// Export main function to be called when imported (for Railway cron service)
export { main as runCronJob };
