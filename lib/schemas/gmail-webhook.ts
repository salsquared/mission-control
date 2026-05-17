import { z } from 'zod';

// PB-6: messageId is REQUIRED. We dedupe Pub/Sub redeliveries on it before any
// side-effect runs. Pub/Sub always populates this field; treating it as
// optional was leaving the door open to redelivery storms.
export const PubSubEnvelopeSchema = z.object({
    message: z.object({
        data: z.string(),
        messageId: z.string().min(1),
        publishTime: z.string().optional(),
    }),
    subscription: z.string().optional(),
});

export const PubSubPayloadSchema = z.object({
    emailAddress: z.string().email(),
    historyId: z.union([z.string(), z.number()]),
});
