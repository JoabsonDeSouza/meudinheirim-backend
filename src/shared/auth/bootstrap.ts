import { getOrCreatePersonalHousehold } from '../../modules/households/households.service.js';
import { getUserByFirebaseUid } from '../middleware/authorization.middleware.js';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly householdId: string;
}

/**
 * Ensures a database user and the user's personal household exist.
 * Called on first authenticated request of a Firebase identity.
 * Must be idempotent: repeated and concurrent calls create at most one of each.
 */
export async function bootstrapAuthenticatedUser(
  firebaseUid: string,
  email: string,
): Promise<AuthenticatedUser> {
  const user = await getUserByFirebaseUid(firebaseUid, email);
  const household = await getOrCreatePersonalHousehold(user.id, email);
  return {
    userId: user.id,
    householdId: household.id,
  };
}
