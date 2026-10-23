import { useRef, useEffect } from "react";
import { Form, useActionData, useNavigation, useSearchParams, redirect } from "react-router";
import { getAdminUser, authenticateAdmin, createAdminUserSession, seedDefaultAdminIfNone } from "../admin/auth.server";

export const loader = async ({ request }) => {
  try {
    await seedDefaultAdminIfNone();
    const user = await getAdminUser(request);
    if (user) {
      return redirect("/admin");
    }
  } catch (err) {
    console.warn("[AdminLogin] Loader warning:", err?.message || err);
  }
  return null;
};

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();
    const email = formData.get("email");
    const password = formData.get("password");
    const returnTo = formData.get("returnTo") || "/admin";

    if (!email || !password) {
      return { error: "Please enter both email and password." };
    }

    const user = await authenticateAdmin(String(email), String(password));
    if (!user) {
      return { error: "Invalid email or password. Please verify credentials." };
    }

    return createAdminUserSession(user.id, String(returnTo));
  } catch (err) {
    console.error("[AdminLogin] Action login failure:", err);
    return {
      error: `Login error: ${err?.message || "Internal database connection failure"}. Please check server database.`,
    };
  }
};

export default function AdminLoginRoute() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = navigation.state === "submitting";
  const returnTo = searchParams.get("returnTo") || "/admin";
  const emailInputRef = useRef(null);

  // Client-side focus to eliminate SSR autofocus hydration mismatch (#418)
  useEffect(() => {
    if (emailInputRef.current) {
      emailInputRef.current.focus();
    }
  }, []);

  return (
    <div className="login-container">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            className="brand-icon"
            style={{ width: 48, height: 48, fontSize: "1.2rem", margin: "0 auto 14px auto" }}
          >
            PM
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--text-main)", letterSpacing: "-0.02em" }}>
            Perfumania Admin
          </h1>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 6 }}>
            Sign in to manage customers, carts, logs & conversations
          </p>
        </div>

        {actionData?.error && (
          <div
            style={{
              padding: "10px 14px",
              background: "rgba(244, 63, 94, 0.12)",
              border: "1px solid rgba(244, 63, 94, 0.3)",
              borderRadius: "var(--radius-sm)",
              color: "var(--accent-rose)",
              fontSize: "0.85rem",
              marginBottom: 20,
              fontWeight: 500,
            }}
          >
            {actionData.error}
          </div>
        )}

        <Form method="post">
          <input type="hidden" name="returnTo" value={returnTo} suppressHydrationWarning />

          <div className="form-group">
            <label className="form-label" htmlFor="email">
              Email Address
            </label>
            <input
              ref={emailInputRef}
              id="email"
              type="email"
              name="email"
              required
              autoComplete="username"
              defaultValue="admin@yopmail.com"
              className="form-input"
              placeholder="admin@yopmail.com"
              suppressHydrationWarning
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              name="password"
              required
              autoComplete="current-password"
              defaultValue="Mobikasa@123"
              className="form-input"
              placeholder="••••••••••••"
              suppressHydrationWarning
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="submit-btn"
            style={{ marginTop: 10 }}
          >
            {isSubmitting ? "Signing in..." : "Sign In to Admin"}
          </button>
        </Form>
      </div>
    </div>
  );
}
