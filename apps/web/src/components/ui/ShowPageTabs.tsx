import { type KeyboardEvent } from "react";

type ShowTab = "show" | "chat" | "rundown";

interface ShowPageTabsProps {
  activeTab: ShowTab;
  onChange: (tab: ShowTab) => void;
}

const TABS: Array<{ id: ShowTab; label: string }> = [
  { id: "show", label: "Show" },
  { id: "chat", label: "Chat" },
  { id: "rundown", label: "Rundown" },
];

export function ShowPageTabs({ activeTab, onChange }: ShowPageTabsProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: ShowTab) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onChange(tab);
  };

  return (
    <div className="show-page-tabs" role="tablist" aria-label="Show sections">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, tab.id)}
            data-active={isActive ? "true" : "false"}
            className="show-page-tab-button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
