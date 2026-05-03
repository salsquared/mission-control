import { z } from 'zod';

export const PubSubEnvelopeSchema = z.object({
    message: z.object({
        data: z.string(),
        messageId: z.string().optional(),
        publishTime: z.string().optional(),
    }),
    subscription: z.string().optional(),
});

export const PubSubPayloadSchema = z.object({
    emailAddress: z.string().email(),
    historyId: z.union([z.string(), z.number()]),
});
