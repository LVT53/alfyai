import { z } from "zod";

export const boschHostedGrants = ["details", "fitness", "location"] as const;
export type BoschHostedGrant = (typeof boschHostedGrants)[number];

export type BoschHostedSetup = {
	mode: "none" | "helper" | "hosted";
	grants: BoschHostedGrant[];
	callbackUrl: string;
};

export const boschHostedGrantsSchema = z
	.array(z.enum(boschHostedGrants))
	.max(boschHostedGrants.length)
	.refine((grants) => new Set(grants).size === grants.length);
export const boschHostedPermissionsSchema = z.strictObject({
	grants: boschHostedGrantsSchema,
});
export const boschHostedStartSchema = boschHostedPermissionsSchema.extend({
	clientId: z.string().trim().min(1).max(512),
	clientSecret: z.string().max(4096).optional(),
});
export type BoschHostedStart = z.infer<typeof boschHostedStartSchema>;
