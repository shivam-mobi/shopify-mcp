import crypto from "crypto";
import { createCookieSessionStorage, redirect } from "react-router";
import prisma from "../db.server.js";

// Dedicated session cookie for the admin panel
const sessionSecret = process.env.ADMIN_SESSION_SECRET || "perfumania-admin-secret-2026-key-9912";

export const adminStorage = createCookieSessionStorage({
  cookie: {
    name: "__perfumania_admin_session",
    secure: process.env.NODE_ENV === "production",
    secrets: [sessionSecret],
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
});

/**
 * Hash password using Node native crypto scrypt with unique salt
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify password against stored salt:hash
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, key] = storedHash.split(":");
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

let tableChecked = false;

/**
 * Ensures the adminUsers table exists in the database.
 */
export async function ensureAdminTableExists() {
  if (tableChecked) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS \`adminUsers\` (
        \`id\` VARCHAR(191) NOT NULL PRIMARY KEY,
        \`email\` VARCHAR(191) NOT NULL UNIQUE,
        \`password_hash\` VARCHAR(191) NOT NULL,
        \`name\` VARCHAR(191) NULL,
        \`role\` VARCHAR(191) NOT NULL DEFAULT 'admin',
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      );
    `);
    tableChecked = true;
  } catch (err) {
    tableChecked = true;
  }
}

let adminAccountsChecked = false;

/**
 * Ensures admin accounts exist so the user can log in out-of-the-box.
 * Seeds both admin@yopmail.com and admin@perfumania.com.
 */
export async function seedDefaultAdminIfNone() {
  if (adminAccountsChecked) return;
  try {
    await ensureAdminTableExists();

    const accounts = [
      {
        email: "admin@yopmail.com",
        password: "Mobikasa@123",
        name: "Mobikasa Admin",
      },
      {
        email: "admin@perfumania.com",
        password: "perfumania2026!",
        name: "Perfumania Admin",
      },
    ];

    for (const acc of accounts) {
      try {
        const existing = await prisma.adminUser.findUnique({
          where: { email: acc.email },
        });
        if (!existing) {
          await prisma.adminUser.create({
            data: {
              email: acc.email,
              passwordHash: hashPassword(acc.password),
              name: acc.name,
              role: "admin",
            },
          });
          console.log(`[AdminAuth] Seeded admin account: ${acc.email}`);
        }
      } catch (innerErr) {
        console.warn(`[AdminAuth] Notice checking/seeding ${acc.email}:`, innerErr?.message || innerErr);
      }
    }
    adminAccountsChecked = true;
  } catch (err) {
    console.error("[AdminAuth] Error checking/seeding default admin:", err);
  }
}

/**
 * Get the current admin session from cookie
 */
export async function getAdminSession(request) {
  const cookieHeader = request.headers.get("Cookie");
  return adminStorage.getSession(cookieHeader);
}

/**
 * Get current logged in admin user or null
 */
export async function getAdminUser(request) {
  const session = await getAdminSession(request);
  const userId = session.get("adminUserId");
  if (!userId) return null;

  try {
    const user = await prisma.adminUser.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    return user;
  } catch {
    return null;
  }
}

/**
 * Require admin authentication or redirect to /admin/login
 */
export async function requireAdminUser(request) {
  await seedDefaultAdminIfNone();

  const user = await getAdminUser(request);
  if (!user) {
    const url = new URL(request.url);
    const returnTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/admin/login?returnTo=${returnTo}`);
  }
  return user;
}

/**
 * Authenticate credentials and return AdminUser or null
 */
export async function authenticateAdmin(email, password) {
  if (!email || !password) return null;
  try {
    await seedDefaultAdminIfNone();

    const normalizedEmail = email.toLowerCase().trim();
    const user = await prisma.adminUser.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) return null;
    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) return null;

    return { id: user.id, email: user.email, name: user.name, role: user.role };
  } catch (err) {
    console.error("[AdminAuth] Error authenticating admin user:", err);
    throw err;
  }
}

/**
 * Create session and redirect to target URL
 */
export async function createAdminUserSession(userId, redirectTo = "/admin") {
  const session = await adminStorage.getSession();
  session.set("adminUserId", userId);
  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await adminStorage.commitSession(session),
    },
  });
}

/**
 * Destroy admin session and redirect to /admin/login
 */
export async function logoutAdmin(request) {
  const session = await getAdminSession(request);
  return redirect("/admin/login", {
    headers: {
      "Set-Cookie": await adminStorage.destroySession(session),
    },
  });
}
