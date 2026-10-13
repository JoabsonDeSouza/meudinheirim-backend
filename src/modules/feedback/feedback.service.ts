import { prisma } from '../../shared/db/prisma.js';
import type { CreateFeedbackInput } from './feedback.schema.js';

/**
 * Create a new user feedback
 */
export async function createFeedback(input: CreateFeedbackInput, email: string): Promise<{ id: string; createdAt: Date; email: string; score: number; feedbackContent: string | null; }> {
  const feedback = await prisma.userFeedback.create({
    data: {
      email,
      score: input.score,
      feedbackContent: input.feedbackContent || null,
    },
  });

  return feedback;
}
