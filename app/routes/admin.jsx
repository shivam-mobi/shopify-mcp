import { useEffect } from "react";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { getAdminUser, requireAdminUser } from "../admin/auth.server";
import { AdminLayout } from "../admin/components/AdminLayout";
import adminStyles from "../admin/admin.css?url";

export const links = () => [
  { rel: "stylesheet", href: adminStyles },
];

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  // Allow login page to be accessed without prior authentication
  if (url.pathname === "/admin/login") {
    const user = await getAdminUser(request);
    return { user };
  }

  const user = await requireAdminUser(request);
  return { user };
};

export default function AdminRoute() {
  const { user } = useLoaderData();
  const location = useLocation();
  const isLoginPage = location.pathname === "/admin/login";

  useEffect(() => {
    document.body.classList.add("admin-body");
    return () => {
      document.body.classList.remove("admin-body");
    };
  }, []);

  if (isLoginPage) {
    return <Outlet context={{ user }} />;
  }

  return (
    <AdminLayout user={user}>
      <Outlet context={{ user }} />
    </AdminLayout>
  );
}

export function ErrorBoundary() {
  return (
    <div className="admin-shell" style={{ padding: 40, display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <div className="glass-panel" style={{ padding: "40px 30px", textAlign: "center", maxWidth: 500, width: "100%" }}>
        <div style={{ fontSize: "2.2rem", marginBottom: 12 }}>⚠️</div>
        <h2 style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
          Admin Panel Notice
        </h2>
        <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 20 }}>
          An error occurred while loading this admin view.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="admin-btn admin-btn-primary"
            style={{ padding: "8px 18px", fontSize: "0.85rem" }}
          >
            Reload Page
          </button>
          <a
            href="/admin"
            className="admin-btn admin-btn-outline"
            style={{ padding: "8px 18px", fontSize: "0.85rem", textDecoration: "none" }}
          >
            Back to Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
