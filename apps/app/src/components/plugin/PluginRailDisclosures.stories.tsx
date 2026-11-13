import { useEffect } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import {
  setPluginSlotRegistrations,
  removePluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  PluginRailDisclosures,
  usePluginSidebarFooterDisclosure,
} from "./PluginSidebarFooterItems";

export default { title: "sidebar/Rail usage" };

function RailContent() {
  const disclosure = usePluginSidebarFooterDisclosure();
  useEffect(() => {
    setPluginSlotRegistrations(
      "rail-preview",
      collectPluginAppRegistrations(
        definePluginApp((app) => {
          app.experimental_sidebarFooter.register({
            kind: "disclosure",
            id: "usage",
            label: "Provider usage",
            icon: "Gauge",
            experimental_placement: "rail-bottom",
            component: ({ dismiss }) => (
              <div className="space-y-4 p-4">
                <h2 className="text-sm font-medium">Provider usage</h2>
                <div className="flex justify-between text-sm">
                  <span>Five-hour limit</span>
                  <span>79% left</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted">
                  <div className="h-full w-4/5 rounded-full bg-primary" />
                </div>
                <div className="flex justify-between text-sm">
                  <span>Weekly limit</span>
                  <span className="text-warning">2% left</span>
                </div>
                <button
                  onClick={dismiss}
                  className="text-xs text-muted-foreground"
                >
                  Close usage
                </button>
              </div>
            ),
          });
        }),
      ),
    );
    return () => removePluginSlotRegistrations("rail-preview");
  }, []);
  return (
    <div className="flex h-144 w-full overflow-hidden rounded-xl border border-border bg-background">
      <aside
        data-testid="usage-rail"
        className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar py-3"
      >
        <Icon name="Home" className="size-5" />
        <div className="flex-1" />
        <PluginRailDisclosures
          activeKey={disclosure.activeKey}
          onCommand={disclosure.handleCommand}
          onDismiss={disclosure.dismiss}
        />
        <Icon name="Settings" className="my-2 size-5" />
      </aside>
      <div className="w-56 border-r border-border p-4 text-sm text-muted-foreground">
        Threads
      </div>
      <div className="flex-1 p-8 text-sm text-muted-foreground">
        Open usage from the bottom-left rail.
      </div>
    </div>
  );
}

export function BottomLeftUsage() {
  return (
    <SidebarProvider>
      <div className="w-full p-6">
        <RailContent />
      </div>
    </SidebarProvider>
  );
}
