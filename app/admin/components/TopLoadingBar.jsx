import { useNavigation, useFetchers } from "react-router";
import { useEffect, useState, useRef } from "react";

/**
 * TopLoadingBar
 * Universal top navigation & data loading indicator line.
 * Automatically activates whenever a user clicks any navigation link,
 * submits a filter/form, or initiates an asynchronous fetch.
 *
 * Provides instant feedback (similar to YouTube/GitHub/Linear) so the user
 * immediately sees their click is in progress and data is loading.
 */
export function TopLoadingBar() {
  const navigation = useNavigation();
  const fetchers = useFetchers();

  const isBusy =
    navigation.state !== "idle" ||
    fetchers.some((f) => f.state !== "idle");

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef(null);
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (isBusy) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);

      setVisible(true);
      setProgress((prev) => (prev > 0 && prev < 90 ? prev : 20));

      // Trickle progress while loading
      intervalRef.current = setInterval(() => {
        setProgress((prev) => {
          if (prev < 40) return prev + 15;
          if (prev < 70) return prev + 8;
          if (prev < 88) return prev + 3;
          if (prev < 95) return prev + 0.5;
          return prev;
        });
      }, 200);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);

      if (visible) {
        setProgress(100);
        timeoutRef.current = setTimeout(() => {
          setVisible(false);
          timeoutRef.current = setTimeout(() => {
            setProgress(0);
          }, 300);
        }, 220);
      }
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isBusy, visible]);

  if (!visible && progress === 0) return null;

  return (
    <div
      className="top-loading-bar-wrap"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        zIndex: 9999999,
        pointerEvents: "none",
        overflow: "hidden",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.25s ease-out",
      }}
      aria-hidden="true"
    >
      <div
        className="top-loading-bar"
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "linear-gradient(90deg, var(--pf-brand, #00bcf2) 0%, #10b981 50%, var(--accent-cyan, #38bdf8) 100%)",
          boxShadow: "0 0 12px rgba(0, 188, 242, 0.9), 0 0 5px rgba(16, 185, 129, 0.7)",
          position: "relative",
          transition: progress === 100 ? "width 0.12s ease-out" : "width 0.25s cubic-bezier(0.1, 0.05, 0, 1)",
        }}
      >
        {/* Leading edge glow */}
        <div
          style={{
            position: "absolute",
            top: "-2px",
            right: 0,
            bottom: "-2px",
            width: "80px",
            background: "radial-gradient(ellipse at right, rgba(255, 255, 255, 0.95), rgba(0, 188, 242, 0.7) 40%, transparent 80%)",
            filter: "drop-shadow(0 0 8px #00bcf2)",
          }}
        />
      </div>

      {/* Subtle top-right activity pulse dot */}
      {isBusy && (
        <div
          style={{
            position: "fixed",
            top: "10px",
            right: "14px",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: "var(--accent-cyan, #00bcf2)",
            boxShadow: "0 0 10px rgba(0, 188, 242, 0.9)",
            animation: "topPulse 0.9s ease-in-out infinite alternate",
            zIndex: 9999999,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
