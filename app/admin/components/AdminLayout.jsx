import { createContext, useContext, useState, useEffect } from "react";
import { Link, useLocation, useNavigation, Form } from "react-router";
import {
  SparkleIcon,
  DashboardIcon,
  UsersIcon,
  ChatBubbleIcon,
  BookOpenIcon,
  ZapIcon,
  UserIcon,
  WrenchIcon,
  SunIcon,
  MoonIcon,
  LogOutIcon,
} from "./ChatIcons.jsx";

export const DevModeContext = createContext({
  devMode: false,
  toggleDevMode: () => {},
});

export function useDevMode() {
  return useContext(DevModeContext);
}

export function AdminLayout({ user, children }) {
  const location = useLocation();
  const navigation = useNavigation();
  const isNavigating = navigation.state !== "idle";
  const targetPath = navigation.location?.pathname;
  const path = location.pathname;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const [devMode, setDevMode] = useState(false);

  // Synchronize dev mode with localStorage
  useEffect(() => {
    try {
      const savedDevMode = localStorage.getItem("perfumania_admin_dev_mode");
      setDevMode(savedDevMode === "true");
    } catch {
      // Safe fallback
    }
  }, []);

  const toggleDevMode = (enabled) => {
    setDevMode(enabled);
    try {
      localStorage.setItem("perfumania_admin_dev_mode", enabled ? "true" : "false");
    } catch {
      // Safe fallback
    }
  };

  // Synchronize theme with localStorage and document element
  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem("perfumania_admin_theme");
      if (savedTheme === "dark") {
        setTheme("dark");
        document.documentElement.setAttribute("data-theme", "dark");
      } else {
        setTheme("light");
        document.documentElement.setAttribute("data-theme", "light");
      }
    } catch {
      // Safe fallback
    }
  }, []);

  const toggleTheme = (newTheme) => {
    setTheme(newTheme);
    try {
      localStorage.setItem("perfumania_admin_theme", newTheme);
      document.documentElement.setAttribute("data-theme", newTheme);
    } catch {
      // Safe fallback
    }
  };

  // Automatically close sidebar on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const allNavItems = [
    { label: "Dashboard", href: "/admin", icon: <DashboardIcon size={18} />, devOnly: false },
    { label: "Customers & Guests", href: "/admin/customers", icon: <UsersIcon size={18} />, devOnly: false },
    { label: "Conversations", href: "/admin/conversations", icon: <ChatBubbleIcon size={18} />, devOnly: false },
    { label: "Knowledge Docs", href: "/admin/knowledge", icon: <BookOpenIcon size={18} />, devOnly: false },
    { label: "Shopify Event Logs", href: "/admin/events", icon: <ZapIcon size={18} />, devOnly: true },
  ];

  // In simple mode (devMode: false), hide complex developer tools
  const navItems = allNavItems.filter((item) => !item.devOnly || devMode);

  return (
    <div className="admin-shell">
      {/* Mobile Topbar */}
      <header className="admin-mobile-topbar">
        <div className="mobile-brand">
          <div className="brand-icon-sm">
            <SparkleIcon size={16} style={{ color: "#ffffff" }} />
          </div>
          <span className="mobile-brand-title">PERFUMANIA ADMIN</span>
        </div>
        <button
          type="button"
          className="mobile-menu-toggle"
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          aria-label="Toggle navigation menu"
        >
          {mobileMenuOpen ? "✕" : "☰"}
        </button>
      </header>

      {/* Mobile Backdrop */}
      {mobileMenuOpen && (
        <div
          className="mobile-sidebar-backdrop"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`admin-sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}>
        <div className="admin-brand">
          <div className="brand-icon">
            <SparkleIcon size={22} style={{ color: "#ffffff" }} />
          </div>
          <div>
            <div className="brand-title">PERFUMANIA</div>
            {devMode && (
              <div className="brand-badge">Dev Intelligence</div>
            )}
          </div>
        </div>

        <nav className="admin-nav">
          {navItems.map((item) => {
            const isCurrentActive =
              item.href === "/admin"
                ? path === "/admin" || path === "/admin/"
                : path.startsWith(item.href);

            const isTargetActive =
              targetPath &&
              (item.href === "/admin"
                ? targetPath === "/admin" || targetPath === "/admin/"
                : targetPath.startsWith(item.href));

            const isPending = isNavigating && isTargetActive && !isCurrentActive;
            const isActive = isTargetActive || (!targetPath && isCurrentActive);

            return (
              <Link
                key={item.href}
                to={item.href}
                className={`nav-link ${isActive ? "active" : ""} ${isPending ? "nav-pending" : ""}`}
              >
                <span className="nav-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {isPending && (
                  <span
                    style={{
                      marginLeft: "auto",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: "var(--accent-cyan)",
                      boxShadow: "0 0 8px var(--accent-cyan)",
                      display: "inline-block",
                      animation: "pulse 1s infinite",
                    }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="admin-sidebar-footer">
          {/* Dev Mode Switcher: Client / Simple vs Developer Mode */}
          <div className="sidebar-control-group">
            <div className="sidebar-control-header">
              <span className="sidebar-control-label">DEV OPTION</span>
              <span className={`status-pill ${devMode ? "status-on" : "status-off"}`}>
                {devMode ? "ON" : "OFF"}
              </span>
            </div>
            <div className="theme-switcher" role="group" aria-label="Dev option view mode switcher">
              <button
                type="button"
                className={`theme-toggle-btn ${!devMode ? "active" : ""}`}
                onClick={() => toggleDevMode(false)}
                title="Dev Option OFF: Client View (Customers, Carts, Storefront Chat)"
              >
                <span className="theme-toggle-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                  <UserIcon size={14} />
                </span>
                <span>OFF</span>
              </button>
              <button
                type="button"
                className={`theme-toggle-btn ${devMode ? "active" : ""}`}
                onClick={() => toggleDevMode(true)}
                title="Dev Option ON: Developer Mode (LLM Prompts, MCP Logs, Knowledge Docs, Webhooks)"
              >
                <span className="theme-toggle-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                  <WrenchIcon size={14} />
                </span>
                <span>ON</span>
              </button>
            </div>
          </div>

          {/* Dark & Light Theme Switcher */}
          <div className="sidebar-control-group">
            <div className="sidebar-control-header">
              <span className="sidebar-control-label">THEME</span>
            </div>
            <div className="theme-switcher" role="group" aria-label="Theme mode switcher">
              <button
                type="button"
                className={`theme-toggle-btn ${theme === "light" ? "active" : ""}`}
                onClick={() => toggleTheme("light")}
                title="Switch to Light Mode"
              >
                <span className="theme-toggle-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                  <SunIcon size={14} />
                </span>
                <span>Light</span>
              </button>
              <button
                type="button"
                className={`theme-toggle-btn ${theme === "dark" ? "active" : ""}`}
                onClick={() => toggleTheme("dark")}
                title="Switch to Dark Mode"
              >
                <span className="theme-toggle-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                  <MoonIcon size={14} />
                </span>
                <span>Dark</span>
              </button>
            </div>
          </div>

          {user && (
            <div className="user-badge">
              <div className="user-avatar">
                {(user.name || user.email || "A").charAt(0).toUpperCase()}
              </div>
              <div className="user-info">
                <div className="user-name">{user.name || user.email}</div>
                <div className="user-role">{user.email}</div>
              </div>
            </div>
          )}
          <Form method="post" action="/admin/logout">
            <button type="submit" className="logout-btn" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <LogOutIcon size={14} />
              <span>Sign Out</span>
            </button>
          </Form>
        </div>
      </aside>

      {/* Main view container wrapped in DevModeContext */}
      <DevModeContext.Provider value={{ devMode, toggleDevMode }}>
        <main className="admin-main">{children}</main>
      </DevModeContext.Provider>
    </div>
  );
}
