import { Button } from "@bb/shared-ui/button";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

export function AddServerButton({
  onBeforeOpen,
}: {
  onBeforeOpen?: () => void;
}) {
  const desktop = getBbDesktopInfo();
  const addServer = desktop?.addServer?.bind(desktop);
  if (!addServer) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        onBeforeOpen?.();
        addServer();
      }}
    >
      Add server
    </Button>
  );
}
