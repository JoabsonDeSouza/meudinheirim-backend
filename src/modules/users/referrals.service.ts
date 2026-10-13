import { prisma } from '../../shared/db/prisma.js';

/**
 * Process referral code when a new user signs up
 * Returns the referrer user ID if valid, null otherwise
 */
export async function processReferralCode(
  referralCode: string,
  newUserId: string
): Promise<string | null> {
  if (!referralCode || !referralCode.trim()) {
    console.log(`[Referral] Empty referral code provided for user ${newUserId}`);
    return null;
  }

  const code = referralCode.trim().toUpperCase();
  console.log(`[Referral] Processing referral code: ${code} for user: ${newUserId}`);

  // Find user by referral code
  const referrer = await prisma.user.findFirst({
    where: {
      referralCode: code,
    },
    select: {
      id: true,
    },
  });

  if (!referrer) {
    // Invalid referral code - silently ignore (don't fail signup)
    console.log(`[Referral] Referral code ${code} not found in database`);
    return null;
  }

  console.log(`[Referral] Found referrer: ${referrer.id} for code: ${code}`);

  // Don't allow self-referral
  if (referrer.id === newUserId) {
    console.log(`[Referral] Self-referral detected for user ${newUserId}, skipping`);
    return null;
  }

  // Check if referral already exists (prevent duplicates)
  const existingReferral = await prisma.referral.findUnique({
    where: {
      referredId: newUserId,
    },
  });

  if (existingReferral) {
    // Already referred - return existing referrer ID
    console.log(`[Referral] User ${newUserId} already has referral record from ${existingReferral.referrerId}`);
    return existingReferral.referrerId;
  }

  // Create referral record
  try {
    const referral = await prisma.referral.create({
      data: {
        referrerId: referrer.id,
        referredId: newUserId,
        referralCode: code,
      },
    });
    console.log(`[Referral] Successfully created referral record: ${referral.id} (${referrer.id} -> ${newUserId})`);
    return referrer.id;
  } catch (error) {
    console.error(`[Referral] Error creating referral record:`, error);
    throw error;
  }
}

/**
 * Get referral count for a user
 */
export async function getReferralCount(userId: string): Promise<number> {
  const count = await prisma.referral.count({
    where: {
      referrerId: userId,
    },
  });

  return count;
}
