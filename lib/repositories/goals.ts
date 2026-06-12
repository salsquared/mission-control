import { prisma } from '@/lib/prisma';
import type { LifeGoal } from '@prisma/client';

// P2.2 (OQ2a): userId-scoped — see lib/repositories/tasks.ts for the pattern.

export interface GoalCreate {
    text: string;
    estimatedTime?: string | null;
}

export interface GoalUpdate {
    text?: string;
    estimatedTime?: string | null;
    completed?: boolean;
}

export function findAllGoals(userId: string): Promise<LifeGoal[]> {
    return prisma.lifeGoal.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }] });
}

export function createGoal(userId: string, data: GoalCreate): Promise<LifeGoal> {
    return prisma.lifeGoal.create({ data: { ...data, userId } });
}

export function updateGoal(id: string, userId: string, data: GoalUpdate): Promise<LifeGoal> {
    return prisma.lifeGoal.update({ where: { id, userId }, data });
}

export function deleteGoal(id: string, userId: string): Promise<LifeGoal> {
    return prisma.lifeGoal.delete({ where: { id, userId } });
}
