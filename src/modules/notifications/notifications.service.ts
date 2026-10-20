import type { NotificationType as Prisma_NotificationType } from '../../generated/prisma/enums.js';
import type { NotificationStatus as Prisma_NotificationStatus } from '../../generated/prisma/enums.js';

import { prisma } from '../../shared/db/prisma.js';
import { type Prisma } from '../../generated/prisma/client.js';
import { NotificationType, NotificationStatus, type ListNotificationsQuery, type UpdateNotificationStatusInput } from './notifications.schema.js';
import { NotFoundError } from '../../shared/errors/index.js';

/**
 * Create a notification for a user
 * This is a generic function that can create notifications of any type
 */
export async function createNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  deepLink?: string;
  expiresAt?: Date;
}): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const { userId, type, title, message, metadata, deepLink, expiresAt } = params;

  return await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      message,
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
      deepLink: deepLink || null,
      expiresAt: expiresAt || null,
      status: NotificationStatus.UNREAD,
    },
  });
}

/**
 * Create a notification for a household invite
 * This is a helper function that creates a notification from a HouseholdInvite
 */
export async function createHouseholdInviteNotification(params: {
  inviteId: string;
  inviteeId: string;
  householdId: string;
  householdName: string;
  inviterName: string;
  role: string;
  expiresAt: Date;
}): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const { inviteId, inviteeId, householdId, householdName, inviterName, role, expiresAt } = params;

  const roleLabel = role === 'EDITOR' ? 'Editor' : 'Visualizador';
  const title = `Convite para ${householdName}`;
  const message = `${inviterName} convidou você para participar da household "${householdName}" como ${roleLabel}`;
  const deepLink = `/app/notifications?inviteId=${inviteId}`;

  return await createNotification({
    userId: inviteeId,
    type: NotificationType.HOUSEHOLD_INVITE,
    title,
    message,
    metadata: {
      inviteId,
      householdId,
      householdName,
      inviterName,
      role,
    },
    deepLink,
    expiresAt,
  });
}

/**
 * Get all notifications for a user
 */
export async function getUserNotifications(userId: string, query: ListNotificationsQuery): Promise<{ items: { id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }[]; pagination: { hasMore: boolean; nextCursor: string | null; }; }> {
  const { status, type, limit, cursor } = query;

  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(status && { status }),
    ...(type && { type }),
    ...(cursor && {
      id: {
        lt: cursor, // Cursor-based pagination (assuming descending order by createdAt)
      },
    }),
    // Filter out expired notifications
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } },
    ],
  };

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
    take: limit + 1, // Take one extra to check if there are more
  });

  const hasMore = notifications.length > limit;
  const items = hasMore ? notifications.slice(0, limit) : notifications;
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

  return {
    items,
    pagination: {
      hasMore,
      nextCursor,
    },
  };
}

/**
 * Get a single notification by ID
 */
export async function getNotification(notificationId: string, userId: string): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      userId, // Ensure user can only access their own notifications
    },
  });

  if (!notification) {
    throw new NotFoundError('Notification not found');
  }

  return notification;
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(notificationId: string, userId: string): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const notification = await getNotification(notificationId, userId);

  if (notification.status === NotificationStatus.READ) {
    return notification; // Already read
  }

  return await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: NotificationStatus.READ,
      readAt: new Date(),
    },
  });
}

/**
 * Mark notification as unread
 */
export async function markNotificationAsUnread(notificationId: string, userId: string): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const notification = await getNotification(notificationId, userId);

  if (notification.status === NotificationStatus.UNREAD) {
    return notification; // Already unread
  }

  return await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: NotificationStatus.UNREAD,
      readAt: null,
    },
  });
}

/**
 * Archive notification
 */
export async function archiveNotification(notificationId: string, userId: string): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const notification = await getNotification(notificationId, userId);

  if (notification.status === NotificationStatus.ARCHIVED) {
    return notification; // Already archived
  }

  return await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: NotificationStatus.ARCHIVED,
      archivedAt: new Date(),
    },
  });
}

/**
 * Update notification status (generic)
 */
export async function updateNotificationStatus(
  notificationId: string,
  userId: string,
  input: UpdateNotificationStatusInput
): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  const { status } = input;

  await getNotification(notificationId, userId); // Ensure notification exists and belongs to user

  const updateData: Prisma.NotificationUpdateInput = {
    status,
  };

  if (status === NotificationStatus.READ) {
    updateData.readAt = new Date();
  } else if (status === NotificationStatus.ARCHIVED) {
    updateData.archivedAt = new Date();
  } else if (status === NotificationStatus.UNREAD) {
    updateData.readAt = null;
    updateData.archivedAt = null;
  }

  return await prisma.notification.update({
    where: { id: notificationId },
    data: updateData,
  });
}

/**
 * Get unread notification count for a user
 */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  const count = await prisma.notification.count({
    where: {
      userId,
      status: NotificationStatus.UNREAD,
      // Filter out expired notifications
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
  });

  return count;
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsRead(userId: string): Promise<Prisma.BatchPayload> {
  return await prisma.notification.updateMany({
    where: {
      userId,
      status: NotificationStatus.UNREAD,
    },
    data: {
      status: NotificationStatus.READ,
      readAt: new Date(),
    },
  });
}

/**
 * Delete notification (soft delete by archiving)
 */
export async function deleteNotification(notificationId: string, userId: string): Promise<{ id: string; type: Prisma_NotificationType; status: Prisma_NotificationStatus; createdAt: Date; updatedAt: Date; message: string; userId: string; expiresAt: Date | null; title: string; metadata: Prisma.JsonValue | null; deepLink: string | null; readAt: Date | null; archivedAt: Date | null; }> {
  return await archiveNotification(notificationId, userId);
}

/**
 * Clean up expired notifications (can be called by a cron job)
 */
export async function cleanupExpiredNotifications(): Promise<Prisma.BatchPayload> {
  const result = await prisma.notification.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
      // Only delete if status is not READ (keep read notifications for history)
      status: {
        not: NotificationStatus.READ,
      },
    },
  });

  return result;
}
