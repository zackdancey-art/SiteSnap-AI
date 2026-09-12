"use client";

import type { ReactNode } from "react";
import ProfileDropdown from "@/components/ProfileDropdown";

/**
 * The single app top bar. Every page renders <Topbar title="…" /> instead of
 * hand-rolling `.topbar` markup with a static `.topbar-avatar` div — that static
 * div was unclickable on all 7 pages (the working profile menu only existed on
 * the site-detail page). Centralising it means the ProfileDropdown is mounted
 * once, here, and the profile menu works everywhere.
 *
 * `right` holds any page-specific content that sits left of the profile menu
 * (e.g. the reports export control, the dashboard date).
 */
export default function Topbar({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="topbar">
      <div className="topbar-title">{title}</div>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
        {right}
        <ProfileDropdown />
      </div>
    </div>
  );
}
