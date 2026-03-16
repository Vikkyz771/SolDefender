/**
 * User middleware - ensures user exists and attaches user data to context
 */

import { Context, MiddlewareFn } from "grammy";
import { userExists, createUser, getUser, User } from "../../database/users.js";
import { getSettings, UserSettings } from "../../database/settings.js";
import { generateWallet } from "../../utils/wallet.js";
import { registerUser } from "../../autosell/index.js";

/**
 * Extended context with user data
 */
export interface UserContext extends Context {
    user: User;
    settings: UserSettings;
}

/**
 * Middleware that ensures a user exists for every interaction
 * Creates user with new wallet on first contact
 */
export function userMiddleware(): MiddlewareFn<UserContext> {
    return async (ctx, next) => {
        // Get Telegram user ID
        const telegramId = ctx.from?.id;

        if (!telegramId) {
            console.warn("⚠️ No user ID in context");
            return next();
        }

        // Check if user exists, create if not
        if (!userExists(telegramId)) {
            console.log(`🆕 New user detected: ${telegramId}`);

            // Generate a new wallet for the user
            const { address, encryptedPrivateKey } = generateWallet();

            // Create user in database
            createUser(telegramId, address, encryptedPrivateKey);

            console.log(`✅ Created user ${telegramId} with wallet ${address.slice(0, 8)}...`);

            // Register user with autosell monitor (async, don't block)
            registerUser(telegramId).catch(err =>
                console.error(`❌ Failed to register user ${telegramId} for autosell:`, err)
            );
        }

        // Attach user data to context
        const user = getUser(telegramId);
        const settings = getSettings(telegramId);

        if (user) {
            ctx.user = user;
            ctx.settings = settings;
        }

        return next();
    };
}

/**
 * Helper to get user from context (with type guard)
 */
export function getUserFromContext(ctx: Context): User | null {
    return (ctx as UserContext).user || null;
}

/**
 * Helper to get settings from context (with type guard)
 */
export function getSettingsFromContext(ctx: Context): UserSettings | null {
    return (ctx as UserContext).settings || null;
}
