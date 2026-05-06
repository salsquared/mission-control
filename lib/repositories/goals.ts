import { prisma } from '@/lib/prisma';
import type { LifeGoal } from '@prisma/client';

export interface GoalCreate {
    text: string;
    estimatedTime?: string | null;
}

export interface GoalUpdate {
    text?: string;
    estimatedTime?: string | null;
    completed?: boolean;
}

export function findAllGoals(): Promise<LifeGoal[]> {
    return prisma.lifeGoal.findMany({ orderBy: [{ createdAt: 'asc' }] });
}

export function createGoal(data: GoalCreate): Promise<LifeGoal> {
    return prisma.lifeGoal.create({ data });
}

export function updateGoal(id: string, data: GoalUpdate): Promise<LifeGoal> {
    return prisma.lifeGoal.update({ where: { id }, data });
}

export function deleteGoal(id: string): Promise<LifeGoal> {
    return prisma.lifeGoal.delete({ where: { id } });
}
